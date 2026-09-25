import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");

/**
 * 删不掉的产物会一直堆在界面里（实测：候选被拒绝后仍留在列表，"拒绝"看起来像没生效）。
 * 三个页面都要能删：学习中心的候选版本、风格指导里的风格版本/人工指南、以及单条规则。
 */
test("候选技能、风格版本与人工指南都能删除，生效版本拦在前面", () => {
  // 客户端：候选卡片与风格卡片上的删除入口。
  assert.match(app, /data-learning-action="delete" data-skill-id="\$\{escapeHtml\(id\)\}"/u);
  assert.match(app, /async function deleteLearningSkill\(skillId\)/u);
  assert.match(app, /api\(`\/api\/learning\/skills\/\$\{encodeURIComponent\(skillId\)\}`, \{ method: "DELETE" \}\)/u);
  assert.match(app, /data-action="delete-profile"/u);
  assert.match(app, /data-action="delete-guide"/u);
  assert.match(app, /data-action="delete-rule" data-rule="\$\{escapeHtml\(rule\)\}"/u);
  // 规则行要留出第三列放删除按钮，否则它会被挤到下一行。
  assert.match(styles, /\.style-rule-row \{ display: grid; grid-template-columns: 25px minmax\(0, 1fr\) auto;/u);

  // 服务端：三条删除路由 + 生效版本保护。
  assert.match(server, /req\.method === "DELETE" && url\.pathname\.startsWith\("\/api\/learning\/skills\/"\)/u);
  assert.match(server, /当前生效版本不能删除：先启用新版本或回滚，再删掉它/u);
  assert.match(server, /req\.method === "DELETE" && url\.pathname\.startsWith\("\/api\/style-profiles\/"\) && url\.pathname\.endsWith\("\/rules"\)/u);
  assert.match(server, /req\.method === "DELETE" && url\.pathname\.startsWith\("\/api\/style-profiles\/"\)/u);
  assert.match(server, /当前生效版本不能删除：先「停用」，再删除/u);
  assert.match(server, /人工风格指南是一整篇文档，不能按条删规则/u);
  // 删规则要同时重建 instruction：提示词读的是它，不是 rules 数组。
  assert.match(server, /function stripStyleRuleLine\(instruction, text\)/u);
  assert.match(server, /renderInstruction\(nextRules, ""\)/u);
});
