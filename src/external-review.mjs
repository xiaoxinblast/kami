import { normalizeSource } from "./text.mjs";
import { normalizedEditDistance } from "./learning-engine.mjs";

function text(value) {
  return String(value || "").trim();
}

function same(left, right) {
  return Boolean(text(left) && text(right) && normalizeSource(left) === normalizeSource(right));
}

function candidateIdentity(candidate = {}) {
  return {
    entryId: text(candidate.entryId),
    sheet: text(candidate.sheet || candidate.context?.sheet),
    row: Number(candidate.sourceRow || candidate.rowNumber || candidate.context?.row) || 0,
    previousSource: text(candidate.previousSource),
    nextSource: text(candidate.nextSource)
  };
}

function trajectoryIdentity(trajectory = {}) {
  const refs = trajectory.assetRefs && typeof trajectory.assetRefs === "object" ? trajectory.assetRefs : {};
  const neighbor = trajectory.contextPack?.neighborContext || {};
  return {
    entryId: text(refs.entryId),
    sheet: text(refs.sheet || neighbor.sheet),
    row: Number(refs.sourceRow || neighbor.row) || 0,
    previousSource: text(refs.previousSource || neighbor.previous),
    nextSource: text(refs.nextSource || neighbor.next)
  };
}

function identityScore(candidate, trajectory) {
  const left = candidateIdentity(candidate);
  const right = trajectoryIdentity(trajectory);
  if (left.entryId && right.entryId && left.entryId !== right.entryId) return -1;
  let score = 0;
  const reasons = [];
  if (left.entryId && left.entryId === right.entryId) {
    score += 1000;
    reasons.push("entry_id");
  }
  if (left.sheet && right.sheet && left.sheet === right.sheet && left.row && left.row === right.row) {
    score += 300;
    reasons.push("sheet_row");
  } else if (left.row && left.row === right.row) {
    score += 80;
    reasons.push("row");
  }
  if (same(left.previousSource, right.previousSource)) {
    score += 60;
    reasons.push("previous");
  }
  if (same(left.nextSource, right.nextSource)) {
    score += 60;
    reasons.push("next");
  }
  return { score, method: reasons.join("+") || "source_only" };
}

/**
 * 将外部人工审校后的双语条目接回工作台原轨迹。
 *
 * 源文只负责建立候选集合；重复源文必须再由条目 ID、行号或上下文唯一消歧。
 * 返回值只给出确定链接，调用方不得把 ambiguous 当作可接受的自动匹配。
 */
export function linkExternalReviewTrajectories(candidates = [], trajectories = []) {
  const sourceGroups = new Map();
  for (const [index, candidate] of (Array.isArray(candidates) ? candidates : []).entries()) {
    const sourceKey = normalizeSource(candidate?.source);
    if (!sourceKey || !text(candidate?.target)) continue;
    const group = sourceGroups.get(sourceKey) || { candidates: [], trajectories: [] };
    group.candidates.push({ index, candidate });
    sourceGroups.set(sourceKey, group);
  }
  for (const trajectory of Array.isArray(trajectories) ? trajectories : []) {
    const sourceKey = normalizeSource(trajectory?.source);
    if (!sourceKey || !sourceGroups.has(sourceKey) || !text(trajectory?.initialTranslation) || !["completed", "review"].includes(trajectory?.status)) continue;
    sourceGroups.get(sourceKey).trajectories.push(trajectory);
  }

  const links = [];
  const unmatched = [];
  const ambiguous = [];
  const alreadyAccepted = [];
  for (const group of sourceGroups.values()) {
    if (!group.trajectories.length) {
      unmatched.push(...group.candidates.map(({ index }) => index));
      continue;
    }
    if (group.candidates.length === 1 && group.trajectories.length === 1) {
      const [{ index }] = group.candidates;
      const [trajectory] = group.trajectories;
      if (trajectory.humanDecision?.accepted === true) alreadyAccepted.push(index);
      else links.push({ candidateIndex: index, trajectory, method: "unique_source", score: 1 });
      continue;
    }

    const proposals = [];
    for (const { index, candidate } of group.candidates) {
      const ranked = group.trajectories.map((trajectory) => ({ trajectory, ...identityScore(candidate, trajectory) }))
        .filter((item) => item.score >= 0)
        .sort((left, right) => right.score - left.score);
      if (!ranked.length || ranked[0].score <= 0 || ranked[1]?.score === ranked[0].score) {
        ambiguous.push(index);
        continue;
      }
      proposals.push({ candidateIndex: index, ...ranked[0] });
    }
    proposals.sort((left, right) => right.score - left.score);
    const claimed = new Set();
    for (const proposal of proposals) {
      if (claimed.has(proposal.trajectory.id)) {
        ambiguous.push(proposal.candidateIndex);
        continue;
      }
      claimed.add(proposal.trajectory.id);
      if (proposal.trajectory.humanDecision?.accepted === true) alreadyAccepted.push(proposal.candidateIndex);
      else links.push(proposal);
    }
  }
  return {
    links,
    unmatched: [...new Set(unmatched)],
    ambiguous: [...new Set(ambiguous)],
    alreadyAccepted: [...new Set(alreadyAccepted)]
  };
}

export function externalReviewTrajectoryPatch({ trajectory, target, sourceFile = "", sourceRow = null, matchMethod = "" } = {}) {
  const finalTranslation = text(target);
  const machineTranslation = text(trajectory?.finalTranslation || trajectory?.initialTranslation);
  if (!trajectory?.id || !finalTranslation || !machineTranslation) throw new Error("外部审校轨迹缺少机器稿或人工终稿");
  const decidedAt = new Date().toISOString();
  const humanDecision = {
    accepted: true,
    finalTranslation,
    editDistance: normalizedEditDistance(machineTranslation, finalTranslation),
    decidedAt,
    source: "external-review-import",
    sourceFile: text(sourceFile),
    sourceRow: Number(sourceRow) || null,
    matchMethod: text(matchMethod)
  };
  return {
    finalTranslation,
    humanDecision,
    status: "completed",
    events: [...(Array.isArray(trajectory.events) ? trajectory.events : []), {
      type: "external_human_review_imported",
      at: decidedAt,
      sourceFile: humanDecision.sourceFile,
      sourceRow: humanDecision.sourceRow,
      editDistance: humanDecision.editDistance,
      matchMethod: humanDecision.matchMethod
    }]
  };
}
