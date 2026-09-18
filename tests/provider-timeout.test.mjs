import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 环境必须在加载 provider 前就绪。
const providerDir = await mkdtemp(join(tmpdir(), "kami-provider-timeout-"));
await writeFile(join(providerDir, "provider.json"), JSON.stringify({ baseUrl: "", model: "", embeddingModel: "", embeddingBaseUrl: "" }));
process.env.KAMI_PROVIDER_DIRECTORY = providerDir;

let chatRequests = 0;
let embeddingRequests = 0;
const stallServer = http.createServer((req, res) => {
  if (req.url === "/v1/chat/completions") {
    chatRequests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"choices":[{"message":{"role":"assistant","content":"部分正文"}');
    const timer = setTimeout(() => { try { res.end(']}'); } catch {} }, 3_000);
    timer.unref();
    return;
  }
  if (req.url === "/v1/embeddings") {
    embeddingRequests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"data":[{"embedding":[0.');
    const timer = setTimeout(() => { try { res.end('1]}'); } catch {} }, 3_000);
    timer.unref();
    return;
  }
  if (req.url === "/normal") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => stallServer.listen(0, "127.0.0.1", resolve));
stallServer.unref();
const stallPort = stallServer.address().port;
process.env.LLM_BASE_URL = `http://127.0.0.1:${stallPort}/v1`;
process.env.LLM_MODEL = "stall-model";
process.env.LLM_EMBEDDING_MODEL = "";
process.env.LLM_EMBEDDING_BASE_URL = `http://127.0.0.1:${stallPort}/v1`;

const { embed, fetchWithTimeout } = await import("../src/provider.mjs");

const chatInit = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };

/**
 * 请求计数由服务端处理函数累加：客户端超时主动断开时，"服务端到底收到没有"取决于
 * 事件循环时序。并行跑整套用例时（浏览器测试会占满 CPU）这个时序会漂，所以这里
 * 容忍短暂延迟，等计数稳定再断言，而不是把机器负载当成产品行为。
 */
async function settleRequests(counter) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  return counter();
}

async function waitForCount(counter, expected) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (counter() >= expected) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return counter();
}

test("正文读取阶段超时转换为带标签错误，且不再泄漏 DOMException", async () => {
  const before = await settleRequests(() => chatRequests);
  await assert.rejects(
    () => fetchWithTimeout(`http://127.0.0.1:${stallPort}/v1/chat/completions`, chatInit, { timeoutMs: 400, label: "翻译" }),
    (error) => /翻译请求超时（400 毫秒）/.test(error.message)
  );
  assert.equal(await waitForCount(() => chatRequests, before + 1), before + 1, "默认不重试");
});

test("超时自动重试一次，第二次仍超时才抛出", async () => {
  const before = await settleRequests(() => chatRequests);
  await assert.rejects(
    () => fetchWithTimeout(`http://127.0.0.1:${stallPort}/v1/chat/completions`, chatInit, { timeoutMs: 400, label: "AIQA", retries: 1 }),
    (error) => /AIQA请求超时（400 毫秒）/.test(error.message)
  );
  assert.equal(await waitForCount(() => chatRequests, before + 2), before + 2, "超时应重试一次共两次请求");
});

test("正常响应原样返回文本与状态", async () => {
  const { response, text } = await fetchWithTimeout(`http://127.0.0.1:${stallPort}/normal`, {}, { timeoutMs: 2_000, label: "探测" });
  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(text), { ok: true });
});

test("非超时错误原样透传，不误报为超时", async () => {
  await assert.rejects(
    () => fetchWithTimeout("http://127.0.0.1:1/v1/x", {}, { timeoutMs: 1_000, label: "请求" }),
    (error) => !/超时/.test(error.message)
  );
});

test("embed 正文停滞同样转换为带标签超时", async () => {
  const before = embeddingRequests;
  await assert.rejects(
    () => embed("测试文本", { model: "test-model", timeoutMs: 400 }),
    (error) => /embedding请求超时（400 毫秒）/.test(error.message)
  );
  assert.equal(embeddingRequests, before + 1);
});
