import { COMMITMENT_PATTERN, assessTranslationRisk } from "./translation-routing.mjs";

/**
 * 质量档：把"生成路线"这种实现细节换成一个用户只需要理解一次的成本/质量旋钮。
 *
 * 逐段判定。判定只依赖可核对的内容信号（长度、事实锚点、必须原样保留的标记、
 * 承诺与法务措辞、术语冲突），不再依赖"这段是什么语体"这种猜出来的结论——
 * 语体只作为其中一路输入。
 */
export const QUALITY_TIERS = Object.freeze({
  fast: {
    label: "快速",
    description: "单次直译 + 确定性检查，不跑模型质检。适合短标签、按钮、道具名这类低风险短句。"
  },
  standard: {
    label: "标准",
    description: "初译 + 模型质检，最多一轮修订。默认档。"
  },
  strict: {
    label: "严苛",
    description: "多候选或强事实约束初译 + 模型质检 + 最多两轮修订，事实锚点硬校验。"
  }
});

export const QUALITY_TIER_VALUES = Object.freeze(["auto", ...Object.keys(QUALITY_TIERS)]);

/** 旧版六条生成路线 → 质量档。历史批次与旧前端仍会传 route，必须继续认。 */
export const LEGACY_ROUTE_TO_TIER = Object.freeze({
  direct: "fast",
  reflective: "standard",
  fact_guarded: "strict",
  transcreation: "strict",
  multi_candidate: "strict",
  mt_post_edit: "strict"
});

export function normalizeQualityTier(value) {
  const tier = String(value || "").trim().toLowerCase();
  if (tier === "auto") return "auto";
  return Object.hasOwn(QUALITY_TIERS, tier) ? tier : "";
}

/** 显式质量档优先；否则认旧路线参数，让老前端与历史请求继续可用。 */
export function resolveManualTier({ qualityTier = "", route = "" } = {}) {
  const explicit = normalizeQualityTier(qualityTier);
  if (explicit) return explicit;
  const legacy = LEGACY_ROUTE_TO_TIER[String(route || "").trim().toLowerCase()];
  return legacy || "auto";
}

export { COMMITMENT_PATTERN };

const CREATIVE_PURPOSES = new Set(["marketing", "social"]);
const FACTUAL_PURPOSES = new Set(["rules", "announcement"]);
const FACT_PURPOSES = FACTUAL_PURPOSES;

/** 事实锚点、时间或数字：公告与规则只有带上它们才需要抬到严苛档。 */
const FACT_LIKE_PATTERN = /\d|月|日|時|分|円|％|%|ポイント|pt\b/iu;

const FAST_MAX_CHARS = 80;
const STRICT_MIN_CHARS = 350;

/**
 * 逐段信号。返回的每一项都要能在界面上原样解释给用户，禁止黑箱打分。
 */
export function assessSegmentSignals({ source = "", purpose = "general", factCount = 0, protectedTokens = [], termConflicts = 0, metadata = [] } = {}) {
  const text = String(source || "");
  const length = [...text].length;
  const constraintMetadata = (Array.isArray(metadata) ? metadata : [])
    .some((item) => item?.role === "constraint" && String(item?.value || "").trim());
  return {
    length,
    purpose,
    factCount: Number(factCount) || 0,
    protectedTokenCount: Array.isArray(protectedTokens) ? protectedTokens.length : 0,
    termConflicts: Number(termConflicts) || 0,
    commitment: COMMITMENT_PATTERN.test(text),
    factualPurpose: FACT_PURPOSES.has(purpose) && FACT_LIKE_PATTERN.test(text),
    constraintMetadata
  };
}

/**
 * 自动判档。规则是显式表，改一条就要改一处，避免"分数加起来刚好越线"的玄学。
 * 只向上升级：调用方拿到档位后只允许把它抬高，不允许悄悄降下来。
 */
