import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGateQueue,
  decideReleaseGate,
  evaluateGoldRun,
  evaluateGoldSample,
  evaluateRegressionCase,
  evaluateRegressionRun,
  gateRefreshDecision,
  gateRunCoversAssets,
  selectGateCases,
  selectGateTargetSkill,
  resolveGateAssets
} from "../src/quality-gate.mjs";

const SCOPE = { locale: "ja-JP", contentType: "announcement", domain: "game", project: "default" };

function goldSample(overrides = {}) {
  return {
    id: "gold-1",
    source: "8月20日にPlayStation Storeで30%オフ。",
    referenceTargets: ["8月20日にPlayStation Storeで30%オフ。"],
    requiredTerms: [{ source: "PlayStation Store", target: "PlayStation Store", acceptedTargets: [], caseSensitive: false, preserveSource: true }],
    forbiddenTranslations: ["プレステ"],
    protectedTokens: ["{count}"],
    facts: [{ id: "fact-1", type: "date", sourceValue: "8月20日", expectedValue: "8月20日", comparison: "semantic_exact", critical: true }],
    ...overrides
  };
}

test("Gold 样本按术语、事实、禁用译法和占位符硬判定", () => {
  const clean = evaluateGoldSample(goldSample(), { translation: "8月20日にPlayStation Storeで{count}本が30%オフ。" });
  assert.equal(clean.passed, true);
  assert.equal(clean.requiredTerms[0].correct, true);
  assert.equal(clean.factChecks[0].correct, true);

  const broken = evaluateGoldSample(goldSample(), { translation: "8月21日にプレステで割引。" });
  assert.equal(broken.passed, false);
  const categories = broken.issues.map((issue) => issue.category).sort();
  assert.deepEqual(categories, ["date", "forbidden", "placeholder", "terminology"]);
});

test("参考译文只作为相似度信号，不构成等值要求", () => {
  const paraphrased = evaluateGoldSample(goldSample({ forbiddenTranslations: [], protectedTokens: [] }), {
    translation: "PlayStation Storeでは8月20日から30％の割引を実施します。"
  });
  assert.equal(paraphrased.passed, true);
  assert.equal(paraphrased.exactMatch, false);
  assert.ok(paraphrased.similarity > 0 && paraphrased.similarity < 1);
});

test("空译文按严重漏译处理", () => {
  const empty = evaluateGoldSample(goldSample(), { translation: "   " });
  assert.equal(empty.passed, false);
  assert.equal(empty.issues[0].category, "omission");
});

const REGRESSION_CASE = {
  id: "regression-1",
  sourceQaCaseId: "qa-1",
  source: "本イベントは日本地域限定です。",
  failingTranslation: "이 이벤트는 전 지역에서 진행됩니다.",
  expectedTranslation: "본 이벤트는 일본 지역 한정입니다.",
  requiredTerms: [],
  facts: [{ id: "fact-1", type: "region", sourceValue: "日本", expectedValue: "일본", comparison: "semantic_exact", critical: true }]
};

test("回归案例只在复现已拒绝译文或丢失事实时判失败", () => {
  const fixed = evaluateRegressionCase(REGRESSION_CASE, { translation: "본 이벤트는 일본 지역 한정입니다." });
  assert.equal(fixed.passed, true);
  assert.equal(fixed.matchesExpected, true);

  const regressed = evaluateRegressionCase(REGRESSION_CASE, { translation: "이 이벤트는 전 지역에서 진행됩니다." });
  assert.equal(regressed.passed, false);
  assert.equal(regressed.issues[0].category, "regression");

  const rephrased = evaluateRegressionCase(REGRESSION_CASE, { translation: "본 이벤트는 일본에서만 진행됩니다." });
  assert.equal(rephrased.passed, true, "换一种说法但事实正确应当通过");

  const factLost = evaluateRegressionCase(REGRESSION_CASE, { translation: "본 이벤트는 한정 진행됩니다." });
  assert.equal(factLost.passed, false);
  assert.equal(factLost.issues[0].category, "region");
});

test("未执行的回归案例计入总数但不计入通过", () => {
  const run = evaluateRegressionRun({
    cases: [REGRESSION_CASE, { ...REGRESSION_CASE, id: "regression-2" }],
    results: [{ id: "regression-1", translation: "본 이벤트는 일본 지역 한정입니다." }]
  });
  assert.equal(run.total, 2);
  assert.equal(run.evaluated, 1);
  assert.equal(run.passed, 1);
  assert.deepEqual(run.missing, ["regression-2"]);
  assert.equal(run.passRate, 0.5);
});

test("回归失败一票否决，缺回归集时不算通过", () => {
  const failing = evaluateRegressionRun({
    cases: [REGRESSION_CASE],
    results: [{ id: "regression-1", translation: "이 이벤트는 전 지역에서 진행됩니다." }]
  });
  const blocked = decideReleaseGate({ regression: failing, gold: null });
  assert.equal(blocked.decision, "block");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.blocking.some((item) => item.code === "regression_failed"));

  const noAssets = decideReleaseGate({ regression: null, gold: null });
  assert.equal(noAssets.allowed, false);
  assert.ok(noAssets.blocking.some((item) => item.code === "regression_missing"));
});

