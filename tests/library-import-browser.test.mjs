import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

test("术语表与风格指南可从各自页面进入完整导入流程", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 60000 }, async () => {
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
  let importedGuide = false;
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
      else if (path === "/api/projects") payload = { projects: [{ id: "project-1", name: "测试项目", settings: createDefaultProjectSettings() }] };
      else if (path === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (path === "/api/memories") payload = { memories: [] };
      else if (path === "/api/feedback/pending" || path === "/api/feedback") payload = [];
      else if (path === "/api/qa-cases/pending") payload = [];
      else if (path === "/api/style-profiles") payload = {
        styleProfiles: [], evidencePools: [], learningRuns: [],
        userProfiles: importedGuide ? [{ id: "guide-1", name: "风格指南 · 项目风格指南", locale: "zh-CN", instruction: "对白使用自然口语。", version: 1, evidenceCount: 0, status: "draft" }] : []
      };
      else if (path === "/api/assets-import/preview") payload = {
        batchId: "batch-1", statistics: { entries: 2 },
        files: [{ filename: "terms.xlsx", type: "xlsx", entries: 2, defaultPurpose: "tm", anomalies: [] }],
        candidates: [{ sourceFile: "terms.xlsx", source: "用語", target: "术语", locale: "zh-CN", selected: true }]
      };
      else if (path === "/api/style-guides/import") {
        importedGuide = true;
        payload = { filename: "项目风格指南.md", characters: 9, profile: { id: "guide-1" } };
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole("button", { name: "术语库" }).click();
    await page.locator("#termLibraryFile").setInputFiles({ name: "terms.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("test") });
    await page.locator("#assetPreflightDialog").waitFor({ state: "visible" });
    assert.equal(await page.locator('[data-asset-purpose="0"]').inputValue(), "term_cleaning");
    assert.equal(await page.locator('[data-asset-purpose="0"]').isDisabled(), true);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/term-library-upload.png`, animations: "disabled" });
    }
    await page.locator('[data-close="assetPreflightDialog"]').first().click();
    await page.getByRole("button", { name: "风格指导" }).click();
    await page.locator("#styleGuideFile").setInputFiles({ name: "项目风格指南.md", mimeType: "text/markdown", buffer: Buffer.from("对白使用自然口语。", "utf8") });
    assert.equal(await page.locator("#styleGuideImportButton").isDisabled(), false);
    await page.locator("#styleGuideImportButton").click();
    await page.getByText("风格指南 · 项目风格指南", { exact: true }).waitFor();
    await page.getByText("人工上传，正文未被改写", { exact: false }).waitFor();
    assert.match(await page.locator("#styleGuideImportNote").textContent(), /已进入待批准规范/u);
    assert.equal(await page.locator(".style-state", { hasText: "待批准" }).count(), 1);
    if (process.env.KAMI_UI_SCREENSHOTS) await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/style-guide-upload.png`, animations: "disabled" });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
