import test from "node:test";
import assert from "node:assert/strict";
import { externalReviewTrajectoryPatch, linkExternalReviewTrajectories, matchReviewPairsToSegments } from "../src/external-review.mjs";

function trajectory(id, source, overrides = {}) {
  return { id, source, initialTranslation: `机器稿-${id}`, status: "completed", ...overrides };
}

/** 审校回填把"审校后的文件"定位到批次段落：优先条目 ID，重复原文不猜。 */
test("审校回填按 memoQ 条目 ID 定位段落，重复原文也能对上", () => {
  const segments = [
    { source: "はい", translation: "是。", entryKey: "CARD_1_a", locator: { unitId: "20" } },
    { source: "はい", translation: "好。", entryKey: "CARD_1_b", locator: { unitId: "21" } }
  ];
  const result = matchReviewPairsToSegments(segments, [
    { source: "はい", target: "是的。", entryKey: "CARD_1_b" },
    { source: "はい", target: "是。", entryKey: "CARD_1_a" }
  ]);
  assert.equal(result.matches.length, 2);
  assert.deepEqual(result.matches.map((match) => match.segmentIndex), [1, 0], "按条目 key 各自归位");
  assert.deepEqual(result.matches.map((match) => match.method), ["entry_key", "entry_key"]);
  assert.equal(result.matches[0].changed, true, "译文被审校改过要标出来");
  assert.equal(result.matches[1].changed, false, "译文没变也算匹配，只是没改动");
  assert.deepEqual(result.unchanged, [1]);
  assert.deepEqual(result.ambiguous, []);
});

test("没有条目 ID 时用 unit id；重复原文无法消歧就算有歧义，绝不乱认", () => {
  const segments = [
    { source: "はい", translation: "是。", locator: { unitId: "20" } },
    { source: "はい", translation: "好。", locator: { unitId: "21" } },
    { source: "了解しました。", translation: "明白了。" }
  ];
  const byId = matchReviewPairsToSegments(segments, [{ source: "はい", target: "好的。", entryId: "21" }]);
  assert.deepEqual(byId.matches.map((match) => [match.segmentIndex, match.method]), [[1, "entry_id"]]);

  const ambiguous = matchReviewPairsToSegments(segments, [{ source: "はい", target: "好的。" }]);
  assert.equal(ambiguous.matches.length, 0);
  assert.equal(ambiguous.ambiguous.length, 1);
  assert.match(ambiguous.ambiguous[0].reason, /出现 2 次/u);

  // 原文唯一时仍可按原文回填（表格文件常见）
  const unique = matchReviewPairsToSegments(segments, [{ source: "了解しました。", target: "我知道了。" }]);
  assert.deepEqual(unique.matches.map((match) => [match.segmentIndex, match.method]), [[2, "unique_source"]]);

  const missing = matchReviewPairsToSegments(segments, [{ source: "新材料です。", target: "是新素材。" }]);
  assert.equal(missing.unmatched.length, 1);
  assert.match(missing.unmatched[0].reason, /不在这个批次里/u);
});

test("外部审校终稿以项目内唯一原文接回原轨迹", () => {
  const result = linkExternalReviewTrajectories(
    [{ source: "メンテナンスを開始します。", target: "维护即将开始。" }],
    [trajectory("t-1", "メンテナンスを開始します。")]
  );
  assert.equal(result.links[0].trajectory.id, "t-1");
  assert.equal(result.links[0].method, "unique_source");
});

test("重复原文优先用条目 ID 和工作表行号消歧", () => {
  const candidates = [
    { source: "はい", target: "是。", entryId: "line-20", sheet: "对白", sourceRow: 20 },
    { source: "はい", target: "好。", entryId: "line-21", sheet: "对白", sourceRow: 21 }
  ];
  const trajectories = [
    trajectory("t-20", "はい", { assetRefs: { entryId: "line-20", sheet: "对白", sourceRow: 20 } }),
    trajectory("t-21", "はい", { assetRefs: { entryId: "line-21", sheet: "对白", sourceRow: 21 } })
  ];
  const result = linkExternalReviewTrajectories(candidates, trajectories);
  assert.deepEqual(result.links.map((item) => item.trajectory.id).sort(), ["t-20", "t-21"]);
  assert.deepEqual(result.ambiguous, []);
});

test("重复原文缺少可靠定位时不自动挂错轨迹", () => {
  const result = linkExternalReviewTrajectories(
    [{ source: "はい", target: "是。" }, { source: "はい", target: "好。" }],
    [trajectory("t-1", "はい"), trajectory("t-2", "はい")]
  );
  assert.equal(result.links.length, 0);
  assert.deepEqual(result.ambiguous, [0, 1]);
});

test("已经有人工决定的轨迹不会被外部文件静默覆盖", () => {
  const result = linkExternalReviewTrajectories(
    [{ source: "終了", target: "结束" }],
    [trajectory("t-1", "終了", { humanDecision: { accepted: true, finalTranslation: "已结束" } })]
  );
  assert.equal(result.links.length, 0);
  assert.deepEqual(result.alreadyAccepted, [0]);
});

test("接回后生成可用于技能学习和训练导出的人工决定", () => {
  const patch = externalReviewTrajectoryPatch({
    trajectory: trajectory("t-1", "開始", { finalTranslation: "开始。", events: [{ type: "completed" }] }),
    target: "正式开始。",
    sourceFile: "memoQ-reviewed.mqxliff",
    sourceRow: 8,
    matchMethod: "entry_id"
  });
  assert.equal(patch.status, "completed");
  assert.equal(patch.finalTranslation, "正式开始。");
  assert.equal(patch.humanDecision.accepted, true);
  assert.equal(patch.humanDecision.source, "external-review-import");
  assert.equal(patch.events.at(-1).type, "external_human_review_imported");
  assert.ok(patch.humanDecision.editDistance > 0);
});
