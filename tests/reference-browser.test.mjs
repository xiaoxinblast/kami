import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, open, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";
import { waitForText } from "./fixtures/browser-wait.mjs";

/**
 * 参考资料页的真实渲染回归：
 * 1) 每行要显示 AI 扫描出来的描述与"几张图识图"，没有描述时明确提示模型只能按文件名猜；
 * 2) 「让 AI 扫描」只调 /describe，扫完刷新出描述，不改成保存/重新索引；
 * 3) 详情里图片识图的统计（识图 N 张 / 跳过 N 张 / 超额 N 张）要看得见。
 */
test("参考资料页显示描述与图片识图统计，扫描按钮只更新描述", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
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

  const describeCalls = [];
  let described = false;
  const document = () => ({
    id: "ref-1",
    projectId: "project-1",
    folderId: "",
    name: "END3_CorelTrain_SCENARIO_ORDER",
    sourceFile: "END3_CorelTrain_SCENARIO_ORDER.xlsx",
    sourceFormat: "xlsx",
    status: "ready",
    characters: 1_204,
    chunkCount: 6,
    contentType: "",
    domain: "",
    ingestReport: {
      format: "xlsx",
      pages: 2,
      visionPages: 0,
      visionImages: 2,
      skippedImages: 1,
      cappedImages: 0,
      ...(described ? { description: "CorelTrain 章节顺序表，列出每章的场景编号与顺序。" } : {})
    }
  });
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
        provider: { baseUrl: "http://localhost:11434/v1", model: "qwen3:14b", apiKeyConfigured: false }, backend: {}, assets: { "zh-CN": { revision: 0, termCount: 0 } }
      };
      else if (path === "/api/health") payload = { ok: true, version: "0.7.0" };
      else if (path === "/api/projects") payload = { projects: [{ id: "project-1", name: "测试项目", settings: createDefaultProjectSettings() }] };
      else if (path === "/api/projects/project-1/libraries") payload = { libraries: [] };
      else if (path === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (path === "/api/memories") payload = { memories: [] };
      else if (path === "/api/feedback/pending" || path === "/api/feedback") payload = [];
      else if (path === "/api/qa-cases/pending") payload = [];
      else if (path === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      else if (path === "/api/tasks") payload = { tasks: [], total: 0 };
      else if (path === "/api/reference-folders") payload = { items: [] };
      else if (path === "/api/references/ref-1/chunks") payload = {
        document: document(),
        total: 6,
        items: [
          { id: "chunk-1", ordinal: 0, heading: "第 1 章", page: "Sheet1", origin: "text", characters: 24, risk: false, allowed: false, text: "第 1 章 旧魔晄炉" },
          { id: "chunk-2", ordinal: 1, heading: "第 1 章", page: "Sheet1", origin: "vision", characters: 18, risk: false, allowed: false, text: "〔图片文字〕地图：旧魔晄炉在左上角" }
        ]
      };
      else if (path === "/api/references/ref-1/describe" && request.method() === "POST") {
        describeCalls.push(request.postData() || "");
        described = true;
        payload = { id: "ref-1", description: "CorelTrain 章节顺序表，列出每章的场景编号与顺序。", document: document() };
      }
      else if (path === "/api/references") payload = { items: [document()], total: 1, libraries: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('button[data-view="references"]').click();

    const row = page.locator("#referenceList .reference-row").first();
    await waitForText(row.locator(".reference-description"), /还没有描述/u);
    assert.match(await page.locator("#referenceCount").textContent(), /已显示 1 \/ 共 1 条/u);
    assert.match(await row.locator(".reference-metrics").textContent(), /2 张图识图/u, "列表要显示有几张图识了图");
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/reference-list-before-describe.png`, animations: "disabled" });
    }

    // 「让 AI 扫描」只调 describe，不改状态、不重建索引
    await row.locator('button[data-reference-action="describe"]').click();
    await waitForText(row.locator(".reference-description"), /章节顺序表/u);
    assert.deepEqual(describeCalls, [""], "扫描按钮只打 describe 接口");
    assert.equal(await page.locator("#referenceList .reference-row").count(), 1);

    // 详情：图片识图统计
    await page.locator("#referenceList .reference-row button[data-reference-action='detail']").first().click();
    const meta = page.locator("#referenceDetailMeta");
    await waitForText(meta, /2 张内嵌图片已识图/u);
    assert.match(await meta.textContent(), /1 张图太小或不是位图/u);
    assert.match(await page.locator("#referenceChunks").textContent(), /〔图片文字〕/u, "识图转录的片段要能看见");
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/reference-detail-vision.png`, fullPage: true, animations: "disabled" });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * 上传大文件的两次事故：页面直接 "Out of Memory"（前端把整份文件读进内存再 base64），
 * 以及 11MB 以上永远传不上去（请求体 15MB 上限 < 20MB 文件上限）。
 * 现在：超过 20MB 先在浏览器拦下来，正常文件按原始字节直传，字节数与文件大小一致。
 */
test("参考资料按原始字节上传，超过 200MB 的文件在浏览器就被拦下", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
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

  const uploads = [];
  const apiCalls = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      apiCalls.push(url.pathname);
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
      else if (url.pathname === "/api/tasks") payload = { tasks: [], total: 0 };
      else if (url.pathname === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      else if (url.pathname === "/api/reference-folders") payload = { items: [] };
      else if (url.pathname === "/api/references/file") {
        const body = request.postDataBuffer();
        uploads.push({
          filename: url.searchParams.get("filename"),
          projectId: url.searchParams.get("projectId"),
          autoScan: url.searchParams.get("autoScan"),
          contentType: request.headers()["content-type"],
          bytes: body ? body.length : 0
        });
        payload = { taskId: "task-1", backgroundTaskId: "task-1", documentId: "ref-upload-1", filename: url.searchParams.get("filename"), folderId: "" };
      }
      else if (url.pathname === "/api/background-tasks/task-1") payload = { id: "task-1", taskType: "reference_ingest", status: "completed", progress: { message: "参考资料已就绪", percent: 100, completed: 1, total: 1 } };
      else if (url.pathname === "/api/references") payload = { items: [], total: 0, libraries: [] };
      await route.fulfill({ status: url.pathname === "/api/references/file" ? 202 : 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('button[data-view="references"]').click();
    await page.waitForSelector("#referenceFileInput", { state: "attached" });

    // 正常文件：原始字节直传，字节数等于文件大小（没有 base64 的 1/3 放大）。
    const payload = Buffer.alloc(2_500_000, 65);
    await page.setInputFiles("#referenceFileInput", { name: "设定集.pdf", mimeType: "application/pdf", buffer: payload });
    await page.waitForFunction(() => document.querySelector("#referenceUploadNote")?.textContent?.includes("已提交"));
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].filename, "设定集.pdf");
    assert.equal(uploads[0].projectId, "project-1");
    assert.equal(uploads[0].autoScan, "1", "默认开启导入后自动 AI 扫描");
    assert.equal(uploads[0].contentType, "application/pdf");
    assert.equal(uploads[0].bytes, payload.length, "请求体就是文件本身，不该再被 base64 放大");

    // 超过 200MB：浏览器直接拦下，不发请求、页面也不崩。
    const callsBefore = apiCalls.filter((path) => path === "/api/references/file").length;
    // Playwright 不允许直接塞 50MB 以上的 buffer：造一个稀疏文件按路径上传，避免测试进程吃满内存。
    const bigPath = join(await mkdtemp(join(tmpdir(), "kami-big-ref-")), "超大资料.pptx");
    const bigHandle = await open(bigPath, "w");
    await bigHandle.truncate(201 * 1024 * 1024);
    await bigHandle.close();
    await page.setInputFiles("#referenceFileInput", bigPath);
    await page.waitForFunction(() => /超过 200MB/u.test(document.querySelector("#toast")?.textContent || ""));
    assert.match(await page.locator("#toast").textContent(), /超大资料\.pptx：超过 200MB/u);
    assert.equal(apiCalls.filter((path) => path === "/api/references/file").length, callsBefore, "超限文件不该发出上传请求");
    assert.deepEqual(errors, [], `页面不应抛异常：${errors.join(" | ")}`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * 上传前的识图开关是唯一入口：选择会写进 upload query，并在刷新后记住。
 */
test("识图开关记忆选择并直接下发 vision，不再弹确认窗", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
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

  const uploadVision = [];
  const uploadAutoScan = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      let payload = {};
      let status = 200;
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
      else if (url.pathname === "/api/tasks") payload = { tasks: [], total: 0 };
      else if (url.pathname === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      else if (url.pathname === "/api/reference-folders") payload = { items: [] };
      else if (url.pathname === "/api/references/file") {
        status = 202;
        uploadVision.push(url.searchParams.get("vision"));
        uploadAutoScan.push(url.searchParams.get("autoScan"));
        payload = { taskId: `task-${uploadVision.length}`, documentId: `ref-${uploadVision.length}`, filename: url.searchParams.get("filename") };
      }
      else if (url.pathname.startsWith("/api/background-tasks/")) payload = { id: url.pathname.split("/").at(-1), taskType: "reference_ingest", status: "completed", progress: { message: "资料已就绪", percent: 100, completed: 1, total: 1 } };
      else if (url.pathname === "/api/references") payload = { items: [], total: 0, libraries: [] };
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('button[data-view="references"]').click();
    await page.waitForSelector("#referenceFileInput", { state: "attached" });

    await page.locator('[data-reference-vision="none"]').click();
    await page.setInputFiles("#referenceFileInput", { name: "设定集.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(1024, 65) });
    await page.waitForFunction(() => /已提交/u.test(document.querySelector("#referenceUploadNote")?.textContent || ""));
    assert.deepEqual(uploadVision, ["none"], "「仅文字」要直接下发 vision:none");
    assert.deepEqual(uploadAutoScan, ["1"], "默认开启导入后自动 AI 扫描");
    assert.equal(await page.locator("#referencePlanDialog").count(), 0, "旧的确认弹窗应被移除");
    await page.reload();
    await page.locator('button[data-view="references"]').click();
    assert.equal(await page.locator('[data-reference-vision="none"]').getAttribute("aria-pressed"), "true", "刷新后应记住仅文字");
    await page.locator('[data-reference-vision="all"]').click();
    await page.locator(".reference-auto-scan").click();
    assert.equal(await page.locator("#referenceAutoScan").isChecked(), false);
    await page.setInputFiles("#referenceFileInput", { name: "设定集2.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(1024, 65) });
    await page.waitForFunction(() => /已提交/u.test(document.querySelector("#referenceUploadNote")?.textContent || ""));
    assert.deepEqual(uploadVision, ["none", "all"]);
    assert.deepEqual(uploadAutoScan, ["1", "0"]);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/reference-vision-toggle.png`, fullPage: true, animations: "disabled" });
    }
    assert.deepEqual(errors, [], `页面不应抛异常：${errors.join(" | ")}`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
