/**
 * 作用域（内容语体 × 业务领域）的取用顺序。
 *
 * 过去三个资产类型各写各的口径：翻译记忆只有"精确/宽松"两档，QA 反例与风格规范
 * 则是严格同语体；结果就是"通用×通用"的规范只有在句段被判成"待分类文本"时才会
 * 生效，用户配错语体就静默失效。这里统一成一条链，任何取用都按顺序找：
 *
 *   1) 同语体 + 同领域   2) 同语体 + 通用领域
 *   3) 通用语体 + 同领域 4) 通用语体 + 通用领域
 *
 * `general` 表示"通用/未分类"，`general` 自身参与去重，所以 4 档最多剩 1 档。
 */
export const GENERAL_SCOPE = "general";

function normalizeScopeValue(value) {
  const text = String(value ?? "").trim();
  return text || GENERAL_SCOPE;
}

/** 返回去重后的降级链，`rank` 就是优先级（越小越优先）。 */
export function scopeFallbackChain(contentType = GENERAL_SCOPE, domain = GENERAL_SCOPE) {
  const type = normalizeScopeValue(contentType);
  const area = normalizeScopeValue(domain);
  const seen = new Set();
  const chain = [];
  for (const [nextType, nextDomain] of [
    [type, area],
    [type, GENERAL_SCOPE],
    [GENERAL_SCOPE, area],
    [GENERAL_SCOPE, GENERAL_SCOPE]
  ]) {
    const key = `${nextType}\u0000${nextDomain}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chain.push({ contentType: nextType, domain: nextDomain, rank: chain.length });
  }
  return chain;
}

/** 一条资产落在链上的第几档；不在链上（既不同语体也不同领域）返回链长度。 */
export function scopeRankOf(asset = {}, { contentType = GENERAL_SCOPE, domain = GENERAL_SCOPE } = {}) {
  const chain = scopeFallbackChain(contentType, domain);
  const assetType = normalizeScopeValue(asset.contentType ?? asset.content_type);
  const assetDomain = normalizeScopeValue(asset.domain);
  const hit = chain.find((entry) => entry.contentType === assetType && entry.domain === assetDomain);
  return hit ? hit.rank : chain.length;
}

/** 作用域的展示文案：`对白 × 游戏`、`通用 × 通用`。 */
export function describeScope({ contentType = GENERAL_SCOPE, domain = GENERAL_SCOPE } = {}) {
  return `${normalizeScopeValue(contentType)} × ${normalizeScopeValue(domain)}`;
}
