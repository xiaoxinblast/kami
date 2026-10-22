import test from "node:test";
import assert from "node:assert/strict";
import { deterministicConsistencyFindings } from "../src/consistency-check.mjs";
import {
  applyDeterministicReplacement,
  pickMajority,
  planConsistencyRepairs,
  resolveFindingTargets,
  summarizeSourceGroups
} from "../src/consistency-repair.mjs";

/** 复刻真实批次：同一句原文在一批里出现两种写法。 */
function repeated(segments) {
  return summarizeSourceGroups(segments);
}

test("裁决优先级：术语库 > 主 TM 人工条 > 参考 TM 人工条", () => {
  const segments = [
    { id: "seg-1", source: "無効", translation: "禁用" },
    { id: "seg-2", source: "無効", translation: "关闭" }
  ];
  const finding = { type: "term_drift", ids: ["seg-1", "seg-2"], detail: "同一术语两种译法", unify: [] };
  const viaTerm = resolveFindingTargets(finding, {
    segments,
    groups: repeated(segments),
    termTargetsFor: () => [{ source: "無効", target: "关闭" }],
    tmEntriesFor: () => [{ source: "無効", target: "禁用", qualityStatus: "human_approved", libraryRole: "master" }]
  });
  assert.equal(viaTerm.targets[0].target, "关闭", "术语库登记译法优先于 TM");
  assert.equal(viaTerm.targets[0].evidence.kind, "term");

  const viaMaster = resolveFindingTargets(finding, {
    segments,
    groups: repeated(segments),
    termTargetsFor: () => [],
    tmEntriesFor: () => [
      { source: "無効", target: "关闭", qualityStatus: "human_approved", libraryRole: "reference" },
      { source: "無効", target: "禁用", qualityStatus: "human_approved", libraryRole: "master" }
    ]
  });
  assert.equal(viaMaster.targets[0].target, "禁用");
  assert.equal(viaMaster.targets[0].evidence.kind, "tm_master");

  const viaReference = resolveFindingTargets(finding, {
    segments,
    groups: repeated(segments),
    termTargetsFor: () => [],
    tmEntriesFor: () => [{ source: "無効", target: "关闭", qualityStatus: "human_approved", libraryRole: "reference" }]
  });
  assert.equal(viaReference.targets[0].target, "关闭");
  assert.equal(viaReference.targets[0].evidence.kind, "tm_reference");
});

test("工作 TM 的机器条不算权威，只有文件内多数（≥2:1）能定案", () => {
  const segments = [
    { id: "seg-1", source: "無効", translation: "禁用" },
    { id: "seg-2", source: "無効", translation: "禁用" },
    { id: "seg-3", source: "無効", translation: "关闭" }
  ];
  const groups = repeated(segments);
  const finding = { type: "duplicate_source", ids: ["seg-1", "seg-2", "seg-3"], detail: "", unify: [] };
  const resolved = resolveFindingTargets(finding, {
    segments,
    groups,
    termTargetsFor: () => [],
    tmEntriesFor: () => [{ source: "無効", target: "关闭", qualityStatus: "machine_verified", libraryRole: "working" }]
  });
  assert.equal(resolved.targets[0].target, "禁用");
  assert.equal(resolved.targets[0].evidence.kind, "file_majority");

  const tie = resolveFindingTargets(finding, {
    segments: [
      { id: "seg-1", source: "無効", translation: "禁用" },
      { id: "seg-2", source: "無効", translation: "关闭" }
    ],
    groups: repeated([
      { id: "seg-1", source: "無効", translation: "禁用" },
      { id: "seg-2", source: "無効", translation: "关闭" }
    ]),
    termTargetsFor: () => [],
    tmEntriesFor: () => []
  });
  assert.equal(tie.targets.length, 0, "1:1 平局不能自动定案");
  assert.match(tie.unresolved[0].reason, /依据不足/u);
});

