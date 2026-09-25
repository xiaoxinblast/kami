import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 真实浏览器回归：侧边栏底部要有「日志」入口，页面要能按等级 / 关键词筛选、
 * 切换服务端记录等级、清空与下载，并且界面侧的报错也会写进同一份日志。
 */
test("日志页面：等级筛选、搜索、记录等级、清空，并记录界面报错", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
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

  const logQueries = [];
  const clientLogs = [];
  const settingsPosts = [];
  let cleared = false;
  let verbosity = "info";
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/logs" && request.method() === "GET") {
        logQueries.push(url.searchParams);
        const level = url.searchParams.get("level") || "";
        const search = url.searchParams.get("search") || "";
        const all = cleared ? [] : [
          { ts: "2026-09-18T12:00:03.000Z", level: "error", message: "Directus 写入失败 431", detail: "GET /items/terms_zh_cn?filter=..." },
          { ts: "2026-09-18T12:00:02.000Z", level: "warn", message: "跳过 2 条：库内已有译法" },
          { ts: "2026-09-18T12:00:01.000Z", level: "info", message: "人工 TM 导入完成：9330 条" },
          { ts: "2026-09-18T11:59:00.000Z", level: "error", message: "上一次运行的报错", previous: true }
        ];
        const rank = { debug: 10, info: 20, warn: 30, error: 40 };
        const entries = all.filter((entry) => (!level || rank[entry.level] >= rank[level]) && (!search || `${entry.message} ${entry.detail || ""}`.includes(search)));
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries, settings: { level: verbosity, levels: ["debug", "info", "warn", "error"], buffered: entries.length, bufferLimit: 2000, file: "data/runtime/logs/kami.log", fileBytes: 1234, rotated: false } }) });
      }
      if (url.pathname === "/api/logs/settings") {
        const body = JSON.parse(request.postData() || "{}");
        settingsPosts.push(body);
        verbosity = body.level || verbosity;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ level: verbosity, levels: ["debug", "info", "warn", "error"], buffered: 4, bufferLimit: 2000, file: "data/runtime/logs/kami.log", fileBytes: 1234, rotated: false }) });
      }
      if (url.pathname === "/api/logs" && request.method() === "DELETE") {
        cleared = true;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ level: "info" }) });
      }
      if (url.pathname === "/api/logs/client") {
        clientLogs.push(JSON.parse(request.postData() || "{}"));
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      }
      if (url.pathname === "/api/library-entries") {
        // 故意失败一次：界面要把失败写进日志，而不是只闪一句提示。
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "记忆库读取失败（测试）" }) });
      }
      if (url.pathname === "/api/projects/project-1/libraries") {
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({
            projectId: "project-1",
            libraries: [{ id: "tm-master", projectId: "project-1", name: "主 TM", kind: "translation_memory", role: "master", enabled: true, priority: 1, entryCount: 3 }]
          })
        });
      }
      let payload = {};
      if (url.pathname === "/api/bootstrap") payload = {
        locales: { "zh-CN": LOCALES["zh-CN"] }, contentTypes: CONTENT_TYPES, contentTags: CONTENT_TAGS,
        provider: { model: "test", baseUrl: "http://127.0.0.1/v1" }, backend: {}, assets: { "zh-CN": { revision: 0, termCount: 0 } }
      };
      else if (url.pathname === "/api/health") payload = { ok: true, version: "0.7.0" };
      else if (url.pathname === "/api/projects") payload = { projects: [{ id: "project-1", name: "测试项目", settings: createDefaultProjectSettings() }] };
      else if (url.pathname === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (url.pathname === "/api/feedback/pending" || url.pathname === "/api/feedback") payload = [];
      else if (url.pathname === "/api/qa-cases/pending") payload = [];
      else if (url.pathname === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");

    // 入口在侧边栏（导航列表之后、状态块之前）
    const logNav = page.locator('.nav-item[data-view="logs"]');
    assert.equal(await logNav.count(), 1, "侧边栏要有日志入口");
    assert.equal(await logNav.textContent().then((text) => text.includes("日志")), true);

    await logNav.click();
    try {
      // 并行跑全量时接口与渲染都会变慢：这是"等状态出现"，不是失败判定，预算给足。
      await page.waitForSelector("#logList .log-row", { timeout: 45_000 });
    } catch (error) {
      const toastText = await page.locator("#toast").textContent().catch(() => "");
      const countText = await page.locator("#logCount").textContent().catch(() => "");
      throw new Error(`日志行没渲染：${error.message}；页面异常：${errors.join(" | ") || "无"}；toast：${toastText}；计数：${countText}`);
    }
    assert.equal(await page.locator("#logCount").textContent(), "4 条");
    assert.equal(await page.locator("#logList .log-row.error").count(), 2, "错误行要标红");
    assert.match(await page.locator("#logList .log-row").first().textContent(), /Directus 写入失败 431/u);
    assert.equal(await page.locator("#logNavBadge").isHidden(), true, "正在看日志时不显示角标");

    // 等级筛选：只留错误
    await page.locator('#logLevels .log-level-chip[data-level="error"]').click();
    await page.waitForFunction(() => document.querySelectorAll("#logList .log-row").length === 2);
    assert.equal(logQueries.at(-1).get("level"), "error");
    assert.equal(await logQueries.at(-1).get("search"), null);

    // 关键词搜索
    await page.locator('#logLevels .log-level-chip[data-level=""]').click();
    await page.locator("#logSearch").fill("9330");
    await page.waitForFunction(() => document.querySelectorAll("#logList .log-row").length === 1);
    assert.equal(logQueries.at(-1).get("search"), "9330");
    assert.match(await page.locator("#logList .log-row").first().textContent(), /人工 TM 导入完成/u);

    // 记录等级：切到 debug 并把设置发给服务端
    await page.locator("#logVerbosity").selectOption("debug");
    await page.waitForFunction(() => document.querySelectorAll("#logList .log-row").length > 0);
    assert.deepEqual(settingsPosts.at(-1), { level: "debug" });
    assert.equal(await page.locator("#logVerbosity").inputValue(), "debug");

    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/log-viewer.png`, fullPage: true, animations: "disabled" });
    }

    // 界面侧的报错要进日志（记忆库接口在这里故意 500）
    // 打开某个库会去读条目，这里注入的 500 就是"界面侧报错要进日志"的素材。
    await page.locator('.nav-item[data-view="memories"]').click();
    await page.waitForSelector('#memoryLibraryBody .library-row[data-library-id="tm-master"]');
    await page.locator('#memoryLibraryBody .library-row[data-library-id="tm-master"] [data-library-action="open"]').click();
    await page.waitForFunction(() => document.querySelectorAll("#logNavBadge").length === 1);
    await page.waitForTimeout(600);
    assert.ok(clientLogs.some((entry) => entry.level === "error" && /\/api\/library-entries/u.test(entry.message)), `界面报错要上报：${JSON.stringify(clientLogs)}`);

    // 清空
    await logNav.click();
    await page.waitForSelector("#logList .log-row");
    await page.locator("#logClear").click();
    await page.waitForFunction(() => document.querySelector("#logCount")?.textContent === "0 条");
    assert.equal(cleared, true, "清空要打到 DELETE /api/logs");
    // 唯一允许的页面异常是上面故意打的那次 500；除此之外不该有别的报错。
    assert.ok(errors.every((message) => message.includes("记忆库读取失败")), `除注入的失败外不该有页面异常：${errors.join(" | ")}`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
