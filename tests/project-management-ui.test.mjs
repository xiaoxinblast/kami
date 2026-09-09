import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("项目管理提供删除入口、确认对话框和稳定的表单重置", async () => {
  const [html, script, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8")
  ]);
  assert.match(html, /id="deleteProject"/u);
  assert.match(html, /id="deleteProjectDialog"/u);
  assert.match(html, /id="deleteProjectForm"/u);
  assert.match(html, /id="deleteProjectName"/u);
  assert.match(html, /id="deleteProjectData"/u);
  assert.match(html, /同时删除后台数据/u);
  assert.match(html, /class="project-form-note"/u);
  assert.match(script, /const formElement = event\.currentTarget;/u);
  assert.match(script, /formElement\.reset\(\)/u);
  assert.doesNotMatch(script, /event\.currentTarget\.reset\(\)/u);
  assert.match(script, /api\(`\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}\$\{purge \? "\?purge=1" : ""\}`, \{ method: "DELETE" \}\)/u);
  assert.match(script, /确认永久删除/u);
  assert.match(styles, /\.project-chip\.danger/u);
  assert.match(styles, /\.project-delete-summary/u);
  assert.match(styles, /\.project-delete-choice/u);
});
