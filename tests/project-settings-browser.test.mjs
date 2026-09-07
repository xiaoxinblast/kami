import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createDefaultProjectSettings, projectRuleMetadata } from "../src/project-config.mjs";

// Opt-in browser regression: point KAMI_BROWSER_TEST_MODULE at an installed Playwright package.
test("项目设置浏览器交互、失败恢复与响应式布局", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 60000 }, async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.KAMI_BROWSER_TEST_MODULE);
  const browser = await chromium.launch({ headless: true, ...(process.env.KAMI_BROWSER_EXECUTABLE ? { executablePath: process.env.KAMI_BROWSER_EXECUTABLE } : {}) });
  const server = createServer(async (req, res) => {
    const pathname = req.url === "/" ? "/index.html" : req.url;
    const extension = pathname.split(".").at(-1);
    try {
      const body = await readFile(new URL(`../public${pathname}`, import.meta.url));
      res.setHeader("content-type", ({ html: "text/html", js: "text/javascript", css: "text/css", png: "image/png" })[extension] || "application/octet-stream");
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/app.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const project = { id: "test", name: "Kami · 日中本地化", settings: createDefaultProjectSettings(), qaRuleMetadata: projectRuleMetadata() };
    const libraries = [
      { id: "terms", name: "项目术语库", kind: "term_base", role: "reference", priority: 10, enabled: true },
      { id: "master", name: "主 TM", kind: "translation_memory", role: "master", priority: 1, enabled: true },
      { id: "working", name: "工作 TM", kind: "translation_memory", role: "working", priority: 999, enabled: true }
    ];
    await page.evaluate(async ({ project, libraries }) => {
      const { createProjectSettingsPanel } = await import("/project-settings.js");
      window.fixture = project;
      window.libraries = libraries;
      window.writes = [];
      window.failSave = false;
      window.panel = createProjectSettingsPanel(document.querySelector("#projectSettingsDialog"), {
        api: async (path, options) => {
          window.writes.push({ path, ...options });
          const body = JSON.parse(options.body);
          if (path.includes("/libraries")) {
            const saved = { ...body, id: options.method === "POST" ? `created-${window.writes.length}` : path.split("/").at(-1) };
            window.libraries = [...window.libraries.filter((library) => library.id !== saved.id), saved];
            return { library: saved };
          }
          if (window.failSave) throw new Error("模拟连接中断");
          return { ...window.fixture, settings: body.settings };
        },
        onSaved: (saved) => { window.fixture = saved; }
      });
      window.panel.open(project, libraries);
    }, { project, libraries });
    const dialog = page.locator("#projectSettingsDialog");
    const selectTab = (tab) => page.locator(`[data-tab="${tab}"]`).click();
    const reopen = () => page.evaluate(() => window.panel.open(window.fixture, window.libraries));
    const screenshot = async (name) => {
      if (!process.env.KAMI_UI_SCREENSHOTS) return;
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/${name}.png`, animations: "disabled" });
    };
    assert.equal(await dialog.locator('[role="tab"]').count(), 4);
    assert.equal(await page.locator("[data-save]").isDisabled(), true);
    await page.locator("[data-tab=libraries]").press("ArrowDown");
    assert.equal(await page.locator("[data-tab=matching]").getAttribute("aria-selected"), "true");
    await selectTab("libraries");
    await screenshot("desktop-libraries");
    const switchBox = await page.locator('[data-library="terms"] [role="switch"]').boundingBox();
    assert.ok(switchBox.width <= 40 && switchBox.height <= 24);
    assert.equal(await page.locator('[data-library="master"] [data-priority-rank]').textContent(), "1");
    assert.equal(await page.locator('[data-library="working"] [data-priority-rank]').textContent(), "2");
    await page.locator('[data-library="working"] [data-move="up"]').click();
    assert.deepEqual(await page.locator('[data-library-list="translation_memory"] [data-library]').evaluateAll((rows) => rows.map((row) => [row.dataset.library, row.querySelector("[data-priority-rank]").textContent])), [["working", "1"], ["master", "2"]]);
    await selectTab("matching");
    await page.locator('[data-setting="tm.llmMinRelevance"]').fill("0");
    await screenshot("desktop-matching");
    await selectTab("batch");
    await page.locator('[data-setting="batch.groupMaxEntries"]').fill("12");
    await screenshot("desktop-batch");
    await selectTab("libraries");
    await page.locator('[data-add-library="term_base"]').click();
    await page.locator('[data-library^="new-"] [data-library-field="name"]').fill("新增术语测试");
    assert.equal(await page.evaluate(() => window.writes.length), 0);
    await selectTab("matching");
    assert.equal(await page.locator('[data-setting="tm.llmMinRelevance"]').inputValue(), "0");
    await selectTab("qa");
    assert.equal(await page.locator("[data-rule]:visible").count(), 20);
    assert.equal(await page.locator('[data-rule-toggle="term_potential"]').isChecked(), false);
    assert.equal(await page.locator('[data-rule-toggle="register"]').isChecked(), false);
    await page.locator("[data-rule-search]").fill("换行数量");
    assert.equal(await page.locator("[data-rule]:visible").count(), 1);
    assert.equal(await page.locator('[data-rule-toggle="newline_count"]').isChecked(), false);
    assert.equal(await page.locator('[data-rule-severity="newline_count"]').isDisabled(), true);
    await page.locator('[data-rule-toggle="newline_count"]').check();
    await page.locator('[data-rule-severity="newline_count"]').selectOption("info");
    await page.locator("[data-rule-search]").fill("");
    await page.locator("[data-rule-group]").selectOption("结构强制");
    assert.equal(await page.locator("[data-rule]:visible").count(), 2);
    assert.equal(await page.locator('[data-rule-group]').inputValue(), "结构强制");
    assert.equal(await page.locator('[data-rule="document_integrity"] input').count(), 0);
    await page.locator("[data-rule-group]").selectOption("");
    await screenshot("desktop-qa");
    await page.locator("[data-close-settings]").click();
    assert.equal(await page.locator("[data-discard-prompt]").isVisible(), true);
    await page.locator("[data-keep-editing]").click();
    await selectTab("batch");
    await page.locator('[data-setting="batch.groupMaxEntries"]').fill("2.5");
    await selectTab("libraries");
    await page.locator("[data-save]").click();
    assert.equal(await page.locator("[data-tab=batch]").getAttribute("aria-selected"), "true");
    assert.equal(await page.locator('[data-setting="batch.groupMaxEntries"]').getAttribute("aria-invalid"), "true");
    assert.equal(await page.evaluate(() => window.writes.length), 0);
    await page.locator('[data-setting="batch.groupMaxEntries"]').fill("12");
    await page.evaluate(() => { window.failSave = true; });
    await page.locator("[data-save]").click();
    await page.getByText(/模拟连接中断。编辑内容已保留/).waitFor();
    assert.equal(await dialog.isVisible(), true);
    await page.evaluate(() => { window.failSave = false; });
    await page.locator("[data-save]").click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => window.writes.filter((request) => request.method === "POST").length), 1);
    await reopen();
    await selectTab("matching");
    assert.equal(await page.locator('[data-setting="tm.llmMinRelevance"]').inputValue(), "0");
    await selectTab("batch");
    assert.equal(await page.locator('[data-setting="batch.groupMaxEntries"]').inputValue(), "12");
    await page.locator('[data-setting="batch.groupMaxEntries"]').fill("13");
    await page.keyboard.press("Escape");
    await page.locator("[data-discard]").click();
    await reopen();
    await selectTab("batch");
    assert.equal(await page.locator('[data-setting="batch.groupMaxEntries"]').inputValue(), "12");
    for (const [width, height] of [[1024, 768], [800, 600], [390, 844], [320, 640]]) {
      await page.setViewportSize({ width, height });
      for (const tab of ["libraries", "matching", "batch", "qa"]) {
        await selectTab(tab);
        const layout = await page.evaluate(() => {
          const dialog = document.querySelector("#projectSettingsDialog");
          const panel = dialog.querySelector('[data-panel]:not([hidden])');
          const footer = dialog.querySelector(".ps-footer").getBoundingClientRect();
          return { overflow: panel.scrollWidth > panel.clientWidth, dialogOverflow: dialog.scrollWidth > dialog.clientWidth, bottom: footer.bottom, top: footer.top };
        });
        assert.equal(layout.overflow, false, `${width} ${tab} horizontal overflow`);
        assert.equal(layout.dialogOverflow, false, `${width} ${tab} dialog overflow`);
        assert.ok(layout.bottom <= height && layout.top >= 0, `${width} footer offscreen`);
        if (width === 390 && ["libraries", "qa"].includes(tab)) await screenshot(`mobile-${tab}`);
      }
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
