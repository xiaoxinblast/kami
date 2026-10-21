import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 学习中心的评测任务要能在任务中心与通知中心看到，落一组的评测要能只重试失败样本。
 *
 * 实测事故：评测跑完只活在学习中心那一栏（任务中心里什么都没有、也没有通知）；
 * 27 组里挂掉 1 组时只有「重新评测」，等于把 26 组成功的样本全部重烧一遍。
 */
test("任务中心/通知中心能看到评测任务，并且可以只重试失败样本", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
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
    version: 1, name: "默认策略", strategy: { qa: { minimumScore: 90 } }, evidenceIds: [], metadata: {}
  };
  const candidate = {
    id: "skill-candidate", status: "challenger", project: "project-1", locale: "zh-CN", contentType: "general", domain: "general",
    version: 3, parentId: champion.id, name: "游戏 UI 语体与技能名一致性补丁", changeReason: "40 条来源证据显示五类修订模式", evidenceIds: ["t-1"], strategy: {}
  };
  const trajectory = {
    id: "t-1", status: "completed", project: "project-1", locale: "zh-CN", contentType: "general", domain: "general",
    source: "開始します。", finalTranslation: "开始。", humanDecision: { accepted: true, finalTranslation: "开始。" }
  };
  const jobId = "job-failed";
  const conclusion = "评测未完成：1 组「生效版本 / 候选版本」对照在翻译或独立 AIQA 阶段失败。失败样本不会按“零问题”计分，本次结果禁止晋升。";
  let jobStatus = "completed";
  let failed = 1;
  const retryCalls = [];
  const jobPayload = () => ({
    jobId, kind: "skill-evaluation", championId: champion.id, challengerId: candidate.id,
    scope: { locale: "zh-CN", contentType: "general", domain: "general", project: "project-1" },
    status: jobStatus, progress: { requested: 27, completed: 27 - failed, failed },
    createdAt: "2026-09-26T01:00:00.000Z", updatedAt: "2026-09-26T01:20:00.000Z", finishedAt: "2026-09-26T01:20:00.000Z",
    error: "", backgroundTaskId: "task-learning",
    result: jobStatus === "completed"
      ? { evaluationId: "eval-1", report: { promotable: false, status: "insufficient", conclusion } }
      : null
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
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
      // 任务中心/通知中心读的就是这份任务列表：评测任务的镜像记录要在这里出现。
      else if (url.pathname === "/api/tasks") payload = [
        {
          id: "task-learning", type: "background", taskType: "skill_evaluation",
          title: "候选技能评测 · 游戏 UI 语体与技能名一致性补丁", projectId: "project-1", locale: "zh-CN",
          // 和真实 bridge 一样跟着任务状态走：正在跑的评测就是 in_progress。
          status: jobStatus === "running" ? "in_progress" : (failed ? "needs_attention" : "completed"),
          totalSegments: 27, completedSegments: 27 - failed,
          progress: { phase: "completed", message: conclusion, percent: 100, completed: 27 - failed, total: 27 },
          payload: { learningJobId: jobId, challengerId: candidate.id, conclusion },
          updatedAt: "2026-09-26T01:20:00.000Z"
        }
      ];
      else if (url.pathname === "/api/learning/evaluation-jobs") payload = { jobs: [jobPayload()] };
      else if (url.pathname === `/api/learning/evaluation-jobs/${jobId}/retry-failed`) {
        retryCalls.push(request.postData() || "");
        jobStatus = "running";
        failed = 0;
        payload = { job: { ...jobPayload(), status: "running", progress: { requested: 27, completed: 26, failed: 0 }, finishedAt: "" } };
      }
      else if (url.pathname === `/api/learning/evaluation-jobs/${jobId}`) payload = { job: jobPayload() };
      else if (url.pathname === "/api/learning") payload = {
        overview: { trajectoryCount: 1, skillCount: 2, pendingCount: 1 },
        champions: [champion], champion, skills: [champion, candidate], candidates: [candidate],
        evaluations: [{
          id: "eval-1", skillId: candidate.id, challengerSkillId: candidate.id, championSkillId: champion.id,
          sampleCount: 27, decision: "needs_review", evaluatedAt: "2026-09-26T01:20:00.000Z",
          report: jobPayload().result.report
        }],
        scopeCounts: [{ contentType: "general", domain: "general", count: 1 }],
        trajectories: [trajectory], evidence: [trajectory]
      };
      else if (url.pathname === "/api/learning/conflict-scan") payload = { scope: {}, conflicts: [], reason: "尚未扫描" };
      else if (url.pathname === "/api/learning/overview") payload = {
        locale: "zh-CN", project: "project-1",
        scopes: [{
          scope: { locale: "zh-CN", contentType: "general", domain: "general", project: "project-1" },
          trajectoryCount: 1, files: [], champion: { id: champion.id, version: 1, name: champion.name },
          candidateCount: 1, latestCandidate: { id: candidate.id, version: 2, status: "challenger", name: candidate.name },
          assets: { goldSampleCount: 0, regressionCaseCount: 0, goldenVersions: [], regressionSuiteVersions: [] }, gate: null
        }]
      };
      else if (url.pathname === "/api/learning/evidence") payload = { scope: {}, total: 1, limit: 20, offset: 0, hasMore: false, items: [trajectory] };
      else if (url.pathname === "/api/quality/assets") payload = { assets: [] };
      else if (url.pathname === "/api/quality/gate") payload = { latestRun: null, recentRuns: [], assets: {} };
      else if (url.pathname === "/api/training/runs") payload = { runs: [] };
      await route.fulfill({ status: url.pathname.endsWith("/retry-failed") ? 202 : 200, contentType: "application/json", body: JSON.stringify(payload) });
    });

    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");

    // 学习中心：卡片上要能只重试失败的那一组。
    await page.getByRole("button", { name: "学习中心" }).click();
    // 重试按钮在流水线第 2 步（候选技能）里。
    await page.locator('[data-learning-step-button="candidates"]').click();
    await page.waitForSelector("#learningCandidateList .learning-skill-card");
    const card = page.locator("#learningCandidateList .learning-skill-card").first();
    await page.waitForFunction(() => /仅重试失败 1 组/.test(document.querySelector('[data-learning-action="retry-failed"]')?.textContent || ""));
    assert.match(await card.innerText(), /已成功的样本会沿用，可以只重试失败的 1 组/u);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/learning-retry-failed.png`, fullPage: true, animations: "disabled" });
    }
    await page.locator('[data-learning-action="retry-failed"]').click();
    await page.waitForFunction(() => /只重试失败的 1 组样本/u.test(document.querySelector("#toast")?.textContent || ""));
    assert.deepEqual(retryCalls, [""], "只调 retry-failed，不带任何参数");
    await page.waitForFunction(() => /评测中 26\/27/.test(document.querySelector('[data-learning-action="evaluate"]')?.textContent || ""));

    // 任务中心：能看到这条评测，还有「打开学习中心」而不是按了没反应的「中断」。
    await page.getByRole("button", { name: "任务中心" }).click();
    await page.waitForSelector("#taskList .task-row");
    const row = page.locator("#taskList .task-row").first();
    assert.match(await row.innerText(), /技能评测/u);
    assert.match(await row.innerText(), /候选技能评测 · 游戏 UI 语体与技能名一致性补丁/u);
    assert.equal(await row.locator('[data-action="open-learning"]').count(), 1);
    assert.equal(await row.locator('[data-action="cancel-background"]').count(), 0, "评测不支持中途取消，不该给假的「中断」");
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/task-center-learning.png`, animations: "disabled" });
    }

    // 删除一条"跑起来就停不下来"的任务：对话框必须说清"删记录＝放弃这次执行"，
    // 否则用户会得到一条看不懂的阻断结论（曾经就是这样）。
    await row.locator('[data-action="delete-background"]').click();
    await page.waitForSelector("#exportOptionsDialog[open]");
    const dialogText = await page.locator("#exportOptionsDialog").innerText();
    assert.match(dialogText, /先请求中断：在下一个样本前停下，已跑完的样本保留/u);
    assert.match(dialogText, /删掉记录＝放弃这次执行/u);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/task-delete-running.png`, animations: "disabled" });
    }
    await page.locator("#exportOptionsDialog [data-close='exportOptionsDialog']").first().click();

    // 通知中心：评测失败要出现在通知里，点进去回学习中心。
    await page.locator("#notificationBell").click();
    await page.waitForSelector("#notificationPanel:not([hidden])");
    const notification = page.locator('#notificationList [data-notification-view="learning"]').first();
    await page.waitForSelector('#notificationList [data-notification-view="learning"]');
    assert.match(await notification.innerText(), /需要处理：候选技能评测 · 游戏 UI 语体与技能名一致性补丁/u);
    assert.match(await notification.innerText(), /失败样本不会按“零问题”计分/u);
    assert.deepEqual(errors, [], `页面不应抛异常：${errors.join(" | ")}`);
  } finally {
    await browser.close();
    await server.close();
  }
});

