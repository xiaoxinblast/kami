import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

test("术语表与风格指南可从各自页面进入完整导入流程", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 60000 }, async () => {
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
  let importedGuide = false;
  let commitBody = null;
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      let payload = {};
      if (path === "/api/bootstrap") payload = {
        locales: { "zh-CN": LOCALES["zh-CN"] }, contentTypes: CONTENT_TYPES, contentTags: CONTENT_TAGS,
        provider: { model: "test", baseUrl: "http://127.0.0.1/v1" }, backend: {}, assets: { "zh-CN": { revision: 0, termCount: 0 } }
      };
      else if (path === "/api/health") payload = { ok: true, version: "0.7.0" };
      else if (path === "/api/projects") payload = { projects: [{ id: "project-1", name: "测试项目", settings: createDefaultProjectSettings() }] };
      else if (path === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (path === "/api/projects/project-1/libraries") payload = {
        projectId: "project-1",
        libraries: [
          { id: "term-1", name: "术语库", kind: "term_base", role: "reference", enabled: true, priority: 1 },
          { id: "term-2", name: "角色术语", kind: "term_base", role: "reference", enabled: true, priority: 2 },
          { id: "tm-master", name: "主 TM", kind: "translation_memory", role: "master", enabled: true, priority: 1 },
          { id: "tm-reference", name: "参考 TM", kind: "translation_memory", role: "reference", enabled: true, priority: 2 }
        ]
      };
      else if (path === "/api/memories") payload = { memories: [] };
      else if (path === "/api/feedback/pending" || path === "/api/feedback") payload = [];
      else if (path === "/api/qa-cases/pending") payload = [];
      else if (path === "/api/style-profiles") payload = {
        styleProfiles: [], evidencePools: [], learningRuns: [],
        userProfiles: importedGuide ? [{ id: "guide-1", name: "风格指南 · 项目风格指南", locale: "zh-CN", instruction: "对白使用自然口语。", version: 1, evidenceCount: 0, status: "active" }] : []
      };
      else if (path === "/api/assets-import/preview") payload = {
        batchId: "batch-1", statistics: { entries: 2 },
        files: [{ filename: "terms.xlsx", type: "xlsx", entries: 2, defaultPurpose: "tm", anomalies: [] }],
        candidates: [{ sourceFile: "terms.xlsx", source: "用語", target: "术语", locale: "zh-CN", selected: true }]
      };
      else if (path === "/api/assets-import/commit") {
        commitBody = JSON.parse(request.postData() || "{}");
        payload = { taskId: "", batchId: "batch-1", accepted: 1 };
      }
      else if (path === "/api/style-guides/import") {
        importedGuide = true;
        payload = { filename: "项目风格指南.md", characters: 9, profile: { id: "guide-1" } };
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole("button", { name: "术语库" }).click();
    await page.locator("#termLibraryFile").setInputFiles({ name: "terms.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("test") });
    await page.locator("#assetPreflightDialog").waitFor({ state: "visible" });
    // 类型在上传前已选定，弹窗只展示去向，并保留 AI 清洗 / 风格证据的最终开关。
    assert.equal(await page.locator("#assetPreflightAiRow").isHidden(), false);
    assert.equal(await page.locator("#assetPreflightAiCleaning").isChecked(), false);
    assert.match(await page.locator("#assetPreflightSummary").textContent(), /按本地规则分流/u);
    // 预检还没确认时可以先放弃：关掉弹窗后导入页那条提示里要能直接取消这次导入。
    await page.locator('[data-close="assetPreflightDialog"]').first().click();
    await page.waitForFunction(() => document.querySelector("#assetPreflightDialog")?.open === false);
    await page.getByRole("button", { name: "双语资产导入" }).click();
    await page.waitForSelector("#importPreflightResume:not([hidden])");
    assert.match(await page.locator("#importPreflightResumeTitle").textContent(), /预检结果还没确认：1 个文件、2 条双语条目/u);
    assert.match(await page.locator("#importPreflightResumeMeta").textContent(), /短词条写入「术语库」，完整句段写入「主 TM」/u);
    assert.equal(await page.locator("#importPreflightCancel").isHidden(), false);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/import-resume-cancel.png`, animations: "disabled" });
    }
    await page.locator("#importPreflightCancel").click();
    await page.waitForFunction(() => document.querySelector("#importPreflightResume")?.hidden === true);
    assert.equal(await page.locator("#filePrompt").textContent(), "拖入或点击选择双语资产文件", "取消后拖入区要回到没选文件的样子");
    assert.equal(await page.locator("#importFileList").isHidden(), true);
    assert.equal(await page.locator("#dropZone").evaluate((node) => node.classList.contains("has-file")), false);
    assert.match(await page.locator("#fileMeta").textContent(), /先本地预检，再确认导入/u);
    // 重新选同一个文件 → 重新预检 → 继续验证弹窗里的去向选择。
    await page.locator("#termLibraryFile").setInputFiles({ name: "terms.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("test") });
    await page.locator("#assetPreflightDialog").waitFor({ state: "visible" });
    // 弹窗里就能改去向：切到人工 TM 后术语库那一栏要收起，目标库跟着换成主 TM。
    assert.equal(await page.locator("#assetPreflightTermLibraryRow").isHidden(), false);
    assert.equal(await page.locator("#assetPreflightTermLibrary").inputValue(), "term-1");
    // 选项本身就是 label：点击要像真实用户那样点整块，而不是硬点被裁剪掉的 input。
    await page.locator('label.import-purpose-option:has(input[name="assetPreflightPurpose"][value="tm"])').click();
    assert.equal(await page.locator("#assetPreflightTermLibraryRow").isHidden(), true, "人工 TM 不该再让人选术语库");
    assert.match(await page.locator("#assetPreflightTarget").textContent(), /人工 TM → 主 TM/u);
    // 去向文案必须跟着选中的库走：选了参考 TM 就不能还写"写入人工主 TM"。
    await page.locator("#assetPreflightTmLibrary").selectOption("tm-reference");
    const destinationCell = page.locator("#assetPreflightBody tr").first().locator("td").nth(3);
    assert.match(await destinationCell.textContent(), /人工终稿 → 「参考 TM」/u);
    assert.match(await page.locator("#assetPreflightSummary").textContent(), /去向：人工终稿 → 「参考 TM」/u);
    assert.doesNotMatch(await destinationCell.textContent(), /主 TM/u, "选中参考 TM 时不该再说写入主 TM");
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/asset-preflight-library-copy.png`, animations: "disabled" });
    }
    // 这里选的库就是提交时带上的库：换一个术语库再切回来。
    await page.locator('label.import-purpose-option:has(input[name="assetPreflightPurpose"][value="term"])').click();
    assert.equal(await page.locator("#assetPreflightTermLibraryRow").isHidden(), false);
    await page.locator("#assetPreflightTermLibrary").selectOption("term-2");
    assert.match(await page.locator("#assetPreflightTarget").textContent(), /术语 → 角色术语/u);
    assert.match(await destinationCell.textContent(), /短词条 → 「角色术语」；句段 → 「参考 TM」/u);
    await page.locator("#assetPreflightConfirm").click();
    await page.waitForFunction(() => /已提交后台导入/.test(document.querySelector("#assetPreflightSummary")?.textContent || ""));
    assert.equal(commitBody?.purpose, "term");
    assert.equal(commitBody?.termLibraryId, "term-2", "弹窗里换的库必须进提交体");
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/term-library-upload.png`, animations: "disabled" });
    }
    await page.locator('[data-close="assetPreflightDialog"]').first().click();
    // 关掉预检后导入页要留一条能再打开的入口，而且说的是现状（已提交），不是"还没确认"。
    await page.waitForFunction(() => document.querySelector("#assetPreflightDialog")?.open === false);
    await page.getByRole("button", { name: "双语资产导入" }).click();
    await page.waitForSelector("#importPreflightResume:not([hidden])");
    assert.match(await page.locator("#importPreflightResumeTitle").textContent(), /已提交后台导入：1 个文件、2 条双语条目/u);
    assert.equal(await page.locator("#importPreflightResumeReset").isHidden(), true, "已提交后不该再提供重新预检");
    assert.equal(await page.locator("#importPreflightCancel").isHidden(), true, "已提交的导入要去任务中心中断，不能在这里取消");
    await page.locator("#importPreflightResumeOpen").click();
    await page.waitForSelector("#assetPreflightDialog[open]");
    if (process.env.KAMI_UI_SCREENSHOTS) await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/asset-preflight-destination.png`, animations: "disabled" });
    await page.locator('[data-close="assetPreflightDialog"]').first().click();
    await page.waitForFunction(() => document.querySelector("#assetPreflightDialog")?.open === false);
    await page.getByRole("button", { name: "风格指导" }).click();
    await page.locator("#styleGuideFile").setInputFiles({ name: "项目风格指南.md", mimeType: "text/markdown", buffer: Buffer.from("对白使用自然口语。", "utf8") });
    assert.equal(await page.locator("#styleGuideImportButton").isDisabled(), false);
    await page.locator("#styleGuideImportButton").click();
    await page.waitForSelector("#styleGuideImportNote.is-ok");
    assert.match(await page.locator("#styleGuideImportNote").textContent(), /已启用：项目风格指南\.md · 9 字/u);
    // 顶部的人工风格指南模块要能一眼看出"有、哪一份、已启用"
    const manualGuide = await page.locator("#manualGuideStatus").textContent();
    assert.match(manualGuide, /项目风格指南/u);
    assert.match(manualGuide, /已启用/u);
    assert.match(manualGuide, /查看正文（全文 9 字/u);
    // 人工指南是一整篇文档，不再混进"一条一条"的规则列表里
    assert.equal(await page.locator("#styleGuidanceList .style-guidance-card").count(), 0);
    assert.match(await page.locator("#styleGuidanceList").textContent(), /人工导入的风格指南在上面的「人工风格指南」模块里单独展示/u);
    if (process.env.KAMI_UI_SCREENSHOTS) await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/style-guide-upload.png`, animations: "disabled" });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
