import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/**
 * 参考资料上传的两次事故与现在的大文件方案：
 *
 * 1) 上传时页面直接 "Out of Memory" —— 浏览器先把整个文件读成二进制字符串再 btoa，
 *    实测 20MB 的文件就把进程推到 ~280MB（是文件的 11 倍），大文件直接把渲染进程顶死。
 * 2) 就算不崩也会被拒：请求体走 15MB 的默认上限，而 base64 放大 1/3，11MB 以上永远传不上去。
 * 3) 上限太小：几百 MB 的扫描件/画册根本没法传。
 *
 * 现在：单文件 200MB，浏览器把 File 当请求体直传，服务端边收边写盘，内存里不出现整份文件。
 */
test("参考资料走 200MB 流式落盘上传，不再在浏览器里拼 base64", async () => {
  const [script, server, materials, html] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/reference-materials.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8")
  ]);
  // 前端：base64 那条路整体删掉，改成 200MB 守卫 + File 直传。
  assert.doesNotMatch(script, /referenceFileToBase64/u, "不该再有任何把整份文件读进内存的 base64 转换");
  assert.match(script, /const REFERENCE_MAX_FILE_BYTES = 200 \* 1024 \* 1024;/u);
  assert.match(script, /Number\(item\.file\?\.size\) > REFERENCE_MAX_FILE_BYTES/u);
  assert.match(script, /await api\(`\/api\/references\/file\?\$\{query\}`, \{/u);
  assert.match(script, /body: file,/u, "File 直接当请求体，浏览器按块发送");
  assert.match(html, /单文件不超过 200MB/u);
  // 服务端：上限提到 200MB，并且真的边收边写盘（超过就中止 + 删半成品）。
  assert.match(materials, /export const MAX_REFERENCE_FILE_BYTES = 200 \* 1024 \* 1024;/u);
  assert.match(server, /async function writeRequestBodyToFile\(req, \{ path, limitBytes = MAX_REFERENCE_FILE_BYTES \} = \{\}\)/u);
  assert.match(server, /const handle = await open\(path, "w"\);/u);
  assert.match(server, /if \(bytes > limitBytes\) \{/u);
  assert.match(server, /await rm\(path, \{ force: true \}\)\.catch\(\(\) => \{\}\);/u);
  assert.match(server, /error\.statusCode = 413;/u);
  assert.match(server, /const REFERENCE_UPLOAD_DIRECTORY = join\("uploads", "references"\);/u);
  // 两条入口（原始字节 / JSON 脚本）都落到同一份存档，后续解析、重试、删除都只认它。
  assert.match(server, /async function startReferenceUpload\(\{ body, params, req \}\) \{/u);
  assert.match(server, /await writeRequestBodyToFile\(req, \{ path: absolute \}\);/u);
  assert.match(server, /ingestReport: \{ sourcePath: referenceRelativePath\(document\.id, extension\), bytes, stage: "planning" \}/u);
});

test("上传前显式选择识图模式：不再产生等待确认的弹窗与 review 任务", async () => {
  const [server, script, materials] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/reference-materials.mjs", import.meta.url), "utf8")
  ]);
  // 预扫仍用于进度与统计，但不再作为阻塞门禁。
  assert.match(materials, /export async function planReferenceExtraction\(/u);
  assert.match(materials, /plan\.estimatedVisionCalls = plan\.scannedPages \+ plan\.images;/u);
  assert.doesNotMatch(server, /phase: "needs_confirmation"/u, "新的参考资料导入不再停在等待确认");
  assert.match(server, /const visionMode = String\(rawVision\).*"none".*"all"/u);
  assert.match(server, /enqueueReferenceIngest\(\{ taskId: task\.id/u);
  assert.match(server, /async function recoverLegacyReferenceIngestTasks\(\)/u);
  assert.match(server, /await recoverLegacyReferenceIngestTasks\(\)/u);
  assert.match(server, /旧版等待确认已由后续导入完成取代/u);
  assert.match(server, /await startReferenceUpload\(\{ body: null, params: url\.searchParams, req \}\)/u);
  assert.match(server, /url\.pathname\.endsWith\("\/ingest"\)/u);
  assert.match(server, /visionMode: body\.vision === false \? "none" : "all"/u);
  // 前端：上传前用开关决定 all / none，上传后直接轮询后台任务。
  assert.match(script, /data-reference-vision/u);
  assert.match(script, /setReferenceVisionMode/u);
  assert.match(script, /vision: state\.referenceVisionMode/u);
  assert.match(script, /autoScan: state\.referenceAutoScan/u);
  assert.match(script, /data-reference-folder-select/u);
  assert.match(script, /const folderIds = \[\.\.\.state\.referenceSelection\.folders\]/u);
  assert.match(script, /webkitGetAsEntry/u);
  assert.match(script, /createReader\(\)/u);
  assert.match(script, /\/api\/reference-folders\/ensure/u);
  assert.match(server, /url\.pathname === "\/api\/reference-folders\/ensure"/u);
  assert.match(server, /type: "reference_describe"/u);
  assert.match(server, /type: "reference_folder_delete"/u);
  assert.match(server, /const autoScan = !\(rawAutoScan === false/u);
  assert.match(server, /autoScanError/u);
  assert.match(server, /requestedFolderIds/u);
  assert.doesNotMatch(script, /referencePlanDialog/u);
});

test("解析前有内存护栏：zip 解压后超量直接拒绝，不把工作台顶成 OOM", async () => {
  const materials = await readFile(new URL("../src/reference-materials.mjs", import.meta.url), "utf8");
  assert.match(materials, /export const MAX_ZIP_UNCOMPRESSED_BYTES = 800 \* 1024 \* 1024;/u);
  assert.match(materials, /export const MAX_XLSX_XML_BYTES = 80 \* 1024 \* 1024;/u);
  assert.match(materials, /async function assertArchiveFitsMemory\(archive, format\) \{/u);
  assert.match(materials, /请拆分成多个文件再上传/u);
  for (const call of [/await assertArchiveFitsMemory\(archive, "docx"\);/u, /await assertArchiveFitsMemory\(await JSZip\.loadAsync\(buffer\), "xlsx"\);/u, /await assertArchiveFitsMemory\(archive, "pptx"\);/u]) {
    assert.match(materials, call);
  }
});