test("配对方案：一条拿到权威译法时，同组另一条按配对写法一起统一", () => {
  const segments = [
    { id: "seg-12", source: "有効", translation: "启用" },
    { id: "seg-18", source: "有効", translation: "启用" },
    { id: "seg-30", source: "有効", translation: "开启" },
    { id: "seg-36", source: "有効", translation: "开启" },
    { id: "seg-14", source: "無効", translation: "禁用" },
    { id: "seg-20", source: "無効", translation: "禁用" },
    { id: "seg-32", source: "無効", translation: "关闭" },
    { id: "seg-38", source: "無効", translation: "关闭" }
  ];
  const finding = {
    type: "term_drift",
    ids: segments.map((segment) => segment.id),
    detail: "同一组 UI 选项两种写法",
    terms: [
      { source: "有効", variants: ["启用", "开启"] },
      { source: "無効", variants: ["禁用", "关闭"] }
    ],
    // 模型自己给的是另一套写法，权威 TM 说無効=禁用，服务端要翻转配对。
    unify: [{ source: "有効", target: "开启" }, { source: "無効", target: "关闭" }]
  };
  const { targets } = resolveFindingTargets(finding, {
    segments,
    groups: repeated(segments),
    termTargetsFor: () => [],
    tmEntriesFor: (source) => (source === "無効"
      ? [{ source: "無効", target: "禁用", qualityStatus: "human_approved", libraryRole: "master" }]
      : [])
  });
  const bySource = new Map(targets.map((target) => [target.source, target]));
  assert.equal(bySource.get("無効").target, "禁用");
  assert.equal(bySource.get("無効").evidence.kind, "tm_master");
  assert.equal(bySource.get("有効").target, "启用", "与权威值同方案的配对写法");
  assert.equal(bySource.get("有効").evidence.kind, "paired_scheme");
  assert.equal(bySource.get("有効").overrodeModel, true, "覆盖了模型给的开启");
});

test("修复计划：术语登记译法未采用只报告，同原文不同译文按依据改", () => {
  const segments = [
    { id: "seg-1", source: "無効", translation: "禁用" },
    { id: "seg-2", source: "無効", translation: "禁用" },
    { id: "seg-3", source: "無効", translation: "关闭" }
  ];
  const findings = deterministicConsistencyFindings(segments);
  const duplicate = findings.find((finding) => finding.type === "duplicate_source");
  const plan = planConsistencyRepairs({ findings: [duplicate], segments, maxSegments: 20 });
  assert.equal(plan.blocked, null);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].target, "禁用");
  assert.equal(plan.actions[0].evidence.kind, "file_majority");
  assert.deepEqual(plan.actions[0].changes.map((change) => change.segmentId), ["seg-3"]);
  assert.equal(plan.actions[0].changes[0].after, "禁用");

  const gap = { type: "term_usage_gap", source: "rule", ids: ["seg-1", "seg-3"], detail: "登记译法未采用", evidence: [] };
  const reportOnly = planConsistencyRepairs({ findings: [gap], segments, maxSegments: 20 });
  assert.equal(reportOnly.actions.length, 0);
  assert.match(reportOnly.skipped[0].reason, /语境/u);
});

test("修复计划：人工回填过就整批只报告，超出上限的部分不改", () => {
  const segments = [
    { id: "seg-1", source: "無効", translation: "禁用", accepted: true },
    { id: "seg-2", source: "無効", translation: "关闭" }
  ];
  const finding = { type: "duplicate_source", source: "rule", ids: ["seg-1", "seg-2"], detail: "", unify: [] };
  const blocked = planConsistencyRepairs({ findings: [finding], segments, maxSegments: 20, hasHumanReview: true });
  assert.match(blocked.blocked.reason, /人工回填/u);
  assert.equal(blocked.actions.length, 0);

  const many = [
    { id: "seg-1", source: "無効", translation: "禁用" },
    { id: "seg-2", source: "無効", translation: "禁用" },
    { id: "seg-3", source: "無効", translation: "关闭" },
    { id: "seg-4", source: "無効", translation: "取消" }
  ];
  const capped = planConsistencyRepairs({
    findings: [{ type: "duplicate_source", source: "rule", ids: many.map((segment) => segment.id), detail: "", unify: [] }],
    segments: many,
    maxSegments: 1
  });
  assert.equal(capped.changedSegmentIds.length, 1);
  assert.equal(capped.actions[0].skippedIds.length, 1);
  assert.match(capped.actions[0].skippedIds[0].reason, /上限/u);
});

test("确定性替换：保护标记、数字或长度被破坏时不改，交给定向修订", () => {
  assert.deepEqual(
    applyDeterministicReplacement({ translation: "开启", from: "开启", to: "启用" }),
    { ok: true, value: "启用" }
  );
  // 保护标记（URL）在替换里被改掉：不能自动改。
  assert.equal(applyDeterministicReplacement({
    translation: "https://example.com 开启",
    from: "https://example.com",
    to: "example.com",
    protectedTokens: ["https://example.com"]
  }).ok, false);
  // 数字被改动：不能自动改。
  assert.equal(applyDeterministicReplacement({ translation: "3 秒后开启", from: "开启", to: "启用3" }).ok, false);
  // 替换后长度暴涨：不能自动改。
  assert.equal(applyDeterministicReplacement({ translation: "开启", from: "开启", to: "启".repeat(40) }).ok, false);
  // 译文里根本没有这个写法：交给定向修订。
  assert.match(applyDeterministicReplacement({ translation: "关闭", from: "开启", to: "启用" }).reason, /没找到/u);
});

