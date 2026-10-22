import { createHash } from "node:crypto";

import { normalizeSource } from "./text.mjs";

/**
 * 文件级工作术语表。
 *
 * 只服务当前批次/文件：主术语库始终优先，工作术语是"本文件内统一译法"的临时约束。
 * 存储位置是 batch_runs.runnerOptions.workingGlossary，不写正式术语表。
 */

export const WORKING_TERM_MAX_SOURCE_LENGTH = 40;
export const WORKING_TERM_MAX_TARGET_LENGTH = 60;
export const WORKING_TERM_MIN_CONFIDENCE = 0.65;
export const WORKING_TERMS_PER_SEGMENT = 5;

function text(value) {
  return String(value ?? "").trim();
}

function termId(source) {
  return `wt-${createHash("sha1").update(normalizeSource(source)).digest("hex").slice(0, 12)}`;
}

/** 主术语库已占用的源词/别名：工作术语遇到这些词必须让位。 */
export function formalTermKeys(terms = []) {
  const keys = new Set();
  for (const term of Array.isArray(terms) ? terms : []) {
    for (const value of [term?.source, ...(Array.isArray(term?.aliases) ? term.aliases : [])]) {
      const key = normalizeSource(value);
      if (key) keys.add(key);
    }
  }
  return keys;
}

export function emptyWorkingGlossary({ batchId = "", filename = "", locale = "zh-CN" } = {}) {
  return { version: 1, batchId: String(batchId || ""), filename: String(filename || ""), locale: String(locale || "zh-CN"), revision: 0, terms: [], conflicts: [] };
}

/**
 * 校验并规范化一条工作术语。
 *
 * 严格模式（逐段学习）要求 source/target 分别是原文/译文的逐字子串；
 * 手动录入可跳过 targetText 校验（targetText 传空即可）。
 */
export function normalizeWorkingTerm(input = {}, {
  formalKeys = new Set(),
  sourceText = "",
  targetText = "",
  sourceSegmentId = "",
  now = new Date()
} = {}) {
  const source = text(input.source);
  const target = text(input.target);
  if (!source || !target) return null;
  if ([...source].length > WORKING_TERM_MAX_SOURCE_LENGTH || [...target].length > WORKING_TERM_MAX_TARGET_LENGTH) return null;
  const key = normalizeSource(source);
  if (!key || formalKeys.has(key)) return null;
  if (sourceText && !String(sourceText).includes(source)) return null;
  if (targetText && !String(targetText).includes(target)) return null;
  const confidence = Number(input.confidence);
  if (input.confidence !== undefined && Number.isFinite(confidence) && confidence < WORKING_TERM_MIN_CONFIDENCE) return null;
  return {
    id: text(input.id) || termId(source),
    source,
    target,
    aliases: Array.isArray(input.aliases) ? input.aliases.map(text).filter(Boolean) : [],
    status: ["active", "suggested", "rejected"].includes(input.status) ? input.status : "active",
    enforcement: input.enforcement === "required" ? "required" : "preferred",
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.8,
    origin: text(input.origin) || "segment-learn",
    sourceSegmentId: text(input.sourceSegmentId || sourceSegmentId),
    createdAt: text(input.createdAt) || now.toISOString(),
    updatedAt: now.toISOString()
  };
}

/** 批量规范化；同源词只保留第一条，主术语库已有的丢弃。 */
export function normalizeWorkingTerms(list = [], options = {}) {
  const formalKeys = options.formalKeys || formalTermKeys(options.formalTerms || []);
  const seen = new Set();
  const terms = [];
  for (const item of Array.isArray(list) ? list : []) {
    const term = normalizeWorkingTerm(item, { ...options, formalKeys });
    if (!term) continue;
    const key = normalizeSource(term.source);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

/**
 * 合并一批新学到的术语：首次出现的译法为准，不覆盖已有工作术语；
 * 同源不同译法记 conflicts，交给一致性报告/UI 处理。
 */
export function mergeWorkingTermsIntoGlossary(glossary, incoming = [], { sourceSegmentId = "", now = new Date() } = {}) {
  const current = glossary && typeof glossary === "object"
    ? { ...glossary, terms: Array.isArray(glossary.terms) ? [...glossary.terms] : [], conflicts: Array.isArray(glossary.conflicts) ? [...glossary.conflicts] : [] }
    : emptyWorkingGlossary();
  const byKey = new Map(current.terms.map((term) => [normalizeSource(term.source), term]));
  let changed = false;
  for (const term of Array.isArray(incoming) ? incoming : []) {
    const key = normalizeSource(term?.source);
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      if (normalizeSource(existing.target) !== normalizeSource(term.target)) {
        current.conflicts.push({
          source: term.source,
          kept: existing.target,
          ignored: term.target,
          sourceSegmentId: term.sourceSegmentId || sourceSegmentId,
          at: now.toISOString()
        });
      }
      continue;
    }
    byKey.set(key, term);
    current.terms.push(term);
    changed = true;
  }
  if (current.conflicts.length > 200) current.conflicts = current.conflicts.slice(-200);
  if (changed) current.revision = (Number(current.revision) || 0) + 1;
  return current;
}

/** 合成 term 让现有 matchTerms / governor 能识别；working 标记供提示词分层。 */
export function workingTermsAsAssets(assets = {}) {
  return Array.isArray(assets.terms) ? assets.terms : [];
}

export function mergeWorkingAssets(assets = {}, glossary = null, { batchId = "" } = {}) {
  const workingTerms = Array.isArray(glossary?.terms) ? glossary.terms.filter((term) => term?.status !== "rejected") : [];
  if (!workingTerms.length) return assets;
  const formalKeys = formalTermKeys(assets.terms || []);
  const merged = [...(Array.isArray(assets.terms) ? assets.terms : [])];
  for (const term of workingTerms) {
    const key = normalizeSource(term.source);
    if (!key || formalKeys.has(key)) continue;
    merged.push({
      id: `working:${batchId || glossary?.batchId || ""}:${term.id || termId(term.source)}`,
      source: term.source,
      target: term.target,
      aliases: Array.isArray(term.aliases) ? term.aliases : [],
      forbidden: [],
      status: "approved",
      assetTier: "formal",
      lifecycleStatus: "active",
      enforcement: term.enforcement === "required" ? "required" : "preferred",
      provenance: "working-glossary",
      working: true,
      libraryId: `working:${batchId || glossary?.batchId || ""}`,
      confidence: term.confidence,
      sourceSegmentId: term.sourceSegmentId || ""
    });
  }
  return { ...assets, terms: merged };
}

export function workingTermSources(glossary = null) {
  return (Array.isArray(glossary?.terms) ? glossary.terms : [])
    .filter((term) => term?.status !== "rejected")
    .map((term) => String(term.source || "").trim())
    .filter(Boolean);
}
