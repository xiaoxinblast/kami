import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 真实浏览器回归：向导步骤里有文件选择这种会触发整块重绘的交互，
 * 步骤内的勾选（AI 清洗 / 风格证据）不能因此被重置。
 */
test("新建项目向导的步骤勾选不会被文件选择重绘掉", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
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

  let createdProjects = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      let payload = {};
      if (path === "/api/bootstrap") payload = {
        locales: { "zh-CN": LOCALES["zh-CN"] }, contentTypes: CONTENT_TYPES, contentTags: CONTENT_TAGS,
        provider: { model: "test", baseUrl: "http://127.0.0.1/v1" }, backend: {}, assets: { "zh-CN": { revision: 0, termCount: 0 } }
      };
      else if (path === "/api/health") payload = { ok: true, version: "0.7.0" };
      else if (path === "/api/projects" && request.method() === "POST") {
        createdProjects += 1;
        payload = { project: { id: "project-new", name: "测试项目", settings: createDefaultProjectSettings() } };
      }
      else if (path === "/api/projects") payload = { projects: [{ id: "project-1", name: "测试项目", settings: createDefaultProjectSettings() }] };
      else if (path === "/api/projects/project-new/libraries") payload = { libraries: [] };
      else if (path === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (path === "/api/memories") payload = { memories: [] };
      else if (path === "/api/feedback/pending" || path === "/api/feedback") payload = [];
      else if (path === "/api/qa-cases/pending") payload = [];
      else if (path === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      else if (path === "/api/assets-import/preview") payload = {
        batchId: "batch-1", statistics: { entries: 1 },
        files: [{ filename: "term_base.xlsx", type: "xlsx", entries: 1, anomalies: [] }],
        candidates: [{ sourceFile: "term_base.xlsx", source: "用語", target: "术语", note: "原表注释", sheetMode: "glossary", locale: "zh-CN", selected: true }]
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector("#newProject");

    await page.locator("#newProject").click();
    await page.waitForSelector("#projectDialog[open]");
    await page.locator('#projectDialog [data-name]').fill("测试项目");
    await page.locator('#projectDialog [data-next]').click();
    assert.equal(createdProjects, 1);
    await page.locator('#projectDialog [data-skip]').click(); // 跳过待译原文件

    const aiCleaning = page.locator("#projectDialog [data-terms-ai-cleaning]");
    await aiCleaning.waitFor();
    await aiCleaning.check();
    assert.equal(await aiCleaning.isChecked(), true);
    await page.locator('#projectDialog input[data-file="terms"]').setInputFiles({ name: "term_base.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("test") });
    await page.waitForTimeout(300);
    assert.equal(await aiCleaning.isChecked(), true, "选文件触发重绘后勾选不能被重置");

    await page.locator('#projectDialog [data-next]').click();
    await page.waitForSelector("#assetPreflightDialog[open]");
    await page.locator('[data-close="assetPreflightDialog"]').first().click();
    await page.waitForTimeout(300);
    const summary = await page.locator("#projectDialog .pw-summary").textContent();
    assert.match(summary, /术语表未导入/u, "取消预检不应声称已提交导入");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
