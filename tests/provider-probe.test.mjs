import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 环境必须在加载 provider 前就绪。
const providerDir = await mkdtemp(join(tmpdir(), "kami-provider-probe-"));
await writeFile(join(providerDir, "provider.json"), JSON.stringify({ baseUrl: "", model: "", embeddingModel: "", embeddingBaseUrl: "" }));
process.env.KAMI_PROVIDER_DIRECTORY = providerDir;

const requests = [];
const mockServer = http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    requests.push(JSON.parse(body || "{}"));
    res.writeHead(200, { "content-type": "application/json" });
    if (requests.length === 1) {
      res.end(JSON.stringify({ choices: [{ finish_reason: "length", message: { role: "assistant", content: "" } }] }));
      return;
    }
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "OK" } }] }));
  });
});
await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
mockServer.unref();
const port = mockServer.address().port;
process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.LLM_MODEL = "reasoning-model";

const { probeModelAvailability } = await import("../src/provider.mjs");

test("模型探针为推理输出预留预算，并在长度耗尽时扩大预算重试", async () => {
  await assert.doesNotReject(() => probeModelAvailability({ timeoutMs: 2_000 }));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].max_tokens, 64);
  assert.equal(requests[1].max_tokens, 128);
  assert.equal(requests[0].reasoning_effort, "low");
});

/**
 * 「模型设置 → 测试连接」要能试"刚填、还没保存"的地址与密钥：
 * 显式覆盖时探针必须打覆盖目标，而不是当前生效配置。
 */
test("显式覆盖 baseUrl / apiKey / model 时探针打覆盖目标", async () => {
  const hits = [];
  const target = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      hits.push({ authorization: req.headers.authorization || "", body: JSON.parse(body || "{}") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "OK" } }] }));
    });
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  target.unref();
  const typedBaseUrl = `http://127.0.0.1:${target.address().port}/v1`;
  const requestsBefore = requests.length;
  try {
    await assert.doesNotReject(() => probeModelAvailability({
      timeoutMs: 2_000,
      config: { baseUrl: typedBaseUrl, apiKey: "typed-key", model: "typed-model" }
    }));
    assert.equal(hits.length, 1, "探针要打覆盖后的地址");
    assert.equal(hits[0].authorization, "Bearer typed-key", "面板里填的密钥要带上");
    assert.equal(hits[0].body.model, "typed-model", "面板里填的模型要带上");
    assert.equal(requests.length, requestsBefore, "覆盖后不应再打原配置的地址");
  } finally {
    await new Promise((resolve) => target.close(resolve));
  }
});
