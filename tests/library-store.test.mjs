import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const requests = [];
const termRows = [
  { id: "t1", source: "バアル", target: "巴尔", aliases: [], forbidden: [], domains: ["game"], content_types: ["item_name"], content_tags: [], enforcement: "preferred", note: "人名", status: "approved", provenance: "table-import:term_base.xlsx#2", project_id: "project-a", library_id: "term-1", date_created: "2026-09-18T13:38:29Z" },
  { id: "t2", source: "ガード", target: "防御", aliases: ["Guard"], forbidden: [], domains: ["game"], content_types: ["item_name"], content_tags: [], enforcement: "preferred", note: "", status: "approved", provenance: "kami-workbench", project_id: "project-a", library_id: "term-2", date_created: "2026-09-17T08:00:00Z" }
];
const memoryRows = [
  { id: "m1", source: "メンテナンスは明日開始します。", target: "维护明天开始。", entry_key: "ID-1", quality_status: "human_approved", qa_score: 100, provenance: "table-import", source_file: "a.xlsx", source_row: 2, project_id: "project-a", library_id: "tm-master", date_created: "2026-09-18T10:14:14Z" }
];

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const server = http.createServer(async (req, res) => {
  const raw = await readBody(req);
  const url = new URL(`http://directus${req.url}`);
  const collection = url.pathname.split("/")[2] || "";
  const fields = url.searchParams.get("fields") || "";
  let data = [];
  if (req.method === "GET" && url.pathname.startsWith("/items/")) {
    requests.push({ method: "GET", collection, query: url.search, fields });
    const grouped = url.searchParams.getAll("groupBy[]");
    if (grouped.length) {
      if (grouped.includes("library_id")) {
        // 库统计：术语只按库分组；TM 还按来源文件分组，用来算"几个文件"。
        data = collection === "terms_zh_cn"
          ? [{ library_id: "term-1", count: "5856", max: { date_created: "2026-09-18T13:38:29Z" } }]
          : [
            { library_id: "tm-master", source_file: "Asia_batch18_new.xlsx_zho-CN.mqxliff", count: "60", max: { date_created: "2026-09-18T10:14:14Z" } },
            { library_id: "tm-master", source_file: "Trophy.xlsx_zho-CN.mqxliff", count: "6", max: { date_created: "2026-09-18T09:00:00Z" } }
          ];
      } else {
        // 文件清单：按 source_file + batch_id 分组。
        data = [
          { source_file: "Asia_batch18_new.xlsx_zho-CN.mqxliff", batch_id: "batch-a", count: "60", max: { date_created: "2026-09-18T10:14:14Z" } },
          { source_file: "Asia_batch18_new.xlsx_zho-CN.mqxliff", batch_id: "batch-b", count: "3", max: { date_created: "2026-09-18T11:00:00Z" } }
        ];
      }
    } else if (fields === "id,aliases") {
      data = termRows.map((row) => ({ id: row.id, aliases: row.aliases }));
    } else if (url.searchParams.get("aggregate[count]") !== null) {
      data = [{ count: collection === "terms_zh_cn" ? "1" : "1" }];
    } else if (url.pathname.split("/").length > 3) {
      const id = url.pathname.split("/").pop();
      data = (collection === "terms_zh_cn" ? termRows : memoryRows).find((row) => row.id === id) || null;
    } else {
      data = collection === "terms_zh_cn" ? termRows : memoryRows;
      const wantedLibrary = url.searchParams.get("filter[_and][1][library_id][_eq]");
      if (wantedLibrary) data = data.filter((row) => row.library_id === wantedLibrary);
      const aliasIds = url.searchParams.get("filter[_and][2][_or][2][id][_in]");
      if (aliasIds) {
        const wanted = new Set(aliasIds.split(","));
        data = data.filter((row) => wanted.has(row.id));
      }
    }
  } else if (req.method === "PATCH") {
    const id = url.pathname.split("/").pop();
    const body = JSON.parse(raw || "{}");
    requests.push({ method: "PATCH", collection, id, body });
    data = { ...(collection === "terms_zh_cn" ? termRows : memoryRows).find((row) => row.id === id), ...body };
  } else if (req.method === "DELETE") {
    requests.push({ method: "DELETE", collection, query: url.search, body: raw });
    data = null;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
process.env.DIRECTUS_URL = `http://127.0.0.1:${server.address().port}`;
process.env.DIRECTUS_TOKEN = "test-token";

const {
  deleteDirectusLibraryEntries,
  deleteDirectusMemory,
  getDirectusAsset,
  getDirectusLibraryStats,
  listDirectusLibraryFiles,
  listDirectusLibraryEntries,
  updateDirectusMemory
} = await import("../src/directus-store.mjs");
const { memorySourceHash } = await import("../src/translation-memory.mjs");

test("库统计按 library_id 聚合出条目数与最新条目时间", async () => {
  const stats = await getDirectusLibraryStats("zh-CN", "project-a");
  assert.equal(stats.get("term-1").termCount, 5856);
  assert.equal(stats.get("term-1").entryCount, 5856);
  assert.equal(stats.get("term-1").lastEntryAt, "2026-09-18T13:38:29Z");
  // TM 侧一并按来源文件分组：条目数是各文件之和，"几个文件"取组数。
  assert.equal(stats.get("tm-master").memoryCount, 66);
  assert.equal(stats.get("tm-master").fileCount, 2);
  assert.equal(stats.get("tm-master").latestFile, "Asia_batch18_new.xlsx_zho-CN.mqxliff");
  const grouped = requests.find((call) => call.query.includes("groupBy%5B%5D=library_id"));
  assert.ok(grouped.query.includes("aggregate%5Bcount%5D=*"), "要有条目数聚合");
  assert.ok(grouped.query.includes("aggregate%5Bmax%5D=date_created"), "要有最新条目时间聚合");
});

test("文件清单把同一文件的多个批次合并成一行，按最近更新排序", async () => {
  requests.length = 0;
  const files = await listDirectusLibraryFiles({ locale: "zh-CN", projectId: "project-a", libraryId: "tm-master" });
  assert.equal(files.length, 1);
  assert.equal(files[0].sourceFile, "Asia_batch18_new.xlsx_zho-CN.mqxliff");
  assert.equal(files[0].entryCount, 63, "两个批次的条目要相加");
  assert.equal(files[0].batchCount, 2);
  assert.equal(files[0].lastEntryAt, "2026-09-18T11:00:00Z");
  const query = requests.find((call) => call.query.includes("groupBy%5B%5D=source_file"));
  assert.ok(query.query.includes("filter%5Blibrary_id%5D%5B_eq%5D=tm-master"), "文件清单要限定在打开的库里");
});

test("库条目列表按库过滤、分页并映射术语/TM 两种字段", async () => {
  requests.length = 0;
  const terms = await listDirectusLibraryEntries({ locale: "zh-CN", kind: "term", projectId: "project-a", libraryId: "term-1", limit: 100, offset: 0 });
  assert.equal(terms.items.length, 1);
  assert.equal(terms.items[0].source, "バアル");
  assert.equal(terms.items[0].libraryId, "term-1");
  assert.equal(terms.items[0].note, "人名");
  const listQuery = requests.find((call) => call.method === "GET" && call.query.includes("limit=100"));
  assert.ok(listQuery.query.includes("filter%5B_and%5D%5B1%5D%5Blibrary_id%5D%5B_eq%5D=term-1"), "要按库过滤");
  assert.ok(listQuery.query.includes("filter%5B_and%5D%5B0%5D%5Bproject_id%5D%5B_eq%5D=project-a"), "要按项目过滤");

  const memories = await listDirectusLibraryEntries({ locale: "zh-CN", kind: "tm", projectId: "project-a", limit: 100, offset: 0 });
  assert.equal(memories.items[0].entryKey, "ID-1");
  assert.equal(memories.items[0].qualityStatus, "human_approved");
});

test("库内搜索同时匹配原文/译法与别名（别名走 id 白名单）", async () => {
  requests.length = 0;
  await listDirectusLibraryEntries({ locale: "zh-CN", kind: "term", projectId: "project-a", libraryId: "term-2", search: "Guard", limit: 50, offset: 0 });
  const aliasIndexCall = requests.find((call) => call.fields === "id,aliases");
  assert.ok(aliasIndexCall, "别名要先拿一次 id+aliases 索引（json 列不能直接过滤）");
  const listCall = requests.find((call) => call.query.includes("limit=50"));
  const decoded = decodeURIComponent(listCall.query);
  assert.ok(decoded.includes("[source][_icontains]=Guard"), "原文要参与搜索");
  assert.ok(decoded.includes("[target][_icontains]=Guard"), "译法要参与搜索");
  assert.ok(decoded.includes("[id][_in]=t2"), "别名命中要并进查询");
});

test("单条术语可以按 id 读回（编辑要基于现有行合并）", async () => {
  const asset = await getDirectusAsset("zh-CN", "t1");
  assert.equal(asset.libraryId, "term-1");
  assert.equal(asset.note, "人名");
});

test("TM 条目编辑重算 source_hash 且不动库归属，删除打 DELETE", async () => {
  requests.length = 0;
  const updated = await updateDirectusMemory("zh-CN", "m1", { source: "メンテナンスは明日開始します！（改）", target: "维护明天开始！（改）" });
  const patch = requests.find((call) => call.method === "PATCH");
  assert.equal(patch.id, "m1");
  assert.equal(patch.body.source_hash, memorySourceHash("メンテナンスは明日開始します！（改）"), "原文变了必须重算 source_hash");
  assert.equal(patch.body.library_id, undefined, "编辑不得改动库归属");
  assert.equal(patch.body.project_id, undefined);
  assert.equal(updated.target, "维护明天开始！（改）");

  const deleted = await deleteDirectusMemory("zh-CN", "m1");
  assert.equal(deleted, true);
  assert.ok(requests.some((call) => call.method === "DELETE" && call.collection === "translation_memory_zh_cn"));
});

test("批量删除库内条目分块发送 id 数组", async () => {
  requests.length = 0;
  const ids = Array.from({ length: 450 }, (_, index) => `t${index}`);
  const deleted = await deleteDirectusLibraryEntries("zh-CN", "term", ids);
  assert.equal(deleted, 450);
  const deletes = requests.filter((call) => call.method === "DELETE");
  assert.equal(deletes.length, 3, "450 条按 200 一批：200 + 200 + 50");
  assert.equal(deletes[0].collection, "terms_zh_cn");
});
