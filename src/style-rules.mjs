/**
 * Rule-level accumulation for style profiles.
 *
 * Distillation used to rewrite the whole instruction from a rolling sample of
 * the newest evidence. That is not accumulation, it is a random walk: a rule
 * learned from evidence #10 silently disappears once the sample window rotates
 * past it, and feeding in more material produces a differently-worded profile
 * of the same size rather than a richer one. Measured on the real corpus, the
 * ja-JP dialogue scope had 481 evidence items yet produced instructions ranging
 * from 181 to 1466 characters depending purely on which 30 samples were drawn.
 *
 * Rules now have stable identity and cumulative support. Each distillation
 * returns OPERATIONS against the existing set — keep / update / add / retire —
 * instead of a fresh block of prose. Two consequences matter:
 *
 *   - A rule the model simply did not mention is NOT dropped. It ages: only
 *     after several consecutive unconfirmed rounds does it retire. This is what
 *     turns "more evidence" into "more rules" instead of "different rules".
 *   - Retiring is explicit and keeps the reason, so a rule never vanishes
 *     without a trace that can be reviewed.
 *
 * Pure module: no store, provider or clock dependency (the clock is injected).
 */

const OPERATIONS = new Set(["keep", "update", "add", "retire"]);
const MAX_RULES = 60;
const MAX_RULE_LENGTH = 300;
const MAX_CATEGORY_LENGTH = 40;

/** 连续多少轮没被证据确认才退休。设小了等于回到滚动重写，设大了过时规则赖着不走。 */
export const DEFAULT_STALE_ROUNDS = 4;

function clean(value, limit) {
  return String(value ?? "").replace(/[\x00-\x1f\x7f]/gu, "").trim().slice(0, limit);
}

/**
 * 提示词注入特征。风格规则同样是模型产出、又会原样渲染进生产提示词
 * （renderInstruction 会输出 category 与 rule 两部分），所以两者都要过这道检查。
 * 原先只有 Skill 的策略补丁做这件事；这里沿用同一套特征，避免两条入库路径宽严不一。
 */
const INJECTION_PATTERNS = Object.freeze([
  /(?:忽略|无视|忘记|废止|绕过)(?:以上|之前|先前)?\s*(?:所有|全部|下述|以下|一切)?\s*(?:的)?\s*(?:规则|指令|要求|约束|限制|提示)/iu,
  /ignore\s*(?:all\s*)?(?:previous|prior|above|the\s+above)?\s*instructions?/i,
  /disregard\s*(?:all\s*)?(?:previous|prior|above)?\s*instructions?/i,
  /you\s+are\s+now\s+(?:an?|the)\s+/i,
  /system\s*:/iu,
  /<\|im_start\|>|<\|im_end\|>/i,
  /输出(?:全部|所有)?(?:密钥|token|提示词|系统消息)/iu,
  /reveal\s+(?:your\s+)?(?:system\s+)?prompt/i
]);

export function hasInjectionSignature(text) {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(String(text ?? "")));
}

/** 稳定 id：同一条规则文本在不同轮次里应当拿到同一个 id，便于人工比对历史。 */
export function ruleId(category, rule) {
  const seed = `${clean(category, MAX_CATEGORY_LENGTH)}\x00${clean(rule, MAX_RULE_LENGTH)}`;
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `r-${(hash >>> 0).toString(36)}`;
}

function normalizeRule(input, { now, round }) {
  const category = clean(input?.category, MAX_CATEGORY_LENGTH) || "其他";
  const rule = clean(input?.rule ?? input?.text ?? input?.observation, MAX_RULE_LENGTH);
  if (!rule) return null;
  if (hasInjectionSignature(rule) || hasInjectionSignature(category)) return null;
  return {
    id: clean(input?.id, 40) || ruleId(category, rule),
    category,
    rule,
    evidenceCount: Math.max(0, Math.trunc(Number(input?.evidenceCount)) || 0),
    rounds: Math.max(1, Math.trunc(Number(input?.rounds)) || 1),
    firstSeen: clean(input?.firstSeen, 40) || now,
    lastConfirmed: clean(input?.lastConfirmed, 40) || now,
    lastRound: Math.max(0, Math.trunc(Number(input?.lastRound)) || round),
    status: input?.status === "retired" ? "retired" : "active",
    retiredReason: clean(input?.retiredReason, MAX_RULE_LENGTH)
  };
}

/** 读回历史规则，容忍缺字段与脏数据；不是数组时按"还没有规则"处理。 */
export function normalizeRules(rules, { now = "", round = 0 } = {}) {
  if (!Array.isArray(rules)) return [];
  const seen = new Set();
  const normalized = [];
  for (const item of rules) {
    const rule = normalizeRule(item, { now, round });
    if (!rule || seen.has(rule.id)) continue;
    seen.add(rule.id);
    normalized.push(rule);
  }
  return normalized;
}

/**
 * Apply one distillation's operations to the accumulated rule set.
 *
 * `evidenceCount` is how many evidence items this round was distilled from; it
 * is credited to every rule the round confirmed, so a long-standing rule ends
 * up carrying the weight of all the evidence that ever supported it.
 */
