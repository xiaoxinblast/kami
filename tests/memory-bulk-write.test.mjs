import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 与其它 store 用例同法：先定数据目录与后端，再 import。
const DATA_DIR = await mkdtemp(join(tmpdir(), "kami-bulk-write-"));
process.env.KAMI_DATA_DIR = DATA_DIR;
process.env.KAMI_STORE = "json";
const {
  getMemories,
  getStyleEvidence,
  initializeStore,
  loadStyleEvidenceIndex,
  saveMemories,
  saveStyleEvidences
} = await import("../src/store.mjs");

await initializeStore();

test.after(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
});

test("批量写翻译记忆：一次写多行，重复的原文+译文不会堆出第二行", async () => {
  const results = await saveMemories("zh-CN", [
    { source: "用語A", target: "术语A", projectId: "p1", qualityStatus: "human_approved", qaScore: 100 },
    { source: "用語B", target: "术语B", projectId: "p1", qualityStatus: "human_approved", qaScore: 100 },
    { source: "用語A", target: "术语A", projectId: "p1", qualityStatus: "human_approved", qaScore: 100 }
  ]);
  assert.equal(results.length, 3);
  assert.ok(results.every((item) => item.id), "三条都要有 id");
  // 同一批里重复的键指向同一行：等同单条写入的"查到刚写的那条并覆盖"。
  assert.equal(results[0].id, results[2].id);
  const memories = await getMemories("zh-CN", { projectId: "p1", limit: -1 });
  assert.equal(memories.length, 2);

  // 再写一次同样的内容：命中已有行（原地覆盖），总数不变。
  const again = await saveMemories("zh-CN", [
    { source: "用語A", target: "术语A", projectId: "p1", qualityStatus: "human_approved", qaScore: 100 }
  ]);
  assert.equal(again[0].id, results[0].id);
  assert.equal((await getMemories("zh-CN", { projectId: "p1", limit: -1 })).length, 2);
});

test("批量写翻译记忆：单条坏数据不影响同批其它行", async () => {
  const results = await saveMemories("zh-CN", [
    { source: "", target: "空原文", projectId: "p2" },
    { source: "用語C", target: "术语C", projectId: "p2", qualityStatus: "human_approved" }
  ]);
  assert.match(results[0].error, /不能为空/u);
  assert.ok(results[1].id);
  assert.equal((await getMemories("zh-CN", { projectId: "p2", limit: -1 })).length, 1);
});

test("批量写风格证据：判重索引复用，同内容不重复入库", async () => {
  const index = await loadStyleEvidenceIndex("zh-CN", { projectId: "p1" });
  const saved = await saveStyleEvidences([
    { locale: "zh-CN", projectId: "p1", source: "用語A", target: "术语A", contentType: "general", domain: "general" },
    { locale: "zh-CN", projectId: "p1", source: "用語B", target: "术语B", contentType: "general", domain: "general" },
    { locale: "zh-CN", projectId: "p1", source: "用語A", target: "术语A", contentType: "general", domain: "general" }
  ], { index });
  assert.ok(saved.every((item) => item.id));
  assert.equal(saved[0].id, saved[2].id, "同批重复证据只写一行");
  assert.equal((await getStyleEvidence("zh-CN", { projectId: "p1", limit: 1_000 })).length, 2);

  // 复用同一个索引再写一遍：命中已有行，不新增。
  await saveStyleEvidences([
    { locale: "zh-CN", projectId: "p1", source: "用語A", target: "术语A", contentType: "general", domain: "general" }
  ], { index });
  assert.equal((await getStyleEvidence("zh-CN", { projectId: "p1", limit: 1_000 })).length, 2);
});
