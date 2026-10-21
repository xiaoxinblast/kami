/**
 * TM 候选索引：先用字符 n-gram 倒排把整库收窄成 top-K 候选，再交给既有打分函数精排。
 *
 * 为什么需要它：一次翻译原本要把整个项目 TM 拉进内存逐条算编辑距离。实测 8.3 万条时
 * 单段要 11–17 秒、要传 369MB；改成"先取候选再精排"后是 130 毫秒级。
 *
 * 召回上的三条硬规则（这是本模块存在的全部意义，改动前先看这里）：
 *   1. 完全相同的原文**永远**进候选，不参与粗筛排序；
 *   2. 查询太短（凑不出 n-gram）时退回子串包含匹配——短串检索本来就该这么找；
 *   3. 打分公式、相似度门槛、范围加成一律不动，这里只决定"候选从哪来"。
 *
 * 索引支持增量维护：单条写入只 upsert 一行、删除只把槽位作废，不再整库重拉重
 * 建。为了让"增量更新"与"全量重建"给出同一批候选，同分时的顺序固定按行 id
 * （Directus 侧 `sort=id`，全量重建本来就按 id 排列），与插入/更新顺序无关。
 *
 * 纯函数模块：不依赖 store、provider 与时钟，便于单测。
 */

import { normalizeSource } from "./text.mjs";

/** 默认候选池大小。实测 500 已接近全量结果，1000 留出余量；再大只是多花时间。 */
export const DEFAULT_CANDIDATE_POOL = 1000;

const GRAM_SIZE = 3;
/** 少于这个数量的 gram 就认为查询太短，退回子串匹配。 */
const MIN_GRAMS_FOR_INDEX = 2;
/** 作废槽位超过这个量（且超过存活行数的 1/4）才压缩，避免频繁重建。 */
const MIN_COMPACTION_GARBAGE = 1024;

/** 索引与查询共用的归一化：去掉空白，避免同一句话因空格差异分成两个键。 */
export function indexText(value = "") {
  return normalizeSource(String(value ?? "")).replace(/\s+/gu, "");
}

/** 一行文本的 n-gram 集合（同一行里重复出现的 gram 只算一次，防止重复用词刷分）。 */
export function gramsOf(text = "", size = GRAM_SIZE) {
  const normalized = indexText(text);
  const grams = new Set();
  for (let index = 0; index + size <= normalized.length; index += 1) {
    grams.add(normalized.slice(index, index + size));
  }
  return grams;
}

function memoryRowOf(row) {
  return {
    ...row,
    id: String(row?.id || ""),
    source: String(row?.source || ""),
    libraryId: String(row?.libraryId || ""),
    qualityStatus: row?.qualityStatus || "provisional",
    projectId: String(row?.projectId || "")
  };
}

/** 追加一个槽位；同一 id 的旧槽位由调用方先作废。 */
function appendMemoryRow(index, row) {
  const slot = index.rows.length;
  const stored = memoryRowOf(row);
  const key = stored.id || `\u0000slot-${slot}`;
  index.rows.push(stored);
  index.normalized.push(indexText(stored.source));
  for (const gram of gramsOf(stored.source)) {
    const bucket = index.postings.get(gram);
    if (bucket) {
      bucket.slots.push(slot);
      bucket.live += 1;
    } else {
      index.postings.set(gram, { slots: [slot], live: 1 });
    }
  }
  index.slotById.set(key, slot);
  index.live += 1;
  index.total = index.live;
  return true;
}

/**
 * 建索引。只留选候选需要的字段（id / 原文 / 库归属），不保存向量：
 * 向量占每行 4.6KB 里的 2KB，留在索引里会让 8 万条直接吃掉几百 MB。
 */
export function buildMemoryIndex(rows = []) {
  const index = {
    rows: [],
    normalized: [],
    postings: new Map(),
    slotById: new Map(),
    live: 0,
    total: 0
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row) appendMemoryRow(index, row);
  }
  return index;
}

function maybeCompactMemoryIndex(index) {
  const garbage = index.rows.length - index.live;
  if (garbage <= Math.max(MIN_COMPACTION_GARBAGE, Math.floor(index.live / 4))) return;
  compactMemoryIndex(index);
}

