import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 模型指向一个没人监听的端口：本批浓缩必然失败，用来验证失败原因会被写下来。
const dataDir = await mkdtemp(join(tmpdir(), "kami-condense-fallback-"));
const providerDir = await mkdtemp(join(tmpdir(), "kami-condense-provider-"));
await writeFile(join(providerDir, "provider.json"), JSON.stringify({
  baseUrl: "http://127.0.0.1:59998/v1", model: "dead-model", fastModel: "", qualityModel: "", mtModel: "",
  embeddingModel: "", embeddingBaseUrl: ""
}));
process.env.KAMI_DATA_DIR = dataDir;
process.env.KAMI_PROVIDER_DIRECTORY = providerDir;
delete process.env.KAMI_STORE;

const { initializeStore, getStyleLearningRuns } = await import("../src/store.mjs");
const { distillBatchStyleLearning } = await import("../src/evolution.mjs");
await initializeStore();

const evidence = [
  { source: "おはよう。", target: "早上好。", provenance: "table-import", contentType: "dialogue", domain: "game" },
  { source: "行こう。", target: "走吧。", provenance: "table-import", contentType: "dialogue", domain: "game" }
];

const distill = (batchId, learningRunId = "") => distillBatchStyleLearning({
  batchId, filename: "fail.xlsx", locale: "zh-CN", contentType: "dialogue", domain: "game",
  projectId: "project-condense", evidence, learningRunId
});

test("模型浓缩失败时把原因写进记录，而不是静默退回本地统计", async () => {
  const run = await distill("batch-condense-fail");
  assert.ok(run, "失败也要留下一条可见的学习记录");
  assert.equal(run.status, "observed");
  assert.match(run.caveat, /模型浓缩失败：/u, `要把失败原因写出来：${run.caveat}`);
  assert.ok(run.caveat.replace("模型浓缩失败：", "").length > 4, `原因不能是空的：${run.caveat}`);
  assert.ok(run.rules.length >= 1, "本地统计的兜底内容仍要保留，用户能看到本批观察");
});

test("重跑用同一条记录就地更新，不新增记录", async () => {
  const first = await distill("batch-condense-rerun");
  const again = await distill("batch-condense-rerun", first.id);
  assert.equal(again.id, first.id, "重跑要更新原记录，避免列表里堆两条一样的");
  const runs = await getStyleLearningRuns("zh-CN", { projectId: "project-condense", limit: 100 });
  assert.equal(runs.filter((item) => item.batchId === "batch-condense-rerun").length, 1);
});
