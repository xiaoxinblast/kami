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
