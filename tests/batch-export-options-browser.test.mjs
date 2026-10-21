import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

test("三个导出入口选项一致，下载实际 MQXLIFF，404 明确报失败", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 60000 }, async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.KAMI_BROWSER_TEST_MODULE);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.KAMI_BROWSER_EXECUTABLE });
  const server = createServer(async (req, res) => {
    const pathname = req.url === "/" ? "/index.html" : req.url;
    const extension = pathname.split(".").at(-1);
    try {
      const bytes = await readFile(new URL(`../public${pathname}`, import.meta.url));
      res.setHeader("content-type", ({ html: "text/html", js: "text/javascript", css: "text/css", png: "image/png", svg: "image/svg+xml" })[extension] || "application/octet-stream");
      res.end(bytes);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const run = { batchId: "export-options", projectId: "project-1", filename: "合并1_zho-CN.mqxliff", format: "mqxliff", locale: "zh-CN",
    contentType: "dialogue", domain: "game", runState: "completed", runnerOptions: { originalFile: "uploads/original.mqxliff" },
    segments: [{ id: "s1", source: "こんにちは", translation: "你好", status: "done", selected: true, result: { qaScore: 97 } }] };
  const file = { ...run, totalSegments: 1, completedSegments: 1, failedSegments: 0, qaPending: 0, status: "completed", hasOriginal: true };
  const xml = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><xliff><source>こんにちは</source><target>你好</target></xliff>');
  const bodies = [];
  let failDownload = false;
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      let payload = {};
      if (url.pathname === "/api/bootstrap") payload = { locales: { "zh-CN": LOCALES["zh-CN"] }, contentTypes: CONTENT_TYPES, contentTags: CONTENT_TAGS, provider: { model: "test", baseUrl: "http://127.0.0.1/v1" }, backend: {}, assets: { "zh-CN": { revision: 0, termCount: 0 } } };
      else if (url.pathname === "/api/health") payload = { ok: true, version: "0.7.0" };
      else if (url.pathname === "/api/projects") payload = { projects: [{ id: "project-1", name: "导出验证", settings: createDefaultProjectSettings() }] };
      else if (url.pathname === "/api/projects/project-1/libraries") payload = { libraries: [] };
      else if (url.pathname === "/api/assets") payload = { locale: "zh-CN", terms: [], revision: 0 };
      else if (url.pathname === "/api/memories") payload = { memories: [], total: 0 };
      else if (["/api/feedback", "/api/feedback/pending", "/api/qa-cases/pending"].includes(url.pathname)) payload = [];
      else if (url.pathname === "/api/tasks") payload = [{ ...file, id: run.batchId, type: "batch" }];
      else if (url.pathname === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      else if (url.pathname === "/api/batch/files") payload = { files: [file], total: 1 };
      else if (url.pathname === `/api/batch/run/${run.batchId}`) payload = run;
      else if (url.pathname === "/api/batch/export/preflight") payload = { ok: true, blocking: [], warnings: [] };
      else if (url.pathname === `/api/tasks/${run.batchId}/export`) {
        bodies.push(JSON.parse(route.request().postData()));
        payload = { backgroundTaskId: "export-1" };
      } else if (url.pathname === "/api/background-tasks/export-1") payload = { id: "export-1", status: "completed", payload: { filename: run.filename, mimeType: "application/xliff+xml", downloadUrl: "/api/export-tasks/export-1/download" } };
      else if (url.pathname === "/api/export-tasks/export-1/download") {
        if (failDownload) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "导出文件已丢失，请重新导出" }) });
        return route.fulfill({ status: 200, contentType: "application/xliff+xml", body: xml });
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector("#batchFileList .batch-file-row");
    const options = async (name) => {
      await page.waitForSelector("#exportOptionsDialog[open]");
      const choices = await page.locator("#exportOptionsBody [data-export-option]").allTextContents();
      if (process.env.KAMI_UI_SCREENSHOTS) {
        await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/export-options-${name}.png`, animations: "disabled" });
      }
      return choices;
    };
    await page.locator('[data-batch-action="export"]').click();
    const listOptions = await options("files");
    assert.equal(listOptions.length, 4);
    await page.locator('#exportOptionsDialog [data-close="exportOptionsDialog"]').first().click();
    await page.locator('[data-batch-action="open"]').click();
    try { await page.waitForSelector("#tertiaryAction:not([hidden])"); }
    catch (error) { throw new Error(`${error.message} · toast=${await page.locator("#toast").textContent()} · errors=${errors.join(" | ")}`); }
    await page.locator("#tertiaryAction").click();
    assert.deepEqual(await options("translation"), listOptions);
    await page.locator('#exportOptionsDialog [data-close="exportOptionsDialog"]').first().click();
    await page.locator('.nav-item[data-view="tasks"]').click();
    await page.locator('[data-action="export-task"]').click();
    assert.deepEqual(await options("tasks"), listOptions);
    const downloading = page.waitForEvent("download");
    await page.locator('[data-export-option="bilingual"]').click();
    const download = await downloading;
    assert.equal(download.suggestedFilename(), run.filename);
    assert.equal(await download.failure(), null);
    assert.deepEqual(await readFile(await download.path()), xml);
    await page.waitForFunction(() => document.querySelector("#exportDialogTitle")?.textContent === "导出完成");
    assert.equal(bodies[0].mode, "bilingual");
    assert.equal(bodies[0].format, "bilingual");
    assert.equal(bodies[0].sourceFormat, "mqxliff");
    assert.equal(bodies[0].base64, undefined, "不能拿另一份当前文件的原文代替该任务的原文件");
    await page.locator('#exportDialog [data-close="exportDialog"]').first().click();
    failDownload = true;
    let unexpectedDownloads = 0;
    page.on("download", () => { unexpectedDownloads += 1; });
    await page.locator('[data-action="export-task"]').click();
    await page.locator('[data-export-option="bilingual"]').click();
    await page.waitForFunction(() => document.querySelector("#exportDialogTitle")?.textContent === "导出失败");
    assert.match(await page.locator("#exportDialogSummary").textContent(), /导出文件已丢失/u);
    assert.equal(unexpectedDownloads, 0, "404 不应生成 download.json");
    if (process.env.KAMI_UI_SCREENSHOTS) await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/export-download-error.png`, animations: "disabled" });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
