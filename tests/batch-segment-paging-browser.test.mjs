import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 批次分段列表分页：250 段时首屏只渲染 200 段，点「加载更多」才补到全量。
 * 防止以后有人把 renderBatchSegments 改回一次性 innerHTML 全部行。
 */
function mockServer() {
  return createServer(async (req, res) => {
    const pathname = req.url === "/" ? "/index.html" : req.url;
    const extension = pathname.split(".").at(-1);
    try {
      const body = await readFile(new URL(`../public${pathname}`, import.meta.url));
      res.setHeader("content-type", ({ html: "text/html", js: "text/javascript", css: "text/css", png: "image/png", svg: "image/svg+xml" })[extension] || "application/octet-stream");
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
}

const segments = Array.from({ length: 250 }, (_, index) => ({
  id: `seg-${index + 1}`, index: index + 1, source: `原文${index + 1}`, translation: `译文${index + 1}`,
  selected: true, status: "done", result: { qualityTier: "standard" }, locator: { type: "text-segment" }
}));

test("批次分段列表首屏分页，加载更多补齐", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.KAMI_BROWSER_TEST_MODULE);
  const browser = await chromium.launch({ headless: true, ...(process.env.KAMI_BROWSER_EXECUTABLE ? { executablePath: process.env.KAMI_BROWSER_EXECUTABLE } : {}) });
  const server = mockServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
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
      else if (url.pathname === "/api/projects/project-1/libraries") payload = { libraries: [] };
      else if (url.pathname === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (url.pathname === "/api/memories") payload = { memories: [], total: 0 };
      else if (url.pathname === "/api/feedback/pending" || url.pathname === "/api/feedback") payload = [];
      else if (url.pathname === "/api/qa-cases/pending") payload = [];
      else if (url.pathname === "/api/tasks") payload = [];
      else if (url.pathname === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      else if (url.pathname === "/api/batch/files") payload = {
        total: 1,
        files: [{
          batchId: "batch-1", filename: "big.mqxliff", format: "mqxliff", runState: "ready", status: "in_progress",
          totalSegments: 250, completedSegments: 250, failedSegments: 0, qaPending: 0, brief: { status: "ready", sections: 1 },
          qualityTiers: { fast: 0, standard: 250, strict: 0, unrecorded: 0 }, learning: { count: 0, humanReviewed: 0 },
          hasOriginal: true, originalBytes: 1000, updatedAt: "2026-10-21T10:00:00.000Z"
        }]
      };
      else if (url.pathname === "/api/batch/run/batch-1") payload = {
        batchId: "batch-1", filename: "big.mqxliff", locale: "zh-CN", contentType: "general", domain: "game",
        format: "mqxliff", segmentationMode: "unit", runState: "completed", projectId: "project-1",
        runnerOptions: {}, requiresBrief: false, contextBriefPending: false,
        contextBrief: { status: "ready", documentType: { purpose: "dialogue", summary: "测试" }, sections: [{ from: 1, to: 250, purpose: "dialogue" }], coverage: { covered: 250, total: 250 } },
        segments
      };
      else if (url.pathname === "/api/batch/run/batch-1/context-brief") payload = { batchId: "batch-1", pending: false, brief: { status: "ready", sections: [] } };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });

    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector("#fileListWorkspace:not([hidden])");
    await page.waitForSelector('#batchFileList .batch-file-row[data-batch-file="batch-1"]');
    await page.locator('#batchFileList .batch-file-row[data-batch-file="batch-1"] [data-batch-action="open"]').click();
    await page.waitForSelector("#batchWorkspace:not([hidden])");
    await page.waitForFunction(() => document.querySelectorAll("#batchSegments .batch-segment").length === 200, null, { timeout: 15000 });
    assert.match(await page.locator("#batchSegmentCount").innerText(), /已显示 200 \/ 共 250 条/u);
    assert.equal(await page.locator("#batchLoadMore").count(), 1, "首屏应有加载更多按钮");
    assert.match(await page.locator("#batchLoadMore").innerText(), /还有 50 条/u);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/batch-segment-paging.png`, animations: "disabled" });
    }
    await page.locator("#batchLoadMore").click();
    await page.waitForFunction(() => document.querySelectorAll("#batchSegments .batch-segment").length === 250, null, { timeout: 15000 });
    assert.match(await page.locator("#batchSegmentCount").innerText(), /已显示 250 \/ 共 250 条/u);
    assert.equal(await page.locator("#batchLoadMore").count(), 0, "全量渲染后不再显示加载更多");
    assert.deepEqual(errors, [], `页面不应抛异常：${errors.join(" | ")}`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
