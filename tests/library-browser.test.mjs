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
  const entryQueries = [];
  const libraries = [
    { id: "term-1", projectId: "project-1", name: "术语库", kind: "term_base", role: "reference", enabled: true, priority: 1, entryCount: 5856, lastEntryAt: "2026-09-18T13:38:29Z" },
    { id: "tm-master", projectId: "project-1", name: "主 TM", kind: "translation_memory", role: "master", enabled: true, priority: 1, entryCount: 8012, lastEntryAt: "2026-09-18T10:14:14Z", fileCount: 2, latestFile: "Asia_Batch15_new.xlsx_zho-CN.mqxliff" },
    { id: "tm-working", projectId: "project-1", name: "工作 TM", kind: "translation_memory", role: "working", enabled: true, priority: 2, entryCount: 66, lastEntryAt: "2026-09-18T12:03:15Z", fileCount: 1, latestFile: "Asia_batch18_new.xlsx_zho-CN.mqxliff" }
  ];
  const entries = {
    "term-1": [
      { id: "t1", source: "バアル", target: "巴尔", note: "人名", libraryId: "term-1", contentTypes: ["item_name"], provenance: "table-import:term_base.xlsx#2" },
      { id: "t2", source: "ガード", target: "防御", note: "", libraryId: "term-1", contentTypes: ["item_name"], provenance: "kami-workbench" }
    ],
    "tm-master": [
      { id: "m1", source: "メンテナンスは明日開始します。", target: "维护明天开始。", libraryId: "tm-master", qualityStatus: "human_approved", entryKey: "ID-1", sourceFile: "Asia_Batch15_new.xlsx_zho-CN.mqxliff" }
    ],
    "tm-working": [
      { id: "w1", source: "崩兆の片", target: "崩兆碎片", libraryId: "tm-working", qualityStatus: "machine_verified", sourceFile: "Asia_batch18_new.xlsx_zho-CN.mqxliff", batchId: "23c6e25c-a697-499a-851c-c0d5cd518f1a" },
      { id: "w2", source: "幽骨の礫", target: "幽骨砾石", libraryId: "tm-working", qualityStatus: "machine_verified", sourceFile: "Asia_batch18_new.xlsx_zho-CN.mqxliff", batchId: "23c6e25c-a697-499a-851c-c0d5cd518f1a" }
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
      // 库行里的「＋ 新增库」会打开项目设置面板，面板要读单项目与资源库这两份数据。
      if (path === "/api/projects/project-1") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "project-1", name: "测试项目", settings: createDefaultProjectSettings(), qaRuleMetadata: [] }) });
      }
      const libraryPatch = path.match(/^\/api\/projects\/project-1\/libraries\/([^/]+)$/u);
      if (libraryPatch && method === "PATCH") {
        const body = JSON.parse(request.postData() || "{}");
        const target = libraries.find((library) => library.id === libraryPatch[1]);
        // enabled 只用来断言请求体：后面的步骤还要拿这个库做导入，别真把它停掉。
        if (target) {
          const { enabled, ...rest } = body;
          Object.assign(target, rest);
        }
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ library: target || {} }) });
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
        const sourceFile = url.searchParams.get("sourceFile") || "";
        entryQueries.push(url.searchParams);
        let items = libraryId ? entries[libraryId] || [] : Object.values(entries).flat();
        if (sourceFile) items = items.filter((item) => (item.sourceFile || "") === sourceFile);
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items, total: items.length, kind: url.searchParams.get("kind"), libraryId, sourceFile }) });
      }
      if (path === "/api/library-files" && method === "GET") {
        const libraryId = url.searchParams.get("libraryId");
        const files = libraryId === "tm-working"
          ? [{
            sourceFile: "Asia_batch18_new.xlsx_zho-CN.mqxliff", entryCount: 2, batchCount: 1, batchId: "23c6e25c-a697-499a-851c-c0d5cd518f1a", lastEntryAt: "2026-09-18T12:03:15Z",
            batch: { batchId: "23c6e25c-a697-499a-851c-c0d5cd518f1a", status: "completed", totalSegments: 2, completedSegments: 2, failedSegments: 0, qaPending: 0, updatedAt: "2026-09-18T12:03:15Z" },
            learning: { count: 2, humanReviewed: 2 }
          }]
          : [{
            sourceFile: "Asia_Batch15_new.xlsx_zho-CN.mqxliff", entryCount: 1, batchCount: 1, batchId: "15aabbcc-1111-2222-3333-444455556666", lastEntryAt: "2026-09-18T10:14:14Z",
            batch: null, learning: { count: 0, humanReviewed: 0 }
          }];
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ libraryId, files }) });
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
    await page.waitForFunction(() => /已提交后台导入/.test(document.querySelector("#assetPreflightSummary")?.textContent || ""), null, { timeout: 45_000 });
    const commitCall = writes.find((call) => call.path === "/api/assets-import/commit");
    assert.ok(commitCall, `确认后要打导入接口：${calls.join(" | ")}`);
    assert.equal(commitCall.body.termLibraryId, "term-1");
    assert.equal(commitCall.body.purpose, "term");
    // 提交后弹窗要能关掉（关掉不影响后台任务），否则挡住后面的页面。
    await page.locator("#assetPreflightClose").click();
    await page.waitForFunction(() => document.querySelector("#assetPreflightDialog")?.open === false);
    // 后台导入任务完成时会把界面切回它出发的页面（术语库）。等它切完再往下走，
    // 否则这次切换会正好砸在后面的记忆库步骤中间，把文件层"藏"起来。
    await page.waitForFunction(() => document.querySelector("#view-assets")?.classList.contains("active"), null, { timeout: 30_000 });

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

    // 第三层：工作 TM → 来源文件 → 条目。每个文件的机器草稿是分开的。
    const workingRow = page.locator('#memoryLibraryBody .library-row[data-library-id="tm-working"]');
    assert.match(await workingRow.textContent(), /1 个文件/u, "TM 库行要显示按几个翻译文件分开");
    await workingRow.locator('[data-library-action="open"]').click();
    await page.waitForSelector('#memoryFileBody .library-row[data-file-key="Asia_batch18_new.xlsx_zho-CN.mqxliff"]');
    const fileRow = page.locator('#memoryFileBody .library-row[data-file-key="Asia_batch18_new.xlsx_zho-CN.mqxliff"]');
    assert.match(await fileRow.textContent(), /Asia_batch18_new\.xlsx_zho-CN\.mqxliff/u);
    assert.match(await fileRow.textContent(), /23c6e25c/u, "文件行要显示它来自哪个批次");
    // 文件层要回答两个问题：翻到哪一步了、有没有人工审校版本回填过。
    assert.match(await fileRow.textContent(), /翻译完成/u, "文件行要显示翻译进度");
    assert.match(await fileRow.textContent(), /2 \/ 2 段/u);
    assert.match(await fileRow.textContent(), /已回填人工终稿 2 条/u, "人工终稿回填要能看出来");
    assert.match(await page.locator("#memoryFilesView .isolation-note").textContent(), /按翻译文件分开/u);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/library-files-tm.png`, animations: "disabled" });
    }
    await fileRow.locator('[data-file-action="export"]').click();
    await page.waitForFunction(() => document.querySelector("#toast")?.classList.contains("show"));
    const fileExport = writes.filter((call) => call.path === "/api/library-export").at(-1);
    assert.equal(fileExport.body.sourceFile, "Asia_batch18_new.xlsx_zho-CN.mqxliff", "文件级导出只导这个文件");
    assert.equal(fileExport.body.libraryId, "tm-working");
    await fileRow.locator('[data-file-action="open"]').click();
    await page.waitForSelector("#memoryList .asset-row");
    assert.equal(entryQueries.at(-1).get("libraryId"), "tm-working");
    assert.equal(entryQueries.at(-1).get("sourceFile"), "Asia_batch18_new.xlsx_zho-CN.mqxliff", "只取这个文件的条目");
    assert.match(await page.locator("#memoryList .asset-row").first().textContent(), /崩兆の片/u);
    assert.match(await page.locator("#memoryList .asset-row").first().textContent(), /批次 23c6e25c/u);
    assert.match(await page.locator("#memoryBreadcrumbFile").textContent(), /当前文件：Asia_batch18_new/u);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/library-file-entries.png`, animations: "disabled" });
    }
    // 面包屑是"退一步"：先回文件列表，再回库列表。
    await page.locator("#memoryBreadcrumbBack").click();
    await page.waitForSelector('#memoryFileBody .library-row[data-file-key="Asia_batch18_new.xlsx_zho-CN.mqxliff"]');
    assert.equal(await page.locator("#memoryEntryView").isHidden(), true);
    // 等文件层真正渲染出来再点下一次返回，否则可能点在还在切换中的按钮上。
    await page.waitForFunction(() => {
      const files = document.querySelector("#memoryFilesView");
      const entries = document.querySelector("#memoryEntryView");
      return files && !files.hidden && entries && entries.hidden;
    });
    assert.equal(await page.locator("#memoryBreadcrumbFile").isHidden(), true, "回到文件列表后不再显示当前文件");
    // 连点两下会连跳两级（真实用户也可能这么点），这里只要最终回到库列表就算通过。
    await page.waitForFunction(() => {
      const button = document.querySelector("#memoryBreadcrumbBack");
      return button && !button.disabled;
    });
    await page.locator("#memoryBreadcrumbBack").click();
    await page.waitForSelector('#memoryLibraryBody .library-row[data-library-id="tm-working"]');

    // 主 TM 也有文件层，但这只是浏览维度：文案必须写清"匹配仍是整个库"。
    await page.locator('#memoryLibraryBody .library-row[data-library-id="tm-master"] [data-library-action="open"]').click();
    await page.waitForSelector('#memoryFileBody .library-row[data-file-key="Asia_Batch15_new.xlsx_zho-CN.mqxliff"]');
    // 没有翻译批次（例如双语资产导入）的文件：说清来源，而不是含糊地写"未完成"。
    const importedFileRow = page.locator('#memoryFileBody .library-row[data-file-key="Asia_Batch15_new.xlsx_zho-CN.mqxliff"]');
    assert.match(await importedFileRow.textContent(), /没有翻译批次/u);
    assert.match(await importedFileRow.textContent(), /尚无学习轨迹/u);
    assert.match(await page.locator("#memoryFilesNote").textContent(), /整个库（跨全部文件）/u, "主 TM 不能让人以为按文件匹配");
    assert.doesNotMatch(await page.locator("#memoryFilesNote").textContent(), /只在同一个文件内参与/u);
    await page.locator("#memoryBreadcrumbBack").click();
    await page.waitForSelector('#memoryLibraryBody .library-row[data-library-id="tm-master"]');

    // 「＋ 新增库」不再要求先想到去项目设置：点一下就在资源库页摆好新库草稿并聚焦名称。
    await page.locator("#memoryAddLibrary").click();
    await page.waitForSelector("#projectSettingsDialog[open]");
    const newDraft = page.locator('#projectSettingsDialog [data-library-list="translation_memory"] [data-library]').last();
    assert.match(await newDraft.textContent(), /新增 · 保存后生效/u);
    assert.equal(await newDraft.locator('input[data-library-field="name"]').inputValue(), "");
    assert.equal(await newDraft.locator('input[data-library-field="name"]').evaluate((node) => node === document.activeElement), true, "新增后要直接聚焦名称");
    await page.locator("[data-cancel-settings]").click();
    await page.locator("[data-discard]").click();
    await page.waitForFunction(() => document.querySelector("#projectSettingsDialog")?.open === false);

    // 优先级也能在列表里调：↑ 会把工作 TM 提到主 TM 前面（同类库优先级重排成 1、2…）。
    await page.locator('#memoryLibraryBody .library-row[data-library-id="tm-working"] [data-library-action="priority"][data-direction="up"]').click();
    await page.waitForFunction(() => /第 1 位/.test(document.querySelector("#toast")?.textContent || ""));
    const priorityPatches = writes.filter((call) => call.method === "PATCH" && /^\/api\/projects\/project-1\/libraries\/tm-/u.test(call.path));
    assert.deepEqual(priorityPatches.map((call) => [call.path.split("/").pop(), call.body.priority]), [["tm-working", 1], ["tm-master", 2]], "上调优先级要写成连续的 1、2…");
    await page.waitForSelector('#memoryLibraryBody .library-row[data-library-id="tm-working"]');

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
