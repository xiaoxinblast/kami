import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (name) => readFile(new URL(`../public/${name}`, import.meta.url), "utf8");

const app = await read("app.js");
const html = await read("index.html");
const styles = await read("styles.css");
const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");

/**
 * 学习中心是项目级的一条流水线：语体与领域由系统自动判定、只作参考，
 * 界面上不再有任何范围选择器，也没有"总览 → 进入流水线"两级。
 */
test("学习中心不再有任何语体/领域选择器", () => {
  assert.doesNotMatch(html, /id="learningContentType"/u, "学习中心不再选语体");
  assert.doesNotMatch(html, /id="learningDomain"/u, "学习中心不再选领域");
  assert.doesNotMatch(html, /id="learningScopeExit"/u, "不再需要返回总览");
  assert.doesNotMatch(html, /id="learningOverview"/u, "总览已被项目级流水线取代");
  assert.doesNotMatch(app, /enterLearningScope|exitLearningScope|renderLearningOverview/u);
  assert.match(html, /<div class="learning-pipeline" id="learningPipeline">/u, "进页面直接是流水线");
  assert.match(app, /function learningInPipeline\(\) \{\n\s+return true;/u);
  assert.match(app, /function learningActionBody\(\) \{\n\s+\/\/ 语体\/领域由服务端自动判定并只作参考：前端不再传这两个维度。\n\s+return \{ locale: state\.learningLocale, project: state\.activeProjectId \|\| "default" \};/u);
});

test("项目级总览：服务端按语言 × 项目返回单条", () => {
  assert.match(server, /url\.pathname === "\/api\/learning\/overview"/u);
  assert.match(server, /const \[scopeCounts, skills, goldRecords, suiteRecords, runs\] = await Promise\.all/u);
  assert.match(server, /const trajectoryCount = scopeCounts\.reduce/u);
  assert.match(server, /scope: \{ contentType: "general", domain: "general", locale, project \}/u);
  assert.doesNotMatch(server, /const scopeKeyOfRow = /u, "总览不再按语体×领域分组");
});

test("流水线是五步：生效版本 → 候选 → 评测 → 门禁 → 启用", () => {
  for (const id of ["champion", "candidates", "evaluation", "gate", "activate"]) {
    assert.match(html, new RegExp(`id="learningStep${id.charAt(0).toUpperCase()}${id.slice(1)}"`, "u"));
  }
  assert.match(html, /<ol class="learning-steps" id="learningSteps"><\/ol>/u);
  assert.match(app, /function renderLearningSteps\(steps\)/u);
  assert.match(app, /function setLearningStep\(stepId, \{ silent = false \} = \{\}\)/u);
  assert.match(app, /const current = state\.learningStep \|\| steps\.find\(\(step\) => step\.status !== "done" && step\.status !== "waiting"\)\?\.id \|\| "activate";/u);
  assert.match(styles, /\.learning-steps \{ display: grid; grid-template-columns: repeat\(5,minmax\(0,1fr\)\)/u);
  assert.match(styles, /\.learning-step\.current > button \{/u);
  // 门禁状态与资产覆盖都要写在步骤条上，而不是只在第 4 步里。
  assert.match(app, /LEARNING_GATE_STATUS_LABELS/u);
  assert.match(app, /gateCoverage\?\.valid/u);
});

test("非晋升必经的两块收进折叠区，规则冲突移到风格页", () => {
  assert.match(html, /<details class="learning-fold" id="learningFoldTraining">/u);
  assert.match(html, /训练与导出（非晋升必经）/u);
  assert.match(html, /<details class="learning-fold" id="learningFoldEvidence">/u);
  assert.doesNotMatch(html, /id="learningConflictList"/u, "冲突面板不能留在学习中心");
  assert.match(html, /id="styleConflictList"/u);
  assert.match(html, /id="styleConflictScan"/u);
  assert.match(app, /function renderStyleConflicts\(report\)/u);
  assert.match(app, /async function loadStyleConflictReport\(\)/u);
  assert.match(app, /await loadStyleConflictReport\(\);/u, "风格页加载时要顺带取冲突报告");
  assert.match(styles, /\.learning-fold\[open\] > summary \{/u);
});

test("来源证据改服务端筛选与分页，并折进技能卡片", () => {
  assert.match(html, /id="learningEvidenceKind"/u);
  assert.match(html, /id="learningEvidenceFile"/u);
  assert.match(html, /id="learningEvidenceMore"/u);
  assert.match(server, /url\.pathname === "\/api\/learning\/evidence"/u);
  assert.match(server, /hasMore: offset \+ page\.length < total,/u);
  assert.match(app, /const LEARNING_EVIDENCE_PAGE_SIZE = 20;/u);
  assert.match(app, /已显示 \$\{items\.length\} \/ 共 \$\{state\.learningEvidence\.total\} 条/u);
  assert.match(app, /data-skill-evidence="\$\{escapeHtml\(id\)\}"/u);
  assert.match(app, /async function loadSkillEvidencePreview\(details\)/u);
  // 证据明细不能再自己 slice 出一个"前 30 条当成全部"。
  assert.doesNotMatch(app, /allRows\.slice\(0, 30\)/u);
});

test("微调任务列表带总数，可以加载更多", () => {
  assert.match(server, /url\.pathname === "\/api\/training\/runs"/u);
  assert.match(server, /hasMore: offset \+ limit < all\.length,/u);
  assert.match(app, /id="learningTrainingMore"/u.test(html) ? /learningTrainingMore/u : /$^/u);
  assert.match(app, /已显示 \$\{runs\.length\} \/ 共 \$\{total\} 个任务/u);
});
