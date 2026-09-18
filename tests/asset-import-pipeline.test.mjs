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
