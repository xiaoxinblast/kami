import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 真实浏览器回归：Directus 压力保护（503 Under pressure）不该让用户看到一屏红字。
 * 界面要自动等一下再试一次；第一次的 503 不写 error 日志，只有重试仍失败才记 warn。
 */
test("Directus 返回 503 压力保护时，界面自动重试一次并正常加载", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
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

  const projectsCalls = [];
  const clientLogs = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      let payload = {};
      let status = 200;
      if (url.pathname === "/api/bootstrap") payload = {
        locales: { "zh-CN": LOCALES["zh-CN"] }, contentTypes: CONTENT_TYPES, contentTags: CONTENT_TAGS,
        provider: { model: "test", baseUrl: "http://127.0.0.1/v1" }, backend: {}, assets: { "zh-CN": { revision: 0, termCount: 0 } }
      };
      else if (url.pathname === "/api/health") payload = { ok: true, version: "0.7.0" };
      else if (url.pathname === "/api/projects") {
        projectsCalls.push(Date.now());
        // 第一次返回 Directus 的压力保护，第二次成功：界面应自动重试并正常显示项目。
        if (projectsCalls.length === 1) {
          status = 503;
          payload = { error: 'Directus GET /items/batch_runs 失败（503 Service "api" is unavailable. Under pressure.）' };
        } else {
          payload = { projects: [{ id: "project-1", name: "测试项目", settings: createDefaultProjectSettings() }] };
        }
      }
      else if (url.pathname === "/api/projects/project-1/libraries") payload = { libraries: [] };
      else if (url.pathname === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (url.pathname === "/api/memories") payload = { memories: [], total: 0 };
      else if (url.pathname === "/api/feedback/pending" || url.pathname === "/api/feedback") payload = [];
      else if (url.pathname === "/api/qa-cases/pending") payload = [];
      else if (url.pathname === "/api/learning/evaluation-jobs") payload = { jobs: [] };
      else if (url.pathname === "/api/tasks") payload = [];
      else if (url.pathname === "/api/logs" && route.request().method() === "POST") {
        clientLogs.push(route.request().postData() || "");
        payload = { ok: true };
      }
      else if (url.pathname === "/api/logs") payload = { entries: [] };
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
    });

    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");
    // 自动重试之后项目要正常出现（说明不是把 503 直接抛给用户）。
    await page.waitForFunction(() => document.querySelector("#projectSelect")?.value === "project-1");
    assert.equal(projectsCalls.length, 2, "第一次 503 后应自动重试一次");
    assert.equal(await page.locator("#projectSelect").inputValue(), "project-1");
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/directus-busy-retry.png`, animations: "disabled" });
    }
    await page.waitForTimeout(300);
    assert.equal(clientLogs.filter((entry) => /Under pressure/u.test(entry)).length, 0, "第一次 503 不该写进错误日志");
    assert.deepEqual(errors, [], `页面不应抛异常：${errors.join(" | ")}`);
  } finally {
    await browser.close();
    server.close();
  }
});
