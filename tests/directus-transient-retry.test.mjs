import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";

/**
 * 工作台到 Directus 的连接会偶发被对端掐断（Windows 上复用中的 keep-alive 连接受限、
 * Directus 重启、容器抖动），undici 抛的是 `TypeError: fetch failed`。
 *
 * 实测事故：这种抖动会把 /api/tasks、/api/style-profiles、/api/qa-cases/pending 一起
 * 变成 HTTP 500 并写进日志。一次网络抖动不该等于一次报错，所以只读请求要重试。
 */
const attempts = [];
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://directus").pathname;
  attempts.push(`${req.method} ${path}`);
  if (attempts.filter((entry) => entry === `${req.method} ${path}`).length === 1) {
    // 第一次直接掐断连接，模拟"复用的连接刚好被对端关掉"。
    req.socket.destroy();
    return;
  }
  for await (const _chunk of req) { /* 读干净请求体，避免连接被重置 */ }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: { id: "project-a", name: "测试项目" } }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
process.env.DIRECTUS_URL = `http://127.0.0.1:${server.address().port}`;
process.env.DIRECTUS_TOKEN = "test-token";

const { getDirectusProject, saveDirectusResourceLibrary } = await import("../src/directus-store.mjs");

test("只读请求遇到连接被掐断会重试，不会把抖动放大成 500", async () => {
  attempts.length = 0;
  const project = await getDirectusProject("project-a");
  assert.equal(project.id, "project-a");
  assert.equal(attempts.length, 2, `第一次失败后要再试一次：${attempts.join(" | ")}`);
  assert.deepEqual(attempts, [attempts[0], attempts[0]], "两次请求打的是同一个地址");
});

test("写请求不重试：断在连接层也直接抛错，避免重复写入", async () => {
  attempts.length = 0;
  await assert.rejects(
    () => saveDirectusResourceLibrary({ projectId: "project-a", name: "参考 TM", kind: "translation_memory", role: "reference" }),
    // 连接层失败要把 undici 的 cause 带出来，否则日志里只有一句 fetch failed。
    /连接失败/u
  );
  assert.equal(attempts.length, 1, "写请求只发一次");
});

test("只读请求把超时也纳入重试（写请求不带重试）", async () => {
  // 实测事故：Directus 偶发 stall 触发 10 秒超时，/api/tasks 直接 500。
  // 只读请求补一次重试；写请求不补——超时可能只是响应慢，重试会重复写入。
  const source = await readFile(new URL("../src/directus-store.mjs", import.meta.url), "utf8");
  assert.match(source, /\.\.\.\(idempotent \? \{ retries: 1, retryDelayMs: 250 \} : \{\}\)/u);
  assert.match(source, /const idempotent = method === "GET" \|\| method === "HEAD";/u);
});

test.after(() => server.close());
