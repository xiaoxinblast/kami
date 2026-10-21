/**
 * 门禁失败复盘：把"这次又犯的错"按模式归类，给出可执行建议，并指出下一步动作。
 *
 * 复盘只做归因，不改任何资产：术语类建议转术语候选（同一套入库策略），
 * 体例类建议用来生成新的候选技能。这样门禁失败之后页面不再是一条死路。
 */

import { parseModelJsonObject } from "./text.mjs";

const REVIEW_KINDS = new Set(["terminology", "convention", "fact", "other"]);
export const GATE_REVIEW_MAX_CASES_PER_CHUNK = 30;
const MAX_PATTERNS = 20;

function text(value) {
  return String(value ?? "").trim();
}

/** 从一条质量门禁运行记录里取出"需要复盘"的失败样本（回归复发 + Gold 硬失败）。 */
export function gateFailureCases(run = {}) {
  const report = run?.report || {};
  const cases = [];
  for (const item of Array.isArray(report?.regression?.cases) ? report.regression.cases : []) {
    if (item?.passed !== false) continue;
    cases.push({
      caseId: text(item.id),
      kind: "regression",
      source: text(item.source),
      candidateTranslation: text(item.translation),
      expectedTranslation: text(item.expectedTranslation),
      sourceTrajectoryId: text(item?.sourceRef?.trajectoryId),
      sourceKind: text(item.sourceKind),
      reason: (Array.isArray(item.issues) ? item.issues : []).map((issue) => text(issue?.message)).filter(Boolean).join("；")
    });
  }
  for (const item of Array.isArray(report?.gold?.samples) ? report.gold.samples : []) {
    if (item?.passed !== false) continue;
    cases.push({
      caseId: text(item.id),
      kind: "gold",
      source: text(item.source),
      candidateTranslation: text(item.translation),
      expectedTranslation: (Array.isArray(item.referenceTargets) ? item.referenceTargets : []).map(text).filter(Boolean)[0] || "",
      reason: (Array.isArray(item.issues) ? item.issues : []).map((issue) => text(issue?.message)).filter(Boolean).join("；")
    });
  }
  return cases.filter((item) => item.caseId && item.source);
}

/** 复盘按块送模型：一次太多会稀释注意力，也容易超出输出预算。 */
export function chunkGateFailures(cases = [], { maxPerChunk = GATE_REVIEW_MAX_CASES_PER_CHUNK } = {}) {
  const limit = Math.max(1, Number(maxPerChunk) || GATE_REVIEW_MAX_CASES_PER_CHUNK);
  const list = Array.isArray(cases) ? cases : [];
  const chunks = [];
  for (let index = 0; index < list.length; index += limit) {
    chunks.push({ index: chunks.length, cases: list.slice(index, index + limit) });
  }
  return chunks;
}

/** 模型输出不可信：白名单 kind、字段截断、按 label 去重。 */
export function normalizeGateReviewReport(raw = {}) {
  const patterns = [];
  const seen = new Set();
  for (const item of Array.isArray(raw?.patterns) ? raw.patterns : []) {
    const label = text(item?.label).slice(0, 120);
    if (!label) continue;
    const kind = REVIEW_KINDS.has(text(item?.kind).toLowerCase()) ? text(item?.kind).toLowerCase() : "other";
    const key = `${kind}\u0000${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    patterns.push({
      id: text(item?.id) || `pattern-${patterns.length + 1}`,
      label,
      kind,
      caseIds: [...new Set((Array.isArray(item?.caseIds) ? item.caseIds : []).map(text).filter(Boolean))],
      reason: text(item?.reason).slice(0, 500),
      suggestion: text(item?.suggestion).slice(0, 500),
      proposedRule: text(item?.proposedRule).slice(0, 300),
      termSuggestions: (Array.isArray(item?.termSuggestions) ? item.termSuggestions : [])
        .map((term) => ({
          source: text(term?.source).slice(0, 80),
          target: text(term?.target).slice(0, 120),
          preserveSource: term?.preserveSource === true
        }))
        .filter((term) => term.source && term.target)
    });
    if (patterns.length >= MAX_PATTERNS) break;
  }
  return {
    summary: text(raw?.summary).slice(0, 500),
    patterns
  };
}

/** 分块结果合并：同 label 的模式并成一条，案例 id 取并集。 */
export function mergeGateReviewReports(parts = []) {
  const merged = new Map();
  const summaries = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    const report = normalizeGateReviewReport(part);
    if (report.summary) summaries.push(report.summary);
    for (const pattern of report.patterns) {
      const key = `${pattern.kind}\u0000${pattern.label}`;
      const existing = merged.get(key);
      if (existing) {
        existing.caseIds = [...new Set([...existing.caseIds, ...pattern.caseIds])];
        existing.termSuggestions = [...existing.termSuggestions, ...pattern.termSuggestions];
        if (!existing.proposedRule && pattern.proposedRule) existing.proposedRule = pattern.proposedRule;
        continue;
      }
      merged.set(key, { ...pattern });
    }
  }
  const patterns = [...merged.values()].map((pattern, index) => ({
    ...pattern,
    id: `pattern-${index + 1}`,
    termSuggestions: [...new Map(pattern.termSuggestions.map((term) => [`${term.source}\u0000${term.target}`, term])).values()]
  }));
  return { summary: summaries[0] || "", patterns };
}

/**
 * 复盘里的术语建议 → 术语候选输入。
 * 期望译法取自**这次失败案例的人工终稿**（回归案例的 expectedTranslation 就是人工定稿），
 * 所以术语类建议天然带权威依据；preserveSource 表示"原文照抄不译"。
 */
export function termInputsFromReview(review = {}, cases = []) {
  const byId = new Map((Array.isArray(cases) ? cases : []).map((item) => [String(item.caseId), item]));
  const inputs = [];
  const seen = new Set();
  for (const pattern of Array.isArray(review?.patterns) ? review.patterns : []) {
    if (pattern.kind !== "terminology") continue;
    for (const term of Array.isArray(pattern.termSuggestions) ? pattern.termSuggestions : []) {
      const evidence = (pattern.caseIds || []).map((id) => byId.get(String(id))).find((item) => item && textContains(item.source, term.source));
      const target = term.preserveSource ? term.source : term.target;
      // 译法必须能在人工终稿里找到，否则只能算模型的猜测，交给人工判断。
      const authoritative = term.preserveSource
        ? Boolean(evidence && textContains(evidence.expectedTranslation, term.source))
        : Boolean(evidence && textContains(evidence.expectedTranslation, term.target));
      const key = `${term.source}\u0000${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      inputs.push({
        source: term.source,
        target,
        preserveSource: term.preserveSource === true,
        confidence: 0.9,
        reason: pattern.label || pattern.suggestion || "",
        patternLabel: pattern.label,
        caseId: evidence?.caseId || "",
        segmentSource: evidence?.source || "",
        humanFinal: evidence?.expectedTranslation || "",
        verbatim: authoritative
      });
    }
  }
  return inputs;
}

