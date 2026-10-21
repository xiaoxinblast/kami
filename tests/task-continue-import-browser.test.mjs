import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 真实浏览器回归：任务中心的「继续导入」按任务类型分流。
 *
 * TM 导入（term_import）现在改成"队列后置"：失败时库里没有候选可续，
 * 续跑要带批次号去打 /api/tm-import/commit（服务端从预检缓存读候选）。
 * 资产导入（asset_import）保持走 /api/assets-import/resume。
 */
test("TM 导入失败后「继续导入」打的是 /api/tm-import/commit", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.KAMI_BROWSER_TEST_MODULE);
  const browser = await chromium.launch({ headless: true, ...(process.env.KAMI_BROWSER_EXECUTABLE ? { executablePath: process.env.KAMI_BROWSER_EXECUTABLE } : {}) });
  const server = createServer(async (req, res) => {
    const pathname = req.url === "/" ? "/index.html" : req.url;
    const extension = pathname.split(".").at(-1);
    try {
      const body = await readFile(new URL(`../public${pathname}`, import.meta.url));
      res.setHeader("content-type", ({ html: "text/html", js: "text/javascript", css: "text/css", png: "image/png", svg: "image/svg+xml" })[extension] || "application/octet-stream");
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  let continueBody = null;
  let resumeBody = null;
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/tm-import/commit") {
        continueBody = JSON.parse(request.postData() || "{}");
        return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ taskId: "task-new", accepted: 72099, background: true }) });
      }
      if (path === "/api/assets-import/resume") {
        resumeBody = JSON.parse(request.postData() || "{}");
        return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ taskId: "task-asset" }) });
      }
      let payload = {};
      if (path === "/api/bootstrap") payload = {
        locales: { "zh-CN": LOCALES["zh-CN"] }, contentTypes: CONTENT_TYPES, contentTags: CONTENT_TAGS,
        provider: { model: "test", baseUrl: "http://127.0.0.1/v1" }, backend: {}, assets: { "zh-CN": { revision: 0, termCount: 0 } }
      };
      else if (path === "/api/health") payload = { ok: true, version: "0.7.0" };
      else if (path === "/api/projects") payload = { projects: [{ id: "project-1", name: "测试项目", settings: createDefaultProjectSettings() }] };
      else if (path === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (path === "/api/memories") payload = { memories: [], total: 0 };
      else if (path === "/api/tasks") payload = [
        {
          id: "task-1", type: "background", taskType: "term_import", title: "TM 导入 · END過去作訳文.xlsx",
          projectId: "project-1", locale: "zh-CN", status: "needs_attention",
          progress: { phase: "failed", message: "ReferenceError: persistedBatchId is not defined", percent: 100, completed: 0, total: 72099 },
          payload: { batchId: "11111111-2222-3333-4444-555555555555", filename: "END過去作訳文.xlsx", resumable: true },
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
        }
      ];
      else if (path === "/api/feedback/pending" || path === "/api/feedback") payload = [];
      else if (path === "/api/qa-cases/pending") payload = [];
      else if (path === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");
    await page.getByRole("button", { name: "任务中心" }).click();
    await page.waitForSelector('[data-action="continue-import"]');
    await page.locator('[data-action="continue-import"]').first().click();
    await page.waitForTimeout(600);
    assert.ok(continueBody, "TM 导入的续传要打 /api/tm-import/commit");
    assert.equal(continueBody.batchId, "11111111-2222-3333-4444-555555555555");
    assert.equal(continueBody.background, true);
    assert.equal(resumeBody, null, "TM 导入不该走资产导入的续传接口");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
