import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (name) => readFile(new URL(`../public/${name}`, import.meta.url), "utf8");

const styles = await read("styles.css");
const html = await read("index.html");
const app = await read("app.js");

test("列表类页面不再被写死的宽度上限截断（宽屏右侧不留空白）", () => {
  // 任务中心 / 术语库 / 记忆库 / 风格指导 / 学习中心曾经各有一条 max-width（1100 / 1180），
  // 宽屏下主区域铺满、面板只占一半，右半边空出来。
  assert.doesNotMatch(styles, /\.asset-list-panel\s*\{[^}]*max-width/u);
  assert.doesNotMatch(styles, /\.task-center-panel[^{]*\{[^}]*max-width/u);
  assert.doesNotMatch(styles, /\.style-guidance-panel[^{]*\{[^}]*max-width/u);
  assert.doesNotMatch(styles, /\.learning-champion-panel[^{]*\{[^}]*max-width/u);
  assert.doesNotMatch(styles, /\.import-learning-panel\s*\{[^}]*max-width/u);
});

test("质量档只在一处可选：批次模式隐藏顶部那一行，取值两边同步", () => {
  // 批次页自己的质量档在「分段与翻译策略」面板里（context-brief 用例依赖它）。
  assert.match(html, /id="batchQualityTier"/u);
  assert.match(html, /<div class="tier-row" id="tierRow">/u);
  assert.match(app, /if \(tierRow\) tierRow\.hidden = state\.translationMode === "batch";/u);
  assert.match(app, /function syncQualityTier\(value, source\)/u);
  assert.match(app, /syncQualityTier\(\$\("#batchQualityTier"\)\.value, \$\("#batchQualityTier"\)\);/u);
  assert.match(app, /syncQualityTier\(\$\("#qualityTier"\)\.value, \$\("#qualityTier"\)\);/u);
  // 单句与批次各自读自己版面里的那一个，值是同步过的。
  assert.match(app, /qualityTier: \$\("#qualityTier"\)\.value,/u);
  assert.match(app, /qualityTier: batchQualityTier\(\),/u);
});

test("学习中心常驻范围面板：每个范围多少条、来自哪个文件，点一下切换", () => {
  assert.match(html, /<div class="learning-scope-hint" id="learningScopeHint" hidden><\/div>/u);
  assert.match(app, /function renderLearningScopeHint\(scopeCounts, trajectoryCount\)/u);
  assert.match(app, /data-learning-scope-content="\$\{escapeHtml\(item\.contentType\)\}"/u);
  assert.match(app, /renderLearningScopeHint\(payload\.scopeCounts, trajectoryCount\);/u);
  // 常驻：不再只在"当前范围空着"时才渲染；每个范围带上来源文件。
  assert.match(app, /本项目各范围的轨迹/u);
  assert.match(app, /learning-scope-files">\$\{item\.files\.length \? `来源：/u);
  assert.match(app, /const sourceFile = String\(item\.sourceFile \|\| item\.assetRefs\?\.sourceFile \|\| ""\);/u);
  assert.match(styles, /\.learning-scope-hint \{/u);
  assert.match(styles, /\.learning-scope-row\.current \{/u);
});

test("当前项目的轨迹算「当前范围」：前端不再只认 default 作用域", () => {
  // 曾经只认 project === "default"，真实项目（如 FF7）的轨迹、技能、生效版本会被整批过滤掉，
  // 学习中心永远显示 0 且"尚无生效版本"。
  assert.match(app, /const activeProject = state\.activeProjectId \|\| "default";/u);
  assert.match(app, /\(!project \|\| project === "default" \|\| project === activeProject\)/u);
});
