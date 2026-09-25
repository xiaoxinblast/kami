import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { waitForCount } from "./fixtures/browser-wait.mjs";

/**
 * 真实浏览器回归：学习中心的「全部语体 / 全部领域」
 *   ① 两个下拉都有"全部"，选了就整维度放开（请求里 contentType=all / domain=all）；
 *   ② 轨迹条目自己带范围标签（"剧情对白 × 游戏"），不用回头猜它在哪个范围；
 *   ③ 跨范围时候选的评测基线取它自己范围的生效版本（不是清单里第一个）；
 *   ④ 范围强绑定的三块（冲突审查 / 质量资产 / 微调任务）在全部视图下不发请求。
 */
test("学习中心支持全部语体 / 全部领域，条目带自己的范围标签", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 120000 }, async () => {
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

  const scopeBoundCalls = [];
  const learningCalls = [];
  const champion = (id, contentType, domain) => ({
    id, status: "champion", project: "project-1", locale: "zh-CN", contentType, domain,
    version: 1, name: `${contentType} · ${domain} 默认策略`, description: "Kami 默认翻译策略",
    strategy: { qa: { minimumScore: 90 } }, evidenceIds: [], metadata: {}
  });
  const trajectory = (id, contentType, domain, source, target) => ({
    id, status: "completed", project: "project-1", locale: "zh-CN", contentType, domain,
    source, finalTranslation: target, humanDecision: { accepted: true, finalTranslation: target },
    sourceFile: "Asia_batch18_new.xlsx_zho-CN.mqxliff",
    createdAt: "2026-09-25T08:00:00.000Z"
  });
  // 真实接口同时给 trajectories 与 evidence（后者带上归因字段），这里照同样的形状打桩。
  const trajectories = [
    trajectory("t-1", "general", "game", "最初の依頼", "最初的委托"),
    trajectory("t-2", "dialogue", "game", "行こう。", "走吧。"),
    trajectory("t-3", "dialogue", "game", "待って！", "等一下！")
  ];

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
      else if (url.pathname === "/api/projects") payload = { projects: [{ id: "project-1", name: "测试项目" }] };
      else if (url.pathname === "/api/projects/project-1/libraries") payload = { projectId: "project-1", libraries: [] };
      else if (url.pathname === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (url.pathname === "/api/memories") payload = { memories: [], total: 0 };
      else if (url.pathname === "/api/feedback/pending" || url.pathname === "/api/feedback") payload = [];
      else if (url.pathname === "/api/qa-cases/pending") payload = [];
      else if (url.pathname === "/api/learning") {
        learningCalls.push(Object.fromEntries(url.searchParams));
        payload = {
          overview: { trajectoryCount: 3, skillCount: 3, pendingCount: 1 },
          scope: { locale: "zh-CN", contentType: url.searchParams.get("contentType"), domain: url.searchParams.get("domain"), project: "project-1" },
    // 第三份生效版本所在范围没有轨迹：默认要收进折叠，别把空壳摆在最前面。
          champions: [champion("skill-general", "general", "game"), champion("skill-dialogue", "dialogue", "game"), champion("skill-idle", "store", "marketing")],
          champion: champion("skill-general", "general", "game"),
          skills: [
            champion("skill-general", "general", "game"),
            champion("skill-dialogue", "dialogue", "game"),
            champion("skill-idle", "store", "marketing"),
            { id: "candidate-1", status: "draft", project: "project-1", locale: "zh-CN", contentType: "dialogue", domain: "game", version: 2, parentId: "skill-dialogue", name: "候选 · 对白", evidenceIds: ["t-2"] }
          ],
          candidates: [{ id: "candidate-1", status: "draft", project: "project-1", locale: "zh-CN", contentType: "dialogue", domain: "game", version: 2, parentId: "skill-dialogue", name: "候选 · 对白", evidenceIds: ["t-2"] }],
    // 只在选了具体范围时才可能判"基线过期"：全部视图必须用候选自己范围的生效版本。
          evaluations: [{
            id: "eval-1", project: "project-1", locale: "zh-CN", contentType: "dialogue", domain: "game",
            championSkillId: "skill-dialogue", challengerSkillId: "candidate-1", decision: "promote",
            report: { promotable: true, metrics: [] }, sampleCount: 30
          }],
          scopeCounts: [
            { contentType: "general", domain: "game", count: 1, files: [{ name: "Asia_batch18_new.xlsx_zho-CN.mqxliff", count: 1 }] },
            { contentType: "dialogue", domain: "game", count: 2, files: [{ name: "Trophy.xlsx_zho-CN.mqxliff", count: 2 }] }
          ],
          trajectories,
          evidence: trajectories
        };
      }
      else if (url.pathname === "/api/learning/conflict-scan" || url.pathname === "/api/quality/gate" || url.pathname === "/api/training/runs") {
        scopeBoundCalls.push(url.pathname);
        payload = url.pathname === "/api/training/runs" ? { runs: [] } : {};
      }
      else if (url.pathname === "/api/quality/assets") { scopeBoundCalls.push(url.pathname); payload = { assets: [] }; }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });

    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");
    await page.getByRole("button", { name: "学习中心" }).click();
    await page.waitForSelector("#learningTrajectoryCount");

    // ① 两个下拉都有"全部"
    assert.equal(await page.locator('#learningContentType option[value="all"]').count(), 1, "内容语体要有全部");
    assert.equal(await page.locator('#learningDomain option[value="all"]').count(), 1, "业务领域要有全部");

    // ② 切到全部：请求整维度放开，轨迹逐条带范围标签
    await page.locator("#learningContentType").selectOption("all");
    await page.locator("#learningDomain").selectOption("all");
    await page.waitForFunction(() => document.querySelector("#learningTrajectoryCount")?.textContent === "3");
    assert.deepEqual(learningCalls.at(-1), { locale: "zh-CN", contentType: "all", domain: "all", project: "project-1" });
    const tags = await page.locator("#learningEvidenceList .learning-evidence-item").evaluateAll((rows) => rows.map((row) => row.querySelector(".learning-scope-tag")?.textContent || ""));
    assert.equal(tags.length, 3);
    assert.ok(tags.includes("剧情对白 × 游戏"), `轨迹条目要带自己的范围标签：${JSON.stringify(tags)}`);
    assert.ok(tags.includes("待分类文本 × 游戏"), `不同范围的条目标签要不同：${JSON.stringify(tags)}`);
    // 生效版本面板：有轨迹的两份各带范围标签，没轨迹的那份收进折叠
    const championTags = await page.locator("#learningChampion .learning-scope-tag").allTextContents();
    assert.deepEqual(championTags, ["待分类文本 × 游戏", "剧情对白 × 游戏", "商店 / 商品说明 × 市场营销"]);
    assert.equal(await page.locator("#learningChampion > .learning-skill-card").count(), 2, "默认只摆有轨迹的范围");
    assert.equal(await page.locator("#learningChampion .learning-champion-rest").count(), 1);
    assert.equal(await page.locator("#learningChampion .learning-champion-rest").getAttribute("open"), null, "没有轨迹的范围默认折叠");
    assert.match(await page.locator("#learningChampion .learning-champion-rest > summary").textContent(), /其它 1 个范围还没有轨迹/u);
    assert.equal(await page.locator("#learningChampionStatus").textContent(), "2 个范围有轨迹 · 共 3 个");
    // 候选基线用它自己范围的生效版本：面板应显示"已完成生效版本 / 候选版本对比"，而不是"旧生效版本基线评测"
    assert.match(await page.locator("#learningEvaluationMatrix").textContent(), /已完成生效版本 \/ 候选版本对比/u);
    // 全部视图下主操作可用：点它会先让你挑一个"有轨迹的范围"（生成必须落到具体范围）
    assert.equal(await page.locator("#primaryAction").isDisabled(), false, "全部视图也能生成候选：先挑范围");
    assert.match(await page.locator("#primaryAction").getAttribute("title"), /先选一个有轨迹的范围/u);
    // 范围分布面板常驻，列出每个范围的条数与来源文件（点击可切换）
    const scopeRows = page.locator("#learningScopeHint .learning-scope-row");
    assert.equal(await scopeRows.count(), 2, "两个有轨迹的范围都要列出来");
    const scopePanelText = await page.locator("#learningScopeHint").innerText();
    assert.match(scopePanelText, /本项目各范围的轨迹/u);
    assert.match(scopePanelText, /待分类文本 × 游戏/u);
    assert.match(scopePanelText, /剧情对白 × 游戏/u);
    assert.match(scopePanelText, /来源：/u);
    // ④ 范围强绑定的三块在全部视图下不再发新请求，且界面说明原因。
    // （进入学习中心时还是默认具体范围，那时发过一次；这里比的是切到全部之后。）
    const scopeBoundCallsBeforeAll = scopeBoundCalls.length;
    await page.waitForTimeout(500);
    assert.equal(scopeBoundCalls.length, scopeBoundCallsBeforeAll, "全部视图不应再请求按单范围结算的接口");
    assert.match(await page.locator("#learningQualityAssets").textContent(), /先选具体/u);
    assert.equal(await page.locator("#learningConflictCount").textContent(), "需选定范围");
    // 范围强绑定的动作按钮也要在点之前就置灰（服务端会用 "all" 直接报错）
    for (const id of ["learningGateRun", "learningGoldSeed", "learningRegressionBuild", "learningExportAudit", "learningExportSft", "learningExportDpo", "trainingCreate", "learningConflictScan"]) {
      assert.equal(await page.locator(`#${id}`).isDisabled(), true, `${id} 在全部视图下应置灰`);
      assert.match(await page.locator(`#${id}`).getAttribute("title"), /先选具体「语体 × 领域」/u);
    }

    // ③ 切回具体范围：范围标签消失，范围强绑定的三块重新开始加载
    await page.locator("#learningContentType").selectOption("dialogue");
    await page.locator("#learningDomain").selectOption("game");
    await page.waitForFunction(() => document.querySelector("#learningScopeHint")?.hidden === false || document.querySelector("#learningTrajectoryCount")?.textContent === "2");
    assert.deepEqual(learningCalls.at(-1), { locale: "zh-CN", contentType: "dialogue", domain: "game", project: "project-1" });
    // 等渲染到位再断言：切了两个下拉会连着发两次请求，读早了还是上一个（全部）视图的 DOM。
    await waitForCount(page.locator("#learningEvidenceList .learning-scope-tag"), 0);
    assert.match(await page.locator("#learningEvidenceList").innerText(), /来源：/u, "每条轨迹要写清来自哪个文件");
    assert.equal(await page.locator("#learningGateRun").isDisabled(), false, "切回具体范围后按钮要恢复可点");
    assert.equal(await page.locator("#learningGateRun").getAttribute("title"), "", "恢复可点后要清掉说明");
    assert.ok(scopeBoundCalls.length > 0, "具体范围要能查冲突审查 / 质量资产 / 微调任务");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
