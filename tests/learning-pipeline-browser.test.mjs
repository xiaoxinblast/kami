import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 真实浏览器回归：学习中心的晋升流水线。
 *
 * 旧版把 11 块面板平铺在一页：候选、评测、门禁、导出、微调、冲突、证据混在一起，
 * 看不出先后。新版只有一条「① 生效版本 → ② 候选 → ③ 评测 → ④ 门禁 → ⑤ 启用」，
 * 语体/领域只作参考，所以整页不再有范围选择器，其余两块收进折叠区。
 * 这个用例按真实渲染逐条确认。
 */
test("学习中心是项目级五步晋升流水线，界面不出现范围选择与批准署名", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 120000 }, async () => {
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
    id: "skill-champion", status: "champion", project: "project-1", locale: "zh-CN", contentType: "general", domain: "game",
    version: 1, name: "默认策略", evidenceIds: [], metadata: {},
    strategy: { qa: { minimumScore: 90 } }
  };
  const candidate = {
    id: "skill-candidate", status: "challenger", project: "project-1", locale: "zh-CN", contentType: "general", domain: "game",
    version: 4, parentId: champion.id, name: "游戏文本自然化补丁", changeReason: "外部审校改动的重复模式", evidenceIds: ["t-1"], strategy: {}
  };
  const trajectory = {
    id: "t-1", status: "completed", project: "project-1", locale: "zh-CN", contentType: "general", domain: "game",
    source: "浄璃の架", finalTranslation: "净璃之架",
    humanDecision: { accepted: true, machineTranslation: "净璃架", finalTranslation: "净璃之架", editDistance: 0.4, sourceFile: "Asia_batch18_new.xlsx_zho-CN.mqxliff" }
  };
  const evidenceCall = [];
  const reviewCalls = [];
  const termCalls = [];
  const skillCalls = [];
  let reviewGenerated = false;
  const gateReview = {
    summary: "13 条复发集中在两套命名体例与一个专名上",
    patterns: [
      {
        id: "pattern-1", label: "〜の片 应译作 〜之隅", kind: "convention", caseIds: ["case-1"],
        reason: "候选沿用了直译的「碎片」", suggestion: "按已定稿命名体例改写", proposedRule: "地名里的「〜の片」统一译作「〜之隅」",
        termSuggestions: []
      },
      {
        id: "pattern-2", label: "PRIVACY & DATA 保留原文", kind: "terminology", caseIds: ["case-1"],
        reason: "该标识是产品固定专名", suggestion: "登记为原文照抄的术语",
        termSuggestions: [{ source: "PRIVACY & DATA", target: "PRIVACY & DATA", preserveSource: true }]
      }
    ],
    generatedAt: "2026-09-26T03:00:00.000Z", model: "test-model", caseCount: 1
  };

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // 生成候选技能这类动作会先 confirm：浏览器默认会 dismiss，导致点了没反应。
    page.on("dialog", (dialog) => dialog.accept());
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
      else if (url.pathname === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      else if (url.pathname === "/api/learning/overview") payload = {
        locale: "zh-CN", project: "project-1",
        scopes: [{
          scope: { locale: "zh-CN", contentType: "general", domain: "game", project: "project-1" },
          trajectoryCount: 67,
          files: [{ name: "Asia_batch18_new.xlsx_zho-CN.mqxliff", count: 67 }],
          champion: { id: champion.id, version: 1, name: champion.name },
          candidateCount: 1,
          latestCandidate: { id: candidate.id, version: 4, status: "challenger", name: candidate.name },
          assets: { goldSampleCount: 40, regressionCaseCount: 27, goldenVersions: ["gold:general@v1"], regressionSuiteVersions: ["regression:general@v3"] },
          gate: { decision: "block", runId: "run-1", skillId: candidate.id, createdAt: "2026-09-26T02:00:00.000Z", coversCurrentAssets: false }
        }]
      };
      else if (url.pathname === "/api/learning") payload = {
        overview: { trajectoryCount: 1, skillCount: 2, pendingCount: 0 },
        champions: [champion], champion, skills: [champion, candidate], candidates: [candidate],
        evaluations: [{ id: "eval-1", challengerSkillId: candidate.id, championSkillId: champion.id, decision: "promote", report: { promotable: true, status: "passed" }, sampleCount: 30 }],
        scopeCounts: [{ contentType: "general", domain: "game", count: 67, files: [{ name: "Asia_batch18_new.xlsx_zho-CN.mqxliff", count: 67 }] }],
        trajectories: [trajectory], evidence: [trajectory]
      };
      else if (url.pathname === "/api/learning/evidence") {
        evidenceCall.push(Object.fromEntries(url.searchParams));
        payload = { scope: {}, total: 67, limit: 20, offset: Number(url.searchParams.get("offset")) || 0, hasMore: (Number(url.searchParams.get("offset")) || 0) === 0, items: [trajectory] };
      }
      else if (url.pathname === "/api/quality/gate") payload = {
        scope: {}, status: "block",
        latestRun: {
          id: "run-2", decision: "block", skillId: candidate.id, createdAt: "2026-09-26T02:00:00.000Z", triggeredBy: "auto:external-review-import",
          regressionTotal: 27, regressionPassed: 25, regressionPassRate: 0.9259, goldTotal: 40, goldTermAccuracy: null, goldFactAccuracy: null,
          assetVersions: { goldSets: ["gold:general@v1"], regressionSuites: ["regression:general@v2"] },
          blocking: [{ code: "regression_failed", message: "回归通过率 92.6% 低于门槛 100.0%，2 个历史失败复发" }],
          report: {
            regression: { cases: [{ id: "case-1", passed: false, source: "浄璃の架", failingTranslation: "净璃架", translation: "净璃架", expectedTranslation: "净璃之架", issues: [{ message: "复现了已被人工拒绝的译文" }] }] },
            review: reviewGenerated ? gateReview : null
          }
        },
        recentRuns: [],
        assets: {
          goldSampleCount: 40, regressionCaseCount: 27, regressionCaseTotal: 27, gateCaseCount: 27, gateCaseLimit: 50,
          goldSetVersions: ["gold:general@v1"], regressionSuiteVersions: ["regression:general@v2"],
          sources: { externalReview: 25, qaApproved: 2 },
          coverage: { valid: false, reason: "资产版本已更新，需要重跑门禁" }
        }
      };
      else if (url.pathname === "/api/quality/assets") payload = { scope: {}, goldSets: [], regressionCandidates: [], regressionSuites: [], active: { goldSampleCount: 40, regressionCaseCount: 27 } };
      else if (url.pathname === "/api/training/runs") payload = { scope: {}, total: 0, limit: 20, offset: 0, hasMore: false, runs: [] };
      else if (url.pathname === "/api/quality/runs/run-2/review") {
        reviewCalls.push(route.request().postData() || "");
        reviewGenerated = true;
        payload = { runId: "run-2", review: gateReview, cached: false };
      }
      else if (url.pathname === "/api/quality/runs/run-2/terms") {
        termCalls.push(route.request().postData() || "");
        payload = { runId: "run-2", candidates: 1, autoWritten: 1, pendingReview: 0, libraryName: "术语库" };
      }
      else if (url.pathname === "/api/learning/skills/from-gate-review") {
        skillCalls.push(JSON.parse(route.request().postData() || "{}"));
        payload = { skill: { ...candidate, id: "skill-candidate-2", version: 5, name: "门禁复盘候选技能" }, runId: "run-2" };
      }
      else if (url.pathname === "/api/learning/conflict-scan") payload = { scope: {}, conflicts: [], scannedRules: 0, reason: "该作用域可比较的规则不足两条" };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });

    const shot = async (name, selector = "") => {
      if (!process.env.KAMI_UI_SCREENSHOTS) return;
      // 截图前先滚到目标位置：只截视口时，页面下半部分的面板会整个落在画面外。
      if (selector) await page.locator(selector).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/${name}.png`, animations: "disabled" });
    };

    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");
    await page.getByRole("button", { name: "学习中心" }).click();

    // ① 项目级单流水线：进页面直接看到五步，不再有总览与范围选择。
    await page.waitForSelector("#learningPipeline:not([hidden]), #learningError:not([hidden])");
    assert.equal(await page.locator("#learningError").isVisible(), false, `读取学习中心不应报错：${await page.locator("#learningErrorMessage").textContent()}`);
    assert.equal(await page.locator("#learningContentType").count(), 0, "不再有语体下拉");
    assert.equal(await page.locator("#learningDomain").count(), 0, "不再有领域下拉");
    const chipsText = await page.locator("#learningPipelineChips").innerText();
    assert.match(chipsText, /条轨迹（\d+ 条人工采纳）/u, "chips 要写清多少条轨迹、其中多少条人工采纳");
    await shot("learning-overview");

    // ② 步骤条：五步 + 默认落在需要动作的那一步（门禁结论过期时是第 4 步）。
    const steps = await page.locator("#learningSteps .learning-step").evaluateAll((items) => items.map((item) => item.querySelector(".learning-step-title")?.textContent || ""));
    assert.deepEqual(steps, ["生效版本", "候选技能", "评测", "发版门禁", "启用"]);
    assert.equal(await page.locator("#learningSteps .learning-step.current .learning-step-title").textContent(), "发版门禁", "门禁结论过期时默认展开第 4 步");
    assert.equal(await page.locator("#learningStepGate").isVisible(), true);
    await shot("learning-pipeline-gate");

    // ③ 门禁步骤：写清本次跑多少条、来源构成与覆盖状态，且不再有任何批准署名入口。
    const gateText = await page.locator("#learningQualityAssets").innerText();
    assert.match(gateText, /本次跑 \/ 共/u);
    assert.match(gateText, /27 \/ 27/u);
    assert.match(gateText, /结论覆盖：资产版本已更新，需要重跑门禁/u);
    const sourcesText = await page.locator("#learningRegressionCandidates").innerText();
    assert.match(sourcesText, /外部审校回填改动 25 条/u);
    assert.match(sourcesText, /人工采纳的 QA 失败案例 2 条/u);
    assert.match(sourcesText, /不需要人工审批与署名/u);
    assert.equal(await page.locator('[data-regression-decision]').count(), 0, "回归候选不再有批准/拒绝按钮");

    // ③b 门禁失败不是死路：总结失败原因 → 按模式归类 → 两条动作各自可达。
    await page.locator('#learningGateReview [data-gate-review="summarize"]').click();
    await page.waitForSelector("#learningGateReview .learning-gate-pattern");
    assert.match(reviewCalls.at(-1) || "", /"force":false/u);
    const patterns = await page.locator("#learningGateReview .learning-gate-pattern").allTextContents();
    assert.equal(patterns.length, 2);
    assert.match(patterns[0], /体例\/规则/u);
    assert.match(patterns[0], /〜の片 应译作 〜之隅/u);
    assert.match(patterns[1], /术语问题/u);
    assert.match(patterns[1], /PRIVACY & DATA/u);
    await shot("learning-gate-review", "#learningGateReview");

    // 术语类模式 → 提为术语候选（走同一套入库策略）
    await page.locator('#learningGateReview .learning-gate-pattern').nth(1).locator('[data-gate-review="terms"]').click();
    await page.waitForFunction(() => /术语候选已处理/.test(document.querySelector("#toast")?.textContent || ""));
    assert.equal(termCalls.length, 1);

    // 体例类模式 → 据此生成新的候选技能（带回该模式的 id）
    await page.locator('#learningGateReview .learning-gate-pattern').first().locator('[data-gate-review="skill"]').click();
    await page.waitForFunction(() => /已据此生成新的候选技能/.test(document.querySelector("#toast")?.textContent || ""));
    assert.deepEqual(skillCalls.at(-1)?.patternIds, ["pattern-1"]);
    assert.equal(skillCalls.at(-1)?.runId, "run-2");

    // ④ 步骤条可以手动切换：点到第 5 步时给出"为什么还不能启用"。
    await page.locator('[data-learning-step-button="activate"]').click();
    await page.waitForSelector("#learningStepActivate:not([hidden])");
    const activateText = await page.locator("#learningActivatePanel").innerText();
    assert.match(activateText, /门禁未通过|门禁结论已过期/u);
    assert.equal(await page.locator('#learningActivatePanel [data-learning-action="activate"]').isDisabled(), true, "门禁没过时启用按钮置灰");
    await shot("learning-pipeline-activate");

    // ⑤ 候选卡片里按需看来源证据。
    await page.locator('[data-learning-step-button="candidates"]').click();
    await page.locator(".learning-skill-card.candidate .learning-skill-evidence > summary").click();
    await page.waitForSelector(".learning-skill-evidence-item");
    assert.match(await page.locator(".learning-skill-evidence-body").innerText(), /净璃之架/u);
    await shot("learning-step-candidates");

    // ⑥ 来源证据区：服务端分页 + 筛选，标题写清"已显示 N / 共 M 条"。
    await page.locator("#learningFoldEvidence > summary").click();
    await page.waitForFunction(() => /已显示 \d+ \/ 共 \d+ 条/.test(document.querySelector("#learningEvidenceCount")?.textContent || ""));
    assert.match(await page.locator("#learningEvidenceCount").textContent(), /已显示 1 \/ 共 67 条/u);
    await page.locator("#learningEvidenceKind").selectOption("accepted");
    await page.waitForFunction(() => document.querySelector("#learningEvidenceList .learning-evidence-item"));
    assert.equal(evidenceCall.at(-1)?.kind, "accepted", "筛选必须走服务端参数");
    await shot("learning-evidence", "#learningFoldEvidence");

    // ⑦ 规则冲突审查搬到风格页，自带范围选择。
    await page.getByRole("button", { name: "风格指导" }).click();
    await page.waitForSelector("#styleConflictScan");
    assert.equal(await page.locator("#learningConflictList").count(), 0, "学习中心不再有冲突面板");
    await shot("style-conflicts", "#styleConflictList");

    assert.deepEqual(errors, [], `页面不应抛异常：${errors.join(" | ")}`);
    assert.ok(evidenceCall.some((call) => call.limit === "20"), "证据明细必须走服务端分页");
  } finally {
    await browser.close();
    server.close();
  }
});
