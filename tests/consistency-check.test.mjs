import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQualityReport,
  deterministicConsistencyFindings,
  mergeConsistencyFindings,
  parseConsistencyFindings,
  splitConsistencyChunks
} from "../src/consistency-check.mjs";

test("一致性核对按字符数分片", () => {
  const pairs = [
    { id: "seg-1", source: "あ".repeat(60), translation: "啊".repeat(60) },
    { id: "seg-2", source: "い".repeat(60), translation: "咦".repeat(60) },
    { id: "seg-3", source: "う".repeat(60), translation: "呜".repeat(60) }
  ];
  const chunks = splitConsistencyChunks(pairs, { maxChars: 100 });
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((chunk) => chunk.ids), [["seg-1"], ["seg-2"], ["seg-3"]]);
  const single = splitConsistencyChunks(pairs, { maxChars: 10_000 });
  assert.deepEqual(single.map((chunk) => chunk.ids), [["seg-1", "seg-2", "seg-3"]]);
});

test("解析一致性发现：引用不存在的条目 id 整条丢弃", () => {
  const content = JSON.stringify({
    findings: [
      { type: "term_drift", ids: ["seg-1", "seg-2"], detail: "同一个词两种译法", suggestion: "统一" },
      { type: "voice_drift", ids: ["seg-1", "seg-9"], detail: "引用越界", suggestion: "" },
      { type: "不存在的类型", ids: ["seg-2", "seg-3"], detail: "类型回落", suggestion: "" }
    ]
  });
  const { findings, dropped } = parseConsistencyFindings(content, { validIds: ["seg-1", "seg-2", "seg-3"] });
  assert.equal(findings.length, 2);
  assert.equal(findings[0].type, "term_drift");
  assert.equal(findings[1].type, "term_drift", "未知类型按最保守的术语漂移处理");
  assert.equal(dropped.length, 1);
  assert.throws(() => parseConsistencyFindings("不是 JSON", { validIds: [] }), /未返回 JSON/u);
});

test("合并发现时按类型与说明去重", () => {
  const merged = mergeConsistencyFindings([
    { findings: [{ type: "term_drift", ids: ["seg-1", "seg-2"], detail: "A" }] },
    { findings: [{ type: "term_drift", ids: ["seg-1", "seg-2"], detail: "A" }, { type: "name_drift", ids: ["seg-3", "seg-4"], detail: "B" }] }
  ]);
  assert.equal(merged.length, 2);
});

test("确定性发现：同原文不同译文与术语登记译法未采用", () => {
  const term = { mode: "exact", expectedTarget: "高级通行证", term: { source: "プレミアムパス", target: "高级通行证" } };
  const findings = deterministicConsistencyFindings([
    { id: "seg-1", source: "プレミアムパスを買う", translation: "购买高级通行证", result: { matches: [term] } },
    { id: "seg-2", source: "プレミアムパスを買う", translation: "购买高级月卡", result: { matches: [term] } },
    { id: "seg-3", source: "別の文", translation: "另一句", result: { matches: [] } }
  ]);
  const types = findings.map((finding) => finding.type).sort();
  assert.deepEqual(types, ["duplicate_source", "term_usage_gap"]);
  const gap = findings.find((finding) => finding.type === "term_usage_gap");
  assert.match(gap.detail, /高级通行证/u);
  assert.equal(gap.source, "rule");
});

test("批次质量报告：档位分布、质检覆盖率、术语采用率与人工复核原因", () => {
  const report = buildQualityReport({
    batchId: "batch-1",
    filename: "sample.xlsx",
    locale: "zh-CN",
    provider: { model: "deepseek-flash" },
    styleProfile: { id: "style-1", name: "简体中文 general 风格", version: 3 },
    brief: { status: "ready", documentType: { purpose: "ui" }, sections: [1, 2], coverage: { covered: 2, total: 3, percent: 67 } },
    findings: [{ type: "term_drift" }],
    segments: [
      {
        id: "seg-1", source: "確認する", translation: "确认", status: "done",
        result: {
          qualityTier: "fast", segmentPurpose: "ui", matches: [{ expectedTarget: "确认", term: { target: "确认" } }],
          issues: []
        }
      },
      {
        id: "seg-2", source: "8月20日に終了します", translation: "将于8月20日结束", status: "done",
        result: {
          qualityTier: "strict", segmentPurpose: "announcement", qaScore: 86,
          qualityUpgradeFrom: "standard",
          matches: [{ expectedTarget: "结束", term: { target: "结束" } }],
          issues: [{ type: "fact_date", severity: "error" }, { severity: "warning", type: "basic_tone" }]
        }
      },
      { id: "seg-3", source: "読込", translation: "", status: "error", result: { qualityTier: "standard", segmentPurpose: "ui" } }
    ]
  });
  assert.deepEqual(report.tiers, { fast: 1, standard: 1, strict: 1, unknown: 0 });
  assert.equal(report.upgrades, 1);
  assert.equal(report.coverage.modelQa, 1, "只有跑过模型质检的段落计入覆盖率");
  assert.equal(report.coverage.percent, 50);
  assert.equal(report.terms.expectedUses, 2);
  assert.equal(report.terms.applied, 2);
  assert.equal(report.terms.adoptionRate, 100);
  assert.equal(report.facts.issueCount, 1);
  assert.equal(report.humanReview.suggested, 2);
  assert.ok(report.humanReview.reasons.some((item) => item.reason === "翻译失败"));
  assert.equal(report.consistency.byType[0].type, "term_drift");
  assert.equal(report.contextBrief.sections, 2);
  assert.equal(report.styleProfile.version, 3);
  assert.equal(report.purposes[0].purpose, "ui");
});

test("没有分数的快速档段落不计入平均分与质检覆盖率", () => {
  const report = buildQualityReport({
    segments: [
      { id: "seg-1", source: "設定", translation: "设置", status: "done", result: { qualityTier: "fast", qaScore: null, issues: [] } },
      { id: "seg-2", source: "確認", translation: "确认", status: "done", result: { qualityTier: "fast", issues: [] } },
      { id: "seg-3", source: "保存する", translation: "保存", status: "done", result: { qualityTier: "standard", qaScore: 96, issues: [] } }
    ]
  });
  assert.deepEqual(report.tiers, { fast: 2, standard: 1, strict: 0, unknown: 0 });
  assert.equal(report.coverage.modelQa, 1, "只有真跑过模型质检的段落才算覆盖率");
  assert.equal(report.coverage.percent, 33);
  assert.equal(report.scores.average, 96, "空分数不能被当成 0 分拉低平均");
  assert.equal(report.scores.distribution.unscored, 2);
  assert.equal(report.humanReview.suggested, 0, "快速档没有分数不等于待人工复核");
});

test("保护标记按原文重算，译文丢失即计入未保留", () => {
  const report = buildQualityReport({
    segments: [
      { id: "seg-1", source: "URLは https://example.com です", translation: "网址是 https://example.com", status: "done", result: { issues: [] } },
      { id: "seg-2", source: "URLは https://example.org です", translation: "网址在这里", status: "done", result: { issues: [] } }
    ]
  });
  assert.equal(report.protectedTokens.total, 2);
  assert.equal(report.protectedTokens.preserved, 1);
});
