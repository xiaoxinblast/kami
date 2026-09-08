import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("浏览器只启动、暂停和轮询服务端批次", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(source, /\/api\/batch\/run\/\$\{encodeURIComponent\(state\.batchPreview\.batchId\)\}\/start/u);
  assert.match(source, /\/api\/batch\/run\/\$\{encodeURIComponent\(state\.batchPreview\.batchId\)\}\/pause/u);
  assert.match(source, /async function pollServerBatch/u);
  assert.match(source, /关闭页面也会继续/u);
});
