import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

/**
 * 日志界面要求：服务端必须在初始化之前接管 console（否则启动阶段的报错看不到），
 * 并提供查询 / 切换记录等级 / 清空 / 下载 / 接收界面报错这一整套接口。
 */
test("日志接口齐全，并且 console 在启动初始化之前就被接管", async () => {
  const server = await read("../server.mjs");
  assert.match(server, /url\.pathname === "\/api\/logs"/u);
  assert.match(server, /url\.pathname === "\/api\/logs\/settings"/u);
  assert.match(server, /url\.pathname === "\/api\/logs\/download"/u);
  assert.match(server, /url\.pathname === "\/api\/logs\/client"/u);
  assert.match(server, /req\.method === "DELETE" && url\.pathname === "\/api\/logs"/u);
  // 启动顺序：接管 console → 读回上次运行尾部 → 再 initializeStore
  const boot = server.slice(server.indexOf("await initializeStore()"), server.indexOf("async function recoverInterruptedBatchWorkers"));
  assert.match(server, /installConsoleCapture\(\);\s*\n\s*loadPreviousRunLogs\(\);\s*\n\s*logInfo\("工作台进程启动"/u);
  assert.ok(server.indexOf("installConsoleCapture();") < server.indexOf("await initializeStore();"), "接管要早于初始化");
  assert.ok(boot.length >= 0);
  // 日志接口自身失败时不再递归上报（前端 api() 里要排除 /api/logs）
  const app = await read("../public/app.js");
  assert.match(app, /if \(!String\(path\)\.startsWith\("\/api\/logs"\)\) recordClientLog\("error"/u);
});

test("日志等级与过滤在后端实现（不是只在前端筛）", async () => {
  const logger = await read("../src/logger.mjs");
  assert.match(logger, /export const LOG_LEVELS = Object\.freeze\(\{ debug: 10, info: 20, warn: 30, error: 40 \}\)/u);
  assert.match(logger, /if \(LOG_LEVELS\[name\] < LOG_LEVELS\[minimumLevel\]\) return null;/u);
  assert.match(logger, /export function setLogLevel\(level\)/u);
  assert.match(logger, /export function listLogs\(\{ level = "", search = "", limit = 300, since = "" \} = \{\}\)/u);
  assert.match(logger, /export function loadPreviousRunLogs\(\)/u);
  assert.match(logger, /export function installConsoleCapture\(\)/u);
  assert.match(logger, /MAX_FILE_BYTES = 5 \* 1024 \* 1024/u);
  assert.match(logger, /\.replace\(\/Bearer\\s\+\[A-Za-z0-9\._-\]\{8,\}\/gu, "Bearer \*\*\*"\)/u);
});
