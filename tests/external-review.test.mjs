import test from "node:test";
import assert from "node:assert/strict";
import { externalReviewTrajectoryPatch, linkExternalReviewTrajectories } from "../src/external-review.mjs";

function trajectory(id, source, overrides = {}) {
  return { id, source, initialTranslation: `机器稿-${id}`, status: "completed", ...overrides };
}

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