test("回归全绿且 Gold 达标时放行，缺 Gold 只警告", () => {
  const regression = evaluateRegressionRun({
    cases: [REGRESSION_CASE],
    results: [{ id: "regression-1", translation: "본 이벤트는 일본 지역 한정입니다." }]
  });
  const gold = evaluateGoldRun({
    samples: [goldSample()],
    results: [{ id: "gold-1", translation: "8月20日にPlayStation Storeで{count}本が30%オフ。" }]
  });
  assert.equal(gold.termAccuracy, 1);
  assert.equal(gold.factAccuracy, 1);
  assert.equal(gold.metrics.terminologyAccuracy, 1);

  const passed = decideReleaseGate({ regression, gold });
  assert.equal(passed.decision, "pass");
  assert.equal(passed.allowed, true);
  assert.ok(passed.warnings.some((item) => item.code === "gold_too_small"));

  const withoutGold = decideReleaseGate({ regression, gold: null });
  assert.equal(withoutGold.allowed, true);
  assert.ok(withoutGold.warnings.some((item) => item.code === "gold_missing"));

  const strict = decideReleaseGate({ regression, gold: null, thresholds: { allowMissingGold: false } });
  assert.equal(strict.allowed, false);
});

test("Gold 术语或事实退化会阻断发版", () => {
  const gold = evaluateGoldRun({
    samples: [goldSample(), goldSample({ id: "gold-2" })],
    results: [
      { id: "gold-1", translation: "8月20日にPlayStation Storeで{count}本が30%オフ。" },
      { id: "gold-2", translation: "8月21日にストアで{count}本が割引。" }
    ]
  });
  assert.equal(gold.passed, 1);
  assert.equal(gold.failed, 1);
  const regression = evaluateRegressionRun({
    cases: [REGRESSION_CASE],
    results: [{ id: "regression-1", translation: "본 이벤트는 일본 지역 한정입니다." }]
  });
  const decision = decideReleaseGate({ regression, gold });
  assert.equal(decision.allowed, false);
  assert.ok(decision.blocking.some((item) => item.code === "gold_terminology"));
  assert.ok(decision.blocking.some((item) => item.code === "gold_facts"));
});

test("门禁资产解析只取当前作用域启用的最新版本，并带出版本指纹", () => {
  const goldSets = [
    { id: "gold-v1", seriesId: "gold", version: 1, scope: SCOPE, name: "发布 Gold", status: "active", enabled: true, samples: [goldSample()] },
    { id: "gold-v2", seriesId: "gold", version: 2, scope: SCOPE, name: "发布 Gold", status: "active", enabled: true, samples: [goldSample({ id: "gold-9" })] },
    { id: "gold-other", seriesId: "other", version: 1, scope: { ...SCOPE, locale: "ko-KR" }, name: "别的语言", status: "active", enabled: true, samples: [goldSample()] }
  ];
  const resolved = resolveGateAssets({ goldSets, regressionSuites: [], scope: SCOPE });
  assert.equal(resolved.samples.length, 1);
  assert.equal(resolved.samples[0].id, "gold-9");
  assert.deepEqual(resolved.goldSetVersions, ["gold@v2"]);
  assert.ok(resolved.samples[0].goldSetFingerprint);
});

test("回归案例按改动幅度封顶，改动最大的先跑", () => {
  const cases = Array.from({ length: 60 }, (_, index) => ({
    ...REGRESSION_CASE,
    id: `regression-${String(index).padStart(2, "0")}`,
    editDistance: index / 100
  }));
  const capped = selectGateCases(cases, 50);
  assert.equal(capped.length, 50);
  assert.equal(capped[0].id, "regression-59", "改动最大的排在最前");
  assert.equal(capped.at(-1).id, "regression-10", "只截掉改动最小的那批");
  assert.equal(selectGateCases(cases, 0).length, 60, "0 表示不限");
});

test("门禁结论必须覆盖当前资产版本，资产出新版本后旧 pass 作废", () => {
  const assets = { goldSetVersions: ["gold@v1"], regressionSuiteVersions: ["regression:reg#v2"] };
  const run = { decision: "pass", assetVersions: { goldSets: ["gold@v1"], regressionSuites: ["regression:reg#v2"] } };
  assert.equal(gateRunCoversAssets(run, assets), true);
  assert.equal(gateRunCoversAssets({ ...run, assetVersions: { ...run.assetVersions, regressionSuites: ["regression:reg#v1"] } }, assets), false);
  assert.equal(gateRunCoversAssets({ ...run, assetVersions: { ...run.assetVersions, goldSets: ["gold@v2"] } }, assets), false);
  assert.equal(gateRunCoversAssets({ decision: "pass", assetVersions: {} }, assets), false, "没有资产记录的旧运行不算覆盖");
});

