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

test("没有条目 ID 的风格证据按原文+译文+作用域去重，命中就覆盖", async () => {
  calls.length = 0;
  const saved = await saveDirectusStyleEvidence({ ...baseInput });
  assert.equal(saved.id, "ev-1");
  assert.ok(calls.some((call) => call.method === "PATCH" && call.id === "ev-1"), `应覆盖同一条而不是新增：${JSON.stringify(calls)}`);
  assert.equal(calls.some((call) => call.method === "POST"), false);
  const fallback = calls.find((call) => call.method === "GET" && call.emptyEntryKey);
  assert.ok(fallback, "没有条目 ID 时要退回原文比对");
  // 去重必须限定在同一作用域内，否则会把别的语体/领域的句子当成同一条覆盖掉。
  for (const filter of ["filter%5Btarget_locale%5D%5B_eq%5D=zh-CN", "filter%5Bcontent_type%5D%5B_eq%5D=dialogue", "filter%5Bdomain%5D%5B_eq%5D=game", "filter%5Bproject_id%5D%5B_eq%5D=project-a"]) {
    assert.ok(fallback.query.includes(filter), `去重查询缺少作用域过滤 ${filter}：${fallback.query}`);
  }
});

test("原文相同但译文不同时不覆盖，按新证据写入", async () => {
  calls.length = 0;
  const saved = await saveDirectusStyleEvidence({ ...baseInput, target: "同一句子。" });
  assert.equal(saved.id, "ev-new");
  assert.ok(calls.some((call) => call.method === "POST"));
  assert.equal(calls.some((call) => call.method === "PATCH"), false);
});

test("有条目 ID 时只按 ID + 作用域对齐，不再退回原文比对", async () => {
  calls.length = 0;
  await saveDirectusStyleEvidence({ ...baseInput, entryKey: "ID-9" });
  const lookup = calls.find((call) => call.method === "GET");
  assert.equal(lookup.entryKey, "ID-9");
  assert.equal(lookup.emptyEntryKey, false);
});
