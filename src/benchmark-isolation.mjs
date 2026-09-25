/**
 * Clean-room isolation for skill benchmarks.
 *
 * A holdout case must never see assets derived from its own final translation:
 * a memory, QA case, style-profile example or user-profile example whose source
 * text is the same sentence (or a near-identical variant) would inject the
 * "gold" answer into the context pack of both variants, collapse every metric
 * delta to zero and permanently freeze the promotion loop.
 *
 * This module is pure over JSON-compatible values: it never mutates inputs and
 * has no store/provider/clock dependency so it can be unit-tested in isolation.
 */

import { normalizeSource, similarity } from "./text.mjs";

/**
 * Sources this close to the case source count as self-derived. One edit on a
 * 21-character sentence already exceeds 0.95 similarity; short sources require
 * an exact match naturally, so no special-casing is needed.
 */
export const SELF_REFERENCE_SIMILARITY_THRESHOLD = 0.95;

/**
 * 去掉标点与空白后的原文骨架。
 *
 * isSelfDerived 用的 0.95 相似度阈值对逐条检索隔离是合适的，但对短句欠捕获：
 * 十来个字的句子多一个句号只有 0.92，换个标点就能同时进学习集和考试集。隔离
 * 宁可多删也不能漏——样本被删多了有最小样本量守卫会报出来，静默泄漏却只会把
 * 分数悄悄抬高。
 */
export function sourceSkeleton(value) {
  return normalizeSource(value).replace(/[\p{P}\p{S}\s]/gu, "");
}

/** True when candidateSource is the same sentence as source (normalized) or a near-identical variant. */
export function isSelfDerived(source, candidateSource) {
  const normalized = normalizeSource(source);
  const candidate = normalizeSource(candidateSource);
  if (!normalized || !candidate) return false;
  if (normalized === candidate) return true;
  const skeleton = sourceSkeleton(source);
  if (skeleton && skeleton === sourceSkeleton(candidateSource)) return true;
  return similarity(normalized, candidate) >= SELF_REFERENCE_SIMILARITY_THRESHOLD;
}

function partition(items = [], source) {
  const kept = [];
  const removed = [];
  for (const item of items || []) {
    const candidate = typeof item?.source === "string" ? item.source : (typeof item?.text === "string" ? item.text : "");
    if (item && candidate && isSelfDerived(source, candidate)) removed.push(item);
    else kept.push(item);
  }
  return { kept, removed };
}

function filterExamples(examples = [], source) {
  return partition(Array.isArray(examples) ? examples : [], source);
}

/**
 * Remove every asset that could reveal the final translation of the given
 * holdout source from the benchmark retrieval inputs. Returns filtered copies
 * and an isolation report for auditing; inputs are never mutated.
 */
export function isolateBenchmarkAssets({ source, memories = [], qaCases = [], styleProfile = null, userProfile = null, referenceChunks = [] } = {}) {
  const memoryPartition = partition(memories, source);
  const qaCasePartition = partition(qaCases, source);
  const styleExamples = filterExamples(styleProfile?.examples, source);
  const userExamples = filterExamples(userProfile?.examples, source);
  // 参考资料里也可能写着同一句的终稿（例如把旧译稿当资料上传），必须同样剔除。
  const referencePartition = partition(referenceChunks, source);

  const isolatedStyleProfile = styleProfile && styleExamples.removed.length
    ? { ...styleProfile, examples: styleExamples.kept }
    : styleProfile;
  const isolatedUserProfile = userProfile && userExamples.removed.length
    ? { ...userProfile, examples: userExamples.kept }
    : userProfile;

  const excludedMemories = memoryPartition.removed.length;
  const excludedQaCases = qaCasePartition.removed.length;
  const excludedStyleExamples = styleExamples.removed.length;
  const excludedUserProfileExamples = userExamples.removed.length;

  return {
    memories: memoryPartition.kept,
    qaCases: qaCasePartition.kept,
    referenceChunks: referencePartition.kept,
    styleProfile: isolatedStyleProfile,
    userProfile: isolatedUserProfile,
    isolation: {
      excludedMemories,
      excludedQaCases,
      excludedStyleExamples,
      excludedUserProfileExamples,
      excludedReferenceChunks: referencePartition.removed.length,
      totalExcluded: excludedMemories + excludedQaCases + excludedStyleExamples + excludedUserProfileExamples + referencePartition.removed.length
    }
  };
}