export function selectQualityTier({ source = "", purpose = "general", risk = null, factCount = 0, protectedTokens = [], termConflicts = 0, metadata = [], manualTier = "auto" } = {}) {
  const manual = normalizeQualityTier(manualTier);
  const signals = assessSegmentSignals({ source, purpose, factCount, protectedTokens, termConflicts, metadata });
  const resolvedRisk = risk || assessTranslationRisk({
    source,
    contentType: purpose,
    facts: { count: signals.factCount },
    metadata,
    protectedTokens
  });
  if (manual && manual !== "auto") {
    return { tier: manual, reason: "手动指定", signals, risk: resolvedRisk, manual: true };
  }
  const strictReasons = [];
  if (signals.factCount >= 2) strictReasons.push(`识别到 ${signals.factCount} 个事实锚点`);
  if (signals.commitment) strictReasons.push("含承诺或法务措辞");
  if (signals.length > STRICT_MIN_CHARS) strictReasons.push(`原文 ${signals.length} 字，信息密度高`);
  if (signals.termConflicts >= 2) strictReasons.push(`${signals.termConflicts} 个术语存在多种登记译法`);
  if (signals.factualPurpose) strictReasons.push("公告或规则类内容带数字与时间");
  if (strictReasons.length) {
    return { tier: "strict", reason: strictReasons.join("；"), signals, risk: resolvedRisk, manual: false };
  }
  const fastEligible = signals.length > 0 && signals.length <= FAST_MAX_CHARS
    && !signals.factCount
    && !signals.commitment
    && !signals.constraintMetadata
    && !CREATIVE_PURPOSES.has(purpose)
    && !FACTUAL_PURPOSES.has(purpose)
    && purpose !== "store";
  if (fastEligible) {
    return { tier: "fast", reason: `短文本（${signals.length} 字）且未发现事实或承诺风险`, signals, risk: resolvedRisk, manual: false };
  }
  return { tier: "standard", reason: "常规句段，走标准流程", signals, risk: resolvedRisk, manual: false };
}

/**
 * 质量档 → 执行计划。返回的 route 仍是 provider.translateWithRoute 认识的形状，
 * 所以执行层不需要为档位再写一套分支。
 */
export function planQualityTier({ tier = "standard", purpose = "general", provider = {}, risk = null } = {}) {
  const resolved = Object.hasOwn(QUALITY_TIERS, tier) ? tier : "standard";
  const mainModel = String(provider.model || "").trim();
  const fastModel = String(provider.fastModel || "").trim();
  const qualityModel = String(provider.qualityModel || "").trim();
  const mtModel = String(provider.mtModel || "").trim();
  const creative = CREATIVE_PURPOSES.has(purpose);
  if (resolved === "fast") {
    return {
      tier: resolved,
      tierLabel: QUALITY_TIERS.fast.label,
      route: "direct",
      candidateCount: 1,
      modelRole: fastModel ? "fast" : "main",
      model: fastModel || mainModel,
      modelFallback: !fastModel,
      reflect: false,
      modelQa: false,
      maxRevisions: 0,
      upgradeTier: "standard"
    };
  }
  if (resolved === "strict") {
    // 配了 MT 底模才有"机器初译 + 后编辑"；其余走创译多候选或事实保护，
    // 两者都由后续的模型质检与修订闭环收口。
    const route = mtModel ? "mt_post_edit" : (creative ? "transcreation" : "fact_guarded");
    return {
      tier: resolved,
      tierLabel: QUALITY_TIERS.strict.label,
      route,
      candidateCount: route === "transcreation" ? 3 : 1,
      modelRole: qualityModel ? "quality" : "main",
      model: qualityModel || mainModel,
      modelFallback: !qualityModel,
      reflect: route !== "transcreation",
      modelQa: true,
      maxRevisions: 2,
      upgradeTier: ""
    };
  }
  return {
    tier: "standard",
    tierLabel: QUALITY_TIERS.standard.label,
    route: "reflective",
    candidateCount: 1,
    modelRole: "main",
    model: mainModel,
    reflect: false,
    modelQa: true,
    maxRevisions: 1,
    upgradeTier: "strict"
  };
}

/** 界面上说明"严苛档现在到底强在哪"：没配高质量模型时必须说实话。 */
export function describeTierStrength({ tier, provider = {} } = {}) {
  if (tier !== "strict") return "";
  const qualityModel = String(provider.qualityModel || "").trim();
  return qualityModel
    ? `严苛档使用高质量模型「${qualityModel}」并执行多轮修订。`
    : "严苛档＝当前模型满强度 + 多候选 + 多轮修订（未启用更强模型）。";
}
