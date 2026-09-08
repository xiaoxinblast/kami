import test from "node:test";
import assert from "node:assert/strict";
import { runServerBatch } from "../src/batch-runner.mjs";

function fixture() {
  return {
    batchId: "batch-1", projectId: "project-1", filename: "dialogue.xlsx", locale: "zh-CN", contentType: "general", domain: "game", segmentationMode: "unit",
    segments: [1, 2, 3].map((index) => ({ id: `seg-${index}`, source: `原文${index}`, selected: true, status: "pending", context: { row: index } }))
  };
}

test("服务端按真实 subBatches 执行并逐段保存检查点", async () => {
  const run = fixture();
  const snapshots = [];
  const calls = [];
  const result = await runServerBatch(run.batchId, {
    loadRun: async () => run,
    saveRun: async (value) => snapshots.push(structuredClone(value)),
    loadProject: async () => ({ settings: { batch: { subBatchMaxEntries: 2, subBatchMaxChars: 99 }, tm: { contextAnchorCount: 2 } } }),
    classifyDocument: async () => "dialogue",
    translateSegment: async (body) => { calls.push(body); return { translation: `译文${calls.length}`, qaScore: 95, issues: [] }; }
  });
  assert.equal(result.runState, "completed");
  assert.deepEqual(result.subBatches.map((batch) => batch.entries), [2, 1]);
  assert.deepEqual(result.subBatches.map((batch) => batch.status), ["completed", "completed"]);
  assert.equal(calls.length, 3);
  assert.ok(snapshots.length >= 7, "启动、每段运行前后和完成状态都应持久化");
});

test("暂停请求在当前段完成后停止，恢复时跳过已完成段", async () => {
  const run = fixture();
  let translated = 0;
  const first = await runServerBatch(run.batchId, {
    loadRun: async () => run,
    saveRun: async () => {},
    loadProject: async () => ({ settings: { batch: { subBatchMaxEntries: 2, subBatchMaxChars: 99 }, tm: {} } }),
    classifyDocument: async () => "dialogue",
    translateSegment: async () => { translated += 1; return { translation: `译文${translated}`, issues: [] }; },
    shouldPause: () => translated >= 1
  });
  assert.equal(first.runState, "paused");
  assert.equal(first.segments.filter((segment) => segment.status === "done").length, 1);

  const resumed = await runServerBatch(run.batchId, {
    loadRun: async () => run,
    saveRun: async () => {},
    loadProject: async () => ({ settings: { batch: { subBatchMaxEntries: 2, subBatchMaxChars: 99 }, tm: {} } }),
    classifyDocument: async () => "dialogue",
    translateSegment: async () => { translated += 1; return { translation: `译文${translated}`, issues: [] }; }
  });
  assert.equal(resumed.runState, "completed");
  assert.equal(translated, 3);
});
