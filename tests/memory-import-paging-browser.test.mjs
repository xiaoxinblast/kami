import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 真实浏览器回归：一份 8 万行的过往译文（8 万条候选、约 49MB）不能整份塞给浏览器。
 * 预检只回一页样例 + 总数，列表写清"已显示 N / 共 M 条"，可以按页加载更多；
 * 确认导入时只回批次号与取消勾选的序号。
 */
test("预检列表按页取，确认导入只回批次号", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
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

  const TOTAL = 320;
  const SAMPLE = 200;
  const candidate = (index) => ({
    source: `原文${index + 1}`,
    target: `译文${index + 1}`,
    sourceFile: "END過去作訳文.xlsx",
    sourceRow: index + 2,
    selected: true
  });
  let commitBody = null;
  let pageCalls = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      if (path === "/api/tm-import/preview" && request.method() === "POST") {
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({
            batchId: "batch-big",
            filename: "END過去作訳文.xlsx",
            sourceFileType: "xlsx",
            candidates: Array.from({ length: SAMPLE }, (_, index) => candidate(index)),
            total: TOTAL,
            sampleLimit: SAMPLE,
            statistics: { rowsScanned: TOTAL, pairedRows: TOTAL, truncated: false, totalRows: TOTAL + 1, rowLimit: 200_000 }
          })
        });
      }
      if (path === "/api/tm-import/preview/batch-big") {
        pageCalls += 1;
        const offset = Number(url.searchParams.get("offset")) || 0;
        const limit = Number(url.searchParams.get("limit")) || SAMPLE;
        const items = Array.from({ length: Math.max(0, Math.min(limit, TOTAL - offset)) }, (_, index) => candidate(offset + index));
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ batchId: "batch-big", total: TOTAL, offset, limit, items }) });
      }
      if (path === "/api/tm-import/commit") {
        commitBody = JSON.parse(request.postData() || "{}");
        return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ taskId: "task-1", accepted: TOTAL - 1, background: true }) });
      }
      if (path === "/api/background-tasks/task-1") {
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({ id: "task-1", status: "completed", progress: { percent: 100, message: "导入完成" }, payload: { summary: { memories: TOTAL - 1, skipped: 0, trajectoriesLinked: 0 } } })
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
      else if (path === "/api/projects/project-1/libraries") payload = {
        projectId: "project-1",
        libraries: [{ id: "tm-master", projectId: "project-1", name: "主 TM", kind: "translation_memory", role: "master", enabled: true, priority: 1, entryCount: 0 }]
      };
      else if (path === "/api/feedback/pending" || path === "/api/feedback") payload = [];
      else if (path === "/api/qa-cases/pending") payload = [];
      else if (path === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");
    await page.getByRole("button", { name: "记忆库 TM" }).click();

    await page.waitForSelector('#memoryLibraryBody .library-row[data-library-id="tm-master"]');
    await page.locator('#memoryLibraryBody .library-row[data-library-id="tm-master"] [data-library-action="import"]').click();
    await page.waitForSelector("#memoryImportDialog[open]");
    await page.locator("#memoryFile").setInputFiles([{ name: "END過去作訳文.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("test") }]);

    await page.waitForSelector("#memoryImportPreview:visible");
    // 只渲染一页，并且写清总量——8 万条不能铺进 DOM。
    assert.equal(await page.locator("#memoryImportPreviewBody tr").count(), SAMPLE);
    assert.equal(await page.locator("#memoryImportCount").textContent(), `已显示 ${SAMPLE} / 共 ${TOTAL} 条`);
    assert.match(await page.locator("#memoryImportNote").textContent(), new RegExp(`本地预检识别 ${TOTAL} 条双语 TM`, "u"));
    assert.equal(await page.locator("#memoryImportMore").isVisible(), true);

    await page.locator("#memoryImportMore").click();
    await page.waitForFunction((expected) => document.querySelectorAll("#memoryImportPreviewBody tr").length === expected, TOTAL);
    assert.equal(pageCalls, 1, "第二页要走分页接口");
    assert.equal(await page.locator("#memoryImportCount").textContent(), `已显示 ${TOTAL} / 共 ${TOTAL} 条`);
    assert.equal(await page.locator("#memoryImportMore").isVisible(), false);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.locator("#memoryImportDialog").screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/memory-import-paging.png`, animations: "disabled" });
    }

    // 取消第一条：确认导入只回批次号 + 取消勾选的序号，不回传候选本体。
    await page.locator("#memoryImportPreviewBody tr").first().locator("input").uncheck();
    await page.locator("#memoryImportConfirm").click();
    await page.waitForFunction(() => Boolean(document.querySelector("#memoryImportProgress") && !document.querySelector("#memoryImportProgress").hidden));
    assert.ok(commitBody, "要发出提交请求");
    assert.equal(commitBody.candidates, undefined, "候选不应再经过浏览器回传");
    assert.deepEqual(commitBody.batches, [{ batchId: "batch-big", filename: "END過去作訳文.xlsx", sourceFileType: "xlsx", deselected: [0] }]);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
