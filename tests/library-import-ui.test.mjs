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
  const [html, script, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8")
  ]);
  assert.match(html, /name="importPurpose" value="term"/u);
  assert.match(html, /name="importPurpose" value="tm"/u);
  assert.match(html, /id="importAiCleaning"/u);
  assert.match(html, /id="importStyleEvidence"/u);
  // 去向用分段开关、勾选用自绘方框：原生控件在窄列里会被挤成竖排单字/超大复选框。
  assert.match(html, /class="import-purpose-switch"/u);
  assert.match(html, /class="import-purpose-option"/u);
  assert.match(html, /class="import-toggle"/u);
  assert.match(html, /class="import-toggle-box"/u);
  assert.match(styles, /\.import-purpose-switch \{ display: flex;/u);
  assert.match(styles, /\.import-toggle-box \{ grid-column: 1;/u);
  assert.match(styles, /\.import-toggle > input \{ position: absolute; width: 1px;/u);
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
  // 逐文件预检：进度按文件推进，单个文件坏了不影响其余文件。
  assert.match(script, /for \(const \[index, file\] of files\.entries\(\)\)/u);
  assert.match(script, /本地预检识别 \$\{preview\.candidates\.length\} 条双语 TM（来自 \$\{files\.length - failures\.length\} \/ \$\{files\.length\} 个文件/u);
  assert.match(script, /candidates, styleEvidence: state\.memoryStyleEvidence \}\)/u);
});

test("术语库列表显示原表注释", async () => {
  const [script, styles] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8")
  ]);
  assert.match(script, /class="asset-note" title="\$\{escapeHtml\(term\.note\)\}"/u);
  assert.match(styles, /\.asset-note \{ grid-column: 1\/-1;/u);
});

test("双语资产导入在前端按后台任务展示进度，并可续跑", async () => {
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(script, /asset_import: "双语资产导入"/u);
  assert.match(script, /async function watchAssetImportTask/u);
  assert.match(script, /async function continueImportTask/u);
  assert.match(script, /api\("\/api\/assets-import\/resume"/u);
  assert.match(script, /data-action="continue-import"/u);
});

test("预检逐个文件进行，并在界面上显示清单、进度与失败原因", async () => {
  const [html, script, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8")
  ]);
  assert.match(html, /id="importFileList"/u);
  assert.match(script, /function renderImportFileList\(container, files, states\)/u);
  assert.match(script, /for \(const \[index, file\] of selected\.entries\(\)\)/u);
  assert.match(script, /progress\(`正在预检 \$\{index \+ 1\} \/ \$\{selected\.length\}：\$\{file\.name\}`, Math\.round\(\(index \/ selected\.length\) \* 100\)\)/u);
  assert.match(script, /progress\(`预检完成：\$\{selected\.length - failures\.length\} \/ \$\{selected\.length\} 个文件，共 \$\{merged\.statistics\.entries\} 条双语条目`, 100\)/u);
  assert.match(styles, /\.import-file-list, \.memory-import-files \{/u);
  assert.match(styles, /\.import-file-list li\.running em/u);
  // 请求根本没到服务端时，不能只把浏览器的 Failed to fetch 丢给用户。
  assert.match(script, /throw new Error\(generic\s*\n\s*\? "连不上工作台：可能正在重启或已停止，请刷新页面后重试"/u);
  // 导入类请求的额度单独放宽，超限也要给出可读提示而不是掐断连接。
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /const IMPORT_BODY_BYTES = 48 \* 1024 \* 1024;/u);
  assert.match(server, /async function readJsonBody\(req, \{ limitBytes = MAX_BODY_BYTES \} = \{\}\)/u);
  assert.match(server, /请求内容超过 \$\{megabytes\}MB 限制，请减少文件数量或改用更小的文件/u);
});
