import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const requests = [];
const server = http.createServer((req, res) => {
  requests.push(req.url);
  const url = new URL(`http://directus${req.url}`);
  const projectId = url.searchParams.get("filter[project_id][_eq]") || "";
  const emptyProject = url.searchParams.get("filter[project_id][_empty]") === "true";
  const data = emptyProject ? [] : [{
    id: "profile-a",
    project_id: projectId,
    name: "A 风格",
    target_locale: "zh-CN",
    content_type: "dialogue",
    content_tags: [],
    domain: "game",
    instructions: "A",
    review_rubric: null,
    examples: [],
    rules: [],
    version: 1,
    parent_id: null,
    evidence_count: 0,
    evidence_ids: [],
    generated_by: "",
    source_batch_id: "",
    learning_run_id: "",
    status: "active",
    date_updated: "2026-09-09T00:00:00.000Z"
  }];
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
process.env.DIRECTUS_URL = `http://127.0.0.1:${server.address().port}`;
process.env.DIRECTUS_TOKEN = "test-token";

const { getDirectusStyleProfile } = await import("../src/directus-store.mjs");

test("Directus 读取生效风格规范时按项目过滤，未归属项目只查空项目", async () => {
  const profile = await getDirectusStyleProfile("zh-CN", "dialogue", "game", { projectId: "project-a" });
  assert.equal(profile.projectId, "project-a");
  assert.equal(profile.instruction, "A");
  const scoped = requests.find((url) => url.includes("filter%5Bproject_id%5D%5B_eq%5D=project-a"));
  assert.ok(scoped, "必须带 project_id 精确过滤");

  assert.equal(await getDirectusStyleProfile("zh-CN", "dialogue", "game"), null);
  const empty = requests.find((url) => url.includes("filter%5Bproject_id%5D%5B_empty%5D=true"));
  assert.ok(empty, "未传项目时必须只查空项目，不能回落到其他项目");
});
