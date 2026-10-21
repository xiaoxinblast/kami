import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";
import { waitForText } from "./fixtures/browser-wait.mjs";

test("任务中心的参考资料进度会自动刷新到完成", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.KAMI_BROWSER_TEST_MODULE);
  const browser = await chromium.launch({ headless: true, ...(process.env.KAMI_BROWSER_EXECUTABLE ? { executablePath: process.env.KAMI_BROWSER_EXECUTABLE } : {}) });
  const server = createServer(async (req, res) => {
    const pathname = req.url === "/" ? "/index.html" : req.url;
    const extension = pathname.split(".").at(-1);
    try {
      const body = await readFile(new URL(`../public${pathname}`, import.meta.url));
      res.setHeader("content-type", ({ html: "text/html", js: "text/javascript", css: "text/css", png: "image/png", svg: "image/svg+xml" })[extension] || "application/octet-stream");
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let taskPolls = 0;
  let finishTask = false;
  const referenceTask = (status, completed) => ({
    id: "ref-task-1",
    type: "background",
    taskType: "reference_ingest",
    title: "参考资料导入：END3_列車ミニゲーム.xlsx",
    locale: "zh-CN",
    status,
    totalSegments: 122,
    completedSegments: completed,
    failedSegments: 0,
    qaPending: 0,
    progress: status === "in_progress"
      ? { phase: "vision", message: `正在识图：${completed} / 122`, percent: 20, completed, total: 122 }
      : { phase: "completed", message: "参考资料已就绪：250 个片段", percent: 100, completed: 250, total: 250 },
    payload: { documentId: "doc-1" },
    updatedAt: "2026-09-26T02:00:00Z"
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      let payload = {};
      if (url.pathname === "/api/bootstrap") payload = {
        locales: { "zh-CN": LOCALES["zh-CN"] }, contentTypes: CONTENT_TYPES, contentTags: CONTENT_TAGS,
        provider: { model: "test", baseUrl: "http://127.0.0.1/v1" }, backend: {}, assets: { "zh-CN": { revision: 0, termCount: 0 } }
      };
      else if (url.pathname === "/api/health") payload = { ok: true, version: "0.7.0" };
      else if (url.pathname === "/api/projects") payload = { projects: [{ id: "project-1", name: "测试项目", settings: createDefaultProjectSettings() }] };
      else if (url.pathname === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (url.pathname === "/api/memories") payload = { memories: [], total: 0 };
      else if (url.pathname === "/api/feedback/pending" || url.pathname === "/api/feedback") payload = [];
      else if (url.pathname === "/api/qa-cases/pending") payload = [];
      else if (url.pathname === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      else if (url.pathname === "/api/tasks") {
        taskPolls += 1;
        payload = [finishTask ? referenceTask("completed", 122) : referenceTask("in_progress", 12)];
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('.nav-item[data-view="tasks"]').click();
    await waitForText(page.locator("#taskList"), /正在识图：12 \/ 122/u);
    assert.match(await page.locator("#taskList").textContent(), /参考资料导入/u, "后台任务要显示正确的类型标签");
    finishTask = true;
    await waitForText(page.locator("#taskList"), /已完成/u, { timeoutMs: 8000 });
    assert.ok(taskPolls >= 2, "任务中心应在没有点刷新时自动轮询");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
