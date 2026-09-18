import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";
import { defaultSettings, settingGroups, TITLE_BRACKET_CHOICES } from "../src/settings.mjs";

/**
 * 真实浏览器回归：面板切分类会整块重绘，未保存的输入不能被抹掉；
 * 只有关窗或保存成功后才回到已保存值。
 */
test("设置面板切分类保留未保存输入，关窗才重置", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
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

  const settings = defaultSettings();
  const providerConfig = { baseUrl: "http://localhost:11434/v1", model: "qwen3:14b", fastModel: "", qualityModel: "", mtModel: "", embeddingModel: "", embeddingBaseUrl: "", inputPricePerMTok: "", outputPricePerMTok: "", apiKeyConfigured: false, embeddingApiKeyConfigured: false };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      let payload = {};
      let status = 200;
      if (path === "/api/bootstrap") payload = {
        locales: { "zh-CN": LOCALES["zh-CN"] }, contentTypes: CONTENT_TYPES, contentTags: CONTENT_TAGS,
        provider: providerConfig, backend: {}, assets: { "zh-CN": { revision: 0, termCount: 0 } }
      };
      else if (path === "/api/health") payload = { ok: true, version: "0.7.0" };
      else if (path === "/api/projects") payload = { projects: [{ id: "project-1", name: "测试项目", settings: createDefaultProjectSettings() }] };
      else if (path === "/api/projects/project-1/libraries") payload = { libraries: [] };
      else if (path === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (path === "/api/memories") payload = { memories: [] };
      else if (path === "/api/feedback/pending" || path === "/api/feedback") payload = [];
      else if (path === "/api/qa-cases/pending") payload = [];
      else if (path === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      else if (path === "/api/provider" && request.method() === "POST") {
        Object.assign(providerConfig, JSON.parse(request.postData() || "{}"), { apiKeyConfigured: false });
        payload = providerConfig;
      }
      else if (path === "/api/settings" && request.method() === "POST") {
        const body = JSON.parse(request.postData() || "{}");
        if (body.settings) Object.assign(settings, body.settings);
        payload = { settings, notes: [], environmentOverrides: {} };
      }
      else if (path === "/api/settings") payload = { settings, groups: settingGroups(), titleBracketChoices: TITLE_BRACKET_CHOICES, locales: { "zh-CN": LOCALES["zh-CN"].label }, environmentOverrides: {} };
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector("#openProvider");
    await page.waitForTimeout(800);
    assert.deepEqual(errors, [], `启动期不应有页面异常：${errors.join(" | ")}`);

    // 模型设置：输入 → 切分类 → 切回
    await page.locator("#openProvider").click();
    await page.waitForSelector("#providerDialog[open]");
    await page.locator('#providerDialog input[name="baseUrl"]').fill("http://127.0.0.1:11435/v1");
    await page.locator('#providerDialog button[data-tab="models"]').click();
    await page.locator('#providerDialog input[name="model"]').fill("typed-model");
    await page.locator('#providerDialog button[data-tab="connection"]').click();
    assert.equal(await page.locator('#providerDialog input[name="baseUrl"]').inputValue(), "http://127.0.0.1:11435/v1", "切分类后 Base URL 不应被重置");
    await page.locator('#providerDialog button[data-tab="models"]').click();
    assert.equal(await page.locator('#providerDialog input[name="model"]').inputValue(), "typed-model", "切分类后模型名不应被重置");

    // 关窗（未保存）→ 重开应回到已保存值
    await page.locator("#providerDialog button[data-close-panel]").first().click();
    await page.locator("#openProvider").click();
    assert.equal(await page.locator('#providerDialog input[name="baseUrl"]').inputValue(), "http://localhost:11434/v1", "关窗未保存应丢弃编辑");

    // 保存 → 值落库，且继续切分类仍然保留
    await page.locator('#providerDialog input[name="baseUrl"]').fill("http://127.0.0.1:11435/v1");
    await page.locator("#providerDialog button[data-save]").click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator("#providerDialog").evaluate((node) => node.open), true, "保存后不应自动关闭面板");
    await page.locator('#providerDialog button[data-tab="pricing"]').click();
    await page.locator('#providerDialog button[data-tab="connection"]').click();
    assert.equal(await page.locator('#providerDialog input[name="baseUrl"]').inputValue(), "http://127.0.0.1:11435/v1");
    await page.locator("#providerDialog button[data-close-panel]").first().click();

    // 参数设置：改值 → 切分类 → 切回；关窗未保存则丢弃
    await page.locator("#openSettings").click();
    await page.waitForSelector("#settingsDialog[open]");
    const scoreInput = page.locator('#settingsDialog input[data-path="quality.qaPassScore"]');
    await scoreInput.fill("95");
    await page.locator('#settingsDialog button[data-tab="retrieval"]').click();
    await page.locator('#settingsDialog button[data-tab="quality"]').click();
    assert.equal(await scoreInput.inputValue(), "95", "切分类后参数不应被重置");
    await page.locator("#settingsDialog button[data-close-panel]").first().click();
    await page.locator("#openSettings").click();
    await page.waitForSelector("#settingsDialog[open]");
    assert.equal(await page.locator('#settingsDialog input[data-path="quality.qaPassScore"]').inputValue(), "90", "关窗未保存应丢弃编辑");
    await scoreInput.fill("95");
    await page.locator("#settingsDialog button[data-save]").click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator("#settingsDialog").evaluate((node) => node.open), true, "保存后不应自动关闭面板");
    await page.locator('#settingsDialog button[data-tab="learning"]').click();
    await page.locator('#settingsDialog button[data-tab="quality"]').click();
    assert.equal(await scoreInput.inputValue(), "95", "保存后切分类应保留已保存值");
    await page.locator("#settingsDialog button[data-close-panel]").first().click();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
