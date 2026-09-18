import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 真实浏览器回归：任务中心要能直接控制任务本身——
 * 批次翻译有「暂停 / 继续翻译 / 中断」，导入类任务有「中断 / 继续导入」，
 * 中断过的任务状态显示成"已中断"而不是"失败/进行中"。
 */
test("任务中心提供暂停、继续、中断，并且点击打到对应接口", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
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

  const actions = [];
  const batch = (overrides) => ({
    id: "batch-1", type: "batch", batchId: "batch-1", filename: "dialogue.xlsx", projectId: "project-1",
    locale: "zh-CN", contentType: "general", domain: "game", format: "xlsx", status: "in_progress", runState: "running",
    runnerOptions: { route: "auto", reflect: true }, totalSegments: 5, completedSegments: 2, failedSegments: 0, qaPending: 0,
    updatedAt: "2026-09-18T12:00:00Z", ...overrides
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // 中断会先弹确认框：浏览器默认会自动关闭它，这里显式接受。
    page.on("dialog", (dialog) => dialog.accept());
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/tasks" && request.method() === "GET") {
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify([
            batch(),
            batch({ id: "batch-2", batchId: "batch-2", filename: "interrupted.xlsx", status: "needs_attention", runState: "paused", runnerOptions: { route: "auto", reflect: true, cancelled: true } }),
            {
              id: "task-1", type: "background", taskType: "asset_import", title: "导入 · terms.xlsx", locale: "zh-CN",
              status: "in_progress", contentType: "general", domain: "general", totalSegments: 100, completedSegments: 40,
              progress: { phase: "importing", message: "正在写入：40 / 100", percent: 40, completed: 40, total: 100 },
              payload: { batchId: "b-9", filename: "terms.xlsx" }, updatedAt: "2026-09-18T12:00:00Z"
            },
            {
              id: "task-2", type: "background", taskType: "asset_import", title: "导入 · old.xlsx", locale: "zh-CN",
              status: "needs_attention", contentType: "general", domain: "general", totalSegments: 100, completedSegments: 40,
              progress: { phase: "cancelled", message: "已中断：已写入 40 条，可在任务中心继续导入" },
              payload: { batchId: "b-9", filename: "old.xlsx", resumable: true }, updatedAt: "2026-09-18T12:00:00Z"
            }
          ])
        });
      }
      if (url.pathname.startsWith("/api/batch/run/") || url.pathname.includes("/cancel")) {
        actions.push(`${request.method()} ${url.pathname}`);
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, cancelling: true }) });
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
      else if (url.pathname === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");
    await page.getByRole("button", { name: "任务中心" }).click();
    await page.waitForSelector("#taskList .task-row");

    // 正在跑的批次：暂停 + 中断
    const runningRow = page.locator('#taskList .task-row[data-task-id="batch-1"]');
    assert.match(await runningRow.textContent(), /进行中/u);
    await runningRow.locator('[data-action="pause-task"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#taskList .task-row[data-task-id="batch-1"] [data-action="pause-task"]').length >= 0);
    assert.ok(actions.includes("POST /api/batch/run/batch-1/pause"), `暂停应打到 pause 接口：${actions.join(" | ")}`);
    await page.locator('#taskList .task-row[data-task-id="batch-1"] [data-action="cancel-task"]').click();
    assert.ok(actions.includes("POST /api/batch/run/batch-1/cancel"), `中断应打到 cancel 接口：${actions.join(" | ")}`);

    // 中断过的批次：显示已中断 + 继续翻译
    const interruptedRow = page.locator('#taskList .task-row[data-task-id="batch-2"]');
    assert.match(await interruptedRow.textContent(), /已中断/u);
    assert.equal(await interruptedRow.locator('[data-action="continue-task"]').count(), 1, "中断的批次要给「继续翻译」");
    await interruptedRow.locator('[data-action="continue-task"]').click();
    assert.ok(actions.includes("POST /api/batch/run/batch-2/start"), `继续应打到 start 接口：${actions.join(" | ")}`);

    // 导入类任务：进行中给「中断」，中断过的给「继续导入」
    const runningImport = page.locator('#taskList .task-row[data-task-id="task-1"]');
    assert.equal(await runningImport.locator('[data-action="cancel-background"]').count(), 1);
    await runningImport.locator('[data-action="cancel-background"]').click();
    assert.ok(actions.includes("POST /api/background-tasks/task-1/cancel"), `导入中断应打到后台任务 cancel 接口：${actions.join(" | ")}`);

    const stoppedImport = page.locator('#taskList .task-row[data-task-id="task-2"]');
    assert.match(await stoppedImport.textContent(), /已中断/u);
    assert.equal(await stoppedImport.locator('[data-action="continue-import"]').count(), 1, "中断的导入要给「继续导入」");
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/task-center-actions.png`, fullPage: true, animations: "disabled" });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
