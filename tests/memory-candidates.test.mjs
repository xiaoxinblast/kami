import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 与其它 store 用例同法：先定数据目录与后端，再 import。
const DATA_DIR = await mkdtemp(join(tmpdir(), "kami-memory-candidates-"));
process.env.KAMI_DATA_DIR = DATA_DIR;
process.env.KAMI_STORE = "json";
const {
  deleteMemory,
  getMemoryCandidates,
  getMemoryIndexDiagnostics,
  initializeStore,
  saveMemories,
  saveMemory
} = await import("../src/store.mjs");

await initializeStore();

test.after(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
});

const corpus = Array.from({ length: 60 }, (_, index) => ({
  source: `セリフ${index}：これはテスト用に用意した長めの日本語のセリフです。`,
  target: `台词${index}：这是一句为了测试准备的比较长的中文台词。`,
  projectId: "p1",
  libraryId: "tm-master",
  qualityStatus: "human_approved",
  qaScore: 100
}));

test("候选检索：整库收窄后仍返回完整记忆行，模糊查询能找到目标", async () => {
  await saveMemories("zh-CN", corpus);
  const target = corpus[42];
  const query = [...target.source].filter((_, position) => position % 9 < 5).join("");
  const candidates = await getMemoryCandidates("zh-CN", { projectId: "p1", source: query, limit: 20 });
  assert.ok(candidates.length > 0);
  assert.ok(candidates.some((item) => item.source === target.source), "被扰动过的目标行要出现在候选里");
  // 返回的必须是完整行（带译文与质量字段），不是索引里的精简行。
  const hit = candidates.find((item) => item.source === target.source);
  assert.equal(hit.target, target.target);
  assert.equal(hit.qualityStatus, "human_approved");
});

test("写入会让索引失效：新写入的记忆立刻能被检索到", async () => {
  const created = await saveMemory("zh-CN", {
    source: "固有の言い回し：ナビマップを起動します。",
    target: "专有说法：启动导览地图。",
    projectId: "p1",
    libraryId: "tm-master",
    qualityStatus: "human_approved"
  });
  // 先检索一次把索引建起来，再写入一条新记录，确认缓存被清掉。
  await getMemoryCandidates("zh-CN", { projectId: "p1", source: "ナビ", limit: 10 });
  await saveMemory("zh-CN", {
    source: "別の言い回し：ナビマップを終了します。",
    target: "另一种说法：关闭导览地图。",
    projectId: "p1",
    libraryId: "tm-master",
    qualityStatus: "human_approved"
  });
  const afterWrite = await getMemoryCandidates("zh-CN", { projectId: "p1", source: "ナビ", limit: 10 });
  assert.ok(afterWrite.some((item) => item.source.includes("終了します")), "写入后新建的索引要含新行");
  // 删除同样要让索引失效。
  await deleteMemory("zh-CN", created.id);
  const afterDelete = await getMemoryCandidates("zh-CN", { projectId: "p1", source: "起動します", limit: 10 });
  assert.equal(afterDelete.filter((item) => item.source.includes("起動します")).length, 0, "删掉的行不能还在候选里");
});

test("候选池为 0 时退回整库取法（应急开关）", async () => {
  const all = await getMemoryCandidates("zh-CN", { projectId: "p1", source: "セリフ1：", limit: 0 });
  assert.ok(all.length >= corpus.length, `不粗筛时要拿到整库（拿到 ${all.length} 条）`);
});

test("并发首次检索只加载一次索引", async () => {
  const projectId = "p-concurrent";
  // 批量写会清空索引缓存，保证下面两条检索都是"首次加载"。
  await saveMemories("zh-CN", [{
    source: "並行実行の確認：ナビマップを起動します。",
    target: "并发检查：启动导览地图。",
    projectId,
    libraryId: "tm-master",
    qualityStatus: "human_approved"
  }]);
  const builds = getMemoryIndexDiagnostics().builds;
  const [first, second] = await Promise.all([
    getMemoryCandidates("zh-CN", { projectId, source: "ナビ", limit: 5 }),
    getMemoryCandidates("zh-CN", { projectId, source: "起動", limit: 5 })
  ]);
  assert.equal(getMemoryIndexDiagnostics().builds, builds + 1, "并发检索共用同一次加载（只拉一次 22MB）");
  assert.ok(first.length + second.length >= 1);
});

test("单条写入/删除走增量索引：不重建整库，结果立刻可检索", async () => {
  const projectId = "p-incremental";
  await saveMemories("zh-CN", [{
    source: "既存の言い回し：設定画面を開きます。",
    target: "既有说法：打开设置画面。",
    projectId,
    libraryId: "tm-master",
    qualityStatus: "human_approved"
  }]);
  // 先把索引建起来，再记录重建次数；之后单条写入不应再触发整库重建。
  await getMemoryCandidates("zh-CN", { projectId, source: "設定", limit: 10 });
  const builds = getMemoryIndexDiagnostics().builds;
  const created = await saveMemory("zh-CN", {
    source: "新しい言い回し：ナビマップを起動します。",
    target: "新说法：启动导览地图。",
    projectId,
    libraryId: "tm-master",
    qualityStatus: "human_approved"
  });
  const afterWrite = await getMemoryCandidates("zh-CN", { projectId, source: "ナビ", limit: 10 });
  assert.ok(afterWrite.some((item) => item.id === created.id), "增量写入后新行要立刻可检索");
  assert.equal(getMemoryIndexDiagnostics().builds, builds, "单条写入不应重建整个候选索引");
  await deleteMemory("zh-CN", created.id);
  const afterDelete = await getMemoryCandidates("zh-CN", { projectId, source: "ナビ", limit: 10 });
  assert.equal(afterDelete.some((item) => item.id === created.id), false, "删除后不能还在候选里");
  assert.equal(getMemoryIndexDiagnostics().builds, builds, "删除也不应重建整个候选索引");
});
