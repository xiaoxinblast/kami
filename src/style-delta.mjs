/**
 * Style evidence shaping for distillation.
 *
 * The distiller used to receive bare `{source, target}` pairs, which throws
 * away the single most information-dense signal the workbench produces: when a
 * human replaces machine draft A with translation B, the DIFFERENCE between A
 * and B is the style preference. Seeing only B, the model cannot tell whether
 * the human changed the register, the length, the honorifics or nothing at all.
 *
 * Evidence therefore carries two extra facts:
 *   - `machineTranslation` — the draft the human replaced (empty when none)
 *   - `polarity` — "positive" (this is how it should read) or "negative"
 *     (this was rejected; there is no approved rewrite yet)
 *
 * Pure module: no store, provider or clock dependency.
 */

/** Evidence with no approved translation of its own is a counter-example only. */
export const NEGATIVE = "negative";
export const POSITIVE = "positive";

function clean(value) {
  return String(value ?? "").trim();
}

export function isNegativeEvidence(item = {}) {
  return clean(item.polarity) === NEGATIVE;
}

/**
 * How a positive piece of evidence came to be:
 *   revised   — a human rewrote the machine draft; the diff carries the style
 *   confirmed — a human accepted the machine draft unchanged
 *   imported  — a pre-existing bilingual pair with no machine draft to compare
 */
export function classifyChange(item = {}) {
  const machine = clean(item.machineTranslation);
  const target = clean(item.target);
  if (!machine) return "imported";
  return machine === target ? "confirmed" : "revised";
}

/**
 * Rank positives by how much style signal they carry. A rewrite teaches more
 * than a silent approval, which teaches more than an imported pair nobody in
 * this project ever reviewed.
 */
const CHANGE_RANK = Object.freeze({ revised: 0, confirmed: 1, imported: 2 });

function rank(item) {
  const change = classifyChange(item);
  const humanFirst = item.provenance === "human-accept" ? 0 : 1;
  return CHANGE_RANK[change] * 2 + humanFirst;
}

/**
 * Split evidence into the two lists the distillation prompt needs, dropping
 * records too empty to teach anything. Positives are ordered so that rewrites
 * survive the sample cap; negatives keep the reviewer's stated reason.
 */
/**
 * 项目级蒸馏的分层取样。
 *
 * 证据池是项目级的（8134 条成就与系统说明、67 条对白……），直接按优先级取前 50 条
 * 会让最大的那一类吃掉全部名额，"对白要口语、公告要书面"这类规则永远学不到。
 * 这里先按语体分组轮转，单语体上限 = max(3, ceil(正例上限 / 4))；轮转没填满的名额
 * 再按组序回流给最大的组，保证总量仍然用满。
 *
 * 组内顺序沿用调用方给的顺序（人工采纳与改写证据排在前面），反例原样返回，
 * 由 shapeDistillEvidence 统一限量。
 */
export function stratifyEvidence(evidence = [], { positiveLimit = 30, perTypeCap = null } = {}) {
  const list = Array.isArray(evidence) ? evidence : [];
  const limit = Math.max(0, Math.trunc(Number(positiveLimit)) || 0);
  if (!limit) return list;
  const cap = Math.max(3, Math.trunc(Number(perTypeCap)) || Math.ceil(limit / 4));
  const groups = new Map();
  const negatives = [];
  for (const item of list) {
    if (!item) continue;
    if (isNegativeEvidence(item)) {
      negatives.push(item);
      continue;
    }
    const type = clean(item.contentType) || "general";
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(item);
  }
  const ordered = [...groups.values()].sort((a, b) => b.length - a.length);
  const picked = [];
  const used = new Array(ordered.length).fill(0);
  let progressed = true;
  while (picked.length < limit && progressed) {
    progressed = false;
    for (let index = 0; index < ordered.length && picked.length < limit; index += 1) {
      if (used[index] >= cap || used[index] >= ordered[index].length) continue;
      picked.push(ordered[index][used[index]]);
      used[index] += 1;
      progressed = true;
    }
  }
  // 语体种类少时轮转会被单语体上限卡住，把剩下的名额按组序回流，避免只取到一半。
  for (let index = 0; index < ordered.length && picked.length < limit; index += 1) {
    while (used[index] < ordered[index].length && picked.length < limit) {
      picked.push(ordered[index][used[index]]);
      used[index] += 1;
    }
  }
  return [...picked, ...negatives];
}

export function shapeDistillEvidence(evidence = [], { positiveLimit = 30, negativeLimit = 10 } = {}) {
  const list = Array.isArray(evidence) ? evidence : [];
  const positives = [];
  const negatives = [];
  for (const item of list) {
    if (!item || !clean(item.source)) continue;
    if (isNegativeEvidence(item)) {
      const rejected = clean(item.target) || clean(item.machineTranslation);
      if (rejected) negatives.push({ source: clean(item.source), rejected, reason: clean(item.note) });
      continue;
    }
    const target = clean(item.target);
    if (!target) continue;
    positives.push(item);
  }
  const shaped = positives
    .slice()
    .sort((left, right) => rank(left) - rank(right))
    .slice(0, Math.max(0, positiveLimit))
    .map((item) => {
      const change = classifyChange(item);
      return change === "revised"
        ? { source: clean(item.source), target: clean(item.target), machineDraft: clean(item.machineTranslation), change }
        : { source: clean(item.source), target: clean(item.target), change };
    });
  return {
    examples: shaped,
    counterExamples: negatives.slice(0, Math.max(0, negativeLimit)),
    counts: {
      revised: shaped.filter((item) => item.change === "revised").length,
      confirmed: shaped.filter((item) => item.change === "confirmed").length,
      imported: shaped.filter((item) => item.change === "imported").length,
      negative: negatives.length
    }
  };
}

/**
 * Evidence usable as "this is good target-language writing". Callers that feed
 * examples straight to a model (translator profile, Auto QA nuance layer) must
 * go through this — a counter-example presented as a model answer teaches the
 * exact thing a human rejected.
 */
export function positiveEvidenceOnly(evidence = []) {
  return (Array.isArray(evidence) ? evidence : []).filter((item) => item && !isNegativeEvidence(item) && clean(item.target));
}
