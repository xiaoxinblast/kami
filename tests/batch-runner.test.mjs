import test from "node:test";
import assert from "node:assert/strict";
import { runServerBatch } from "../src/batch-runner.mjs";

function fixture() {
  return {
    batchId: "batch-1", projectId: "project-1", filename: "dialogue.xlsx", locale: "zh-CN", contentType: "general", domain: "game", segmentationMode: "unit",
    segments: [1, 2, 3].map((index) => ({ id: `seg-${index}`, source: `原文${index}`, selected: true, status: "pending", context: { row: index } }))
  };
}

test("服务端按真实 subBatches 执行，每段结果落盘一次（不再逐段写两遍）", async () => {
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
  // 落盘节流：初始 1 次 + 每段结果 1 次 + 收尾 1 次。旧行为是每段写两遍（running + 结果），
  // 78 段的批次会打出上百次大 JSON 写入，把 Directus 压出压力保护。
  assert.equal(snapshots.length, 5, "初始 + 三段结果 + 收尾");
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.segments.filter((segment) => segment.status === "done").length),
    [0, 1, 2, 3, 3],
    "每段完成都必须落盘，才能从断点继续"
  );
  assert.equal(
    snapshots.some((snapshot) => snapshot.segments.some((segment) => segment.status === "running")),
    false,
    "快速段落不再为「正在翻」多写一次整行"
  );
});

test("中断请求在当前段完成后停止，留下已中断标记且已完成段保留", async () => {
  const run = fixture();
  let translated = 0;
  const snapshots = [];
  const first = await runServerBatch(run.batchId, {
    loadRun: async () => run,
    saveRun: async (value) => snapshots.push(structuredClone(value)),
    loadProject: async () => ({ settings: { batch: { subBatchMaxEntries: 2, subBatchMaxChars: 99 }, tm: {} } }),
    classifyDocument: async () => "dialogue",
    translateSegment: async () => { translated += 1; return { translation: `译文${translated}`, issues: [] }; },
    shouldCancel: () => translated >= 1
  });
  assert.equal(first.runState, "paused");
  assert.equal(first.runnerOptions.cancelled, true, "中断要留标记：界面据此显示「已中断」而不是「已暂停」");
  assert.equal(first.segments.filter((segment) => segment.status === "done").length, 1);
  assert.equal(translated, 1, "中断之后不能继续翻后面的段落");
  assert.equal(snapshots.at(-1).runState, "paused");
  assert.equal(snapshots.at(-1).runnerOptions.cancelled, true);

  // 继续：只翻没完成的段落，已完成的那段不重翻
  const resumed = await runServerBatch(run.batchId, {
    loadRun: async () => run,
    saveRun: async () => {},
    loadProject: async () => ({ settings: { batch: { subBatchMaxEntries: 2, subBatchMaxChars: 99 }, tm: {} } }),
    classifyDocument: async () => "dialogue",
    translateSegment: async () => { translated += 1; return { translation: `译文${translated}`, issues: [] }; }
  });
  assert.equal(resumed.runState, "completed");
  assert.equal(translated, 3, "续跑只补剩下两段");
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