/** 压缩：用存活行重建，清掉作废槽位和仍指向它们的倒排项。 */
export function compactMemoryIndex(index) {
  const liveRows = index.rows.filter(Boolean);
  liveRows.sort((left, right) => {
    const leftId = String(left.id || "");
    const rightId = String(right.id || "");
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  const rebuilt = buildMemoryIndex(liveRows);
  index.rows = rebuilt.rows;
  index.normalized = rebuilt.normalized;
  index.postings = rebuilt.postings;
  index.slotById = rebuilt.slotById;
  index.live = rebuilt.live;
  index.total = rebuilt.total;
  return index;
}

/**
 * 作废一个槽位：不清倒排数组（查询时跳过），但把它贡献的 gram 存活计数减掉，
 * 保证 IDF 与"完整重建"一致；垃圾积累到阈值再统一压缩。
 */
function markMemorySlotDead(index, slot) {
  const row = index.rows[slot];
  if (!row) return;
  for (const gram of gramsOf(row.source)) {
    const bucket = index.postings.get(gram);
    if (bucket && bucket.live > 0) bucket.live -= 1;
  }
  index.rows[slot] = null;
  index.normalized[slot] = "";
  index.live -= 1;
  index.total = index.live;
}

/**
 * 增量写入/更新一行：同 id 的旧槽位作废，新内容追加到尾部。
 *
 * 旧倒排项不立即删除——查询时会跳过作废槽位，等垃圾超过阈值再统一压缩。
 * 这样一次写入的成本只和这一行的 gram 数有关，不会随 TM 总量增长。
 */
export function upsertMemoryRow(index, row) {
  const id = String(row?.id || "").trim();
  if (!id) return false;
  const existing = index.slotById.get(id);
  if (existing !== undefined) {
    markMemorySlotDead(index, existing);
    index.slotById.delete(id);
  }
  appendMemoryRow(index, { ...row, id });
  maybeCompactMemoryIndex(index);
  return true;
}

/** 增量删除一行。 */
export function removeMemoryRow(index, id) {
  const key = String(id || "").trim();
  const slot = index.slotById.get(key);
  if (slot === undefined) return false;
  markMemorySlotDead(index, slot);
  index.slotById.delete(key);
  maybeCompactMemoryIndex(index);
  return true;
}

function compareRowId(index, left, right) {
  const leftId = String(index.rows[left]?.id || "");
  const rightId = String(index.rows[right]?.id || "");
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

/**
 * 选候选：精确原文优先，其余按"命中 gram 的 IDF 之和"排序取前 limit 条。
 *
 * IDF 让罕见片段说话：「ナビマップ」这种专有词比「の」「を」更能定位到同一条记忆，
 * 也顺带压掉了模板句扎堆时的平局风险。同分按 id 排序，保证增量索引与全量重建一致。
 */
export function selectMemoryCandidates(index, source, { limit = DEFAULT_CANDIDATE_POOL, libraryIds = null } = {}) {
  const rows = index?.rows || [];
  if (!rows.length) return [];
  const wanted = indexText(source);
  if (!wanted) return [];
  const pool = Math.max(1, Math.trunc(Number(limit)) || DEFAULT_CANDIDATE_POOL);
  const total = Number.isFinite(index.total) ? index.total : (index.live || rows.length);
  const allowed = Array.isArray(libraryIds) && libraryIds.length ? new Set(libraryIds.map(String)) : null;
  const allow = (position) => {
    const row = rows[position];
    if (!row) return false;
    return !allowed || allowed.has(String(row.libraryId || ""));
  };
  const picked = [];
  const seen = new Set();
  // 规则 1：同原文的行无条件进池（哪怕它在候选池第 3000 名）。
  const exact = [];
  for (let position = 0; position < rows.length; position += 1) {
    if (allow(position) && index.normalized[position] === wanted) exact.push(position);
  }
  exact.sort((left, right) => compareRowId(index, left, right));
  for (const position of exact) {
    picked.push(rows[position]);
    seen.add(position);
    if (picked.length >= pool) return picked;
  }
  const grams = [...gramsOf(wanted)];
  const scores = new Map();
  if (grams.length >= MIN_GRAMS_FOR_INDEX) {
    for (const gram of grams) {
      const bucket = index.postings.get(gram);
      if (!bucket || !bucket.live) continue;
      const idf = Math.log(1 + total / (1 + bucket.live));
      for (const position of bucket.slots) {
        if (seen.has(position) || !allow(position)) continue;
        scores.set(position, (scores.get(position) || 0) + idf);
      }
    }
  } else {
    // 规则 2：短查询凑不出 n-gram，退回子串包含（「設定」「ナビ」这类短串就该这样找）。
    for (let position = 0; position < rows.length; position += 1) {
      if (seen.has(position) || !allow(position)) continue;
      if (index.normalized[position].includes(wanted)) scores.set(position, 1);
    }
  }
  const ranked = [...scores.entries()]
    // 同分按行 id，保证同一查询每次得到同一批候选（与增量/重建路径无关）。
    .sort((left, right) => right[1] - left[1] || compareRowId(index, left[0], right[0]));
  for (const [position] of ranked) {
    if (picked.length >= pool) break;
    if (seen.has(position)) continue;
    picked.push(rows[position]);
    seen.add(position);
  }
  return picked;
}