test("自动门禁只针对最新候选，并在结论仍覆盖资产或已有任务在跑时跳过", () => {
  const skills = [
    { id: "champion-1", status: "champion", version: 7 },
    { id: "draft-1", status: "draft", version: 2 },
    { id: "challenger-1", status: "challenger", version: 3 }
  ];
  assert.equal(selectGateTargetSkill(skills).id, "challenger-1", "候选优先于草稿，版本高的优先");
  assert.equal(selectGateTargetSkill([{ id: "champion-1", status: "champion", version: 7 }]), null, "没有候选时不拿生效版本空跑");

  const assets = { samples: [{ id: "gold-1" }], cases: [{ id: "reg-1" }], goldSetVersions: ["gold@v1"], regressionSuiteVersions: ["regression:r#v2"] };
  const covered = { decision: "pass", assetVersions: { goldSets: ["gold@v1"], regressionSuites: ["regression:r#v2"] } };
  const stale = { decision: "pass", assetVersions: { goldSets: ["gold@v1"], regressionSuites: ["regression:r#v1"] } };

  assert.equal(gateRefreshDecision({ skills, assets, latestRun: null }).run, true);
  assert.equal(gateRefreshDecision({ skills, assets, latestRun: stale }).run, true, "资产更新后必须重跑");
  assert.equal(gateRefreshDecision({ skills, assets, latestRun: covered }).reason, "already_covered");
  assert.equal(gateRefreshDecision({ skills, assets, inFlight: true }).reason, "already_running");
  assert.equal(gateRefreshDecision({ enabled: false, skills, assets }).reason, "auto_gate_disabled");
  assert.equal(gateRefreshDecision({ skills: [{ id: "champion-1", status: "champion", version: 3 }], assets }).reason, "no_candidate");
  assert.equal(gateRefreshDecision({ skills, assets: { samples: [], cases: [] } }).reason, "no_assets");
});

test("样本一条都没跑成时说清是执行被中断，而不是拿 0% 通过率当质量结论", () => {
  const neverRan = evaluateRegressionRun({
    cases: [REGRESSION_CASE, { ...REGRESSION_CASE, id: "regression-2" }],
    results: []
  });
  const blocked = decideReleaseGate({ regression: neverRan, gold: null });
  assert.equal(blocked.allowed, false);
  const messages = blocked.blocking.map((item) => item.message);
  assert.ok(messages.some((message) => /一条都没执行（本次执行多半被中断）/u.test(message)), messages.join(" | "));
  assert.equal(blocked.blocking.some((item) => item.code === "regression_failed"), false, "没跑完时不该给出通过率结论");

  const goldNeverRan = evaluateGoldRun({ samples: [goldSample(), goldSample({ id: "gold-2" })], results: [] });
  const goldGate = decideReleaseGate({ regression: null, gold: goldNeverRan });
  assert.ok(goldGate.blocking.some((item) => /Gold 样本 2 条一条都没执行/u.test(item.message)));
});

test("样本缺一半时只报未执行数量，不给自欺欺人的通过率", () => {
  const half = evaluateRegressionRun({
    cases: [REGRESSION_CASE, { ...REGRESSION_CASE, id: "regression-2" }],
    results: [{ id: "regression-1", translation: "본 이벤트는 일본 지역 한정입니다." }]
  });
  const gate = decideReleaseGate({ regression: half, gold: null });
  const incomplete = gate.blocking.find((item) => item.code === "regression_incomplete");
  assert.match(incomplete.message, /有 1 个回归案例未执行（共 2 条，已执行 1 条）/u);
  assert.equal(gate.blocking.some((item) => item.code === "regression_failed"), false);
});

test("待测清单按原文去重：一条原文只翻一次，但要过 Gold 与回归两套规则", () => {
  const shared = { id: "gold-1", source: "浄璃の架", referenceTargets: ["净璃之架"] };
  const onlyGold = { id: "gold-2", source: "星葬の玉座", referenceTargets: ["星葬王座"] };
  const sharedCase = { id: "reg-1", source: "浄璃の架", failingTranslation: "净璃架", expectedTranslation: "净璃之架" };
  const sameSourceTwice = { id: "reg-2", source: "浄璃の架", failingTranslation: "净璃之架", expectedTranslation: "净璃架" };
  const queue = buildGateQueue({ samples: [shared, onlyGold], cases: [sharedCase, sameSourceTwice] });
  assert.equal(queue.length, 2, "两条唯一原文 → 两次执行（原来是 4 条样本/案例）");
  const merged = queue.find((entry) => entry.key === "浄璃の架");
  assert.equal(merged.gold.length, 1);
  assert.equal(merged.regression.length, 2, "回归集内部同句也合并到同一次执行");
  assert.equal(queue.find((entry) => entry.source === "星葬の玉座").gold.length, 1);

  const raw = buildGateQueue({ samples: [shared, onlyGold], cases: [sharedCase, sameSourceTwice], dedupe: false });
  assert.equal(raw.length, 4, "关掉去重回到逐条执行");
  assert.equal(raw[0].key, "gold:gold-1");
});
