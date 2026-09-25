import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 真实浏览器回归：待译表格上传时要弹出"列含义"确认弹窗，
 * 表头为空但下面有内容的列也必须出现在弹窗里、可以改角色，且确认后映射会随解析请求发出去。
 */
test("待译表格上传弹出列含义确认弹窗，并带映射解析", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
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

  let prepareBody = null;
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/batch/columns") {
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({
            filename: "对白.xlsx", format: "xlsx", structureSource: "rules",
            sheets: [{
              sheet: "对白", headerRow: 1, rowCount: 3, reason: "规则识别到语义表头",
              columns: [
                { column: 1, letter: "A", label: "日语", header: "日语", headerEmpty: false, role: "source_text", confidence: 0.8, reason: "日文正文密度最高", samples: ["プレミアムパス"] },
                { column: 2, letter: "B", label: "B列", header: "", headerEmpty: true, role: "context", confidence: 0.62, reason: "辅助定位或说明信息", samples: ["CARD-0001", "CARD-0002"] },
                { column: 3, letter: "C", label: "备注", header: "备注", headerEmpty: false, role: "context", confidence: 0.62, reason: "辅助定位或说明信息", samples: ["系统提示"] }
              ]
            }]
          })
        });
      }
      if (path === "/api/batch/prepare") {
        prepareBody = JSON.parse(request.postData() || "{}");
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({
            filename: "对白.xlsx", format: "xlsx", batchId: "batch-1", segmentationMode: "unit",
            segments: [{ id: "seg-1", index: 1, source: "プレミアムパスを購入してください。", context: { sheet: "对白", row: 2 }, locator: { type: "xlsx-cell", sheet: "对白", address: "B2", row: 2, column: 2, entryId: "CARD-0001" }, entryKey: "", selected: true }],
            subBatches: [], statistics: { segments: 1, characters: 18 },
            structure: { cells: [] },
            spreadsheetAnalysis: { source: "rules", usedModel: false, sheets: [{ sheet: "对白", sourceColumn: 2, targetColumns: [] }] }
          })
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
      else if (path === "/api/feedback/pending" || path === "/api/feedback") payload = [];
      else if (path === "/api/qa-cases/pending") payload = [];
      else if (path === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");
    await page.getByRole("button", { name: "翻译", exact: true }).click();
    await page.getByRole("button", { name: "粘贴 / 文件翻译" }).click();

    await page.locator("#batchFile").setInputFiles({ name: "对白.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("test") });
    await page.waitForSelector("#batchColumnDialog[open]");
    assert.equal(await page.locator(".batch-column-row").count(), 3, "表头为空的列也要出现");
    assert.match(await page.locator(".batch-column-sheet-head").textContent(), /对白/u);
    const rows = await page.locator(".batch-column-row").allTextContents();
    assert.match(rows[1], /表头为空/u);
    assert.match(rows[1], /CARD-0001/u);
    assert.equal(await page.locator('select[data-column="2"]').inputValue(), "context");
    // 表格常见"译文列"：弹窗里必须能把它指定成写回列
    assert.equal(await page.locator('select[data-column="2"] option[value="translation_output"]').count(), 1, "要有「写回译文的列」这个选项");

    // 把"表头为空"的那一列改成日文原文，确认后应该带着映射去解析
    await page.locator('select[data-column="2"]').selectOption("source_text");
    assert.equal(await page.locator("#batchColumnConfirm").isDisabled(), false);
    await page.locator("#batchColumnConfirm").click();
    await page.waitForSelector("#batchColumnDialog", { state: "hidden" });
    await page.waitForFunction(() => window.__prepareSeen === true, null, { timeout: 45_000 }).catch(() => {});
    assert.ok(prepareBody, "应该发起解析请求");
    const mapped = prepareBody.columnMapping?.sheets?.[0];
    assert.equal(mapped.headerRow, 1);
    assert.deepEqual(mapped.columns.map((column) => [column.column, column.role]), [[1, "source_text"], [2, "source_text"], [3, "context"]]);
    assert.equal(await page.locator("#batchSourceMeta").textContent(), "18 字 · 1 段");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
