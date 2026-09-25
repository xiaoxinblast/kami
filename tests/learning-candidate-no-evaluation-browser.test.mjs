import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 真实浏览器回归：刚生成的候选还没有任何评测时，学习中心必须正常渲染。
 *
 * 实测事故：点「根据近期轨迹生成候选技能」后，页面报
 * "Cannot read properties of null (reading 'decision')" 并整块显示"学习中心暂时无法读取"——
 * 候选卡片里读 `evaluation.decision` 时没防住 evaluation 为 null（还没评测过）。
 */
test("候选还没有评测时学习中心照常渲染", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
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
    version: 2, parentId: champion.id, name: "候选技能", changeReason: "由近期轨迹提出", evidenceIds: ["t-1", "t-2"], strategy: {}
  };
  const trajectory = {
    id: "t-1", status: "completed", project: "project-1", locale: "zh-CN", contentType: "general", domain: "general",
    source: "開始します。", finalTranslation: "开始。", humanDecision: { accepted: true, finalTranslation: "开始。" }
  };

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
      else if (url.pathname === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      else if (url.pathname === "/api/learning") payload = {
        overview: { trajectoryCount: 1, skillCount: 2, pendingCount: 1 },
        champions: [champion], champion, skills: [champion, candidate], candidates: [candidate],
        // 关键：还没有任何评测记录
        evaluations: [], scopeCounts: [{ contentType: "general", domain: "general", count: 1 }],
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
    // 等"渲染完成"或"错误横幅出现"这两个结果之一：崩了要立刻给出可读的失败原因，而不是等到超时。
    await page.waitForFunction(() => document.querySelector("#learningCandidateList .learning-skill-card")
      || document.querySelector("#learningError")?.hidden === false);

    assert.equal(await page.locator("#learningError").isVisible(), false, `没有评测不等于读取失败：${await page.locator("#learningErrorMessage").textContent()}`);
    assert.equal(await page.locator("#learningError").isVisible(), false, "没有评测不等于读取失败：不能弹错误横幅");
    assert.equal(await page.locator("#learningCandidateList .learning-skill-card").count(), 1, "候选卡片要照常显示");
    assert.match(await page.locator("#learningCandidateList .learning-skill-card").innerText(), /尚未与当前生效版本进行隔离评测/u);
    assert.match(await page.locator("#learningEvaluationMatrix").innerText(), /还没有可对比的评测/u);
    assert.deepEqual(errors, [], `页面不应抛异常：${errors.join(" | ")}`);
  } finally {
    await browser.close();
    await server.close();
  }
});
