import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

/**
 * 回归：原文归一化后为空时，按原文查重会算出空哈希。
 *
 * 真实事故：`Asia_batch18_new.xlsx_zho-CN.mqxliff` 导入任务显示
 * 「跳过 1（Directus GET /items/translation_memory_zh_cn 失败（400 Invalid query.
 * You can't filter for an empty string in "_eq". Use "_empty" instead.））」。
 * 那条候选的原文是整段只有一个 MQXLIFF 内联标签占位符
 * `<tag id='tag-1' type='inline' desc='ph'/>`，`normalizeMemoryText` 之后是空串
 * → `memorySourceHash` 返回 `""` → 旧代码把空串写进 `filter[source_hash][_eq]`
 * → Directus 400 → 整条候选被跳过，主 TM 少一条人工确认译文。
 */

const requests = [];
let rejectedEmptyEq = 0;

const server = http.createServer(async (req, res) => {
  const url = new URL(`http://directus${req.url}`);
  const collection = url.pathname.split("/")[2] || "";
  requests.push({ method: req.method, collection, query: url.search });
  if (req.method === "GET" && collection.startsWith("translation_memory")) {
    // 复刻 Directus 的校验：`_eq` 收到空串直接 400。
    for (const [key, value] of url.searchParams) {
      if (key.endsWith("[_eq]") && value === "") {
        rejectedEmptyEq += 1;
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: 'Invalid query. You can\'t filter for an empty string in "_eq". Use "_empty" instead.' }] }));
        return;
      }
    }
  }
  const data = req.method === "POST"
    ? { id: "created-1", source: "占位段", target: "占位段", quality_status: "human_approved", qa_score: 100 }
    : [];
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
process.env.DIRECTUS_URL = `http://127.0.0.1:${server.address().port}`;
process.env.DIRECTUS_TOKEN = "test-token";

const { demoteDirectusMemories, saveDirectusMemory } = await import("../src/directus-store.mjs");

const TAG_ONLY_SOURCE = "<tag id='tag-1' type='inline' desc='ph'/>";

test("只有内联标签的原文不再把整条 TM 候选打成 400 跳过", async () => {
  const saved = await saveDirectusMemory("zh-CN", {
    source: TAG_ONLY_SOURCE,
    target: "占位段",
    projectId: "project-1",
    libraryId: "tm-master",
    qualityStatus: "human_approved",
    qaScore: 100
  });
  assert.equal(saved.id, "created-1", "候选要真的写进去，而不是被跳过");
  assert.equal(rejectedEmptyEq, 0, "查询里不允许再出现空的 _eq");
  const pairLookup = requests.find((item) => item.method === "GET" && item.collection.startsWith("translation_memory"));
  assert.ok(pairLookup, "按原文查重要真的发出去");
  assert.ok(
    new URLSearchParams(pairLookup.query).get("filter[source_hash][_empty]") === "true",
    "空哈希的查重要改用 _empty（Directus 推荐的写法）"
  );
});

test("降级旧译文同样不再用空 _eq 查原文哈希", async () => {
  const demoted = await demoteDirectusMemories("zh-CN", TAG_ONLY_SOURCE, "", { projectId: "project-1" });
  assert.equal(demoted, 0);
  assert.equal(rejectedEmptyEq, 0);
});
