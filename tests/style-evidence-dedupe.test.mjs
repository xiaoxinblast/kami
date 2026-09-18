import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const calls = [];
const existingRow = {
  id: "ev-1",
  project_id: "project-a",
  target_locale: "zh-CN",
  content_type: "dialogue",
  domain: "game",
  source: "同じ文です。",
  target: "同一句话。",
  entry_key: "",
  date_created: "2026-09-18T00:00:00.000Z"
};

const server = http.createServer((req, res) => {
  const url = new URL(`http://directus${req.url}`);
  const entryKey = url.searchParams.get("filter[entry_key][_eq]") || "";
  const emptyEntryKey = url.searchParams.get("filter[entry_key][_empty]") === "true";
  let data = null;
  if (req.method === "GET" && url.pathname === "/items/style_evidence") {
    calls.push({ method: "GET", query: url.search, entryKey, emptyEntryKey });
    data = emptyEntryKey ? [existingRow] : [];
  } else if (req.method === "PATCH" && url.pathname.startsWith("/items/style_evidence/")) {
    const id = url.pathname.split("/").pop();
    calls.push({ method: "PATCH", id });
    data = { id };
  } else if (req.method === "POST" && url.pathname === "/items/style_evidence") {
    calls.push({ method: "POST" });
    data = { id: "ev-new" };
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
process.env.DIRECTUS_URL = `http://127.0.0.1:${server.address().port}`;
process.env.DIRECTUS_TOKEN = "test-token";

const { saveDirectusStyleEvidence } = await import("../src/directus-store.mjs");

const baseInput = {
  locale: "zh-CN",
  projectId: "project-a",
  contentType: "dialogue",
  domain: "game",
  source: "同じ文です。",
  target: "同一句话。",
  embedding: [0.5, 0.5]
};

test("没有条目 ID 的风格证据按原文+译文+项目去重，命中就覆盖", async () => {
  calls.length = 0;
  const saved = await saveDirectusStyleEvidence({ ...baseInput });
  assert.equal(saved.id, "ev-1");
  assert.ok(calls.some((call) => call.method === "PATCH" && call.id === "ev-1"), `应覆盖同一条而不是新增：${JSON.stringify(calls)}`);
  assert.equal(calls.some((call) => call.method === "POST"), false);
  const fallback = calls.find((call) => call.method === "GET" && call.emptyEntryKey);
  assert.ok(fallback, "没有条目 ID 时要退回原文比对");
  // 去重按项目 + 语言：风格资产是项目级的，语体与领域不再参与判重。
  for (const filter of ["filter%5Btarget_locale%5D%5B_eq%5D=zh-CN", "filter%5Bproject_id%5D%5B_eq%5D=project-a"]) {
    assert.ok(fallback.query.includes(filter), `去重查询缺少项目过滤 ${filter}：${fallback.query}`);
  }
  assert.equal(fallback.query.includes("content_type"), false, "去重不再按语体切开");
  assert.equal(fallback.query.includes("domain"), false, "去重不再按领域切开");
});

test("原文相同但译文不同时不覆盖，按新证据写入", async () => {
  calls.length = 0;
  const saved = await saveDirectusStyleEvidence({ ...baseInput, target: "同一句子。" });
  assert.equal(saved.id, "ev-new");
  assert.ok(calls.some((call) => call.method === "POST"));
  assert.equal(calls.some((call) => call.method === "PATCH"), false);
});

test("有条目 ID 时按 ID + 项目对齐，不再退回原文比对", async () => {
  calls.length = 0;
  await saveDirectusStyleEvidence({ ...baseInput, entryKey: "ID-9" });
  const lookup = calls.find((call) => call.method === "GET");
  assert.equal(lookup.entryKey, "ID-9");
  assert.equal(lookup.emptyEntryKey, false);
  assert.equal(lookup.query.includes("content_type"), false, "条目 ID 判重不再按语体切开");
  assert.equal(lookup.query.includes("domain"), false, "条目 ID 判重不再按领域切开");
});
