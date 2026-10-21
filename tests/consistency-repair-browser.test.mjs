import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 质量报告里的「一致性修复」区：改了几段、依据是什么、哪些没改、复核结果。
 * 这些结论必须一眼可读，否则用户只能看到一堆"待核对"却不知道系统做过什么。
 */
test("质量报告展示一致性修复的依据与剩余项", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 120000 }, async () => {
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
    batchId: "batch-repair-1",
    projectId: "project-1",
    filename: "Asia_batch18_new_02.xlsx_zho-CN.mqxliff",
    locale: "zh-CN",
    contentType: "general",
    domain: "auto",
    format: "mqxliff",
    segmentationMode: "unit",
    structure: null,
    subBatches: [],
    runnerOptions: null,
    runState: "completed",
    contextBrief: null,
    requiresBrief: true,
    contextBriefPending: false,
    qualityReport: {
      report: {
        version: 1,
        totals: { selected: 8, translated: 8, failed: 0 },
        tiers: { fast: 3, standard: 3, strict: 0, unknown: 2 },
        upgrades: 0,
        coverage: { modelQa: 3, deterministicOnly: 5, percent: 38 },
        scores: { average: 97, distribution: { ">=95": 3, "90-94": 0, "<90": 0, unscored: 5 } },
        terms: { expectedUses: 2, applied: 2, adoptionRate: 100, fuzzyExpected: 1, fuzzyApplied: 0, basis: "recorded-matches" },
        facts: { issueCount: 0, segments: 0 },
        protectedTokens: { total: 4, preserved: 4 },
        humanReview: { suggested: 0, reasons: [] },
        consistency: { findings: 2, byType: [{ type: "duplicate_source", count: 1 }, { type: "term_drift", count: 1 }] },
        contextBrief: null
      },
      findings: [
        {
          type: "duplicate_source",
          ids: ["seg-12", "seg-30"],
          detail: "同一原文出现 2 次，却有 2 种不同译文：启用 / 开启",
          suggestion: "确认这几处是否应保持一致",
          source: "rule",
          terms: [{ source: "有効", variants: ["启用", "开启"] }],
          evidence: [],
          repair: { status: "repaired", target: "启用", evidence: { kind: "paired_scheme", ref: "与「禁用」配对的写法" }, overrodeModel: true, changedIds: ["seg-30"], reason: "" }
        },
        {
          type: "name_drift",
          ids: ["seg-22", "seg-76"],
          detail: "同一角色名 MAI 在两条里写作全角ＭＡＩ",
          suggestion: "依据缺失，需人工决定：MAI 用半角还是全角",
          source: "model",
          terms: [{ source: "MAI", variants: ["MAI", "ＭＡＩ"] }],
          unify: [],
          evidence: [],
          repair: { status: "skipped", reason: "依据不足（库里没有登记译法，文件里也没有多数写法）" }
        }
      ],
      repair: {
        at: "2026-09-26T03:00:00.000Z",
        enabled: true,
        blocked: null,
        changed: [
          { segmentId: "seg-30", findingIndex: 0, type: "duplicate_source", source: "有効", target: "启用", evidence: { kind: "paired_scheme", ref: "与「禁用」配对的写法" }, overrodeModel: true, method: "replace", before: "开启", after: "启用" },
          { segmentId: "seg-32", findingIndex: 0, type: "duplicate_source", source: "無効", target: "禁用", evidence: { kind: "tm_master", ref: "無効 → 禁用" }, overrodeModel: false, method: "replace", before: "关闭", after: "禁用" }
        ],
        skipped: [{ findingIndex: 1, type: "name_drift", ids: ["seg-22", "seg-76"], reason: "依据不足（库里没有登记译法，文件里也没有多数写法）" }],
        verification: { checkedChunks: 1, remaining: [], failures: [] }
      }
    },
    segments: Array.from({ length: 8 }, (_, index) => ({
      id: `seg-${index + 1}`,
      source: `原文 ${index + 1}`,
      translation: `译文 ${index + 1}`,
      status: "done",
      selected: true,
      accepted: false,
      result: { qualityTier: "standard", issues: [], matches: [] },
      locator: { type: "text-segment" }
    }))
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
          batchId: "batch-repair-1", filename: run.filename, format: "mqxliff", runState: "completed", status: "review",
          totalSegments: 8, completedSegments: 8, failedSegments: 0, qaPending: 0, brief: { status: "ready", sections: 1 },
          qualityTiers: { fast: 3, standard: 3, strict: 0, unrecorded: 2 },
          learning: { count: 8, humanReviewed: 0 }, hasOriginal: true, originalBytes: 2048, updatedAt: "2026-09-26T03:00:00.000Z"
        }]
      };
      else if (path === "/api/batch/run/batch-repair-1/consistency-check") payload = { batchId: run.batchId, pending: false, ...run.qualityReport };
      else if (path === "/api/batch/run/batch-repair-1/context-brief") payload = { batchId: run.batchId, pending: false, brief: null };
      else if (path === "/api/batch/run/batch-repair-1") payload = run;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.addInitScript(() => {
      localStorage.setItem("kami-batch-id", "batch-repair-1");
      localStorage.setItem("kami-project-id", "project-1");
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector("#batchFileList .batch-file-row[data-batch-file='batch-repair-1']");
    await page.locator("#batchFileList .batch-file-row[data-batch-file='batch-repair-1'] [data-batch-action=\"open\"]").click();
    // 质量报告现在在独立标签页里。
    await page.locator('#batchTabs [data-batch-tab="report"]').click();
    await page.waitForSelector("#batchReportPanel:not([hidden])");

    const repairText = await page.locator("#batchReportRepair").innerText();
    assert.match(repairText, /一致性修复/u);
    assert.match(repairText, /已按证据自动统一 2 段/u);
    assert.match(repairText, /配对方案 × 1/u);
    assert.match(repairText, /主 TM 人工条 × 1/u);
    assert.match(repairText, /seg-30/u);
    assert.match(repairText, /开启 → 启用/u);
    assert.match(repairText, /已覆盖模型建议/u);
    assert.match(repairText, /未自动改 1 处：依据不足/u);
    assert.match(repairText, /复核：改动所在 1 片，仍报 0 条/u);

    const findingsText = await page.locator("#batchReportFindings").innerText();
    assert.match(findingsText, /处理：已自动统一为「启用」/u);
    assert.match(findingsText, /处理：依据不足/u);
    assert.match(await page.locator("#batchReportMetrics").innerText(), /模糊命中 0 \/ 1（仅供参考）/u);
    assert.deepEqual(errors, []);
    await page.locator("#batchReportPanel").scrollIntoViewIfNeeded();
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/consistency-repair-report.png`, animations: "disabled" });
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
