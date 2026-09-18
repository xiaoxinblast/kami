import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("术语库和风格指导页面提供各自的上传入口", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8")
  ]);
  assert.match(html, /id="termLibraryFile"[^>]+accept="\.xlsx,\.csv"/u);
  assert.match(html, /id="styleGuideFile"[^>]+accept="\.txt,\.md,\.docx"/u);
  assert.match(html, /id="styleGuideImportButton"/u);
  assert.match(script, /setImportFiles\(files, \{ intent: "terms", returnView: "assets" \}\)/u);
  assert.match(script, /api\("\/api\/style-guides\/import"/u);
  assert.doesNotMatch(html, /name="enforcement"/u);
});

test("双语资产导入在上传前就能选术语/TM，并可选 AI 清洗与风格证据", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8")
  ]);
  assert.match(html, /name="importPurpose" value="term"/u);
  assert.match(html, /name="importPurpose" value="tm"/u);
  assert.match(html, /id="importAiCleaning"/u);
  assert.match(html, /id="importStyleEvidence"/u);
  // 预检弹窗里保留最终确认用的开关与只读去向说明。
  assert.match(html, /id="assetPreflightAiCleaning"/u);
  assert.match(html, /id="assetPreflightStyleEvidence"/u);
  assert.match(html, /id="assetImportProgress"/u);
  assert.match(html, /id="assetPreflightClose"/u);
  assert.doesNotMatch(html, /data-asset-purpose/u);
  assert.match(script, /purpose,\s*\n\s*aiCleaning,\s*\n\s*styleEvidence/u);
  assert.match(script, /const aiCleaning = purpose === "term" && Boolean\(\$\("#assetPreflightAiCleaning"\)\?\.checked\)/u);
});

test("记忆库支持批量选择文件导入，并可选择是否写入风格证据", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8")
  ]);
  assert.match(html, /id="memoryFile"[^>]+accept="\.xliff,\.mqxliff,\.xlsx,\.csv" multiple/u);
  assert.match(html, /id="memoryStyleEvidence" checked/u);
  assert.match(script, /state\.memoryImportFiles = \[\.\.\.event\.target\.files\]/u);
  assert.match(script, /files: await Promise\.all\(files\.map\(async \(file\) => \(\{ filename: file\.name, base64: await fileToBase64\(file\) \}\)\)\)/u);
  assert.match(script, /candidates, styleEvidence: state\.memoryStyleEvidence \}\)/u);
});

test("双语资产导入在前端按后台任务展示进度，并可续跑", async () => {
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(script, /asset_import: "双语资产导入"/u);
  assert.match(script, /async function watchAssetImportTask/u);
  assert.match(script, /async function continueImportTask/u);
  assert.match(script, /api\("\/api\/assets-import\/resume"/u);
  assert.match(script, /data-action="continue-import"/u);
});
