import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 日志模块：等级过滤、搜索、落盘、清空、console 接管、密钥打码。
 * 目录用环境变量指到临时目录，避免把测试日志写进仓库 data/。
 */
const directory = await mkdtemp(join(tmpdir(), "kami-log-"));
process.env.KAMI_LOG_DIRECTORY = directory;

const {
  LOG_FILE, clearLogs, getLogSettings, installConsoleCapture, listLogs, loadPreviousRunLogs,
  logDebug, logError, logInfo, logWarn, readLogFile, setLogLevel, writeLog
} = await import("../src/logger.mjs");

test("默认等级 info：debug 不记录，info/warn/error 记录", async () => {
  setLogLevel("info");
  clearLogs();
  logDebug("调试细节");
  logInfo("开始翻译", { segment: 1 });
  logWarn("模型返回不完整");
  logError("翻译失败：连不上模型服务");
  const entries = listLogs({ limit: 50 });
  assert.deepEqual(entries.map((entry) => entry.level), ["error", "warn", "info"], "最新在前，且不包含 debug");
  assert.equal(entries[2].message, "开始翻译");
  assert.equal(entries[2].detail, JSON.stringify({ segment: 1 }));
});

test("等级筛选、关键词搜索与时间过滤", async () => {
  clearLogs();
  logInfo("导入术语表 terms.xlsx");
  logWarn("跳过 2 条：库内已有译法");
  logError("Directus 写入失败 431");
  assert.deepEqual(listLogs({ level: "warn" }).map((entry) => entry.level), ["error", "warn"]);
  assert.deepEqual(listLogs({ level: "error" }).map((entry) => entry.level), ["error"]);
  assert.equal(listLogs({ search: "directus" }).length, 1, "搜索不区分大小写");
  assert.equal(listLogs({ search: "库内已有" }).length, 1, "搜索要能命中中文");
  const newest = listLogs({ limit: 1 });
  assert.equal(listLogs({ since: newest[0].ts }).length, 0, "since 之后没有更新的日志");
  assert.equal(listLogs({ limit: 1 }).length, 1);
});

test("日志落盘为 JSONL，重启后能读回上一次运行的尾部", async () => {
  clearLogs();
  logInfo("第一行");
  logError("第二行：报错");
  const text = readFileSync(LOG_FILE, "utf8");
  const lines = text.split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).message, "第二行：报错");

  clearLogs();
  assert.deepEqual(listLogs({}), [], "清空后内存里没有日志");
  await rm(LOG_FILE, { force: true });
  writeFileSync(LOG_FILE, `${JSON.stringify({ ts: "2026-09-18T10:00:00.000Z", level: "error", message: "上一次运行的报错" })}\n`, "utf8");
  loadPreviousRunLogs();
  const restored = listLogs({});
  assert.equal(restored.length, 1);
  assert.equal(restored[0].message, "上一次运行的报错");
  assert.equal(restored[0].previous, true, "历史日志要标记出来，界面区分「上次运行」");
});

test("切到 debug 等级后调试日志才会记录，设置里能看出来", async () => {
  clearLogs();
  const settings = setLogLevel("debug");
  assert.equal(settings.level, "debug");
  writeLog("debug", "细粒度调试信息");
  assert.equal(listLogs({ level: "debug" }).some((entry) => entry.message === "细粒度调试信息"), true);
  assert.equal(getLogSettings().file, LOG_FILE);
  assert.ok(getLogSettings().fileBytes > 0, "写日志后文件应该有内容");
  assert.deepEqual(getLogSettings().levels, ["debug", "info", "warn", "error"]);
  setLogLevel("info");
});

test("清空会同时删掉内存与磁盘上的日志", async () => {
  setLogLevel("info");
  logError("待清空的报错");
  assert.ok(getLogSettings().fileBytes > 0);
  clearLogs();
  assert.deepEqual(listLogs({}), []);
  assert.equal(readLogFile(), "");
  assert.equal(getLogSettings().fileBytes, 0);
});

test("接管 console：既有 console.error 也会进日志，且不吞掉原输出", async () => {
  clearLogs();
  installConsoleCapture();
  const seen = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { seen.push(String(chunk)); return original(chunk, ...rest); };
  try {
    console.error("[Kami] 测试报错");
  } finally {
    process.stderr.write = original;
  }
  assert.ok(seen.join("").includes("测试报错"), "原来的控制台输出要保留");
  const entries = listLogs({ level: "error" });
  assert.equal(entries.length, 1);
  assert.match(entries[0].message, /测试报错/u);
});

test("日志里的密钥会打码，超长内容被截断", async () => {
  clearLogs();
  logError("请求失败", "authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz");
  logInfo("x".repeat(4_000));
  const entries = listLogs({ limit: 10 });
  const keyed = entries.find((entry) => entry.level === "error");
  const big = entries.find((entry) => entry.message.startsWith("x"));
  assert.ok(keyed && big, "两条日志都应该被记录");
  assert.equal(keyed.detail.includes("sk-abcdefghijklmnopqrstuvwxyz"), false, "Bearer token 不能落进日志");
  assert.match(keyed.detail, /Bearer \*\*\*/u);
  assert.equal(big.message.length, 2_000, "超长消息截断到 2000 字");
});
