import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";

/**
 * 真实浏览器回归：人工风格指南导入
 *  - 上传控件是个看得出来的按钮，选中后显示文件名；
 *  - 导入成功后给出醒目的"已启用"结果（原来只在右侧显示一行小字）；
 *  - 导入的指南以 active 状态回到列表里（不再是"待批准规范"）。
 */
test("人工风格指南导入后立即启用，并给出明确结果", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
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

  let importBody = null;
  let imported = false;
  let guideStatus = "active";
  const profileActions = [];
  // 8058 字那种规模：正文尾部放一行唯一标记，只有真的渲染全文才看得到。
  const guideTail = "尾部校验：省略号一律使用 ……（U+2026 两个一组）。";
  const guideInstruction = [
    "# 品牌语气指南",
    "编译自：品牌指南.docx（权威综合文档）",
    "====================",
    "## 1.1 引号",
    "・中文译文只能用弯引号“”（U+201C / U+201D）",
    "・绝对禁止使用日式角引号「」（U+300C / U+300D）",
    ...Array.from({ length: 60 }, (_, index) => `・条款 ${index + 1}：保持克制、不用感叹号。`),
    "## 1.3 省略号",
    "・使用中文省略号 ……（U+2026，两个三点省略号为一组）",
    guideTail
  ].join("\n");
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/style-guides/import") {
        importBody = JSON.parse(request.postData() || "{}");
        imported = true;
        return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ profile: { id: "up-1", name: "风格指南 · 品牌语气", locale: "zh-CN", instruction: "…", examples: [], version: 1 }, filename: "品牌语气.md", characters: 1234 }) });
      }
      if (url.pathname.startsWith("/api/style-profiles/")) {
        profileActions.push(url.pathname);
        if (url.pathname.endsWith("/reject")) guideStatus = "inactive";
        if (url.pathname.endsWith("/activate")) guideStatus = "active";
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "up-1", status: guideStatus }) });
      }
      let payload = {};
      if (url.pathname === "/api/bootstrap") payload = {
        locales: { "zh-CN": LOCALES["zh-CN"] }, contentTypes: CONTENT_TYPES, contentTags: CONTENT_TAGS,
        provider: { model: "test", baseUrl: "http://127.0.0.1/v1" }, backend: {}, assets: { "zh-CN": { revision: 0, termCount: 0 } }
      };
      else if (url.pathname === "/api/health") payload = { ok: true, version: "0.7.0" };
      else if (url.pathname === "/api/projects") payload = { projects: [{ id: "project-1", name: "测试项目", settings: createDefaultProjectSettings() }] };
      else if (url.pathname === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (url.pathname === "/api/memories") payload = { memories: [], total: 0 };
      else if (url.pathname === "/api/feedback/pending" || url.pathname === "/api/feedback") payload = [];
      else if (url.pathname === "/api/qa-cases/pending") payload = [];
      else if (url.pathname === "/api/style-profiles") payload = imported
        ? {
          // 人工指南是整篇文档：标题、分隔线、正文，末尾还有一行"只有全文才看得到"的校验行。
          userProfiles: [{
            id: "up-1", name: "风格指南 · 品牌语气", instruction: guideInstruction,
            examples: [], version: 1, evidenceCount: 0, status: guideStatus, updatedAt: "2026-09-18T12:00:00Z"
          }],
          // 蒸馏出来的才是"一条一条的规则"，这里给 30 条验证不再被截断到 24 条。
          styleProfiles: [{
            id: "sp-1", name: "简体中文 marketing 风格", contentType: "marketing", domain: "game",
            instruction: Array.from({ length: 30 }, (_, index) => `规则 ${index + 1}`).join("\n"),
            examples: [], version: 1, evidenceCount: 12, status: "draft"
          }],
          evidencePools: [], learningRuns: []
        }
        : { userProfiles: [], styleProfiles: [], evidencePools: [], learningRuns: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector(".nav-item");
    await page.getByRole("button", { name: "风格指导" }).click();
    await page.waitForSelector("#styleGuideFile", { state: "attached" });

    assert.equal(await page.locator("#styleGuideImportButton").textContent(), "导入并立即启用");
    assert.equal(await page.locator("#styleGuideImportButton").isDisabled(), true);
    assert.equal(await page.locator("#styleGuideFileName").textContent(), "支持 TXT / Markdown / DOCX，最大 5MB");
    // 风格数据是异步拉的，等模块渲染完再断言，否则会读到"正在读取"的占位文案
    await page.waitForSelector("#manualGuideStatus .manual-guide-empty");
    assert.match(await page.locator("#manualGuideStatus").textContent(), /还没有人工风格指南/u, "没有指南时要有明确空状态");

    await page.locator("#styleGuideFile").setInputFiles({ name: "品牌语气.md", mimeType: "text/markdown", buffer: Buffer.from("# 语气\n1. 克制。\n") });
    assert.equal(await page.locator("#styleGuideImportButton").isDisabled(), false);
    assert.match(await page.locator("#styleGuideFileName").textContent(), /品牌语气\.md/u);
    assert.match(await page.locator("#styleGuideImportNote").textContent(), /点右侧按钮导入并立即启用/u);
    assert.equal(await page.locator(".library-file-button.has-file").count(), 1, "选中的上传控件要有可见状态");

    await page.locator("#styleGuideImportButton").click();
    await page.waitForSelector("#styleGuideImportNote.is-ok");
    assert.ok(importBody, "应该发起导入请求");
    assert.equal(importBody.filename, "品牌语气.md");
    assert.match(await page.locator("#styleGuideImportNote").textContent(), /已启用：品牌语气\.md · 1234 字/u);
    // 蒸馏出来的规则是 draft：这里等规则卡片渲染出来（人工指南不在这个列表里）。
    await page.waitForSelector("#styleGuidanceList .style-guidance-card");
    assert.match(await page.locator("#styleGuidanceList .style-guidance-card").first().textContent(), /共 30 条规则/u, "蒸馏规则不再被截断到 24 条");
    assert.equal(await page.locator("#styleGuidanceList .style-rule-list > div").count(), 30, "30 条规则要全部渲染");

    // 人工风格指南模块：哪一份、是否启用、多少字、什么时候更新，一眼可见
    await page.waitForSelector("#manualGuideStatus .manual-guide-card.active");
    const guideText = await page.locator("#manualGuideStatus").textContent();
    assert.match(guideText, /品牌语气/u);
    assert.match(guideText, /正在作为最高优先级风格规则参与翻译/u);
    assert.ok(guideText.includes(`v1 · 正文 ${[...guideInstruction].length} 字`), `模块要显示正文字数：${guideText}`);
    assert.match(guideText, /已启用/u);
    // 全文：不能只渲染前 1500 字，尾巴那行必须能看到
    assert.ok(guideText.includes(guideTail), "查看正文要渲染整篇文档，不能截断");
    assert.equal(await page.locator(".manual-guide-card [data-action=copy-guide]").count(), 1, "要能复制全文");
    await page.locator(".manual-guide-card .manual-guide-details summary").click();
    assert.equal(await page.locator(".manual-guide-card .guide-doc").isVisible(), true, "展开后显示全文文档");
    assert.equal(await page.locator(".manual-guide-card .guide-doc-heading").count() >= 3, true, "按文档结构渲染标题");
    // 人工指南不再混进"当前规则与待批准规范"的逐条列表
    assert.equal(await page.locator("#styleGuidanceList .style-guidance-card", { hasText: "风格指南 · 品牌语气" }).count(), 0, "人工指南不按条列在规则表里");
    assert.equal(await page.locator('.manual-guide-card [data-action="disable"]').count(), 1, "启用状态要给停用入口");
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/manual-style-guide.png`, fullPage: true, animations: "disabled" });
    }

    // 停用 → 模块要立刻反映"已停用 / 可重新启用"
    await page.locator('.manual-guide-card [data-action="disable"]').click();
    await page.waitForFunction(() => document.querySelector('.manual-guide-card')?.classList.contains("inactive"));
    assert.equal(profileActions.at(-1), "/api/style-profiles/up-1/reject");
    const disabledText = await page.locator("#manualGuideStatus").textContent();
    assert.match(disabledText, /已停用，历史版本仍保留/u);
    assert.equal(await page.locator('.manual-guide-card [data-action="activate"]').count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
