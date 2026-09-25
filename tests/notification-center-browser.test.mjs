import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/** 通知中心：铃铛、未读角标、面板里的"已完成 / 需要处理"，以及点条目跳页面。 */
test("右上角通知中心显示任务完成与待处理并保留未读", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 60000 }, async () => {
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
  // 通知的时间戳必须落在"现在"之前：写成未来时间会让"打开就算读过"永远算不完。
  const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

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
      else if (url.pathname === "/api/qa-cases/pending") payload = [{ id: "qa-1", status: "pending", updatedAt: minutesAgo(12) }];
      else if (url.pathname === "/api/tasks") payload = [
        { id: "task-done", type: "background", taskType: "asset_import", title: "导入 · END過去作訳文.xlsx", status: "completed", totalSegments: 9791, completedSegments: 9791, progress: { message: "导入完成：主 TM 9791 条", completed: 9791, total: 9791 }, updatedAt: minutesAgo(20) },
        { id: "task-attention", type: "batch", filename: "Asia_batch18_new.xlsx_zho-CN.mqxliff", status: "needs_attention", totalSegments: 67, completedSegments: 64, failedSegments: 3, updatedAt: minutesAgo(30) },
        { id: "task-running", type: "background", taskType: "asset_import", title: "导入 · Trophy.xlsx", status: "in_progress", totalSegments: 900, completedSegments: 120, progress: { message: "正在入库：120 / 900", total: 900, completed: 120 }, updatedAt: minutesAgo(2) }
      ];
      else if (url.pathname === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });

    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector("#notificationBell");
    // 4 条通知（完成 + 需要处理 + 进行中 + 待处理 QA）都算未读。
    await page.waitForFunction(() => document.querySelector("#notificationBadge")?.hidden === false);
    assert.equal(await page.locator("#notificationBadge").textContent(), "4");
    // 还没点开时是未读态：深色标题 + 彩色圆点（面板还没展开，只查 DOM 与计算样式）。
    await page.waitForSelector('#notificationList .notification-item.is-unread', { state: "attached" });
    assert.equal(await page.locator("#notificationList .notification-item.is-read").count(), 0);
    const unreadDot = page.locator('#notificationList .notification-item.is-unread').first().locator(".notification-dot");
    assert.notEqual(await unreadDot.evaluate((node) => getComputedStyle(node).backgroundColor), "rgb(223, 228, 220)", "未读要点彩色圆点");

    await page.locator("#notificationBell").click();
    await page.waitForSelector("#notificationPanel:not([hidden])");
    const listText = await page.locator("#notificationList").innerText();
    assert.match(listText, /已完成：导入 · END過去作訳文\.xlsx/u);
    assert.match(listText, /导入完成：主 TM 9791 条/u);
    assert.match(listText, /需要处理：Asia_batch18_new\.xlsx_zho-CN\.mqxliff/u);
    assert.match(listText, /3 段失败/u);
    assert.match(listText, /进行中：导入 · Trophy\.xlsx[\s\S]*正在入库：120 \/ 900/u);
    assert.doesNotMatch(listText, /120 \/ 900 段 · 正在入库/u, "同一件事不要写两遍");
    assert.match(listText, /1 个 QA 案例等着处理/u);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/notification-center.png`, animations: "disabled" });
    }
    // 打开就算读过：角标消失，但条目还在。
    assert.equal(await page.locator("#notificationBadge").isHidden(), true);
    assert.match(await page.locator("#notificationMeta").textContent(), /共 4 条 · 没有未读/u);
    // 这一次打开里仍保留"这几条是新到的"高亮，关掉再开才退成浅色。
    assert.equal(await page.locator("#notificationList .notification-item.is-unread").count(), 4);

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector("#notificationPanel")?.hidden === true);
    await page.locator("#notificationBell").click();
    await page.waitForSelector("#notificationPanel:not([hidden])");
    // 已读态要退到背景里：全部浅色，圆点变灰而不是继续绿/黄。
    assert.equal(await page.locator("#notificationList .notification-item.is-unread").count(), 0);
    assert.equal(await page.locator("#notificationList .notification-item.is-read").count(), 4);
    assert.equal(await page.locator("#notificationList .notification-item").first().locator(".notification-dot").evaluate((node) => getComputedStyle(node).backgroundColor), "rgb(223, 228, 220)");
    assert.equal(await page.locator("#notificationList .notification-item").first().locator("strong").evaluate((node) => getComputedStyle(node).color), "rgb(124, 137, 129)");
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/notification-center-read.png`, animations: "disabled" });
    }

    // 点条目跳到对应页面并收起面板。
    await page.locator('#notificationList [data-notification-view="tasks"]').first().click();
    await page.waitForFunction(() => document.querySelector("#notificationPanel")?.hidden === true);
    await page.waitForFunction(() => document.querySelector("#view-tasks")?.classList.contains("active"));
    assert.deepEqual(errors, [], `页面不应抛异常：${errors.join(" | ")}`);
  } finally {
    await browser.close();
    await server.close();
  }
});

/**
 * 通知轮询是后台行为：Directus 抖一下导致 /api/tasks 500 时，不该写日志、也不该点亮
 * 日志角标（实测事故：轮询每 20 秒把一次连接抖动写成两条 error）。
 */
test("通知轮询失败不写日志、不点亮日志角标", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 60000 }, async () => {
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
  const clientLogs = [];

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/logs/client") {
        clientLogs.push(route.request().postData());
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      }
      // 通知轮询的两个只读接口都坏掉：模拟 Directus 抖动。
      if (url.pathname === "/api/tasks" || url.pathname === "/api/qa-cases/pending") {
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "fetch failed", path: "/" }) });
      }
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
      else if (url.pathname === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });

    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector("#notificationBell");
    await page.waitForTimeout(1500);
    await page.locator("#notificationBell").click();
    await page.waitForSelector("#notificationPanel:not([hidden])");
    assert.match(await page.locator("#notificationList").innerText(), /暂无通知/u);
    assert.equal(await page.locator("#notificationBadge").isHidden(), true);
    assert.equal(await page.locator("#logNavBadge").isHidden(), true, "后台轮询失败不该点亮日志角标");
    assert.deepEqual(clientLogs, [], "后台轮询失败不该写进日志");
    assert.deepEqual(errors, [], `页面不应抛异常：${errors.join(" | ")}`);
  } finally {
    await browser.close();
    await server.close();
  }
});
