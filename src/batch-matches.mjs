import { matchTerms } from "./matcher.mjs";

/**
 * 批次详情里的术语匹配：优先复用该段翻译时已经保存的 matches。
 *
 * 为什么不每次重算：术语库有几千条时，`matchTerms` 对长句是 O(术语数 × 滑窗数)。
 * 实测 5,859 条术语、24 个已完成段落合计约 22 秒；任务页每次轮询都重算一遍，
 * 会把单线程事件循环占满，批次进度和 /api/health 都排不上队。
 *
 * 保存的 matches 与译文一起落库，任务页展示用它就够了；术语改动后重译该段即可刷新。
 * 老数据没有保存 matches 时才计算，并按「资源版本 + 原文 + 作用域」缓存，避免轮询重复算。
 */
const CACHE_LIMIT = 2_000;
const computedMatches = new Map();

function cacheKey(segment, assets, options = {}) {
  return JSON.stringify([
    assets?.revision ?? "",
    Array.isArray(assets?.terms) ? assets.terms.length : 0,
    String(segment?.source || ""),
    options.contentType || "",
    options.domain || "",
    options.project || "",
    options.channel || "",
    options.platform || "",
    options.region || ""
  ]);
}

export function resolveSegmentMatches(segment, assets, options = {}, compute = matchTerms) {
  const saved = segment?.result?.matches;
  if (Array.isArray(saved)) return saved;
  const key = cacheKey(segment, assets, options);
  if (computedMatches.has(key)) return computedMatches.get(key);
  const matches = compute(String(segment?.source || ""), assets, options);
  computedMatches.set(key, matches);
  if (computedMatches.size > CACHE_LIMIT) {
    // 简单的 FIFO 淘汰：只防止长期运行无限增长，命中率不是关键。
    computedMatches.delete(computedMatches.keys().next().value);
  }
  return matches;
}
