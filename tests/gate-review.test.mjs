import test from "node:test";
import assert from "node:assert/strict";
import { chunkGateFailures, gateFailureCases, mergeGateReviewReports, normalizeGateReviewReport, termInputsFromReview } from "../src/gate-review.mjs";

/**
 * 门禁失败复盘：把复发案例聚成模式、给出可执行建议，并区分"术语类"（转术语候选）
 * 与"体例类"（生成新候选技能）。这里锁住取数口径与模型输出的净化规则。
 */
const run = {
  report: {
    regression: {
      cases: [
        { id: "reg-1", passed: false, source: "崩兆の片", translation: "崩兆碎片", expectedTranslation: "崩兆之隅", issues: [{ message: "复现了已被人工拒绝的译文" }] },
        { id: "reg-2", passed: true, source: "星葬の玉座", translation: "星葬王座", expectedTranslation: "星葬王座", issues: [] }
      ]
    },
    gold: {
      samples: [{ id: "gold-1", passed: false, source: "PRIVACY & DATA", translation: "隐私与数据", referenceTargets: ["PRIVACY & DATA"], issues: [{ message: "强制术语未命中" }] }]
    }
  }
};

test("只取失败的样本，回归与 Gold 分开标注", () => {
  const cases = gateFailureCases(run);
  assert.deepEqual(cases.map((item) => item.caseId), ["reg-1", "gold-1"]);
  assert.equal(cases[0].kind, "regression");
  assert.equal(cases[0].expectedTranslation, "崩兆之隅");
  assert.equal(cases[1].kind, "gold");
  assert.equal(cases[1].expectedTranslation, "PRIVACY & DATA");
  assert.match(cases[0].reason, /复现了已被人工拒绝的译文/u);
});

test("失败案例按每块 30 条分块送模型", () => {
  const cases = Array.from({ length: 65 }, (_, index) => ({ caseId: `c-${index}`, source: `s-${index}` }));
  const chunks = chunkGateFailures(cases);
  assert.deepEqual(chunks.map((chunk) => chunk.cases.length), [30, 30, 5]);
  assert.deepEqual(chunks.map((chunk) => chunk.index), [0, 1, 2]);
});

test("模型输出按白名单净化，未知类型归 other、字段截断、重复标签合并", () => {
  const raw = {
    summary: "13 条复发集中在两套命名体例上",
    patterns: [
      {
        id: "p1", label: "〜の片 应译作 〜之隅", kind: "convention", caseIds: ["reg-1", "reg-1"],
        reason: "候选沿用了直译", suggestion: "按已定稿命名体例改写", proposedRule: "〜の片 统一译作 〜之隅",
        termSuggestions: [{ source: "崩兆の片", target: "崩兆之隅", preserveSource: false }]
      },
      { id: "p2", label: "〜の片 应译作 〜之隅", kind: "convention", caseIds: ["reg-2"] },
      { id: "p3", label: "保留原文的专名", kind: "没见过的类型", caseIds: ["gold-1"], termSuggestions: [{ source: "PRIVACY & DATA", target: "PRIVACY & DATA", preserveSource: true }] },
      { label: "" }
    ]
  };
  const report = normalizeGateReviewReport(raw);
  assert.equal(report.patterns.length, 2, "空标签丢弃，其它字段归位");
  assert.equal(report.patterns[1].kind, "other");
  assert.deepEqual(report.patterns[0].caseIds, ["reg-1"]);
  assert.equal(report.patterns[0].termSuggestions[0].target, "崩兆之隅");
});

test("分块报告合并：同标签并成一条、案例 id 取并集、id 重新编号", () => {
  const merged = mergeGateReviewReports([
    { summary: "第一块", patterns: [{ label: "A", kind: "convention", caseIds: ["c1"] }] },
    { summary: "第二块", patterns: [{ label: "A", kind: "convention", caseIds: ["c2"], termSuggestions: [] }, { label: "B", kind: "terminology", caseIds: ["c3"] }] }
  ]);
  assert.equal(merged.patterns.length, 2);
  assert.deepEqual(merged.patterns[0].caseIds, ["c1", "c2"]);
  assert.equal(merged.patterns[0].id, "pattern-1");
  assert.equal(merged.patterns[1].id, "pattern-2");
  assert.equal(merged.summary, "第一块");
});

test("复盘里的术语建议必须能在人工终稿里找到依据，否则只算待审", () => {
  const cases = gateFailureCases(run);
  const inputs = termInputsFromReview({
    patterns: [
      { label: "保留原文的专名", kind: "terminology", caseIds: ["gold-1"], termSuggestions: [{ source: "PRIVACY & DATA", target: "PRIVACY & DATA", preserveSource: true }] },
      { label: "凭空猜的术语", kind: "terminology", caseIds: ["reg-1"], termSuggestions: [{ source: "崩兆の片", target: "崩兆碎片" }] }
    ]
  }, cases);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].verbatim, true, "终稿就是原文，preserveSource 建议可自动入库");
  assert.equal(inputs[0].target, "PRIVACY & DATA");
  assert.equal(inputs[1].verbatim, false, "终稿里是「崩兆之隅」，模型的旧建议不能自动入库");
  assert.equal(inputs[1].humanFinal, "崩兆之隅");
});
