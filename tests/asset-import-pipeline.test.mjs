import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("术语导入不再逐条拉整库，改为一次索引 + 分块写入", async () => {
  const server = await read("../server.mjs");
  // 旧实现是每条候选都 getProjectAssets(整库) 判重，5859 条会变成分钟级导入。
  assert.doesNotMatch(server, /\.filter\(\(term\) => term\.source\.toLocaleLowerCase\(\) === source\.toLocaleLowerCase\(\)\)/u);
  assert.match(server, /const loadTermIndex = async \(locale\) =>/u);
  assert.match(server, /saveAssets\(batch\[0\]\.locale/u);
  assert.match(server, /const TERM_WRITE_BATCH_SIZE = 200;/u);
  assert.match(server, /const SKIPPED_DETAIL_LIMIT = 200;/u);
});

test("双语资产导入走后台任务，并支持同行批次续跑", async () => {
  const server = await read("../server.mjs");
  assert.match(server, /url\.pathname === "\/api\/assets-import\/commit"/u);
  assert.match(server, /type: "asset_import"/u);
  assert.match(server, /runAssetImportInBackground\(/u);
  assert.match(server, /url\.pathname === "\/api\/assets-import\/resume"/u);
  // 持久化候选没有 selected 列：续跑必须按"默认全选"还原，否则整批会被判成未选择。
  assert.match(server, /const candidates = preview\.candidates\.map\(\(candidate\) => \(\{ \.\.\.candidate, selected: candidate\.selected !== false \}\)\);/u);
  assert.match(server, /const purpose = body\.purpose === "tm" \? "tm" : "term"/u);
  assert.match(server, /const aiCleaning = purpose === "term" && body\.aiCleaning === true/u);
  // 后台任务执行期间挂住收尾判定，否则导入会被"关页面"规则连带杀掉。
  assert.match(server, /workbenchSessionMonitor\?\.hold\(backgroundTaskHoldId\(task\.id\)\)/u);
  assert.match(server, /BACKGROUND_TASK_TERMINAL_STATUSES/u);
  assert.match(server, /async function recoverInterruptedImportTasks/u);
});

test("确认导入立刻返回任务号，审核队列写入放到后台并带进度", async () => {
  const server = await read("../server.mjs");
  const routeStart = server.indexOf('url.pathname === "/api/assets-import/commit"');
  const route = server.slice(routeStart, server.indexOf('url.pathname === "/api/assets-import/resume"', routeStart));
  // 路由里不能再直接写审核队列：那会让弹窗长时间只有一个灰按钮。
  assert.doesNotMatch(route, /await saveImportPreview\(/u);
  assert.match(route, /const task = await createBackgroundTask\(/u);
  assert.match(route, /persistCandidates: true/u);
  assert.match(server, /persistCandidates: false/u);
  // 后台链路里写队列，并按条数报进度。
  const job = server.slice(server.indexOf("async function runAssetImportInBackground"), server.indexOf("async function previewTermImport"));
  assert.match(job, /正在写入审核队列：0 \/ \$\{working\.length\} 条候选/u);
  assert.match(job, /\{ onProgress: countReport\(1, 8\) \}/u);
  assert.match(job, /payload: \{\s*\n\s*batchId: batch \|\| batchId,/u);
  // 队列写入本身要能报进度：createItemsInChunks -> saveImportPreview -> store 透传回调。
  const directusStore = await read("../src/directus-store.mjs");
  assert.match(directusStore, /async function createItemsInChunks\(path, records, \{ onProgress \} = \{\}\)/u);
  assert.match(directusStore, /onProgress\?\.\(\{ completed: saved\.length, total: records\.length \}\)/u);
  assert.match(directusStore, /export async function saveDirectusImportPreview\(input, \{ onProgress \} = \{\}\)/u);
  const store = await read("../src/store.mjs");
  assert.match(store, /export async function saveImportPreview\(input, options\)/u);
});

test("术语注释取自原表，记账信息移出 note", async () => {
  const server = await read("../server.mjs");
  assert.match(server, /provenance: `table-import:\$\{String\(sourceFile \|\| "unknown"\)\.slice\(0, 120\)\}\$\{sourceRow \? `#\$\{sourceRow\}` : ""\}`/u);
  assert.match(server, /note: String\(candidate\.note \|\| ""\)\.trim\(\)\.slice\(0, 500\)/u);
  assert.doesNotMatch(server, /note: `批次 \$\{body\.batchId\} · 原表第/u);
  const provider = await read("../src/provider.mjs");
  // 注释要参与 AI 清洗判断。
  assert.match(provider, /note: candidate\.note \|\| "",/u);
  assert.match(provider, /把它标为 noteColumn；没有这样的列时 noteColumn 必须为 null/u);
});

test("页面中途关闭不会让长任务抛未捕获异常", async () => {
  const server = await read("../server.mjs");
  assert.match(server, /if \(res\.destroyed \|\| res\.writableEnded\) return;/u);
  assert.match(server, /res\.on\("error", \(\) => \{\}\);/u);
});

test("按原文查重改走哈希，长句不再把查询串撑爆（431）", async () => {
  const directus = await read("../src/directus-store.mjs");
  // 旧写法把整句原文/译文塞进 URL，几百字的句段直接触发 431 并让候选被跳过。
  assert.doesNotMatch(directus, /params\.set\("filter\[source\]\[_eq\]"/u);
  assert.doesNotMatch(directus, /params\.set\("filter\[target\]\[_eq\]"/u);
  assert.match(directus, /pairParams\.set\("filter\[source_hash\]\[_eq\]", memorySourceHash\(attempt\.source\)\)/u);
  assert.match(directus, /params\.set\("filter\[source_hash\]\[_eq\]", memorySourceHash\(source\)\)/u);
  assert.match(directus, /source_hash: memorySourceHash\(source\),/u);
  const memory = await read("../src/translation-memory.mjs");
  assert.match(memory, /export function memorySourceHash\(source = ""\)/u);
  // 报错信息会进任务记录并显示在界面上：必须去掉查询串并截断。
  assert.match(directus, /const plainPath = String\(path\)\.split\("\?"\)\[0\]\.slice\(0, 80\);/u);
  assert.match(directus, /失败（\$\{response\.status\}/u);
});

test("跳过原因与任务文案都做了截断，界面不会被长报错撑爆", async () => {
  const server = await read("../server.mjs");
  assert.match(server, /const reason = String\(entry\?\.reason \|\| "未知原因"\)\.slice\(0, 120\);/u);
  const styles = await read("../public/styles.css");
  assert.match(styles, /\.task-row > \* \{ min-width: 0; \}/u);
  assert.match(styles, /\.task-main small, \.task-qa small, \.task-qa strong \{/u);
  assert.match(styles, /-webkit-line-clamp: 2;/u);
  const app = await read("../public/app.js");
  assert.match(app, /<strong title="\$\{escapeHtml\(payloadText \|\| ""\)\}">/u);
});

test("导入体积规则各入口统一：单文件 20MB、只限文件个数", async () => {
  const app = await read("../public/app.js");
  assert.doesNotMatch(app, /MEMORY_IMPORT_TOTAL_BYTES/u);
  assert.match(app, /const UPLOAD_FILE_BYTES = 20 \* 1024 \* 1024;/u);
  assert.match(app, /const IMPORT_MAX_FILES = 200;/u);
  const server = await read("../server.mjs");
  assert.match(server, /const IMPORT_FILE_BYTES = 20 \* 1024 \* 1024;/u);
  assert.match(server, /const tooLarge = files\.find\(\(file\) => Buffer\.byteLength\(String\(file\.base64 \|\| ""\), "base64"\) > IMPORT_FILE_BYTES\);/u);
  const html = await read("../public/index.html");
  assert.match(html, /单个文件不超过 20MB/u);
  // 文件类请求的 body 额度必须容得下 20MB 文件 base64 后的体积（约 27MB）。
  assert.match(server, /const IMPORT_BODY_BYTES = 48 \* 1024 \* 1024;/u);
  for (const route of ["/api/term-import/preview", "/api/term-import/commit", "/api/batch/prepare"]) {
    const index = server.indexOf(`url.pathname === "${route}"`);
    assert.ok(index > 0, `找不到路由 ${route}`);
    assert.match(server.slice(index, index + 220), /readJsonBody\(req, \{ limitBytes: IMPORT_BODY_BYTES \}\)/u, `${route} 需要放宽请求体额度`);
  }
  // 解析器侧的上限也要跟着改，否则 20MB 文件仍会被拒。
  const extractor = await read("../src/table-term-extractor.mjs");
  assert.match(extractor, /const MAX_FILE_BYTES = 20 \* 1024 \* 1024;/u);
  const batchDocument = await read("../src/batch-document.mjs");
  assert.match(batchDocument, /const MAX_FILE_BYTES = 20 \* 1024 \* 1024;/u);
});
