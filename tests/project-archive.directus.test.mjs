import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const requests = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
  requests.push({ method: req.method, url: req.url, body });
  let data;
  if (req.method === "GET" && req.url.startsWith("/items/localization_projects/project-1")) {
    data = { id: "project-1", name: "待删除项目", description: "", status: "active", settings: {}, date_created: "2026-09-09T00:00:00.000Z", date_updated: "2026-09-09T00:00:00.000Z" };
  } else if (req.method === "PATCH" && req.url === "/items/localization_projects/project-1") {
    data = { id: "project-1", name: "待删除项目", description: "", status: body.status, settings: {}, date_created: "2026-09-09T00:00:00.000Z", date_updated: "2026-09-09T00:00:00.000Z" };
  } else if (req.method === "GET" && req.url.startsWith("/items/") && req.url.includes("filter=")) {
    data = [];
  } else if (req.method === "DELETE" && req.url === "/items/localization_projects/project-1") {
    data = { id: "project-1" };
  } else {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ errors: [{ message: "not found" }] }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
process.env.DIRECTUS_URL = `http://127.0.0.1:${server.address().port}`;
process.env.DIRECTUS_TOKEN = "test-token";

const { archiveDirectusProject, purgeDirectusProject } = await import("../src/directus-store.mjs");

test("Directus 删除项目采用归档，不物理删除项目记录", async () => {
  const project = await archiveDirectusProject("project-1");
  assert.equal(project.status, "archived");
  const patch = requests.find((item) => item.method === "PATCH");
  assert.deepEqual(patch.body, { status: "archived" });
  assert.equal(requests.some((item) => item.method === "DELETE"), false);
});

test("Directus 彻底删除项目会先清理项目作用域集合再删除项目", async () => {
  const result = await purgeDirectusProject("project-1");
  assert.equal(result.total, 0);
  const scopedQueries = requests.filter((item) => item.method === "GET" && item.url.startsWith("/items/") && item.url.includes("filter="));
  assert.ok(scopedQueries.length >= 20);
  assert.equal(requests.some((item) => item.method === "DELETE" && item.url === "/items/localization_projects/project-1"), true);
});
