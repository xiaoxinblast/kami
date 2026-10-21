import test from "node:test";
import assert from "node:assert/strict";
import { qualityRunBody } from "../src/directus-store.mjs";

/**
 * "没测出来"和"测出来是 0"是两件事。旧实现用 Number.isFinite(Number(value)) 判断，
 * 而 Number(null) === 0，于是 Gold 样本没有术语约束（指标不可测）会被写成 0.0%，
 * 界面上看起来就像术语全错。这里锁住可空字段的落库口径。
 */
test("门禁运行的可空指标 null 落库为 null，0 仍然是 0", () => {
  const body = qualityRunBody({
    locale: "zh-CN", contentType: "general", domain: "game", project: "p-1",
    skillId: "skill-1", skillVersion: "1", decision: "block",
    regressionTotal: 12, regressionPassed: 12, regressionPassRate: null,
    goldTotal: 40, goldTermAccuracy: null, goldFactAccuracy: null
  });
  assert.equal(body.gold_term_accuracy, null, "不可测的术语准确率不能写成 0");
  assert.equal(body.gold_fact_accuracy, null);
  assert.equal(body.regression_pass_rate, null);
  assert.equal(body.gold_total, 40);

  const measured = qualityRunBody({
    locale: "zh-CN", contentType: "general", domain: "game", project: "p-1",
    decision: "pass", regressionPassRate: 0, goldTermAccuracy: 0.975
  });
  assert.equal(measured.regression_pass_rate, 0, "真的 0% 不能被当成没数据");
  assert.equal(measured.gold_term_accuracy, 0.975);
  assert.equal(measured.gold_fact_accuracy, null);
});
