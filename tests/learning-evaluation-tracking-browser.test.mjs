import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 真实浏览器回归：评测在后台跑着的时候，"评测中 N/M"必须是页面状态。
 *
 * 实测现象：点「运行评测」后按钮显示"评测中 5/27……"，过一会儿又变回「运行评测」。
 * 根因是进度只写在按钮文字里——服务端任务一直在跑，但前端一次重绘（切视图、换范围、
 * 点卡片）就把按钮换成新节点，新节点只会按"有没有评测"渲染成"运行评测"。
 */
test("评测进行中的状态扛得住重绘，跑完自动刷新结论", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
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
    version: 1, name: "默认策略", description: "Kami 默认翻译策略", strategy: { qa: { minimumScore: 90 } }, evidenceIds: [], metadata: {}
  };
  const candidate = {
    id: "skill-candidate", status: "challenger", project: "project-1", locale: "zh-CN", contentType: "general", domain: "general",
    version: 2, parentId: champion.id, name: "候选技能", changeReason: "由近期轨迹提出", evidenceIds: ["t-1"], strategy: {}
  };
  const trajectory = {
    id: "t-1", status: "completed", project: "project-1", locale: "zh-CN", contentType: "general", domain: "general",
    source: "開始します。", finalTranslation: "开始。", humanDecision: { accepted: true, finalTranslation: "开始。" }
  };
  const jobId = "job-1";
  let jobStatus = "running";
  let jobCompleted = 5;
  let evaluated = false;
  const jobPayload = () => ({
    jobId, kind: "skill-evaluation", championId: champion.id, challengerId: candidate.id,
    scope: { locale: "zh-CN", contentType: "general", domain: "general", project: "project-1" },
    status: jobStatus, progress: { requested: 27, completed: jobCompleted, failed: 0 },
    createdAt: "2026-09-25T11:28:35.000Z", updatedAt: "2026-09-25T11:33:01.000Z", finishedAt: "", error: "",
    result: jobStatus === "completed"
      ? { evaluationId: "eval-1", report: { promotable: false, status: "reject", conclusion: "评测未通过：候选在术语与 AIQA 上没有提升" } }
      : null
  });
  const evaluationPayload = () => ({
    id: "eval-1", skillId: candidate.id, challengerSkillId: candidate.id, championSkillId: champion.id,
    sampleCount: 27, decision: "needs_review", evaluatedAt: "2026-09-25T11:40:00.000Z",
    report: { promotable: false, status: "reject", conclusion: "评测未通过：候选在术语与 AIQA 上没有提升" }
  });

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
      else if (url.pathname === "/api/tasks") payload = [{ id: "task-1", type: "background", taskType: "asset_import", title: "导入 · 参考库.xlsx", status: "completed", updatedAt: "2026-09-25T11:27:40.000Z" }];
      else if (url.pathname === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      else if (url.pathname === "/api/learning/evaluation-jobs") payload = { jobs: [jobPayload()] };
      else if (url.pathname === `/api/learning/evaluation-jobs/${jobId}`) payload = { job: jobPayload() };
      else if (url.pathname === "/api/learning") payload = {
        overview: { trajectoryCount: 1, skillCount: 2, pendingCount: evaluated ? 0 : 1 },
        champions: [champion], champion, skills: [champion, candidate], candidates: [candidate],
        evaluations: evaluated ? [evaluationPayload()] : [],
        scopeCounts: [{ contentType: "general", domain: "general", count: 1 }],
        trajectories: [trajectory], evidence: [trajectory]
      };
      else if (url.pathname === "/api/learning/conflict-scan") payload = { scope: {}, conflicts: [], reason: "尚未扫描" };
      else if (url.pathname === "/api/quality/assets") payload = { assets: [] };
      else if (url.pathname === "/api/quality/gate") payload = { latestRun: null, recentRuns: [], assets: {} };
      else if (url.pathname === "/api/training/runs") payload = { runs: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });

    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");
    await page.getByRole("button", { name: "学习中心" }).click();
    const evaluateButton = page.locator('#learningCandidateList [data-learning-action="evaluate"]');
    await page.waitForSelector("#learningCandidateList .learning-skill-card");

    // 进页面就显示"评测中"：后台任务还在跑，不需要用户再点一次才知道。
    await page.waitForFunction(() => /评测中 5\/27/.test(document.querySelector('[data-learning-action="evaluate"]')?.textContent || ""));
    assert.equal(await evaluateButton.isDisabled(), true, "评测进行中不能再点");
    assert.match(await page.locator("#learningCandidateList .learning-skill-card").innerText(), /评测在后台队列里跑/u);

    // 关键回归：切走再切回来（触发一次完整重绘）后，按钮不能退回「运行评测」。
    await page.getByRole("button", { name: "任务中心" }).click();
    await page.getByRole("button", { name: "学习中心" }).click();
    await page.waitForSelector("#learningCandidateList .learning-skill-card");
    await page.waitForFunction(() => /评测中 5\/27/.test(document.querySelector('[data-learning-action="evaluate"]')?.textContent || ""));
    assert.equal(await evaluateButton.isDisabled(), true);

    // 轮询把进度落在同一个按钮上：4 秒一轮，不整页重绘。
    jobCompleted = 7;
    await page.waitForFunction(() => /评测中 7\/27/.test(document.querySelector('[data-learning-action="evaluate"]')?.textContent || ""), null, { timeout: 20000 });

    // 跑完之后自动刷新结论：按钮变「重新评测」，并提示结果。
    jobStatus = "completed";
    evaluated = true;
    await page.waitForFunction(() => document.querySelector("#toast")?.textContent?.includes("候选评测完成"), null, { timeout: 25000 });
    await page.waitForFunction(() => /重新评测/.test(document.querySelector('[data-learning-action="evaluate"]')?.textContent || ""), null, { timeout: 25000 });
    assert.equal(await evaluateButton.isDisabled(), false, "评测结束后要能再跑一次");
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/learning-evaluation-tracking.png`, animations: "disabled" });
    }
    assert.deepEqual(errors, [], `页面不应抛异常：${errors.join(" | ")}`);
  } finally {
    await browser.close();
    await server.close();
  }
});
