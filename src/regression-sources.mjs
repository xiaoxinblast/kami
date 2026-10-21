/**
 * 回归案例的来源派生。
 *
 * 这套工作流的主线是：Kami 出机器稿 → 外部（memoQ 等）人工审校 → 回填双语文件。
 * 回填时"人工把机器稿改成了什么"就是最真实的历史失败证据，不需要有人在
 * 工作台里再点一遍 QA 复核。本模块只做纯函数派生：给定轨迹与批次段落，
 * 产出可以直接进回归集的案例，调用方负责存储与版本管理。
 */

import { normalizeSource } from "./text.mjs";
import { createHash } from "node:crypto";
import { normalizedEditDistance } from "./learning-engine.mjs";
import { normalizeRegressionCandidate, regressionSourceKey } from "./gold-regression.mjs";

export const EXTERNAL_REVIEW_CASE_KIND = "external_review";

function text(value) {
  return String(value ?? "").trim();
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * 机器稿基准：新数据直接取 humanDecision.machineTranslation；旧数据（该字段
 * 尚未落库时回填的批次）回退到批次段落里记的 previousTranslation。
 */
function machineDraftFor(trajectory, segmentsByBatch) {
  const decision = trajectory?.humanDecision || {};
  const stored = text(decision.machineTranslation);
  if (stored) return { machine: stored, from: "humanDecision" };
  const segments = segmentsByBatch?.get?.(text(trajectory?.batchId)) || segmentsByBatch?.[text(trajectory?.batchId)] || [];
  const segmentId = text(trajectory?.segmentId);
  const segment = (Array.isArray(segments) ? segments : []).find((item) => text(item?.id) === segmentId);
  const previous = text(segment?.result?.humanReview?.previousTranslation);
  return previous ? { machine: previous, from: "batchSegment" } : { machine: "", from: "" };
}

function externalReviewCase(trajectory, machineDraft, editDistance, { scope, now, machineDraftSource = "humanDecision" }) {
  const decision = trajectory.humanDecision || {};
  const segmentId = text(trajectory.segmentId) || text(trajectory.id);
  return normalizeRegressionCandidate({
    id: `regression-external:${text(trajectory.batchId)}:${segmentId}`,
    status: "approved",
    sourceKind: EXTERNAL_REVIEW_CASE_KIND,
    sourceRef: {
      trajectoryId: text(trajectory.id),
      batchId: text(trajectory.batchId),
      segmentId,
      sourceFile: text(decision.sourceFile || trajectory.assetRefs?.sourceFile),
      sourceRow: finiteNumber(decision.sourceRow)
    },
    scope,
    source: text(trajectory.source),
    failingTranslation: machineDraft,
    expectedTranslation: text(decision.finalTranslation || trajectory.finalTranslation),
    editDistance,
    issues: [{
      dimension: "external_review",
      category: "external_review_edit",
      severity: editDistance >= 0.5 ? "major" : "minor",
      message: `外部审校改动（归一化编辑距离 ${editDistance.toFixed(2)}）`,
      suggestion: "人工终稿已采纳，候选不得原样复现机器稿"
    }],
    requiredTerms: [],
    facts: [],
    createdAt: text(decision.decidedAt) || now,
    createdBy: "external-review-import",
    approval: {
      decision: "approve",
      reviewer: "",
      decidedAt: text(decision.decidedAt) || now,
      note: "外部审校回填自动并入"
    },
    metadata: {
      machineDraftSource,
      matchMethod: text(decision.matchMethod)
    }
  });
}

/**
 * 从审校回填过的轨迹派生回归案例。
 *
 * 只收"人工确实改动了机器稿"且改动幅度达到阈值的条目：小于阈值的多半是
 * 标点或措辞润色，把它们当成一票否决的历史失败会让门禁永远过不了。
 *
 * @param {object} input
 * @param {Array} input.trajectories 已按作用域过滤的学习轨迹
 * @param {Map|object} input.batchSegments 批次 ID → 段落数组，用于回退机器稿
 * @param {object} input.scope 目标作用域
 * @param {number} input.minEditDistance 归一化编辑距离阈值
 */
export function deriveExternalReviewCases({ trajectories = [], batchSegments = new Map(), scope, minEditDistance = 0.2, now = "" } = {}) {
  const threshold = Number.isFinite(Number(minEditDistance)) ? Number(minEditDistance) : 0.2;
  const stats = { scanned: 0, accepted: 0, changed: 0, belowThreshold: 0, missingMachineDraft: 0, missingFinal: 0, included: 0 };
  const cases = [];
  for (const trajectory of Array.isArray(trajectories) ? trajectories : []) {
    stats.scanned += 1;
    const decision = trajectory?.humanDecision || {};
    if (decision.accepted !== true || trajectory?.status !== "completed") continue;
    stats.accepted += 1;
    const final = text(decision.finalTranslation || trajectory?.finalTranslation);
    if (!final) {
      stats.missingFinal += 1;
      continue;
    }
    const { machine, from } = machineDraftFor(trajectory, batchSegments);
    if (!machine) {
      stats.missingMachineDraft += 1;
      continue;
    }
    if (normalizeSource(machine) === normalizeSource(final)) continue;
    stats.changed += 1;
    const stored = finiteNumber(decision.editDistance);
    const editDistance = stored === null ? Number(normalizedEditDistance(machine, final).toFixed(4)) : Number(stored.toFixed(4));
    if (editDistance < threshold) {
      stats.belowThreshold += 1;
      continue;
    }
    cases.push(externalReviewCase(trajectory, machine, editDistance, { scope, now, machineDraftSource: from }));
    stats.included += 1;
  }
  return { cases, stats };
}

function sortKey(candidate) {
  const distance = Number.isFinite(Number(candidate?.editDistance)) ? Number(candidate.editDistance) : -1;
  // 改动越大越可能代表真错，门禁按这个顺序截取；同分用 id 保证顺序稳定。
  return [-distance, text(candidate?.id)];
}

/**
 * 合并两个来源：外部审校派生的案例与人工批准过的 QA 候选。
 * 同一来源键只保留一条案例，顺序稳定，调用方据此生成回归集版本。
 */
export function mergeRegressionSources({ externalCases = [], qaCandidates = [] } = {}) {
  const byKey = new Map();
  let duplicates = 0;
  for (const candidate of [...externalCases, ...qaCandidates]) {
    const key = text(candidate?.sourceKey) || regressionSourceKey(candidate);
    if (byKey.has(key)) {
      duplicates += 1;
      continue;
    }
    byKey.set(key, candidate);
  }
  const cases = [...byKey.values()].sort((left, right) => {
    const [leftDistance, leftId] = sortKey(left);
    const [rightDistance, rightId] = sortKey(right);
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    return leftId.localeCompare(rightId);
  });
  return {
    cases,
    stats: {
      external: externalCases.length,
      qa: qaCandidates.length,
      total: cases.length,
      duplicates
    }
  };
}

/**
 * 回归集内容指纹：来源键 + 两端译文，顺序无关。重建回归集时先比它，
 * 内容没变就复用现版本——否则每跑一次回填都会堆出一个一模一样的新版本。
 */
export function regressionCaseSetDigest(cases = []) {
  const rows = (Array.isArray(cases) ? cases : []).map((item) => [
    String(item?.sourceKey || item?.id || ""),
    String(item?.failingTranslation || ""),
    String(item?.expectedTranslation || "")
  ]);
  rows.sort((left, right) => left[0].localeCompare(right[0]));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
