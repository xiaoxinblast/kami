import test from "node:test";
import assert from "node:assert/strict";
import { deriveExternalReviewCases, mergeRegressionSources, regressionCaseSetDigest } from "../src/regression-sources.mjs";

const SCOPE = { locale: "zh-CN", contentType: "general", domain: "game", project: "p-1" };

/**
 * 外部审校回填是这套工作流的主证据源：人工在 memoQ 里把机器稿改成了什么，
 * 就是"候选不允许再犯"的名单。这些用例锁住入集口径与机器稿回退路径。
 */
function trajectory(overrides = {}) {
  return {
    id: "t-1",
    status: "completed",
    locale: "zh-CN",
    contentType: "general",
    domain: "game",
    project: "p-1",
    batchId: "batch-1",
    segmentId: "seg-1",
    source: "浄璃の架",
    initialTranslation: "净璃架",
    finalTranslation: "净璃之架",
    humanDecision: {
      accepted: true,
      machineTranslation: "净璃架",
      finalTranslation: "净璃之架",
      editDistance: 0.4,
      sourceFile: "Asia_batch18_new.xlsx_zho-CN.mqxliff",
      sourceRow: 71
    },
    ...overrides
  };
}

test("编辑距离达到阈值的审校改动才入回归集，边界值算入", () => {
  const atThreshold = trajectory({ id: "t-at", humanDecision: { ...trajectory().humanDecision, editDistance: 0.2 } });
  const below = trajectory({ id: "t-below", humanDecision: { ...trajectory().humanDecision, editDistance: 0.199 } });
  const derived = deriveExternalReviewCases({
    trajectories: [atThreshold, below],
    scope: SCOPE,
    minEditDistance: 0.2,
    now: "2026-09-26T00:00:00.000Z"
  });
  assert.equal(derived.cases.length, 1, "0.2 入集、0.199 不入集");
  assert.equal(derived.cases[0].sourceRef.trajectoryId, "t-at");
  assert.equal(derived.stats.belowThreshold, 1);
  assert.equal(derived.stats.included, 1);
  assert.equal(derived.cases[0].editDistance, 0.2);
});

test("未被人工改动或未采纳的轨迹不进回归集", () => {
  const untouched = trajectory({
    id: "t-same",
    humanDecision: { ...trajectory().humanDecision, machineTranslation: "净璃之架", finalTranslation: "净璃之架", editDistance: 0 }
  });
  const notAccepted = trajectory({ id: "t-open", humanDecision: { accepted: false, finalTranslation: "净璃之架" } });
  const derived = deriveExternalReviewCases({ trajectories: [untouched, notAccepted], scope: SCOPE, minEditDistance: 0.2 });
  assert.equal(derived.cases.length, 0);
  assert.equal(derived.stats.accepted, 1, "未采纳的轨迹不算人工结论");
  assert.equal(derived.stats.changed, 0, "没改动过机器稿的轨迹不是历史失败");
});

test("旧轨迹缺少 machineTranslation 时回退到批次段落的 previousTranslation", () => {
  const legacy = trajectory({
    id: "t-legacy",
    humanDecision: { accepted: true, finalTranslation: "净璃之架", editDistance: 0.4, sourceFile: "review.xlsx", sourceRow: 12 }
  });
  const batchSegments = new Map([["batch-1", [{
    id: "seg-1",
    source: "浄璃の架",
    translation: "净璃之架",
    result: { humanReview: { previousTranslation: "净璃架" } }
  }]]]);
  const derived = deriveExternalReviewCases({ trajectories: [legacy], batchSegments, scope: SCOPE, minEditDistance: 0.2 });
  assert.equal(derived.cases.length, 1);
  assert.equal(derived.cases[0].failingTranslation, "净璃架", "机器稿要取回填前的译文");
  assert.equal(derived.cases[0].expectedTranslation, "净璃之架");
  assert.equal(derived.cases[0].metadata.machineDraftSource, "batchSegment");
});

test("既无机器稿记录也无批次段落时只计数上报，不凭空造案例", () => {
  const orphan = trajectory({
    id: "t-orphan",
    batchId: "batch-gone",
    humanDecision: { accepted: true, finalTranslation: "净璃之架", editDistance: 0.4 }
  });
  const derived = deriveExternalReviewCases({ trajectories: [orphan], scope: SCOPE, minEditDistance: 0.2 });
  assert.equal(derived.cases.length, 0);
  assert.equal(derived.stats.missingMachineDraft, 1);
});

test("没有存过编辑距离时按机器稿与人工终稿现算", () => {
  const noDistance = trajectory({
    id: "t-compute",
    humanDecision: { accepted: true, machineTranslation: "净璃架", finalTranslation: "完全不同的另一句译文" }
  });
  const derived = deriveExternalReviewCases({ trajectories: [noDistance], scope: SCOPE, minEditDistance: 0.2 });
  assert.equal(derived.cases.length, 1);
  assert.ok(derived.cases[0].editDistance >= 0.2);
});

test("合并两个来源：按来源键去重、改动最大的排在前面", () => {
  const external = deriveExternalReviewCases({
    trajectories: [
      trajectory({ id: "t-small", segmentId: "seg-small", humanDecision: { ...trajectory().humanDecision, editDistance: 0.3 } }),
      trajectory({ id: "t-big", segmentId: "seg-big", humanDecision: { ...trajectory().humanDecision, editDistance: 0.9 } })
    ],
    scope: SCOPE,
    minEditDistance: 0.2
  }).cases;
  const qaCandidate = {
    id: "regression-candidate:qa-1",
    status: "approved",
    sourceKind: "qa_case",
    sourceQaCaseId: "qa-1",
    scope: SCOPE,
    source: "行こう。",
    failingTranslation: "走吧",
    expectedTranslation: "走吧。",
    editDistance: null,
    approval: { decision: "approve" }
  };
  const merged = mergeRegressionSources({ externalCases: [...external, external[0]], qaCandidates: [qaCandidate] });
  assert.equal(merged.cases.length, 3, "重复来源键只保留一条");
  assert.equal(merged.stats.duplicates, 1);
  assert.deepEqual(merged.cases.map((item) => item.id), [
    "regression-external:batch-1:seg-big",
    "regression-external:batch-1:seg-small",
    "regression-candidate:qa-1"
  ]);
  assert.equal(merged.cases[0].sourceKind, "external_review");
  assert.equal(merged.cases.at(-1).sourceKind, "qa_case");
});

test("回归集指纹与顺序无关：内容没变就不该重建新版本", () => {
  const first = { sourceKey: "external:b:1", failingTranslation: "净璃架", expectedTranslation: "净璃之架" };
  const second = { sourceKey: "external:b:2", failingTranslation: "陨石射击", expectedTranslation: "陨石乱击" };
  assert.equal(regressionCaseSetDigest([first, second]), regressionCaseSetDigest([second, first]));
  assert.notEqual(
    regressionCaseSetDigest([first, second]),
    regressionCaseSetDigest([first, { ...second, expectedTranslation: "陨石连击" }]),
    "终稿改了就必须出新版本"
  );
});
