import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 「当前文件」改成分区标签页之后的真实渲染：
 * 文件与策略 / 翻译队列 / 语境档案 / 质量报告 / 术语普查五个分区各在自己的标签里，
 * 批次里的粘贴框彻底去掉，术语普查要能看到"模型建议 / 机器稿实际用的 / 人工终稿 / 库里登记"。
 */
test("当前文件分区标签页与术语普查面板", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 120000 }, async () => {
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

  const run = {
    batchId: "batch-tabs-1",
    projectId: "project-1",
    filename: "Asia_batch18_new_02.xlsx_zho-CN.mqxliff",
    locale: "zh-CN",
    contentType: "general",
    domain: "auto",
    format: "mqxliff",
    segmentationMode: "unit",
    structure: null,
    subBatches: [],
    runnerOptions: { termSurvey: { generatedAt: "2026-09-26T02:14:35.000Z" } },
    runState: "paused",
    requiresBrief: true,
    contextBriefPending: false,
    contextBrief: {
      status: "ready",
      documentType: { purpose: "ui", summary: "菜单与系统提示混排" },
      sections: [{ from: 1, to: 8, purpose: "ui", tone: "简洁", note: "控件名不加句号" }],
      notes: [{ text: "保留 <br> 标签", ids: [] }],
      crossRefs: [],
      coverage: { analyzed: 8, total: 8, covered: 8, percent: 100 }
    },
    qualityReport: {
      report: {
        version: 1,
        totals: { selected: 8, translated: 5, failed: 0 },
        tiers: { fast: 3, standard: 2, strict: 0, unknown: 3 },
        upgrades: 0,
        coverage: { modelQa: 2, deterministicOnly: 3, percent: 40 },
        scores: { average: 97, distribution: { ">=95": 2, "90-94": 0, "<90": 0, unscored: 6 } },
        terms: { expectedUses: 2, applied: 2, adoptionRate: 100, fuzzyExpected: 0, fuzzyApplied: 0, basis: "recorded-matches" },
        facts: { issueCount: 0, segments: 0 },
        protectedTokens: { total: 2, preserved: 2 },
        humanReview: { suggested: 0, reasons: [] },
        consistency: { findings: 1, byType: [{ type: "duplicate_source", count: 1 }] },
        contextBrief: null
      },
      findings: [{
        type: "duplicate_source", ids: ["seg-1", "seg-3"], detail: "同一原文出现 2 次，却有 2 种不同译文：启用 / 开启",
        suggestion: "确认是否一致", source: "rule", terms: [], evidence: [],
        repair: { status: "repaired", target: "启用", evidence: { kind: "file_majority", ref: "2 / 3 条已经用这个写法" }, overrodeModel: false, changedIds: ["seg-3"], reason: "" }
      }],
      repair: { at: "2026-09-26T03:00:00.000Z", enabled: true, blocked: null, changed: [], skipped: [], verification: null }
    },
    termSurvey: {
      version: 1,
      generatedAt: "2026-09-26T02:14:35.000Z",
      model: "deepseek-flash",
      coverage: { analyzedPairs: 8, totalSegments: 8, chunks: 1 },
      warning: "",
      review: { at: "2026-09-26T03:00:00.000Z", stats: { libraryName: "项目术语库" } },
      stats: { total: 3, adopted: 2, missingInMachine: 0, unlocated: 1, inLibrary: 1, reviewed: 1, autoWritten: 0, pendingReview: 0, skipped: 1 },
      terms: [
        {
          source: "スキルコア", suggestedTarget: "技能核心", confidence: 0.9, reason: "系统固定用语",
          machine: { matched: 2, adopted: 2, samples: [{ id: "seg-1", machine: "解放了技能核心", human: "解放了技能核心", machineAdopted: true }] },
          human: { reviewed: true, segments: 1, kept: 1 },
          library: { found: false, target: "", status: "" },
          outcome: { action: "skipped", target: "技能核心", reason: "人工终稿里没有出现这个源词", libraryName: "项目术语库" }
        },
        {
          source: "ヤマスキー絶壁", suggestedTarget: "亚马斯基绝壁", confidence: 0.8, reason: "地名，任务标题中的固定专名",
          machine: { matched: 1, adopted: 1, samples: [{ id: "seg-4", machine: "前往亚马斯基绝壁", human: "", machineAdopted: true }] },
          human: { reviewed: false, segments: 0, kept: null },
          library: { found: true, target: "亚马斯基峭壁", status: "approved" },
          outcome: null
        },
        {
          source: "存在しない語", suggestedTarget: "不存在的词", confidence: 0.6, reason: "误报",
          machine: { matched: 0, adopted: 0, samples: [] },
          human: { reviewed: false, segments: 0, kept: null },
          library: { found: false, target: "", status: "" },
          outcome: null
        }
      ]
    },
    segments: Array.from({ length: 8 }, (_, index) => ({
      id: `seg-${index + 1}`,
      source: `原文 ${index + 1}`,
      translation: index < 5 ? `译文 ${index + 1}` : "",
      status: index < 5 ? "done" : "pending",
      selected: true,
      accepted: false,
      result: { qualityTier: "standard", issues: [], matches: [] },
      locator: { type: "text-segment" }
    })).map((segment, index) => (index === 1
      ? {
        ...segment,
        source: "クエスト　ヤマスキー絶壁：登山口",
        translation: "任务　亚马斯基绝壁：登山口",
        locator: { type: "xliff-unit", unitIndex: 6, unitId: "6" },
        context: { note: "Resident_Level_Other_CheckPoint // チェックポイントのテキスト", metadata: [{ label: "位置", value: "菜单", role: "context" }] },
        result: {
          qualityTier: "standard", issues: [],
          matches: [{ mode: "exact", matchPhrase: "クエスト", score: 1, term: { source: "クエスト", target: "任务" } }],
          aiQa: {
            references: [{ source: "クエスト　ヤマスキー絶壁：登山口", target: "任务　亚马斯基峭壁：登山口", similarity: 0.92, qualityStatus: "human_approved" }],
            qaCases: []
          }
        }
      }
      : segment))
  };

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      let payload = {};
      if (path === "/api/bootstrap") payload = {
        locales: { "zh-CN": LOCALES["zh-CN"] }, contentTypes: CONTENT_TYPES, contentTags: CONTENT_TAGS,
        provider: { model: "test", baseUrl: "http://127.0.0.1/v1" }, backend: {}, assets: { "zh-CN": { revision: 0, termCount: 0 } }
      };
      else if (path === "/api/health") payload = { ok: true, version: "0.7.0" };
      else if (path === "/api/projects") payload = { projects: [{ id: "project-1", name: "测试项目", settings: createDefaultProjectSettings() }] };
      else if (path === "/api/projects/project-1/libraries") payload = { projectId: "project-1", libraries: [] };
      else if (path === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (path === "/api/memories") payload = { memories: [], total: 0 };
      else if (path === "/api/feedback/pending" || path === "/api/feedback") payload = [];
      else if (path === "/api/qa-cases/pending") payload = [];
      else if (path === "/api/style-profiles") payload = { userProfiles: [], styleProfiles: [], learningRuns: [], evidencePools: [] };
      else if (path === "/api/tasks") payload = { tasks: [] };
      else if (path === "/api/batch/files") payload = {
        total: 1,
        files: [{
          batchId: run.batchId, filename: run.filename, format: "mqxliff", runState: "paused", status: "in_progress",
          totalSegments: 8, completedSegments: 5, failedSegments: 0, qaPending: 0, brief: { status: "ready", sections: 1 },
          qualityTiers: { fast: 3, standard: 2, strict: 0, unrecorded: 3 },
          learning: { count: 5, humanReviewed: 0 }, hasOriginal: true, originalBytes: 2048, updatedAt: "2026-09-26T03:00:00.000Z"
        }]
      };
      else if (path === `/api/batch/run/${run.batchId}/consistency-check`) payload = { batchId: run.batchId, pending: false, ...run.qualityReport };
      else if (path === `/api/batch/run/${run.batchId}/context-brief`) payload = { batchId: run.batchId, pending: false, brief: run.contextBrief };
      else if (path === `/api/batch/run/${run.batchId}`) payload = run;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.addInitScript(() => {
      localStorage.setItem("kami-batch-id", "batch-tabs-1");
      localStorage.setItem("kami-project-id", "project-1");
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(`#batchFileList .batch-file-row[data-batch-file="${run.batchId}"]`);
    await page.locator(`#batchFileList .batch-file-row[data-batch-file="${run.batchId}"] [data-batch-action="open"]`).click();
    await page.waitForSelector("#batchTabs .batch-tab.active");

    // ① 打开已有批次默认落在翻译队列，标签上带待处理数量。
    assert.equal(await page.locator('#batchTabs [data-batch-tab="queue"]').getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#batchSegments").isVisible(), true);
    assert.equal(await page.locator("#batchTabQueueBadge").textContent(), "3", "队列标签要显示还剩几段");
    assert.equal(await page.locator("#batchTabReportBadge").textContent(), "1", "质量报告标签要显示待核对条数");
    assert.equal(await page.locator("#batchTabTermsBadge").textContent(), "3", "术语普查标签要显示条数");

    // ② 文件与策略：只剩上传入口，粘贴框已经删掉。
    await page.locator('#batchTabs [data-batch-tab="setup"]').click();
    assert.equal(await page.locator("#batchDropZone").isVisible(), true);
    assert.equal(await page.locator("#batchSegments").isVisible(), false, "切到文件与策略后队列要收起来");
    assert.equal(await page.locator("#batchPasteText").count(), 0, "批次页不再有粘贴文本框");
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.locator("#batchWorkspace").screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/batch-tabs-setup.png`, animations: "disabled" });
    }

    // ③ 语境档案与质量报告各在自己的标签里。
    await page.locator('#batchTabs [data-batch-tab="brief"]').click();
    await page.waitForSelector("#batchBriefPanel:not([hidden])");
    assert.match(await page.locator("#batchBriefPanel").innerText(), /1 个用途区间/u);
    await page.locator('#batchTabs [data-batch-tab="report"]').click();
    assert.match(await page.locator("#batchReportPanel").innerText(), /快速 3 · 标准 2/u);

    // ④ 术语普查：模型建议 / 机器稿实际用法 / 人工终稿 / 库里登记 / 处理结果。
    await page.locator('#batchTabs [data-batch-tab="terms"]').click();
    await page.waitForSelector("#batchTermSurveyPanel");
    assert.match(await page.locator("#batchTermSurveySummary").textContent(), /普查时间/u);
    assert.match(await page.locator("#batchTermSurveySummary").textContent(), /覆盖 8 \/ 8 段/u);
    const chips = await page.locator("#batchTermSurveyChips").innerText();
    assert.match(chips, /共 3 条/u);
    assert.match(chips, /机器稿已采用 2/u);
    assert.match(chips, /库里已有登记 1/u);
    assert.match(chips, /已忽略 1/u);
    const surveyText = await page.locator("#batchTermSurveyList").innerText();
    assert.match(surveyText, /スキルコア/u);
    assert.match(surveyText, /机器稿 2 \/ 2 段用了这个译法/u);
    assert.match(surveyText, /人工终稿保留了这个译法（1 段）/u);
    assert.match(surveyText, /库里没有登记/u);
    assert.match(surveyText, /已忽略/u);
    assert.match(surveyText, /ヤマスキー絶壁/u);
    assert.match(surveyText, /库里已有登记：亚马斯基峭壁（approved）/u);
    assert.match(surveyText, /等待人工审校回填/u);
    assert.match(surveyText, /原文里找不到这个源词/u);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.locator("#batchTermSurveyPanel").screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/batch-tabs-term-survey.png`, animations: "disabled" });
    }

    // ⑤ 筛选：只看"库里已有登记"只剩一条，点回全部恢复。
    await page.locator('#batchTermSurveyFilters [data-term-filter="library"]').click();
    assert.equal(await page.locator("#batchTermSurveyList .batch-term-card").count(), 1);
    assert.match(await page.locator("#batchTermSurveyList").innerText(), /已显示 1 \/ 共 3 条/u);
    await page.locator('#batchTermSurveyFilters [data-term-filter=""]').click();
    assert.equal(await page.locator("#batchTermSurveyList .batch-term-card").count(), 3);

    // ⑥ 分段队列：每段常显 ID / 注释 / 术语 / TM，并且可以按原文/译文/ID/注释搜索。
    await page.locator('#batchTabs [data-batch-tab="queue"]').click();
    await page.waitForSelector("#batchSegments .batch-segment");
    const metaText = await page.locator("#batchSegments .batch-segment").nth(1).locator(".batch-segment-meta").innerText();
    assert.match(metaText, /ID/u);
    assert.match(metaText, /6/u, `ID 要显示 unitId：${metaText}`);
    assert.match(metaText, /注释/u);
    assert.match(metaText, /チェックポイント/u, `注释要显示原文注释：${metaText}`);
    assert.match(metaText, /クエスト → 任务/u, "术语要显示命中词与登记译法");
    assert.match(metaText, /92% · 人工批准/u, "TM 要显示相似度与权威来源");
    // 行号不再是 undefined。
    assert.equal(await page.locator("#batchSegments .batch-segment").first().locator(".row-ref").textContent(), "1");
    assert.equal(await page.locator("#batchSegmentCount").textContent(), "已显示 8 / 共 8 条");

    await page.locator("#batchSegmentSearch").fill("チェックポイント");
    await page.waitForFunction(() => document.querySelector("#batchSegmentCount")?.textContent === "已显示 1 / 共 8 条");
    assert.equal(await page.locator("#batchSegments .batch-segment").count(), 1);
    await page.locator("#batchSegmentSearch").fill("seg-3");
    await page.waitForFunction(() => /原文 3/.test(document.querySelector("#batchSegments")?.textContent || ""));
    assert.match(await page.locator("#batchSegments .batch-segment").innerText(), /原文 3/u, "按 ID 也能搜到");
    await page.locator("#batchSegmentSearch").press("Escape");
    await page.waitForFunction(() => document.querySelector("#batchSegmentCount")?.textContent === "已显示 8 / 共 8 条");
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.locator("#batchSegments").screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/segment-meta-search.png`, animations: "disabled" });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
