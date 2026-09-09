import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("项目管理提供新建向导、删除入口和稳定的表单重置", async () => {
  const [html, script, styles, wizard, wizardStyles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../public/project-wizard.js", import.meta.url), "utf8"),
    readFile(new URL("../public/project-wizard.css", import.meta.url), "utf8")
  ]);
  assert.match(html, /id="projectDialog" class="project-wizard"/u);
  assert.match(html, /project-wizard\.css/u);
  assert.match(script, /createProjectWizard/u);
  assert.match(script, /getProjectWizard\(\)\.open\(\)/u);
  assert.match(script, /onCreateProject: createProjectFromWizard/u);
  assert.match(script, /onImportSource: importWizardSource/u);
  assert.match(script, /onPreviewTm: previewWizardTm/u);
  assert.match(script, /onOpenQaSettings/u);
  assert.match(wizard, /待译原文件/u);
  assert.match(wizard, /术语库/u);
  assert.match(wizard, /翻译记忆/u);
  assert.match(wizard, /风格指南/u);
  assert.match(wizard, /QA 设置/u);
  assert.match(wizard, /data-skip/u);
  assert.match(wizard, /data-next/u);
  assert.match(wizard, /data-open-qa/u);
  assert.match(wizardStyles, /\.pw-steps/u);
  assert.match(wizardStyles, /\.pw-file/u);
  assert.match(wizardStyles, /\.pw-primary/u);
  assert.match(html, /id="deleteProject"/u);
  assert.match(html, /id="deleteProjectDialog"/u);
  assert.match(html, /id="deleteProjectForm"/u);
  assert.match(html, /id="deleteProjectName"/u);
  assert.match(html, /id="deleteProjectData"/u);
  assert.match(html, /同时删除后台数据/u);
  assert.match(script, /const formElement = event\.currentTarget;/u);
  assert.match(script, /formElement\.reset\(\)/u);
  assert.doesNotMatch(script, /event\.currentTarget\.reset\(\)/u);
  assert.match(script, /api\(`\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}\$\{purge \? "\?purge=1" : ""\}`, \{ method: "DELETE" \}\)/u);
  assert.match(script, /确认永久删除/u);
  assert.match(styles, /\.project-chip\.danger/u);
  assert.match(styles, /\.project-delete-summary/u);
  assert.match(styles, /\.project-delete-choice/u);
});
