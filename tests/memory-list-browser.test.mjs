import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 真实浏览器回归：记忆库标题要写"已显示 N / 共 M 条"（不是把一页当成全库），
 * 未显示的条目能按页加载，搜索走服务端而不是只过滤已加载的那一页。
 */
test("记忆库显示总数、按页加载，搜索走服务端", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
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

  const memoryQueries = [];
  const row = (id, source, target) => ({ id, source, target, qualityStatus: "human_approved" });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/library-entries") {
        memoryQueries.push(url.searchParams);
        const search = url.searchParams.get("search") || "";
        const offset = Number(url.searchParams.get("offset") || 0);
        // 服务端搜索这里故意返回一条"词面不含查询词"的条目：前端若还按输入框二次
        // 过滤，这条会被吞掉——那正是"只搜到已加载一页"的老问题。
        const payload = search
          ? { items: [row("s1", "別の原文", "服务端命中的条目")], total: 1 }
          : offset > 0
            ? { items: [row("m4", "ロード", "读取")], total: 1200 }
            : { items: [row("m1", "プレミアムパス", "高级通行证"), row("m2", "メンテナンス", "维护"), row("m3", "アップデート", "更新")], total: 1200 };
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
      }
      let payload = {};
      if (url.pathname === "/api/bootstrap") payload = {
        locales: { "zh-CN": LOCALES["zh-CN"] }, contentTypes: CONTENT_TYPES, contentTags: CONTENT_TAGS,
        provider: { model: "test", baseUrl: "http://127.0.0.1/v1" }, backend: {}, assets: { "zh-CN": { revision: 0, termCount: 0 } }
      };
      else if (url.pathname === "/api/health") payload = { ok: true, version: "0.7.0" };
      else if (url.pathname === "/api/projects") payload = { projects: [{ id: "project-1", name: "测试项目", settings: createDefaultProjectSettings() }] };
      else if (url.pathname === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (url.pathname === "/api/projects/project-1/libraries") payload = {
        projectId: "project-1",
        libraries: [
          { id: "term-1", projectId: "project-1", name: "术语库", kind: "term_base", role: "reference", enabled: true, priority: 1, entryCount: 1200, lastEntryAt: "2026-09-18T10:00:00Z" },
          { id: "tm-master", projectId: "project-1", name: "主 TM", kind: "translation_memory", role: "master", enabled: true, priority: 1, entryCount: 1200, lastEntryAt: "2026-09-18T10:00:00Z", fileCount: 2, latestFile: "Asia_batch18_new.xlsx_zho-CN.mqxliff" },
          { id: "tm-working", projectId: "project-1", name: "工作 TM", kind: "translation_memory", role: "working", enabled: true, priority: 2, entryCount: 66, lastEntryAt: "2026-09-18T11:00:00Z", fileCount: 1, latestFile: "Asia_batch18_new.xlsx_zho-CN.mqxliff" }
        ]
      };
      else if (url.pathname === "/api/library-files") payload = {
        libraryId: "tm-master",
        files: [{ sourceFile: "Asia_batch18_new.xlsx_zho-CN.mqxliff", entryCount: 1200, batchCount: 1, batchId: "23c6e25c-a697-499a-851c-c0d5cd518f1a", lastEntryAt: "2026-09-18T10:00:00Z" }]
      };
      else if (url.pathname === "/api/feedback/pending" || url.pathname === "/api/feedback") payload = [];
      else if (url.pathname === "/api/qa-cases/pending") payload = [];
      else if (url.pathname === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");
    await page.getByRole("button", { name: "记忆库 TM" }).click();
    // 两级结构：先进库列表，再打开某个库看条目。
    await page.waitForSelector('#memoryLibraryBody .library-row[data-library-id="tm-master"]');
    assert.match(await page.locator('#memoryLibraryBody .library-row[data-library-id="tm-master"]').textContent(), /主 TM/u);
    assert.match(await page.locator('#memoryLibraryBody .library-row[data-library-id="tm-working"]').textContent(), /工作 TM · 66|66/u);
    await page.locator('#memoryLibraryBody .library-row[data-library-id="tm-master"] [data-library-action="open"]').click();
    // 第三层：TM 库先进"来源文件"列表，再进条目（工作 TM 是按文件分开的）。
    await page.waitForSelector('#memoryFileBody .library-row[data-file-key="Asia_batch18_new.xlsx_zho-CN.mqxliff"]');
    assert.match(await page.locator("#memoryFileBody").textContent(), /Asia_batch18_new\.xlsx_zho-CN\.mqxliff/u);
    assert.match(await page.locator("#memoryFilesView .isolation-note").textContent(), /按翻译文件分开/u);
    await page.locator('#memoryFileBody [data-file-action="open"]').click();
    await page.waitForSelector("#memoryList .asset-row");
    assert.equal(memoryQueries.at(-1).get("libraryId"), "tm-master", "条目列表要按打开的库过滤");
    assert.equal(memoryQueries.at(-1).get("sourceFile"), "Asia_batch18_new.xlsx_zho-CN.mqxliff", "只取这个文件的条目");
    assert.match(await page.locator("#memoryBreadcrumbFile").textContent(), /当前文件：Asia_batch18_new/u);

    assert.equal(await page.locator("#memoryList .asset-row").count(), 3, "第一页只渲染服务端返回的 3 条");
    assert.equal(await page.locator("#memoryCount").textContent(), "已显示 3 / 共 1200 条");
    assert.equal(await page.locator("#memoryMoreMeta").textContent(), "还有 1197 条未显示");

    await page.locator("#memoryMore").click();
    await page.waitForFunction(() => document.querySelectorAll("#memoryList .asset-row").length === 4, null, { timeout: 20000 });
    assert.equal(memoryQueries.at(-1).get("offset"), "3", "加载更多要从已加载条数继续取");
    assert.equal(await page.locator("#memoryCount").textContent(), "已显示 4 / 共 1200 条");

    await page.locator("#memorySearch").fill("用語");
    await page.waitForFunction(() => document.querySelectorAll("#memoryList .asset-row").length === 1, null, { timeout: 20000 });
    assert.equal(memoryQueries.at(-1).get("search"), "用語", "搜索要发给服务端");
    assert.match(await page.locator("#memoryList .asset-row").first().textContent(), /服务端命中的条目/u);
    assert.equal(await page.locator("#memoryCount").textContent(), "1 条");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