test("短语级漂移：术语库登记译法覆盖模型建议，只改不统一的那些段落", () => {
  const segments = [
    { id: "seg-10", source: "MAIレポートの通知演出を省略し、ナビマップのアイコン追加演出を省略します。", translation: "省略通知演出与导览地图的图标添加演出" },
    { id: "seg-11", source: "ナビゲーションマップ、共通チュートリアルスキップなどを設定します。", translation: "设定导航地图、跳过通用教程等内容。" }
  ];
  const finding = {
    type: "term_drift",
    ids: ["seg-10", "seg-11"],
    detail: "同一个功能两种译法",
    terms: [{ source: "ナビマップ", variants: ["导览地图", "导航地图"] }],
    // 模型建议的是与术语库冲突的那个写法，服务端必须按登记译法覆盖它。
    unify: [{ source: "ナビマップ", target: "导航地图" }]
  };
  const plan = planConsistencyRepairs({
    findings: [finding],
    segments,
    termTargetsFor: (source) => (source === "ナビマップ" ? [{ source: "ナビマップ", target: "导览地图" }] : []),
    tmEntriesFor: () => []
  });
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].target, "导览地图");
  assert.equal(plan.actions[0].evidence.kind, "term");
  assert.equal(plan.actions[0].overrodeModel, true);
  assert.deepEqual(plan.actions[0].changes.map((change) => change.segmentId), ["seg-11"]);
  assert.equal(plan.actions[0].changes[0].after, "设定导览地图、跳过通用教程等内容。");
});

test("文件内多数：2:1 成立，3:2 与 1:1 不成立", () => {
  assert.equal(pickMajority([{ target: "禁用", count: 2 }, { target: "关闭", count: 1 }]).target, "禁用");
  assert.equal(pickMajority([{ target: "禁用", count: 3 }, { target: "关闭", count: 2 }]), null);
  assert.equal(pickMajority([{ target: "禁用", count: 1 }, { target: "关闭", count: 1 }]), null);
});

test("术语只是在整句里命中时，不能把半句目标译法当成整句译文塞进去", () => {
  const segments = [
    { id: "seg-1", source: "プレミアムパスを買う", translation: "购买高级通行证" },
    { id: "seg-2", source: "プレミアムパスを買う", translation: "购买高级月卡" }
  ];
  const finding = {
    type: "duplicate_source",
    ids: ["seg-1", "seg-2"],
    detail: "同一句两种译法",
    terms: [{ source: "プレミアムパスを買う", variants: ["购买高级通行证", "购买高级月卡"] }],
    unify: []
  };
  const plan = planConsistencyRepairs({
    findings: [finding],
    segments,
    termTargetsFor: () => [{ source: "プレミアムパス", target: "高级通行证" }],
    tmEntriesFor: () => []
  });
  assert.equal(plan.actions.length, 0, "不能把整句换成半句术语译法");
  assert.match(plan.skipped[0].reason, /依据不足/u);
});

test("pattern_drift 带固定说法时按文件多数统一固定部分", () => {
  const segments = [
    { id: "seg-1", source: "プレミアムパスを買うと3個の宝箱", translation: "购买高级通行证可获得 3 个宝箱", status: "done" },
    { id: "seg-2", source: "プレミアムパスを買うと10個の宝箱", translation: "购买高级通行证可获得 10 个宝箱", status: "done" },
    { id: "seg-3", source: "プレミアムパスを買うと5個の宝箱", translation: "买高级通行证能拿到 5 个宝箱", status: "done" }
  ];
  const groups = repeated(segments);
  const finding = {
    type: "pattern_drift", ids: ["seg-1", "seg-2", "seg-3"], detail: "同句式固定说法不一致",
    terms: [{ source: "购买高级通行证可获得", variants: ["购买高级通行证可获得", "买高级通行证能拿到"] }],
    unify: [], evidence: []
  };
  const resolved = resolveFindingTargets(finding, { segments, groups, termTargetsFor: () => [], tmEntriesFor: () => [] });
  assert.equal(resolved.targets[0].target, "购买高级通行证可获得");
  assert.equal(resolved.targets[0].evidence.kind, "file_majority");
  const plan = planConsistencyRepairs({
    findings: [finding], segments,
    groups,
    termTargetsFor: () => [],
    tmEntriesFor: () => []
  });
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].changes[0].segmentId, "seg-3");
  assert.equal(plan.actions[0].changes[0].after, "购买高级通行证可获得 5 个宝箱");
});
