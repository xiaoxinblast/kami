/**
 * 风格证据的分层取样。
 *
 * 老读法是"最新优先 + limit"：`getStyleEvidence(locale, { projectId, limit: 1000 })`。
 * 一条 7 万行的过往译文导入进来之后，最近 1000 条全被这一批占满——蒸馏、翻译提示词
 * 里看到的就只剩这批表格证据，之前人工采纳的、别的语体的、别的文件的证据全部被挤出去。
 *
 * 这里改成"先扫一个有界窗口，再分层取"：
 *   1. 人工采纳（human-accept）优先，其次是外部审校回填，最后才是表格导入；
 *   2. 同一档内按语体轮转，保证对白 / UI / 公告都有代表；
 *   3. 同一语体内按来源文件轮转，单个文件有上限，避免一个文件霸榜；
 *   4. 同一层内按时间倒序（取数时已经排好），结果可复现。
 *
 * 纯模块：不依赖 store / provider / 时钟，便于单测。
 */

import { isNegativeEvidence } from "./style-delta.mjs";

/** 扫描窗口：最多看最近这么多条证据（1000/页，最多 5 次请求）。 */
export const EVIDENCE_SCAN_BUDGET = 5_000;
export const EVIDENCE_PAGE_SIZE = 1_000;

/** 单文件上限：池子很小时不至于把名额卡没，池子很大时又能压住单文件霸榜。 */
export function evidenceFileCap(limit) {
  return Math.max(3, Math.ceil(Math.max(1, Number(limit) || 1) / 4));
}

/** provenance 优先级：人工采纳 > 外部审校回填 > 其它（表格导入 / 历史）。 */
export function evidenceProvenanceRank(item = {}) {
  const provenance = String(item?.provenance || "");
  if (provenance === "human-accept") return 0;
  if (provenance === "external-review-import") return 1;
  return 2;
}

function bucketKey(item = {}) {
  return String(item?.contentType || "general");
}

function fileKey(item = {}) {
  return String(item?.sourceFile || "");
}

/**
 * 分层取样：按 provenance → 语体 → 来源文件轮转，单文件不超过 perFileCap。
 * `positiveOnly` 为 true 时只返回正例（提示词用），否则把反例附在结果末尾
 * （蒸馏的 `stratifyEvidence` 会自己再分出正反例，不能被这里吞掉）。
 */
export function stratifyEvidenceSample(rows = [], { limit = 1_000, perFileCap, positiveOnly = false } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  const quota = Math.max(1, Math.trunc(Number(limit)) || 1_000);
  const cap = Math.max(1, Math.trunc(Number(perFileCap)) || evidenceFileCap(quota));
  const positives = [];
  const negatives = [];
  for (const item of list) (isNegativeEvidence(item) ? negatives : positives).push(item);
  const picked = [];
  const used = new Set();
  const fileCounts = new Map();
  // 两趟：第一趟守单文件上限（防止一个文件霸榜），第二趟放开上限但保持轮转
  // （池子里只有一两个文件时，名额要能填满，否则提示词/蒸馏拿不到足够样本）。
  for (const enforceCap of [true, false]) {
    for (const rank of [0, 1, 2]) {
      if (picked.length >= quota) break;
      const byType = new Map();
      for (const item of positives) {
        if (used.has(item) || evidenceProvenanceRank(item) !== rank) continue;
        const key = bucketKey(item);
        if (!byType.has(key)) byType.set(key, new Map());
        const byFile = byType.get(key);
        const file = fileKey(item);
        if (!byFile.has(file)) byFile.set(file, []);
        byFile.get(file).push(item);
      }
      if (!byType.size) continue;
      const typeGroups = [...byType.values()].map((byFile) => [...byFile.values()]);
      const typeCursors = typeGroups.map(() => 0);
      const fileCursors = typeGroups.map((group) => group.map(() => 0));
      let progressed = true;
      while (picked.length < quota && progressed) {
        progressed = false;
        for (let type = 0; type < typeGroups.length && picked.length < quota; type += 1) {
          const files = typeGroups[type];
          for (let probe = 0; probe < files.length && picked.length < quota; probe += 1) {
            const fileIndex = typeCursors[type] % files.length;
            typeCursors[type] += 1;
            const queue = files[fileIndex];
            let taken = false;
            while (fileCursors[type][fileIndex] < queue.length) {
              const item = queue[fileCursors[type][fileIndex]];
              fileCursors[type][fileIndex] += 1;
              const file = fileKey(item);
              // 上限按「语体 × 文件」算：同一个文件在不同语体下各自有序额，
              // 否则先轮到的语体会把文件的全部额度吃掉，另一个语体在第一批就被饿死。
              const slot = `${bucketKey(item)}\u0000${file}`;
              const count = Number(fileCounts.get(slot) || 0);
              if (enforceCap && file && count >= cap) continue;
              if (file) fileCounts.set(slot, count + 1);
              picked.push(item);
              used.add(item);
              taken = true;
              progressed = true;
              break;
            }
            // 该语体这一轮取到一条就轮到下一个语体，保证语体之间也轮转。
            if (taken) break;
          }
        }
      }
    }
  }
  if (positiveOnly) return picked;
  return [...picked, ...negatives];
}

/**
 * 有界分页：最多扫 scanBudget 行，页不滿就停。
 * `fetchPage(offset, limit)` 注入，便于单测断言"请求次数有上限"。
 */
export async function collectEvidencePages({ fetchPage, scanBudget = EVIDENCE_SCAN_BUDGET, pageSize = EVIDENCE_PAGE_SIZE } = {}) {
  if (typeof fetchPage !== "function") return [];
  const budget = Math.max(1, Math.trunc(Number(scanBudget)) || EVIDENCE_SCAN_BUDGET);
  const size = Math.max(1, Math.trunc(Number(pageSize)) || EVIDENCE_PAGE_SIZE);
  const rows = [];
  for (let offset = 0; offset < budget; offset += size) {
    const want = Math.min(size, budget - offset);
    const page = await fetchPage(offset, want);
    if (!Array.isArray(page) || !page.length) break;
    rows.push(...page);
    if (page.length < want) break;
  }
  return rows;
}
