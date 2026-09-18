import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 真实浏览器回归：语境档案与质量报告
 *   ① 批次页展示语境分析出的用途区间，可编辑并保存（PATCH 打到服务端）；
 *   ② 翻译前能看到"翻译必须等语境分析"的状态；
 *   ③ 质量报告给出档位分布、术语采用率与跨条目待核对清单。
 */
test("语境档案可查看可编辑，质量报告显示指标与待核对清单", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 120000 }, async () => {
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

  const writes = [];
  const run = {
    batchId: "batch-brief-1",
    projectId: "project-1",
    filename: "Asia_batch18_new.xlsx",
    locale: "zh-CN",
    contentType: "general",
    domain: "general",
    format: "xlsx",
    segmentationMode: "sentence",
    structure: null,
    subBatches: [],
    runnerOptions: null,
    runState: "completed",
    contextBrief: {
      version: 1,
      status: "ready",
      filename: "Asia_batch18_new.xlsx",
      model: "deepseek-flash",
      generatedAt: "2026-09-19T02:00:00.000Z",
      documentType: { purpose: "dialogue", audience: "玩家", tone: "口语", summary: "战斗台词与系统提示混排" },
      sections: [
        { from: 1, to: 12, purpose: "dialogue", tone: "口语", note: "角色口吻保持短促" },
        { from: 13, to: 20, purpose: "ui", tone: "简洁", note: "控件名不加句号" }
      ],
      crossRefs: [{ ids: ["seg-1", "seg-14"], note: "同一个道具名前后要一致" }],
      notes: [{ text: "保留 <br> 标签", ids: [] }],
      coverage: { analyzed: 20, total: 20, covered: 20, percent: 100 }
    },
    qualityReport: {
      report: {
        version: 1,
        totals: { selected: 20, translated: 20, failed: 0 },
        tiers: { fast: 14, standard: 4, strict: 2, unknown: 0 },
        upgrades: 1,
        coverage: { modelQa: 6, deterministicOnly: 14, percent: 30 },
        scores: { average: 92, distribution: { ">=95": 4, "90-94": 2, "<90": 0, unscored: 14 } },
        terms: { expectedUses: 10, applied: 9, adoptionRate: 90, basis: "recorded-matches" },
        facts: { issueCount: 1, segments: 1 },
        protectedTokens: { total: 4, preserved: 4 },
        humanReview: { suggested: 1, reasons: [{ reason: "质量分低于 90", count: 1 }] },
        consistency: { findings: 2, byType: [{ type: "term_drift", count: 1 }, { type: "duplicate_source", count: 1 }] },
        contextBrief: { status: "ready", documentPurpose: "dialogue", sections: 2, coverage: { covered: 20, total: 20, percent: 100 } }
      },
      findings: [
        { type: "term_usage_gap", ids: ["seg-3", "seg-17"], detail: "术语「マテリア」的登记译法「魔晶石」在 1 条里未采用", suggestion: "确认是否为语境判断", source: "rule" },
        { type: "voice_drift", ids: ["seg-5", "seg-9"], detail: "同一角色的口吻从随意变成书面", suggestion: "统一为随意口吻", source: "model" }
      ]
    },
    segments: Array.from({ length: 20 }, (_, index) => ({
      id: `seg-${index + 1}`,
      source: `原文 ${index + 1}`,
      translation: `译文 ${index + 1}`,
      status: "done",
      selected: true,
      accepted: false,
      result: {
        segmentPurpose: index < 12 ? "dialogue" : "ui",
        qualityTier: index < 14 ? "fast" : "standard",
        tierReason: "短文本且未发现事实或承诺风险",
        issues: [],
        matches: []
      }
    }))
  };

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();
      if (method !== "GET") {
        writes.push({ method, path, body: (() => { try { return JSON.parse(request.postData() || "null"); } catch { return null; } })() });
      }
      if (path === "/api/batch/run/batch-brief-1/context-brief" && method === "GET") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ batchId: run.batchId, pending: false, brief: run.contextBrief, summary: null }) });
      }
      if (path === "/api/batch/run/batch-brief-1/context-brief" && method === "PATCH") {
        const body = JSON.parse(request.postData() || "{}");
        run.contextBrief = { ...run.contextBrief, sections: body.sections || run.contextBrief.sections, notes: body.notes || run.contextBrief.notes };
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ batchId: run.batchId, summary: { sections: run.contextBrief.sections.length } }) });
      }
      if (path === "/api/batch/run/batch-brief-1/consistency-check" && method === "GET") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ batchId: run.batchId, pending: false, ...run.qualityReport }) });
      }
      if (path === "/api/batch/run/batch-brief-1") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(run) });
      }
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
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });

    await page.addInitScript(() => {
      localStorage.setItem("kami-batch-id", "batch-brief-1");
      localStorage.setItem("kami-project-id", "project-1");
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector("#batchBriefPanel:not([hidden])");

    // ① 语境档案：用途区间、注意点、整体结论
    const briefText = await page.locator("#batchBriefPanel").textContent();
    assert.match(briefText, /2 个用途区间/u);
    assert.match(briefText, /剧情对白|对话/u);
    assert.match(briefText, /第 1–12 条/u);
    assert.match(briefText, /保留 <br> 标签/u);
    assert.match(briefText, /同一个道具名前后要一致/u);
    assert.equal(await page.locator("#batchQualityTier").count(), 1, "批次页要有质量档下拉");

    // ② 编辑用途并保存：PATCH 必须带上新的用途
    await page.locator("#batchBriefEditToggle").click();
    await page.locator("#batchBriefSections select[data-brief-section-purpose]").first().selectOption("narrative");
    await page.locator("#batchBriefSave").click();
    await page.waitForFunction(() => /语境档案已更新/.test(document.querySelector("#toast")?.textContent || ""));
    const patch = writes.find((item) => item.method === "PATCH" && item.path.endsWith("/context-brief"));
    assert.ok(patch, "必须把修改提交到语境档案接口");
    assert.equal(patch.body.sections[0].purpose, "narrative");

    // ③ 质量报告：档位分布、术语采用率、跨条目待核对
    const reportText = await page.locator("#batchReportPanel").textContent();
    assert.match(reportText, /快速 14 · 标准 4 · 严苛 2 · 升级 1/u);
    assert.match(reportText, /90%（9 \/ 10）/u);
    assert.match(reportText, /术语译法未统一/u);
    assert.match(reportText, /角色口吻漂移/u);
    assert.match(await page.locator("#batchReportSummary").textContent(), /质检覆盖 30%/u);

    // ④ 段落行显示本段用途与档位
    const firstSegment = await page.locator(".batch-segment").first().textContent();
    assert.match(firstSegment, /快速/u);

    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      // 等提示条消失再截图，否则 toast 会盖住质量报告。
      await page.waitForFunction(() => !String(document.querySelector("#toast")?.textContent || "").trim(), null, { timeout: 12_000 }).catch(() => {});
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/context-brief-and-report.png`, fullPage: true, animations: "disabled" });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
