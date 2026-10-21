import test from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_TASK_STALE_MS, interruptedTaskPatch, selectStaleRunningTasks } from "../src/background-task-sweep.mjs";

/**
 * 工作台重启会把跑到一半的后台任务留在库里（状态仍是进行中），任务中心于是永远转圈。
 * 判定必须只看"多久没有进度更新"：正在跑的任务几十秒就写一次进度，不能被误伤。
 */
const NOW = Date.parse("2026-09-26T08:00:00.000Z");
const at = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();

test("只挑长时间没有进度更新的进行中任务", () => {
  const tasks = [
    { id: "running-fresh", status: "in_progress", updatedAt: at(30) },
    { id: "running-stale", status: "in_progress", updatedAt: at(10 * 60) },
    { id: "done", status: "completed", updatedAt: at(60 * 60) },
    { id: "waiting", status: "review", updatedAt: at(60 * 60) },
    { id: "no-timestamp", status: "in_progress" }
  ];
  const stale = selectStaleRunningTasks(tasks, { now: NOW });
  assert.deepEqual(stale.map((task) => task.id), ["running-stale", "no-timestamp"]);
  assert.equal(BACKGROUND_TASK_STALE_MS, 5 * 60_000, "默认阈值 5 分钟：远大于单样本耗时");
});

test("中断收尾沿用任务中心的既有口径，并保留原进度与 payload", () => {
  const patch = interruptedTaskPatch({
    status: "in_progress",
    progress: { phase: "running", message: "正在执行第 6 / 67 个固定样本", completed: 5, total: 67 },
    payload: { skillId: "skill-1" }
  });
  assert.equal(patch.status, "needs_attention");
  assert.equal(patch.progress.phase, "interrupted");
  assert.match(patch.progress.message, /已中断/u);
  assert.equal(patch.progress.completed, 5, "已跑完的样本数要留着");
  assert.equal(patch.payload.skillId, "skill-1");
  assert.equal(patch.payload.interrupted, true);
});
