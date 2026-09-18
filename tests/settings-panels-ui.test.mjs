import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("模型设置与参数设置使用分栏面板，不再平铺单页", async () => {
  const [html, script, panels, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/settings-panels.js", import.meta.url), "utf8"),
    readFile(new URL("../public/settings-panels.css", import.meta.url), "utf8")
  ]);
  assert.match(html, /id="settingsDialog" class="settings-shell"/u);
  assert.match(html, /id="providerDialog" class="settings-shell"/u);
  assert.match(html, /settings-panels\.css/u);
  assert.doesNotMatch(html, /id="settingsForm"/u);
  assert.doesNotMatch(html, /id="providerForm"/u);
  assert.match(script, /createProviderSettingsPanel/u);
  assert.match(script, /createParameterSettingsPanel/u);
  assert.match(script, /openProviderSettings/u);
  assert.match(script, /openParameterSettings/u);
  for (const label of ["连接与鉴权", "模型分工", "Embedding", "成本门禁", "质量与 QA", "检索与上下文", "学习与评测", "分享与标点"]) {
    assert.match(panels, new RegExp(label, "u"));
  }
  assert.match(panels, /data-tab=/u);
  assert.match(styles, /\.sp-nav/u);
  assert.match(styles, /\.sp-field/u);
  assert.match(styles, /\.sp-card/u);
});

/**
 * 回归：保存时的取值必须发生在重绘之前。
 * render() 会用内存里的旧配置重建整个面板，先 render 会把用户刚输入的值丢掉。
 */
function submitBody(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `找不到 ${marker}`);
  const ends = ["\n  async function", "\n  dialog.addEventListener", "\n  return {"]
    .map((token) => source.indexOf(token, start + marker.length))
    .filter((index) => index > start);
  return source.slice(start, ends.length ? Math.min(...ends) : source.length);
}

test("模型设置先取表单值再重绘，并且保存后不关面板", async () => {
  const panels = await readFile(new URL("../public/settings-panels.js", import.meta.url), "utf8");
  const body = submitBody(panels, "async function submit() {\n    if (saving) return;\n    // 必须先取值再重绘");
  const collect = body.indexOf('new FormData(find(".sp-form"))');
  const render = body.indexOf("render();");
  assert.ok(collect >= 0 && render >= 0, "取值与重绘都应出现在 submit 里");
  assert.ok(collect < render, "必须先把表单值取出来再 render()");
  assert.doesNotMatch(body, /dialog\.close\(\)/u);
  assert.match(body, /已保存 · /u);
});

test("参数设置先 collect 再重绘，并且保存后不关面板", async () => {
  const panels = await readFile(new URL("../public/settings-panels.js", import.meta.url), "utf8");
  const body = submitBody(panels, "async function submit() {\n    if (saving) return;\n    // 同模型设置");
  const collect = body.indexOf("const submitted = collect();");
  const render = body.indexOf("render();");
  assert.ok(collect >= 0 && render >= 0, "collect 与 render 都应出现在 submit 里");
  assert.ok(collect < render, "必须先把表单值取出来再 render()");
  assert.doesNotMatch(body, /dialog\.close\(\)/u);
  assert.match(body, /已保存并立即生效/u);
});

test("项目设置保存后留在面板里，不自动关闭", async () => {
  const source = await readFile(new URL("../public/project-settings.js", import.meta.url), "utf8");
  const start = source.indexOf("async function submit() {");
  const body = source.slice(start, source.indexOf("\n  dialog.addEventListener", start));
  assert.doesNotMatch(body, /dialog\.close\(\)/u);
  assert.match(body, /已保存 · /u);
});

/**
 * 回归：面板切分类会整块重绘，未保存的编辑必须放在草稿里渲染，
 * 否则用户切一下分类再切回来，刚输入的地址/参数就没了。
 */
test("两个设置面板都用草稿渲染，切分类不丢未保存输入", async () => {
  const panels = await readFile(new URL("../public/settings-panels.js", import.meta.url), "utf8");
  assert.match(panels, /let draft = null;/u);
  // 模型设置：打开/保存时重建草稿，渲染优先读草稿。
  assert.match(panels, /function draftFromProvider\(source\)/u);
  assert.match(panels, /const value = draft && Object\.hasOwn\(draft, field\.name\) \? draft\[field\.name\] : saved;/u);
  assert.match(panels, /draft = draftFromProvider\(saved\);/u);
  assert.match(panels, /draft = draftFromProvider\(nextProvider\);/u);
  // 参数设置：草稿参与渲染，勾选与数值都写回草稿。
  assert.match(panels, /const edited = draft \? readPath\(draft, field\.path\) : undefined;/u);
  assert.match(panels, /const source = draft\?\.orthography\?\.titleBrackets \|\| payload\.settings\.orthography\?\.titleBrackets \|\| \{\};/u);
  assert.match(panels, /draft = structuredClone\(payload\.settings\);/u);
  assert.match(panels, /writePath\(draft, input\.dataset\.path, Number\(input\.value\)\);/u);
  assert.match(panels, /draft\.orthography\.titleBrackets\[input\.dataset\.bracket\] = input\.value;/u);
  // 只靠 input 事件维护草稿：click 里的分类切换不能顺手把草稿清掉。
  assert.equal((panels.match(/dialog\.addEventListener\("input"/gu) || []).length, 2);
});

test("浏览器回归测试覆盖设置面板的草稿行为", async () => {
  const browserTest = await readFile(new URL("./settings-panels-browser.test.mjs", import.meta.url), "utf8");
  assert.match(browserTest, /切分类后 Base URL 不应被重置/u);
  assert.match(browserTest, /关窗未保存应丢弃编辑/u);
  assert.match(browserTest, /保存后不应自动关闭面板/u);
});