function textContains(haystack, needle) {
  const target = text(needle);
  return Boolean(target) && text(haystack).includes(target);
}

/**
 * 复盘提示词：输入就是门禁跑出来的失败清单（含人工终稿，所以模型能看出"该译成什么"）。
 * 输出按模式归类，并明确区分"这是术语问题"还是"这是体例/规则问题"——两者后续动作不同。
 */
export function gateReviewMessages({ locale = "zh-CN", scope = {}, cases = [], part = null } = {}) {
  const partLine = part ? `这是整份失败清单的第 ${part.index + 1} / ${part.total} 片，caseId 沿用输入里的 id。\n` : "";
  const system = [
    "你在复盘一次翻译技能发版门禁的失败：候选技能在这些固定样本上仍然犯错，被人工终稿否决。",
    "请把失败**按根因归类成尽量少的模式**（同类问题合成一条），不要一条失败一个模式。",
    "kind 只能是 terminology（术语/专名没按已定稿写法）、convention（命名体例、句式、格式等成文规则）、fact（数字、日期、平台、占位符等事实锚点）、other（其它）。",
    "每条模式要给出：label（一句话概括，如「〜の片 应译作 〜之隅」）、caseIds（命中的失败案例 id）、reason（简体中文说明候选为什么会犯这个错）、suggestion（可执行的修改建议）。",
    "如果是术语类，额外给 termSuggestions：源词 + **从人工终稿里抄下来的**译法；若终稿要求原文照抄，preserveSource 填 true。",
    "如果是体例类，给 proposedRule：一句能直接写进翻译技能附加规则的规则（简体中文，可执行、可判定）。",
    "只依据输入里的人工终稿判断，不要自己发明译法。summary 用一句话总结这批失败的共性问题。",
    '只输出严格 JSON：{"summary":"...","patterns":[{"id":"pattern-1","label":"...","kind":"convention","caseIds":["reg-1"],"reason":"...","suggestion":"...","proposedRule":"...","termSuggestions":[{"source":"...","target":"...","preserveSource":false}]}]}',
    "整个回答只能是一个 JSON 对象：禁止 Markdown、解释或代码围栏。"
  ].join("\n");
  const user = [
    `目标语言：${locale}`,
    `作用域：语体 ${scope.contentType || "general"} · 领域 ${scope.domain || "general"}`,
    partLine,
    "失败清单（kind=regression 表示历史失败复发；kind=gold 表示固定样本硬约束失败）：",
    JSON.stringify(cases.map((item) => ({
      caseId: item.caseId,
      kind: item.kind,
      source: String(item.source || "").slice(0, 400),
      candidateTranslation: String(item.candidateTranslation || "").slice(0, 400),
      expectedTranslation: String(item.expectedTranslation || "").slice(0, 400),
      reason: String(item.reason || "").slice(0, 200)
    })))
  ].filter(Boolean).join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

export function parseGateReview(content) {
  let payload;
  try {
    payload = parseModelJsonObject(content);
  } catch (error) {
    throw new Error(`门禁复盘模型未返回 JSON（${error.message}）`);
  }
  return normalizeGateReviewReport(payload);
}
