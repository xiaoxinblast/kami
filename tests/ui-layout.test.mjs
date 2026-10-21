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

test("质量档只在一处可选：只有单句模式显示顶部那一行，取值两边同步", () => {
  // 批次页自己的质量档在「分段与翻译策略」面板里（context-brief 用例依赖它）。
  assert.match(html, /id="batchQualityTier"/u);
  assert.match(html, /<div class="tier-row" id="tierRow">/u);
  // 顶部那一行属于单句输入：文件列表与批次页各有自己的入口，不能同时出现两个开关。
  assert.match(app, /if \(tierRow\) tierRow\.hidden = state\.translationMode !== "single";/u);
  assert.match(app, /function syncQualityTier\(value, source\)/u);
  assert.match(app, /syncQualityTier\(\$\("#batchQualityTier"\)\.value, \$\("#batchQualityTier"\)\);/u);
  assert.match(app, /syncQualityTier\(\$\("#qualityTier"\)\.value, \$\("#qualityTier"\)\);/u);
  // 单句与批次各自读自己版面里的那一个，值是同步过的。
  assert.match(app, /qualityTier: \$\("#qualityTier"\)\.value,/u);
  assert.match(app, /qualityTier: batchQualityTier\(\),/u);
});

test("学习中心是项目级单流水线：没有范围选择器，也没有总览→进入流水线两级", () => {
  assert.doesNotMatch(html, /id="learningOverview"/u);
  assert.doesNotMatch(html, /id="learningContentType"/u);
  assert.doesNotMatch(app, /renderLearningOverview|enterLearningScope/u);
  assert.match(html, /<div class="learning-pipeline" id="learningPipeline">/u);
  assert.match(app, /function learningInPipeline\(\) \{\n\s+return true;/u);
  // 头部的 chips 仍要写清"多少条轨迹、其中多少条人工采纳"。
  assert.match(app, /条轨迹（\$\{proposalCount\} 条人工采纳）/u);
  assert.match(styles, /\.learning-pipeline-chips \{/u);
});

test("当前项目的轨迹算「当前范围」：前端不再只认 default 作用域", () => {
  // 曾经只认 project === "default"，真实项目（如 FF7）的轨迹、技能、生效版本会被整批过滤掉，
  // 学习中心永远显示 0 且"尚无生效版本"。
  assert.match(app, /const activeProject = state\.activeProjectId \|\| "default";/u);
  assert.match(app, /\(!project \|\| project === "default" \|\| project === activeProject\)/u);
});
