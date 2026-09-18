import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 真实浏览器回归：双语资产预检要逐文件进行，界面上必须看得见文件清单、
 * N/M 进度与每个文件的结果——只有一句"正在预检"用户无法判断是不是卡住了。
 */
test("双语资产预检显示文件清单与逐文件进度", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
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

  const previewBodies = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/assets-import/preview") {
        const body = JSON.parse(request.postData() || "{}");
        previewBodies.push(body);
        const file = body.files?.[0]?.filename || "unknown";
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({
            batchId: "batch-1",
            files: [{ filename: file, type: "xlsx", entries: 2, anomalies: [], defaultPurpose: "term_cleaning" }],
            candidates: [
              { sourceFile: file, source: "用語", target: "术语", note: "原表注释", sheetMode: "glossary", locale: "zh-CN", selected: true },
              { sourceFile: file, source: "用語集", target: "术语表", note: "", sheetMode: "glossary", locale: "zh-CN", selected: true }
            ],
            statistics: { files: 1, entries: 2, anomalies: 0 }
          })
        });
      }
      let payload = {};
      if (path === "/api/bootstrap") payload = {
        locales: { "zh-CN": LOCALES["zh-CN"] }, contentTypes: CONTENT_TYPES, contentTags: CONTENT_TAGS,
        provider: { model: "test", baseUrl: "http://127.0.0.1/v1" }, backend: {}, assets: { "zh-CN": { revision: 0, termCount: 0 } }
      };
      else if (path === "/api/health") payload = { ok: true, version: "0.7.0" };
      else if (path === "/api/projects") payload = { projects: [{ id: "project-1", name: "测试项目", settings: createDefaultProjectSettings() }] };
      else if (path === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (path === "/api/memories") payload = { memories: [] };
      else if (path === "/api/feedback/pending" || path === "/api/feedback") payload = [];
      else if (path === "/api/qa-cases/pending") payload = [];
      else if (path === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");
    await page.getByRole("button", { name: "双语资产导入" }).click();
    await page.waitForSelector("#termFile", { state: "attached" });

    const file = (name) => ({ name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("test") });
    await page.locator("#termFile").setInputFiles([file("a.xlsx"), file("b.xlsx"), file("c.xlsx")]);

    await page.waitForSelector("#importFileList:visible");
    assert.equal(await page.locator("#importFileList li").count(), 3);
    assert.match(await page.locator(".import-file-head").textContent(), /3 个文件/u);
    await page.waitForSelector("#assetPreflightDialog[open]");
    assert.equal(previewBodies.length, 3, "应当逐个文件预检，而不是一次性提交整批");
    assert.deepEqual(previewBodies.map((body) => body.files[0].filename), ["a.xlsx", "b.xlsx", "c.xlsx"]);
    assert.equal(await page.locator("#importFileList li.done").count(), 3);
    assert.match(await page.locator(".import-file-head span").textContent(), /已预检 3 \/ 3/u);
    assert.match(await page.locator("#fileMeta").textContent(), /预检完成：3 \/ 3 个文件，共 6 条双语条目 · 已用时/u);
    assert.match(await page.locator("#assetPreflightSummary").textContent(), /已识别 3 个文件、6 条双语条目/u);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
