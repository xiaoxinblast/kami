import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("续跑复用上一轮的 AI 清洗结果，只判定没标记过的条目", async () => {
  const server = await read("../server.mjs");
  // 清洗完先写回候选行，再入库：这样即使入库阶段被打断，判定结果也已经存住了。
  const job = server.slice(server.indexOf("async function runAssetImportInBackground"), server.indexOf("async function previewTermImport"));
  assert.match(job, /const persistedCleaning = await persistImportCleaning\(batch, \{ projectId, filename, candidates: routed \}\);/u);
  assert.match(job, /phase: "saving-cleaning"/u);
  // 已经有标记的候选不再送模型，并且不计入"模型没返回"的缺失统计
  assert.match(server, /candidate\.contentTypeSource !== "ai-cleaned"/u);
  assert.match(server, /const cachedCount = candidates\.filter\(\(candidate\) => candidate\.contentTypeSource === "ai-cleaned"\)\.length;/u);
  assert.match(server, /ai\.missing = Math\.max\(0, \(candidates\.length - cachedCount\) - ai\.reviewed\);/u);
  assert.match(server, /复用 \$\{cachedCount\} 条已判定结果/u);

  // 写回实现：老候选按 id 更新，本轮新产生的句内术语作为新行进同一批次，统一打 ai-cleaned 标记
  const directusStore = await read("../src/directus-store.mjs");
  const persist = directusStore.slice(
    directusStore.indexOf("export async function persistDirectusImportCleaning"),
    directusStore.indexOf("export async function getDirectusImportPreview")
  );
  assert.match(persist, /classification_source: "ai-cleaned"/u);
  assert.match(persist, /id: candidate\.candidateId/u);
  assert.match(persist, /\{ \.\.\.candidate, contentTypeSource: "ai-cleaned" \}/u);
  assert.match(persist, /createItemsInChunks\("\/items\/term_candidates"/u);
  // 候选行 → 表字段的映射只有一份（写队列与写回共用）
  assert.match(directusStore, /function importCandidateRecord\(candidate, \{ batchId, projectId = "", filename = "", aiUsed = false \} = \{\}\)/u);
  const store = await read("../src/store.mjs");
  assert.match(store, /export async function persistImportCleaning\(batchId, payload\)/u);
});

test("导入任务在开始就带上批次号，服务重启后「继续导入」才找得到候选", async () => {
  const server = await read("../server.mjs");
  const commitRoute = server.slice(
    server.indexOf('url.pathname === "/api/assets-import/commit"'),
    server.indexOf('url.pathname === "/api/assets-import/resume"')
  );
  // 之前批次号只在成功（或抛错）时才写进任务载荷：进程被杀就没有 batchId，
  // 任务中心虽然给出「继续导入」，点了却提示"没有可续传的批次"。
  assert.match(commitRoute, /payload: \{ batchId: String\(body\.batchId \|\| ""\), filename, purpose, aiCleaning, styleEvidence, termLibraryId, tmLibraryId, resumable: false \}/u);
  const resumeRoute = server.slice(
    server.indexOf('url.pathname === "/api/assets-import/resume"'),
    server.indexOf('url.pathname === "/api/batch/columns"')
  );
  assert.match(resumeRoute, /payload: \{ batchId, filename, purpose, aiCleaning, styleEvidence, termLibraryId, tmLibraryId, resumable: false \}/u);
  // 后台链路写队列拿到批次号后立刻补写，TM 导入同理。
  assert.match(server, /persistedBatchId = persisted\.batchId;/u);
  assert.match(server, /payload: \{ batchId: batch, filename, purpose, aiCleaning, styleEvidence, termLibraryId, tmLibraryId, resumable: false \}/u);
});

test("中断：跑批循环在分块边界停下，任务标成可继续而不是一直进行中", async () => {
  const server = await read("../server.mjs");
  assert.match(server, /const runningBackgroundTasks = new Map\(\);/u);
  assert.match(server, /function cancellationError\(message\)/u);
  // 路由：后台任务中断 + 批次中断
  assert.match(server, /\^\\\/api\\\/background-tasks\\\/\[\^\/\]\+\\\/cancel\$/u);
  assert.match(server, /\^\\\/api\\\/batch\\\/run\\\/\[\^\/\]\+\\\/cancel\$/u);
  // 中断落成 needs_attention + phase=cancelled + resumable，界面才知道可以继续
  assert.match(server, /phase: cancelled \? "cancelled" : "failed"/u);
  assert.match(server, /status: cancelled \? "needs_attention" : "failed"/u);
  assert.match(server, /const cancelled = isCancellation\(error\);/u);
  // 批次：中断用 runnerOptions.cancelled 标记（run_state 只有库里允许的取值）
  const runner = await read("../src/batch-runner.mjs");
  assert.match(runner, /run\.runState = "paused";\s*\n\s*run\.runnerOptions = \{ \.\.\.options, cancelled: true \};/u);
  assert.match(server, /shouldCancel: \(\) => controller\.cancelRequested/u);
  assert.match(server, /worker\.cancelRequested = true;/u);
});

test("服务重启后：批次任务与导入任务都会标成可继续", async () => {
  const server = await read("../server.mjs");
  const recovery = server.slice(
    server.indexOf("async function recoverInterruptedBatchWorkers"),
    server.indexOf("async function shutdownManagedWorkbench")
  );
  // 批次：运行中的批次置 paused，卡在 running 的段落退回 pending
  assert.match(recovery, /runState: "paused"/u);
  assert.match(recovery, /error: "服务重启后等待继续"/u);
  // 对应的后台任务行也要收尾，否则任务中心一直显示"进行中"
  assert.match(recovery, /item\.type === "batch_translation" && item\.status === "in_progress"/u);
  assert.match(recovery, /message: "服务重启导致中断，可在任务中心继续翻译"/u);
  assert.match(recovery, /payload: \{ \.\.\.\(task\.payload \|\| \{\}\), batchId: run\.batchId, filename: run\.filename, resumable: true \}/u);
  // 导入：in_progress 的 term_import / asset_import 标成 needs_attention + resumable
  assert.match(server, /\["term_import", "asset_import"\]\.includes\(task\.type\)/u);
});

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

test("人工 TM 导入支持后台任务：接口立刻返回任务号，页面跟进度", async () => {
  const server = await read("../server.mjs");
  const routeIndex = server.indexOf('url.pathname === "/api/tm-import/commit"');
  assert.ok(routeIndex > 0);
  const route = server.slice(routeIndex, routeIndex + 1400);
  assert.match(route, /if \(body\.background === true\) \{/u);
  assert.match(route, /type: "term_import"/u);
  assert.match(route, /runTmImportInBackground\(/u);
  assert.match(route, /return json\(res, 202, \{ taskId: task\.id/u);
  // 后台执行体自带进度：写审核队列按条数报，入库沿用 commitTermImport 的内部百分比。
  const job = server.slice(server.indexOf("async function runTmImportInBackground"), server.indexOf("async function previewTermImport"));
  assert.match(job, /正在写入审核队列：0 \/ \$\{candidates\.length\}/u);
  assert.match(job, /countProgressReport\(report, 2, 10\)/u);
  assert.match(job, /scaleProgressReport\(report, 10, 92\)/u);
  assert.match(job, /payload: \{\s*\n\s*batchId: persisted\.batchId,/u);
  // 进度辅助函数与资产导入共用一份实现。
  assert.match(server, /function scaleProgressReport\(report, from, to\)/u);
  assert.match(server, /function countProgressReport\(report, from, to\)/u);

  const app = await read("../public/app.js");
  assert.match(app, /styleEvidence: state\.memoryStyleEvidence, tmLibraryId: state\.memoryImportTargetId \|\| "", background: true/u);
  assert.match(app, /#memoryImportProgressText/u);
  // 复核确认那条路径也跟同一批次的进度，不再只有按钮文字。
  assert.match(app, /const backgroundTaskId = state\.importPreview\.backgroundTaskId \|\| "";/u);
  const html = await read("../public/index.html");
  assert.match(html, /id="memoryImportProgress"/u);
  const wizard = await read("../public/project-wizard.js");
  assert.match(wizard, /已提交后台写入：\$\{tmResult\.accepted/u);
});

test("待译原文件上传：列映射弹窗 + 映射随解析请求下发", async () => {
  const server = await read("../server.mjs");
  assert.match(server, /url.pathname === "\/api\/batch\/columns"/u);
  assert.match(server, /describeBatchColumns/u);
  // 解析时把人工映射带进去
  assert.match(server, /prepareBatchDocument\(body, \{ analyzeSpreadsheet, batch: project\?\.settings\?\.batch \|\| \{\}, columnMapping: body\.columnMapping \|\| null \}\)/u);
  const document = await read("../src/batch-document.mjs");
  assert.match(document, /analysis = applyColumnMapping\(analysis, columnMapping\);/u);
  assert.match(document, /export async function describeBatchColumns/u);
  const app = await read("../public/app.js");
  assert.match(app, /if \(\/\\\.\(xlsx\|csv\)\$\/iu\.test\(file\.name\)\) \{/u);
  assert.match(app, /const confirmed = await confirmBatchColumns\(file\);/u);
  assert.match(app, /columnMapping: state\.batchColumnMapping \|\| undefined/u);
  assert.match(app, /const accepted = await setBatchFile\(file\);/u);
  const html = await read("../public/index.html");
  assert.match(html, /id="batchColumnDialog"/u);
  assert.match(html, /id="batchColumnConfirm"/u);
});

test("条目 ID 从待译段落一路带到提示词与译文记忆库", async () => {
  const runner = await read("../src/batch-runner.mjs");
  assert.match(runner, /entryKey: segment\.entryKey \|\| segment\.locator\?\.entryKey \|\| "",/u);
  assert.match(runner, /entryKey: segment\.entryKey \|\| segment\.locator\?\.entryKey \|\| ""\s*\n\s*\};/u);
  const server = await read("../server.mjs");
  // 工作 TM / 人工采纳两条写库路径都带上条目身份
  assert.match(server, /entryId: body\.entryId \|\| "", entryKey: body\.entryKey \|\| ""/u);
  assert.match(server, /provenance: "batch-working-tm",[\s\S]{0,240}entryKey: body\.entryKey \|\| ""/u);
  // 提示词里单独一行标注条目 ID
  const provider = await read("../src/provider.mjs");
  assert.match(provider, /if \(context\.entryKey\) lines\.push\(`条目：\$\{context\.entryKey\}（仅用于理解/u);
  // CAT 匹配优先按条目 ID
  const memory = await read("../src/translation-memory.mjs");
  assert.match(memory, /entryKey && memory\?\.entryKey && String\(entryKey\) === String\(memory\.entryKey\)/u);
  const app = await read("../public/app.js");
  assert.match(app, /entryKey: segment\.entryKey \|\| segment\.locator\?\.entryKey \|\| "",/u);
});
