import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/**
 * 重启脚本的进程匹配必须收紧。
 *
 * 实测：重启 Kami 时脚本按 `CommandLine -match 'server\.mjs'` 找进程，
 * 结果把 Codex 自带的 `./server.mjs` 工具进程也一起杀了（它的命令行同样匹配）。
 * Kami 的工作台是 `node --use-system-ca --env-file=directus/.env server.mjs`，
 * 所以必须带上 --env-file 这个特征；另外把"当前占用端口的进程"作为兜底。
 */
test("重启脚本只结束 Kami 自己的工作台进程", async () => {
  const script = await readFile(new URL("../scripts/stop-kami-server.ps1", import.meta.url), "utf8");
  assert.match(script, /Name='node\.exe'/u);
  assert.match(script, /\$_\.CommandLine -match '--env-file'/u);
  assert.match(script, /\$portOwners = @\(Get-NetTCPConnection -LocalPort \$Port -State Listen/u);
  assert.match(script, /\$portOwners -contains \$_\.ProcessId/u);
  // 线索工具（Codex 自带的 ./server.mjs）继续排除在外。
  assert.match(script, /artifact-template-picker/u);
  // 不许退回"只按 server.mjs 匹配"的老写法。
  assert.doesNotMatch(
    script,
    /Where-Object \{ \$_\.CommandLine -match 'server\\\.mjs' -and \$_\.CommandLine -notmatch 'artifact-template-picker' \}/u
  );
});