export function applyRulePatch(existingRules, operations, {
  round,
  now,
  evidenceCount = 0,
  staleRounds = DEFAULT_STALE_ROUNDS
} = {}) {
  const rules = new Map(normalizeRules(existingRules, { now, round }).map((rule) => [rule.id, { ...rule }]));
  const warnings = [];
  const confirmed = new Set();

  for (const operation of Array.isArray(operations) ? operations.slice(0, MAX_RULES * 2) : []) {
    const op = clean(operation?.op, 16);
    if (!OPERATIONS.has(op)) {
      warnings.push({ op: op || "(空)", reason: "未知操作，已丢弃" });
      continue;
    }
    if (op === "add") {
      if (hasInjectionSignature(operation?.rule ?? operation?.text ?? operation?.observation) || hasInjectionSignature(operation?.category)) {
        warnings.push({ op, reason: "规则含提示词注入特征，已丢弃" });
        continue;
      }
      const created = normalizeRule({ ...operation, evidenceCount, rounds: 1, firstSeen: now, lastConfirmed: now, lastRound: round }, { now, round });
      if (!created) { warnings.push({ op, reason: "规则内容为空，已丢弃" }); continue; }
      if (rules.has(created.id)) {
        // 模型把已有规则当成新规则提交：按确认处理，不制造重复。
        confirmed.add(created.id);
        const current = rules.get(created.id);
        current.rounds += 1;
        current.evidenceCount += evidenceCount;
        current.lastConfirmed = now;
        current.lastRound = round;
        current.status = "active";
        continue;
      }
      if (rules.size >= MAX_RULES) { warnings.push({ op, reason: `规则数量已达上限 ${MAX_RULES}，新规则被丢弃` }); continue; }
      rules.set(created.id, created);
      confirmed.add(created.id);
      continue;
    }

    const id = clean(operation?.id, 40);
    const target = rules.get(id);
    if (!target) { warnings.push({ op, id, reason: "规则 id 不存在，已丢弃" }); continue; }

    if (op === "retire") {
      target.status = "retired";
      target.retiredReason = clean(operation?.reason, MAX_RULE_LENGTH) || "本轮证据与该规则冲突";
      target.lastRound = round;
      continue;
    }
    if (op === "update") {
      const rule = clean(operation?.rule ?? operation?.text, MAX_RULE_LENGTH);
      if (!rule) { warnings.push({ op, id, reason: "更新内容为空，已丢弃" }); continue; }
      if (hasInjectionSignature(rule) || hasInjectionSignature(operation?.category)) {
        warnings.push({ op, id, reason: "更新内容含提示词注入特征，已丢弃" });
        continue;
      }
      target.rule = rule;
      if (operation?.category) target.category = clean(operation.category, MAX_CATEGORY_LENGTH);
    }
    target.rounds += 1;
    target.evidenceCount += evidenceCount;
    target.lastConfirmed = now;
    target.lastRound = round;
    target.status = "active";
    confirmed.add(id);
  }

  // 没被提到 ≠ 被否定：连续多轮无人确认才退休，这是"累积"与"滚动重写"的分界。
  const retiredByAge = [];
  for (const rule of rules.values()) {
    if (rule.status !== "active" || confirmed.has(rule.id)) continue;
    if (round - rule.lastRound >= staleRounds) {
      rule.status = "retired";
      rule.retiredReason = `连续 ${round - rule.lastRound} 轮蒸馏未再被证据确认`;
      retiredByAge.push(rule.id);
    }
  }

  const all = [...rules.values()];
  return {
    rules: all,
    active: all.filter((rule) => rule.status === "active"),
    confirmedIds: [...confirmed],
    retiredByAge,
    warnings
  };
}

/**
 * Retire one rule by id, outside the distillation cycle.
 *
 * The conflict scanner needs this: when two prompt rules contradict each other
 * and a human approves dropping the weaker one, waiting for four unconfirmed
 * distillation rounds would leave the contradiction in the prompt the whole
 * time. Returns null when there is nothing to do, so callers can tell "already
 * retired" apart from "retired just now".
 */
export function retireRule(rules, id, { reason = "", now = new Date().toISOString() } = {}) {
  const list = normalizeRules(rules);
  const target = list.find((rule) => rule.id === id);
  if (!target || target.status === "retired") return null;
  return list.map((rule) => (rule.id === id
    ? { ...rule, status: "retired", retiredReason: clean(reason, MAX_RULE_LENGTH) || "人工在规则冲突审查中退休", lastConfirmed: now }
    : rule));
}

/**
 * Render the active rules as the instruction text the translation prompt reads.
 * Legacy profiles that predate rule accumulation keep their prose until the
 * next distillation converts it.
 */
export function renderInstruction(rules, fallbackInstruction = "") {
  const active = normalizeRules(rules).filter((rule) => rule.status === "active");
  if (!active.length) return String(fallbackInstruction || "");
  const byCategory = new Map();
  for (const rule of active) {
    if (!byCategory.has(rule.category)) byCategory.set(rule.category, []);
    byCategory.get(rule.category).push(rule);
  }
  return [...byCategory.entries()]
    .map(([category, items]) => `【${category}】\n${items
      .sort((left, right) => right.evidenceCount - left.evidenceCount)
      .map((rule) => `· ${rule.rule}`)
      .join("\n")}`)
    .join("\n");
}

/** 规则集的可读统计，供界面与蒸馏记录展示。 */
export function summarizeRules(rules) {
  const all = normalizeRules(rules);
  const active = all.filter((rule) => rule.status === "active");
  return {
    total: all.length,
    active: active.length,
    retired: all.length - active.length,
    categories: [...new Set(active.map((rule) => rule.category))],
    strongest: active.slice().sort((left, right) => right.evidenceCount - left.evidenceCount).slice(0, 3)
      .map((rule) => ({ id: rule.id, category: rule.category, rule: rule.rule, evidenceCount: rule.evidenceCount, rounds: rule.rounds }))
  };
}
