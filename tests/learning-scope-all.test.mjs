import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (name) => readFile(new URL(`../public/${name}`, import.meta.url), "utf8");

const app = await read("app.js");
const html = await read("index.html");
const styles = await read("styles.css");
const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");

test("学习中心两个下拉都有「全部」，默认仍是待分类文本 × 通用", () => {
  assert.match(html, /<option value="all">全部领域<\/option>/u);
  assert.match(app, /<option value="all">全部语体<\/option>/u);
  assert.match(app, /\[\.\.\.\$\("#learningContentType"\)\.options\]\.some\(\(option\) => option\.value === "general"\)\) \$\("#learningContentType"\)\.value = "general";/u);
});

test("选「全部」时整维度放开：服务端把 all 换成空串，界面按跨范围处理", () => {
  // 服务端：all → ""（存储层空串=不过滤），并且不再为全部视图创建默认生效版本。
  assert.match(server, /function learningScopeQuery\(scope\)/u);
  assert.match(server, /contentType: learningScopeAll\(scope\.contentType\) \? "" : scope\.contentType,/u);
  assert.match(server, /domain: learningScopeAll\(scope\.domain\) \? "" : scope\.domain/u);
  assert.match(server, /if \(queriedScope\.contentType && queriedScope\.domain\) await ensureChampionTranslationSkill\(requestedScope\);/u);
  assert.match(server, /champions,\n\s+skills,/u, "响应要把范围内的生效版本都带上");
  // 界面：全部 = 通配过滤 + 逐条标范围 + 不显示"其它范围"提示 + 不能生成候选。
  assert.match(app, /function learningAllScopes\(\)/u);
  assert.match(app, /learningScopeSelected\("contentType"\) === "all" \|\| contentType === \$\("#learningContentType"\)\.value/u);
  assert.match(app, /function learningScopeTag\(item = \{\}\)/u);
  // 范围分布面板常驻：不再只在"当前范围空着"时才提示。
  assert.match(app, /function renderLearningScopeHint\(scopeCounts, trajectoryCount\)/u);
  assert.match(app, /本项目各范围的轨迹/u);
  assert.match(app, /当前选择（\$\{escapeHtml\(contentTypeLabel\(currentContentType\)\)\} × \$\{escapeHtml\(learningDomainLabel\(currentDomain\)\)\}）还没有轨迹/u);
  // 全部视图下主操作不再禁用，而是先让用户挑一个有轨迹的范围。
  assert.match(app, /if \(learningAllScopes\(\) && !\(await resolveLearningScopeForGeneration\(\)\)\) return;/u);
  assert.match(app, /async function resolveLearningScopeForGeneration\(\)/u);
  assert.match(app, /先选一个有轨迹的范围，再生成该范围的候选技能/u);
  assert.match(app, /function renderLearningScopeBoundNotice\(\)/u);
  assert.match(styles, /\.learning-scope-tag \{/u);
});

test("全部视图下候选基线取它自己范围的生效版本", () => {
  assert.match(app, /function learningChampionFor\(skill, champions = \[\]\)/u);
  assert.match(app, /const champion = learningChampionFor\(skill, champions\);/u);
  assert.match(app, /renderLearningEvaluation\(selected, selected \? learningEvaluationFor\(selected, evaluations\) : null, learningChampionFor\(selected, champions\)\);/u);
});

test("全部视图默认只摆有轨迹的范围，其余收进折叠", () => {
  // 每个用过的范围都有一份默认生效版本：16 份里大部分是 0 条轨迹的空壳，
  // 默认只列真有轨迹的，其余折在"其它 N 个范围还没有轨迹"下面。
  assert.match(app, /function renderLearningChampion\(champions, scopeCounts\)/u);
  assert.match(app, /const withTrajectories = new Set\(learningArray\(scopeCounts\)\.map\(scopeKeyOf\)\);/u);
  assert.match(app, /const idle = list\.filter\(\(champion\) => !withTrajectories\.has\(scopeKeyOf\(champion\)\)\);/u);
  assert.match(app, /\$\{active\.length\} 个范围有轨迹 · 共 \$\{list\.length\} 个/u);
  assert.match(app, /其它 \$\{idle\.length\} 个范围还没有轨迹（默认折叠）/u);
  assert.match(app, /renderLearningChampion\(champions, payload\.scopeCounts\);/u);
  assert.match(styles, /\.learning-champion-rest > summary \{/u);
});

test("界面文案把 champion 叫成「生效版本」，不再用冠军", () => {
  assert.doesNotMatch(app, /冠军/u);
  assert.doesNotMatch(html, /冠军/u);
  assert.doesNotMatch(styles, /冠军/u);
  assert.match(html, /只有生效版本会影响生产翻译/u);
  assert.match(app, /return \["生效中", "active"\];/u);
  assert.match(app, /尚无生效版本/u);
  assert.match(app, /已完成生效版本 \/ 候选版本对比/u);
});

test("全部视图下范围强绑定的动作按钮置灰并说明原因", () => {
  // 这些接口在服务端按作用域校验，传 all 会直接 500「不允许使用通配值」：
  // 按钮必须在点之前就置灰，而不是等用户点了看报错。
  assert.match(app, /const LEARNING_SCOPE_BOUND_BUTTONS = \["learningGateRun", "learningGoldSeed", "learningRegressionBuild", "learningExportAudit", "learningExportSft", "learningExportDpo", "trainingCreate", "learningConflictScan"\];/u);
  assert.match(app, /function syncLearningScopeBoundActions\(\)/u);
  assert.match(app, /button\.disabled = allScopes;/u);
  assert.match(app, /button\.title = "先选具体「语体 × 领域」：这些操作按单个范围结算，不能跨范围执行";/u);
  assert.match(app, /syncLearningScopeBoundActions\(\);\n  bindLearningCardEvents\(\);/u);
});
