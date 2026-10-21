import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 评测板块要单独说清"几组没跑成、几组是模型没产出译文"。
 *
 * 实测事故：模型工具轮次用尽没给译文，空串被当成"候选的译文"计分，界面上只看到
 * 硬错误变多、质量分下降，用户根本不知道其实是 5 组没跑成，还以为是候选质量差。
 */
test("评测板块显示样本执行情况与空译文条数", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
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

  const champion = {
    id: "skill-champion", status: "champion", project: "project-1", locale: "zh-CN", contentType: "general", domain: "general",
    version: 1, name: "Kami 默认翻译策略", strategy: {}, evidenceIds: [], metadata: {}
  };
  const candidate = {
    id: "skill-candidate", status: "challenger", project: "project-1", locale: "zh-CN", contentType: "general", domain: "general",
    version: 3, parentId: champion.id, name: "游戏 UI 语体与技能名一致性补丁", changeReason: "40 条来源证据显示五类修订模式", evidenceIds: ["t-1"], strategy: {}
  };
  const conclusion = "评测未完成：5 组「生效版本 / 候选版本」对照在翻译或独立 AIQA 阶段失败。其中 5 组是模型没有产出译文（不是候选翻译质量差），可以只重试这些失败样本。失败样本不会按“零问题”计分，本次结果禁止晋升。";
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
      else if (url.pathname === "/api/qa-cases/pending") payload = [];
      else if (url.pathname === "/api/tasks") payload = [];
      else if (url.pathname === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      else if (url.pathname === "/api/learning/evaluation-jobs") payload = { jobs: [] };
      else if (url.pathname === "/api/learning/conflict-scan") payload = { scope: {}, conflicts: [], reason: "尚未扫描" };
      else if (url.pathname === "/api/quality/assets") payload = { assets: [] };
      else if (url.pathname === "/api/quality/gate") payload = { latestRun: null, recentRuns: [], assets: {} };
      else if (url.pathname === "/api/training/runs") payload = { runs: [] };
      else if (url.pathname === "/api/learning") payload = {
        overview: { trajectoryCount: 1, skillCount: 2, pendingCount: 0 },
        champions: [champion], champion, skills: [champion, candidate], candidates: [candidate],
        evaluations: [{
          id: "eval-1", skillId: candidate.id, challengerSkillId: candidate.id, championSkillId: champion.id,
          sampleCount: 27, decision: "needs_review", evaluatedAt: "2026-09-26T01:29:24.000Z",
          report: {
            promotable: false, status: "insufficient", conclusion,
            benchmark: { requestedPairs: 27, completedPairs: 22, failedPairs: 5, missingTranslations: 5, failureReasons: [{ reason: "empty_translation", count: 5 }] },
            challengerMetrics: { hardErrorCount: 5, qaScore: 86.9, humanEditDistance: 0.364, humanAcceptanceRate: 0.407 },
            championMetrics: { hardErrorCount: 0, qaScore: 100, humanEditDistance: 0.116, humanAcceptanceRate: 0.37 }
          }
        }],
        scopeCounts: [{ contentType: "general", domain: "general", count: 1 }],
        trajectories: [], evidence: []
      };
      else if (url.pathname === "/api/learning/overview") payload = {
        locale: "zh-CN", project: "project-1",
        scopes: [{
          scope: { locale: "zh-CN", contentType: "general", domain: "general", project: "project-1" },
          trajectoryCount: 1, files: [], champion: { id: champion.id, version: 1, name: champion.name },
          candidateCount: 1, latestCandidate: { id: candidate.id, version: 2, status: "challenger", name: candidate.name },
          assets: { goldSampleCount: 0, regressionCaseCount: 0, goldenVersions: [], regressionSuiteVersions: [] }, gate: null
        }]
      };
      else if (url.pathname === "/api/learning/evidence") payload = { scope: {}, total: 0, limit: 20, offset: 0, hasMore: false, items: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");
    await page.getByRole("button", { name: "学习中心" }).click();
    // 项目级单流水线：进页面直接就是五步流水线。
    await page.waitForSelector("#learningEvaluationMatrix .learning-evaluation-samples");
    const samples = await page.locator("#learningEvaluationMatrix .learning-evaluation-samples").textContent();
    assert.match(samples, /样本执行：22 \/ 27 组完成/u);
    assert.match(samples, /5 组未跑成/u);
    assert.match(samples, /其中 5 组是模型没有产出译文，可只重试失败样本/u);
    assert.match(await page.locator("#learningEvaluationMatrix .learning-evaluation-conclusion").textContent(), /其中 5 组是模型没有产出译文/u);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/learning-empty-samples.png`, fullPage: true, animations: "disabled" });
    }
    assert.deepEqual(errors, [], `页面不应抛异常：${errors.join(" | ")}`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

