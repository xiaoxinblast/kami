import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 真实浏览器回归：人工风格指南导入
 *  - 上传控件是个看得出来的按钮，选中后显示文件名；
 *  - 导入成功后给出醒目的"已启用"结果（原来只在右侧显示一行小字）；
 *  - 导入的指南以 active 状态回到列表里（不再是"待批准规范"）。
 */
test("人工风格指南导入后立即启用，并给出明确结果", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
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

  let importBody = null;
  let imported = false;
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/style-guides/import") {
        importBody = JSON.parse(request.postData() || "{}");
        imported = true;
        return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ profile: { id: "up-1", name: "风格指南 · 品牌语气", locale: "zh-CN", instruction: "…", examples: [], version: 1 }, filename: "品牌语气.md", characters: 1234 }) });
      }
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
      else if (url.pathname === "/api/style-profiles") payload = imported
        ? {
          userProfiles: [{ id: "up-1", name: "风格指南 · 品牌语气", instruction: "1. 语气克制。", examples: [], version: 1, evidenceCount: 0, status: "active" }],
          styleProfiles: [], evidencePools: [], learningRuns: []
        }
        : { userProfiles: [], styleProfiles: [], evidencePools: [], learningRuns: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");
    await page.getByRole("button", { name: "风格指导" }).click();
    await page.waitForSelector("#styleGuideFile", { state: "attached" });

    assert.equal(await page.locator("#styleGuideImportButton").textContent(), "导入并立即启用");
    assert.equal(await page.locator("#styleGuideImportButton").isDisabled(), true);
    assert.equal(await page.locator("#styleGuideFileName").textContent(), "支持 TXT / Markdown / DOCX，最大 5MB");

    await page.locator("#styleGuideFile").setInputFiles({ name: "品牌语气.md", mimeType: "text/markdown", buffer: Buffer.from("# 语气\n1. 克制。\n") });
    assert.equal(await page.locator("#styleGuideImportButton").isDisabled(), false);
    assert.match(await page.locator("#styleGuideFileName").textContent(), /品牌语气\.md/u);
    assert.match(await page.locator("#styleGuideImportNote").textContent(), /点右侧按钮导入并立即启用/u);
    assert.equal(await page.locator(".library-file-button.has-file").count(), 1, "选中的上传控件要有可见状态");

    await page.locator("#styleGuideImportButton").click();
    await page.waitForSelector("#styleGuideImportNote.is-ok");
    assert.ok(importBody, "应该发起导入请求");
    assert.equal(importBody.filename, "品牌语气.md");
    assert.match(await page.locator("#styleGuideImportNote").textContent(), /已启用：品牌语气\.md · 1234 字/u);
    await page.waitForSelector("#styleGuidanceList .style-guidance-card.active");
    assert.match(await page.locator("#styleGuidanceList .style-guidance-card").first().textContent(), /已启用/u);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
