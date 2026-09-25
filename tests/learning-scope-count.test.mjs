import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

/**
 * 学习中心的"范围分布"数据：语体与领域是逐段判定的，用户刚导入完语料时打开的
 * 默认作用域（待分类文本 × 通用）常常是空的，轨迹其实都在别的领域里
 * （实测：本项目 67 条落在 general × game）。这条聚合接口既要给每个范围的条数，
 * 也要给出它们来自哪些文件；口径必须与「当前范围有效轨迹」一致。
 */

const requests = [];
const countRows = [
  { content_type: "general", domain: "game", count: { id: "67" } },
  { content_type: "announcement", domain: "game", count: { id: "4" } },
  { content_type: "ui", domain: "general", count: { id: "0" } }
];
const fileRows = [
  { content_type: "general", domain: "game", batch_id: "batch-a", asset_refs: { sourceFile: "Asia_batch18_new.xlsx_zho-CN.mqxliff" } },
  { content_type: "general", domain: "game", batch_id: "batch-a", asset_refs: { sourceFile: "Asia_batch18_new.xlsx_zho-CN.mqxliff" } },
  { content_type: "general", domain: "game", batch_id: "batch-b", asset_refs: {} },
  { content_type: "announcement", domain: "game", batch_id: "batch-c", asset_refs: {} }
];

const server = http.createServer(async (req, res) => {
  const url = new URL(`http://directus${req.url}`);
  requests.push({ method: req.method, path: url.pathname, query: url.search });
  let data = [];
  if (url.pathname === "/items/learning_trajectories") {
    data = url.searchParams.getAll("groupBy[]").length ? countRows : fileRows;
  }
  if (url.pathname === "/items/batch_runs") {
    data = [{ id: "batch-b", filename: "Trophy.xlsx_zho-CN.mqxliff" }, { id: "batch-c", filename: "smoke-tier2.txt" }];
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
process.env.DIRECTUS_URL = `http://127.0.0.1:${server.address().port}`;
process.env.DIRECTUS_TOKEN = "test-token";

const { countDirectusLearningTrajectoriesByScope, listDirectusLearningTrajectories } = await import("../src/directus-store.mjs");

test("按语体 × 领域聚合有效轨迹，空作用域不出现在提示里", async () => {
  const counts = await countDirectusLearningTrajectoriesByScope({ locale: "zh-CN", project: "project-1" });
  // 条数按语体 × 领域；文件优先取轨迹自己的来源文件，没有就退回批次原文件。
  assert.deepEqual(counts, [
    { contentType: "general", domain: "game", count: 67, files: [{ name: "Asia_batch18_new.xlsx_zho-CN.mqxliff", count: 2 }, { name: "Trophy.xlsx_zho-CN.mqxliff", count: 1 }] },
    { contentType: "announcement", domain: "game", count: 4, files: [{ name: "smoke-tier2.txt", count: 1 }] }
  ]);
  const countRequest = requests.find((item) => item.path === "/items/learning_trajectories" && item.query.includes("aggregate%5Bcount%5D"));
  assert.ok(countRequest, "条数要走聚合查询");
  const query = countRequest.query;
  assert.match(query, /aggregate%5Bcount%5D=id/u);
  assert.match(query, /groupBy%5B%5D=content_type/u);
  assert.match(query, /groupBy%5B%5D=domain/u);
  // 口径与「当前范围有效轨迹」一致：completed / review 且已有最终译文；项目必须收窄。
  assert.match(query, /filter%5Bstatus%5D%5B_in%5D=completed%2Creview/u);
  assert.match(query, /filter%5Bfinal_translation%5D%5B_nempty%5D=true/u);
  assert.match(query, /filter%5Bproject%5D%5B_eq%5D=project-1/u);
  assert.match(query, /filter%5Btarget_locale%5D%5B_eq%5D=zh-CN/u);
});

test("选「全部语体 / 全部领域」时不带这两维的 filter", async () => {
  // 学习中心的"全部"是把整维度放开：服务端把 all 换成空串，存储层即不加该维度过滤。
  await listDirectusLearningTrajectories({ locale: "zh-CN", project: "project-1", contentType: "", domain: "", limit: 500 });
  const query = requests.at(-1).query;
  assert.doesNotMatch(query, /content_type/u, "全部语体时不能带 content_type 过滤");
  assert.doesNotMatch(query, /domain/u, "全部领域时不能带 domain 过滤");
  assert.match(query, /filter%5Bproject%5D%5B_eq%5D=project-1/u, "项目与语言照旧收窄");
  assert.match(query, /filter%5Btarget_locale%5D%5B_eq%5D=zh-CN/u);
});
