import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

/**
 * 门禁是长任务：跑一轮要几十次模型调用、二十多分钟。它必须像导入任务一样，
 * 1) 能被任务中心的「中断」真正停住；
 * 2) 中途被删记录/被打断时留下一份"结论无效"的记录，而不是伪装成质量判定；
 * 3) 收尾 hold 由执行方自己释放，避免"删任务→hold 放开→页面一关工作台就自己停"。
 */
test("门禁运行注册进本进程运行表，中断在样本边界生效", () => {
  assert.match(server, /const control = beginBackgroundRun\(task\.id\);\n\s*qualityGateInFlight\.add\(String\(skill\.id\)\);/u);
  assert.match(server, /shouldCancel: \(\) => control\.cancelRequested,/u);
  assert.match(server, /if \(shouldCancel\?\.\(\)\) \{ cancelled = "已按用户要求中断本次门禁执行"; break; \}/u);
  assert.match(server, /endBackgroundRun\(task\.id\);\n\s*qualityGateInFlight\.delete\(String\(skill\.id\)\);/u);
});

test("被删记录/被中断时留存「结论无效」的运行记录与已中断任务", () => {
  assert.match(server, /cancelled = "后台任务记录已被删除，本次门禁执行已中止";/u);
  assert.match(server, /gate\.blocking = \[\{ code: "gate_interrupted", message: `\$\{cancelled\}：已执行 \$\{executed\} \/ \$\{queue\.length\} 个样本，结论无效` \}, \.\.\.gate\.blocking\];/u);
  assert.match(server, /if \(result\.cancelled\) \{\n\s*await updateBackgroundTaskProgress\(task\.id, \{\n\s*status: "needs_attention",\n\s*progress: \{ \.\.\.\(task\.progress \|\| \{\}\), phase: "cancelled", message: result\.cancelled/u);
});

test("删除正在跑的任务不放开收尾 hold；重启后残留任务会被标记为已中断", () => {
  assert.match(server, /if \(!runningBackgroundTasks\.has\(id\)\) workbenchSessionMonitor\?\.release\(backgroundTaskHoldId\(id\)\);/u);
  assert.match(server, /sweepStaleBackgroundTasks\(\{ reason: "startup" \}\)/u);
  assert.match(server, /const staleSweepTimer = setInterval\(\(\) => \{\n\s*sweepStaleBackgroundTasks\(\{ reason: "interval" \}\)\.catch\(\(\) => \{\}\);\n\s*\}, BACKGROUND_TASK_STALE_MS\);/u);
  assert.match(server, /workbenchSessionMonitor\?\.release\(backgroundTaskHoldId\(task\.id\)\);$/mu);
});

test("删除运行中的门禁/评测任务时，对话框说明会放弃这次执行", () => {
  assert.match(app, /const abortsOnDelete = \["quality-gate", "skill_evaluation"\]\.includes\(String\(task\?\.taskType \|\| ""\)\);/u);
  assert.match(app, /"先请求中断：在下一个样本前停下，已跑完的样本保留"/u);
  assert.match(app, /"删掉记录＝放弃这次执行：会以「执行已中断」收尾，不会给出有效结论"/u);
});

test("被中断的后台任务在任务中心不再被显示成「已完成」", () => {
  assert.match(server, /\["failed", "needs_attention", "abandoned"\]\.includes\(String\(task\.status\)\)/u);
  assert.match(server, /\? "needs_attention"\n\s*: "completed",/u);
});
