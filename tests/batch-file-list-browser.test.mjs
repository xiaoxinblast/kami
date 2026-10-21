import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 翻译视图的真实渲染回归：
 * - 点「翻译」默认落在文件列表（不再直接进单句输入或某个批次）；
 * - 每行显示进度、语境分析、QA 待处理与人工审校；
 * - 语境分析没就绪时「开始翻译」是灰的，分析完成后不用刷新自动解锁；
 * - 打开文件、返回列表、导出、删除都能走通。
 */
function mockServer() {
  return createServer(async (req, res) => {
    const pathname = req.url === "/" ? "/index.html" : req.url;
    const extension = pathname.split(".").at(-1);
    try {
      const body = await readFile(new URL(`../public${pathname}`, import.meta.url));
      res.setHeader("content-type", ({ html: "text/html", js: "text/javascript", css: "text/css", png: "image/png", svg: "image/svg+xml" })[extension] || "application/octet-stream");
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
}

test("翻译视图默认落文件列表，点文件进批次、能返回", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.KAMI_BROWSER_TEST_MODULE);
  const browser = await chromium.launch({ headless: true, ...(process.env.KAMI_BROWSER_EXECUTABLE ? { executablePath: process.env.KAMI_BROWSER_EXECUTABLE } : {}) });
  const server = mockServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const segments = Array.from({ length: 8 }, (_, index) => ({
    id: `seg-${index + 1}`, index: index + 1, source: `原文${index + 1}`, translation: index < 5 ? `译文${index + 1}` : "",
    selected: true, status: index < 5 ? "done" : "pending",
    // 前两段带档位（其中一段是自动升档），其余是旧版本翻的、没有档位字段。
    result: index === 0
      ? { qualityTier: "standard", tierReason: "含承诺措辞" }
      : index === 1
        ? { qualityTier: "standard", qualityUpgradeFrom: "fast", tierReason: "确定性检查发现 1 个阻断问题" }
        : null,
    locator: { type: "text-segment" }
  }));
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      let payload = {};
      const status = 200;
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
      else if (url.pathname === "/api/tasks") payload = [];
      else if (url.pathname === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      else if (url.pathname === "/api/batch/files") payload = {
        total: 2,
        files: [
          {
            batchId: "batch-1", filename: "Asia_batch18_new.xlsx_zho-CN.mqxliff", format: "mqxliff", runState: "ready", status: "in_progress",
            totalSegments: 78, completedSegments: 26, failedSegments: 0, qaPending: 3, brief: { status: "pending", sections: 0 },
            qualityTiers: { fast: 20, standard: 6, strict: 0, unrecorded: 0 },
            learning: { count: 4, humanReviewed: 0 }, hasOriginal: true, originalBytes: 2_400_000, updatedAt: "2026-09-26T02:00:00.000Z"
          },
          {
            batchId: "batch-2", filename: "Trophy.xlsx", format: "xlsx", runState: "completed", status: "completed",
            totalSegments: 12, completedSegments: 12, failedSegments: 0, qaPending: 0, brief: { status: "ready", sections: 3 },
            qualityTiers: { fast: 0, standard: 0, strict: 0, unrecorded: 12 },
            learning: { count: 9, humanReviewed: 9 }, hasOriginal: true, originalBytes: 120_000, updatedAt: "2026-09-25T22:00:00.000Z"
          }
        ]
      };
      else if (url.pathname === "/api/batch/run/batch-1") payload = {
        batchId: "batch-1", filename: "Asia_batch18_new.xlsx_zho-CN.mqxliff", locale: "zh-CN", contentType: "general", domain: "game",
        format: "mqxliff", segmentationMode: "unit", runState: "ready", projectId: "project-1",
        runnerOptions: { originalFile: "uploads/batch-1.mqxliff" }, requiresBrief: true, contextBriefPending: false, contextBrief: null,
        segments
      };
      else if (url.pathname === "/api/batch/run/batch-1/context-brief") payload = { batchId: "batch-1", pending: true, brief: null };
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
    });

    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");
    // 进翻译视图默认就是文件列表：单句输入与当前文件都必须藏着。
    await page.waitForSelector("#fileListWorkspace:not([hidden])");
    assert.equal(await page.locator("#singleWorkspace").isHidden(), true);
    assert.equal(await page.locator("#batchWorkspace").isHidden(), true);
    await page.waitForFunction(() => document.querySelectorAll("#batchFileList .batch-file-row").length === 2);
    const firstRow = page.locator('#batchFileList .batch-file-row[data-batch-file="batch-1"]');
    const firstText = await firstRow.innerText();
    assert.match(firstText, /Asia_batch18_new\.xlsx_zho-CN\.mqxliff/u);
    assert.match(firstText, /26 \/ 78/u);
    assert.match(firstText, /语境 分析中/u);
    assert.match(firstText, /QA 待处理 3/u);
    assert.match(firstText, /人工审校 无（4 条轨迹未采纳）/u);
    // 自动档实际用了哪几档：文件行直接写清；旧版本翻的段落如实标"未记录"。
    assert.match(firstText, /质量档：快速 20 · 标准 6/u);
    assert.match(await page.locator('#batchFileList .batch-file-row[data-batch-file="batch-2"]').innerText(), /质量档：未记录（旧版本翻译）/u);
    assert.match(await page.locator('#batchFileList .batch-file-row[data-batch-file="batch-2"]').innerText(), /人工审校 9 条/u);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/batch-file-list.png`, animations: "disabled" });
    }

    // 打开文件 → 当前文件标签；语境分析没就绪时「开始翻译」必须是灰的。
    await firstRow.locator('[data-batch-action="open"]').click();
    await page.waitForSelector("#batchWorkspace:not([hidden])");
    const primary = page.locator("#primaryAction");
    await page.waitForFunction(() => /等待语境分析|语境分析未就绪/.test(document.querySelector("#primaryAction")?.textContent || ""));
    assert.equal(await primary.isDisabled(), true, "语境分析没就绪就不该能点开始翻译");
    assert.equal(await primary.textContent(), "等待语境分析…");

    // 模拟后台分析完成：不刷新页面，按钮要自己解锁。
    await page.route("**/api/batch/run/batch-1/context-brief", async (route) => {
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ batchId: "batch-1", pending: false, brief: { status: "ready", documentType: { purpose: "dialogue", summary: "战斗与关卡提示" }, sections: [{ from: 1, to: 8, purpose: "dialogue" }], coverage: { covered: 8, total: 8 } } })
      });
    });
    await page.waitForFunction(() => /开始批次翻译/.test(document.querySelector("#primaryAction")?.textContent || ""), null, { timeout: 15000 });
    assert.equal(await primary.isDisabled(), false, "分析完成后要能直接开跑");
    // 段落徽标要带文字：有档位的写档位（升档的带 ↑），旧段落写"档位未记录"。
    const segmentChips = await page.locator("#batchSegments .segment-chips").allTextContents();
    assert.ok(segmentChips[0].includes("标准"), `第一段应显示实际档位：${JSON.stringify(segmentChips)}`);
    assert.ok(segmentChips[1].includes("↑标准"), `自动升档的段落要标出来：${JSON.stringify(segmentChips)}`);
    assert.ok(segmentChips[2].includes("档位未记录"), `旧版本翻的段落要如实标注：${JSON.stringify(segmentChips)}`);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/batch-brief-unlocked.png`, animations: "disabled" });
    }

    await page.locator("#batchBackToList").click();
    await page.waitForSelector("#fileListWorkspace:not([hidden])");
    assert.deepEqual(errors, [], `页面不应抛异常：${errors.join(" | ")}`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
