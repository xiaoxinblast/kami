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
