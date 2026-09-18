import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 真实浏览器回归：术语库 / 记忆库改成"库列表 → 条目视图"两级后，
 * 打开库、搜索、编辑、删除、行内导入导出、启用开关都要真的打到对应接口。
 */
test("术语库与记忆库按库浏览：打开/编辑/删除/导入/导出都落到对应库", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 120000 }, async () => {
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

  const calls = [];
  const writes = [];
  const libraries = [
    { id: "term-1", projectId: "project-1", name: "术语库", kind: "term_base", role: "reference", enabled: true, priority: 1, entryCount: 5856, lastEntryAt: "2026-09-18T13:38:29Z" },
    { id: "tm-master", projectId: "project-1", name: "主 TM", kind: "translation_memory", role: "master", enabled: true, priority: 1, entryCount: 8012, lastEntryAt: "2026-09-18T10:14:14Z" },
    { id: "tm-working", projectId: "project-1", name: "工作 TM", kind: "translation_memory", role: "working", enabled: true, priority: 2, entryCount: 66, lastEntryAt: "2026-09-18T12:03:15Z" }
  ];
  const entries = {
    "term-1": [
      { id: "t1", source: "バアル", target: "巴尔", note: "人名", libraryId: "term-1", contentTypes: ["item_name"], provenance: "table-import:term_base.xlsx#2" },
      { id: "t2", source: "ガード", target: "防御", note: "", libraryId: "term-1", contentTypes: ["item_name"], provenance: "kami-workbench" }
    ],
    "tm-master": [
      { id: "m1", source: "メンテナンスは明日開始します。", target: "维护明天开始。", libraryId: "tm-master", qualityStatus: "human_approved", entryKey: "ID-1" }
    ]
  };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();
      if (method !== "GET") {
        calls.push(`${method} ${path}${url.search}`);
        writes.push({ method, path, body: (() => { try { return JSON.parse(request.postData() || "null"); } catch { return null; } })() });
      }
      if (path === "/api/projects/project-1/libraries") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projectId: "project-1", libraries }) });
      }
      if (path === "/api/tasks") {
        // 库导出跑完后任务中心要给出下载入口（复用 batch_export 的下载链路）。
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify([{
            id: "export-1", type: "background", taskType: "batch_export", title: "导出 · 术语库", locale: "zh-CN",
            status: "completed", contentType: "general", domain: "general", totalSegments: 5856, completedSegments: 5856,
            progress: { phase: "completed", message: "导出完成：5856 条", percent: 100, completed: 5856, total: 5856 },
            payload: { kind: "library_export", libraryId: "term-1", libraryName: "术语库", count: 5856, filename: "术语库_术语库_zh-CN_2026-09-18.xlsx", downloadUrl: "/api/export-tasks/export-1/download" },
            updatedAt: "2026-09-18T14:00:00Z"
          }])
        });
      }
      if (path === "/api/library-entries" && method === "GET") {
        const libraryId = url.searchParams.get("libraryId") || "";
        const items = libraryId ? entries[libraryId] || [] : Object.values(entries).flat();
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items, total: items.length, kind: url.searchParams.get("kind"), libraryId }) });
      }
      if (path === "/api/library-entries" && method === "DELETE") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deleted: 2 }) });
      }
      if (path === "/api/library-export") {
        return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ taskId: "export-1" }) });
      }
      if (path === "/api/assets-import/preview") {
        const body = JSON.parse(request.postData() || "{}");
        const filename = body.files?.[0]?.filename || "a.xlsx";
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({
            batchId: "batch-1",
            files: [{ filename, type: "xlsx", entries: 1, anomalies: [], defaultPurpose: "term_cleaning" }],
            candidates: [{ sourceFile: filename, source: "用語", target: "术语", sheetMode: "glossary", locale: "zh-CN", selected: true }],
            duplicates: { existing: 0, conflict: 0 },
            statistics: { files: 1, entries: 1, anomalies: 0 }
          })
        });
      }
      if (path === "/api/assets-import/commit") {
        return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ taskId: "import-1", batchId: "batch-1", accepted: 1 }) });
      }
      if (path === "/api/background-tasks/import-1") {
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({ id: "import-1", status: "completed", taskType: "asset_import", progress: { phase: "completed", message: "导入完成", percent: 100 }, payload: { summary: { imported: 1, terms: 1, memories: 0, skipped: 0 } } })
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
      else if (path === "/api/feedback/pending" || path === "/api/feedback") payload = [];
      else if (path === "/api/qa-cases/pending") payload = [];
      else if (path === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");
    await page.getByRole("button", { name: "术语库" }).click();

    // 库列表：类型徽章 + 实时条目数 + 合并行
    await page.waitForSelector('#assetLibraryBody .library-row[data-library-id="term-1"]');
    const termRow = page.locator('#assetLibraryBody .library-row[data-library-id="term-1"]');
    assert.match(await termRow.textContent(), /术语库/u);
    assert.match(await termRow.textContent(), /5856/u);
    assert.match(await page.locator('#assetLibraryBody .library-row[data-library-id=""]').textContent(), /全部库（合并视图）/u);
    assert.equal(await termRow.locator('[data-library-action="import"]').count(), 1);
    assert.equal(await termRow.locator('[data-library-action="export"]').count(), 1);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/library-list-term.png`, animations: "disabled" });
    }

    // 打开库 → 条目视图（面包屑 + 条目 + 注释）
    await termRow.locator('[data-library-action="open"]').click();
    await page.waitForSelector("#assetEntryView:not([hidden])");
    await page.waitForSelector("#assetList .asset-row");
    assert.match(await page.locator("#assetBreadcrumbName").textContent(), /术语库/u);
    assert.match(await page.locator("#assetRevision").textContent(), /2 条/u);
    assert.match(await page.locator("#assetList .asset-row").first().textContent(), /バアル/u);
    assert.match(await page.locator("#assetList .asset-row").first().textContent(), /人名/u);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/library-entries-term.png`, animations: "disabled" });
    }

    // 编辑术语：弹窗填好现值，保存走 PATCH 且不改库归属
    await page.locator('#assetList .asset-row[data-entry-id="t1"] [data-term-action="edit"]').click();
    await page.waitForSelector("#assetDialog[open]");
    assert.equal(await page.locator("#assetDialogId").inputValue(), "t1");
    assert.equal(await page.locator('#assetForm input[name="source"]').inputValue(), "バアル");
    assert.match(await page.locator("#assetDialogTarget").textContent(), /术语库/u);
    await page.locator('#assetForm input[name="target"]').fill("巴尔（改）");
    await page.locator("#assetDialogSubmit").click();
    await page.waitForFunction(() => document.querySelector("#assetDialog")?.open === false);
    const patchCall = writes.find((call) => call.method === "PATCH" && call.path === "/api/assets/t1");
    assert.ok(patchCall, `编辑术语要打 PATCH /api/assets/t1：${calls.join(" | ")}`);
    assert.equal(patchCall.body.target, "巴尔（改）");
    assert.equal(patchCall.body.libraryId, undefined, "编辑不得改动库归属");

    // 删除条目 → DELETE
    await page.locator('#assetList .asset-row[data-entry-id="t2"] [data-term-action="delete"]').click();
    await page.waitForFunction(() => window.__deleted === undefined || true);
    assert.ok(calls.some((item) => item.startsWith("DELETE /api/assets/t2")), `删除术语要打 DELETE：${calls.join(" | ")}`);

    // 返回库列表 → 行内导出
    await page.locator("#assetBreadcrumbBack").click();
    await page.waitForSelector('#assetLibraryBody .library-row[data-library-id="term-1"]');
    await page.locator('#assetLibraryBody .library-row[data-library-id="term-1"] [data-library-action="export"]').click();
    await page.waitForFunction(() => document.querySelector("#toast")?.classList.contains("show"));
    const exportCall = writes.find((call) => call.path === "/api/library-export");
    assert.ok(exportCall, `导出要打 /api/library-export：${calls.join(" | ")}`);
    assert.equal(exportCall.body.kind, "term");
    assert.equal(exportCall.body.libraryId, "term-1");

    // 启用开关 → PATCH 资源库（与项目设置同一份数据）
    // 开关是"视觉隐藏的 checkbox + 自绘滑块"，点击要打在 label 上（跟真实用户一样）。
    await page.locator('#assetLibraryBody .library-row[data-library-id="term-1"] .library-toggle').click();
    await page.waitForFunction(() => window.__toggled === undefined || true);
    const toggleCall = writes.find((call) => call.method === "PATCH" && call.path === "/api/projects/project-1/libraries/term-1");
    assert.ok(toggleCall, `库开关要打资源库接口：${calls.join(" | ")}`);
    assert.equal(toggleCall.body.enabled, false);

    // 行内导入：预检弹窗写清目标库，提交时把 termLibraryId 带到后台任务
    await page.locator('#assetLibraryBody .library-row[data-library-id="term-1"] [data-library-action="import"]').click();
    await page.locator("#termLibraryFile").setInputFiles({ name: "术语.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("test") });
    await page.waitForSelector("#assetPreflightDialog[open]");
    assert.match(await page.locator("#assetPreflightTarget").textContent(), /术语 → 术语库/u);
    assert.match(await page.locator("#assetPreflightTarget").textContent(), /句段 → 主 TM/u);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/library-import-preflight.png`, animations: "disabled" });
    }
    await page.locator("#assetPreflightConfirm").click();
    await page.waitForFunction(() => /已提交后台导入/.test(document.querySelector("#assetPreflightSummary")?.textContent || ""), null, { timeout: 20000 });
    const commitCall = writes.find((call) => call.path === "/api/assets-import/commit");
    assert.ok(commitCall, `确认后要打导入接口：${calls.join(" | ")}`);
    assert.equal(commitCall.body.termLibraryId, "term-1");
    assert.equal(commitCall.body.purpose, "term");
    // 提交后弹窗要能关掉（关掉不影响后台任务），否则挡住后面的页面。
    await page.locator("#assetPreflightClose").click();
    await page.waitForFunction(() => document.querySelector("#assetPreflightDialog")?.open === false);

    // 记忆库页：库列表显示主 TM / 工作 TM 与各自条目数
    await page.locator('.nav-item[data-view="memories"]').click();
    await page.waitForSelector('#memoryLibraryBody .library-row[data-library-id="tm-master"]');
    const masterRow = page.locator('#memoryLibraryBody .library-row[data-library-id="tm-master"]');
    assert.match(await masterRow.textContent(), /主 TM/u);
    assert.match(await masterRow.textContent(), /8012/u);
    assert.match(await page.locator('#memoryLibraryBody .library-row[data-library-id="tm-working"]').textContent(), /工作 TM/u);
    assert.match(await page.locator('#memoryLibraryBody .library-row[data-library-id="tm-working"]').textContent(), /66/u);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/library-list-tm.png`, animations: "disabled" });
    }

    // 导出的任务行要能直接下载（库导出复用 batch_export 的下载按钮）
    await page.locator('.nav-item[data-view="tasks"]').click();
    await page.waitForSelector('#taskList .task-row[data-task-id="export-1"]');
    const exportRow = page.locator('#taskList .task-row[data-task-id="export-1"]');
    assert.match(await exportRow.textContent(), /导出 · 术语库/u);
    assert.equal(await exportRow.locator('[data-action="download-export"]').count(), 1, "库导出完成后任务中心要能下载");
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/library-export-task.png`, animations: "disabled" });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
