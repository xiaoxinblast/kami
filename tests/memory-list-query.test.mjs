import test from "node:test";
import assert from "node:assert/strict";

/**
 * 记忆库列表接口的查询口径回归：
 *  - 按 date_created 倒序（date_updated 允许为空，NULL 在 DESC 里会挤到最前面）；
 *  - offset 分页；keyword 同时匹配日语原文与简体中文译文；
 *  - 总数走 aggregate，过滤条件与列表共用同一套，保证"共 N 条"和列表口径一致。
 */
process.env.DIRECTUS_URL = "http://directus.test";
process.env.DIRECTUS_TOKEN = "test-token";

const { getDirectusMemories, countDirectusMemories } = await import("../src/directus-store.mjs");

function stubFetch(payload) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify(payload)
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("记忆库列表按创建时间倒序，并且支持 offset 分页", async () => {
  const stub = stubFetch({ data: [{ id: "m1", source: "用語", target: "术语", date_created: "2026-09-18T10:00:00Z" }] });
  try {
    const items = await getDirectusMemories("zh-CN", { projectId: "p1", limit: 500, offset: 500 });
    assert.equal(items.length, 1);
    const url = new URL(stub.calls[0]);
    assert.equal(url.searchParams.get("limit"), "500");
    assert.equal(url.searchParams.get("offset"), "500");
    assert.equal(url.searchParams.get("sort"), "-date_created", "不能按 date_updated 排：NULL 会排到最前面");
    assert.equal(url.searchParams.get("filter[_and][0][project_id][_eq]"), "p1");
  } finally {
    stub.restore();
  }
});

test("关键词同时匹配日语原文与简体中文译文", async () => {
  const stub = stubFetch({ data: [] });
  try {
    await getDirectusMemories("zh-CN", { projectId: "p1", search: "用語" });
    const url = new URL(stub.calls[0]);
    assert.equal(url.searchParams.get("filter[_and][1][_or][0][source][_icontains]"), "用語");
    assert.equal(url.searchParams.get("filter[_and][1][_or][1][target][_icontains]"), "用語");
  } finally {
    stub.restore();
  }
});

test("总数走 aggregate，且不拉取数据行", async () => {
  const stub = stubFetch({ data: [{ count: { id: "8012" } }] });
  try {
    const total = await countDirectusMemories("zh-CN", { projectId: "p1" });
    assert.equal(total, 8012);
    const url = new URL(stub.calls[0]);
    assert.equal(url.searchParams.get("aggregate[count]"), "id");
    assert.equal(url.searchParams.get("filter[_and][0][project_id][_eq]"), "p1");
    assert.equal(url.searchParams.get("limit"), null, "计数请求不该带 limit");
    assert.equal(url.searchParams.get("fields"), null);
  } finally {
    stub.restore();
  }
});

test("按语体/领域收窄时，计数与列表的过滤口径一致", async () => {
  const stub = stubFetch({ data: [{ count: { id: "12" } }] });
  try {
    await countDirectusMemories("zh-CN", { projectId: "p1", contentType: "ui", domain: "game" });
    const url = new URL(stub.calls[0]);
    assert.equal(url.searchParams.get("filter[_and][1][_or][0][content_type][_eq]"), "ui");
    assert.equal(url.searchParams.get("filter[_and][1][_or][1][content_type][_eq]"), "general");
    assert.equal(url.searchParams.get("filter[_and][2][_or][0][domain][_eq]"), "game");
    assert.equal(url.searchParams.get("filter[_and][2][_or][1][domain][_eq]"), "general");
  } finally {
    stub.restore();
  }
});
