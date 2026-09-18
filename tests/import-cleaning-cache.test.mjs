import test from "node:test";
import assert from "node:assert/strict";

/**
 * 续跑省模型调用靠的是"清洗结论写回候选行"：这一层必须真的把
 * ai-cleaned 标记写进 term_candidates，并让本轮新产生的句内术语作为新行进同一批次，
 * 否则续跑要么重洗整批、要么丢掉句内术语。
 */
process.env.DIRECTUS_URL = "http://directus.test";
process.env.DIRECTUS_TOKEN = "test-token";

const { persistDirectusImportCleaning } = await import("../src/directus-store.mjs");

function stubFetch() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), method: init.method || "GET", body });
    return {
      ok: true,
      status: init.method === "POST" ? 200 : 200,
      statusText: "OK",
      text: async () => JSON.stringify(Array.isArray(body) ? body.map((row, index) => ({ ...row, id: row.id || `new-${index}` })) : {})
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("清洗结论写回：老候选打 ai-cleaned 标记，句内术语作为新行进同一批次", async () => {
  const stub = stubFetch();
  try {
    const total = await persistDirectusImportCleaning("batch-1", {
      projectId: "project-1",
      filename: "terms.xlsx",
      candidates: [
        { candidateId: "c-1", source: "用語", target: "术语", decision: "ready", assetType: "memory", contentType: "dialogue", domain: "game", reasons: ["完整句段可归档"] },
        { source: "水簾洞", target: "水帘洞", locale: "zh-CN", candidateKey: "k-1", candidateRole: "embedded_term", candidateOrigin: "ai-term-extraction", decision: "review", assetType: "term", reasons: ["句内专名"] }
      ]
    });
    assert.equal(total, 2);

    const patch = stub.calls.find((call) => call.method === "PATCH");
    assert.ok(patch, "老候选要用 PATCH 更新");
    assert.match(patch.url, /\/items\/term_candidates/u);
    assert.deepEqual(patch.body, [{
      id: "c-1",
      decision: "ready",
      reason: "完整句段可归档",
      asset_type: "memory",
      content_type: "dialogue",
      domain: "game",
      classification_source: "ai-cleaned"
    }]);

    const post = stub.calls.find((call) => call.method === "POST");
    assert.ok(post, "本轮新产生的句内术语要写入同一批次");
    assert.equal(post.body.length, 1);
    assert.equal(post.body[0].batch_id, "batch-1");
    assert.equal(post.body[0].project_id, "project-1");
    assert.equal(post.body[0].candidate_role, "embedded_term");
    assert.equal(post.body[0].classification_source, "ai-cleaned", "新行也要带标记，续跑时同样跳过");
    assert.equal(post.body[0].decision, "review");
    assert.equal(post.body[0].source_file, "terms.xlsx");
  } finally {
    stub.restore();
  }
});

test("没有候选时不发任何请求", async () => {
  const stub = stubFetch();
  try {
    assert.equal(await persistDirectusImportCleaning("batch-1", { candidates: [] }), 0);
    assert.deepEqual(stub.calls, []);
  } finally {
    stub.restore();
  }
});
