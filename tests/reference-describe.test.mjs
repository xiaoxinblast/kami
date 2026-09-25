import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 环境必须在加载 provider 前就绪。
const providerDir = await mkdtemp(join(tmpdir(), "kami-reference-describe-"));
await writeFile(join(providerDir, "provider.json"), JSON.stringify({ baseUrl: "", model: "", embeddingModel: "", embeddingBaseUrl: "" }));
process.env.KAMI_PROVIDER_DIRECTORY = providerDir;

const requests = [];
let reply = '  这份资料是 CorelTrain 章节顺序表，列出每章的场景编号与顺序。\n（补充说明不该出现）';
const mockServer = http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    requests.push(JSON.parse(body || "{}"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: reply } }], usage: { prompt_tokens: 120, completion_tokens: 20 } }));
  });
});
await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
mockServer.unref();

process.env.LLM_BASE_URL = `http://127.0.0.1:${mockServer.address().port}/v1`;
process.env.LLM_MODEL = "mock-model";

const { describeReferenceWithModel, updateProviderConfig } = await import("../src/provider.mjs");
updateProviderConfig({ persist: false, model: "mock-model" });

/**
 * 「让 AI 扫描」生成的资料描述会写进 ingest_report，翻译时模型先看"文件名 + 描述"
 * 判断要不要读全文，所以描述必须是短短一句，而不是把整篇正文再吐一遍。
 */
test("资料描述只取首行短句，并把正文节选交给模型", async () => {
  const description = await describeReferenceWithModel({
    name: "END3_CorelTrain_SCENARIO_ORDER",
    kind: "setting",
    text: "第 1 章 旧魔晄炉\n第 2 章 贫民窟\n第 3 章 古留根尾的宅邸"
  });
  assert.equal(description, "这份资料是 CorelTrain 章节顺序表，列出每章的场景编号与顺序。");
  const body = requests.at(-1);
  assert.equal(body.model, "mock-model");
  assert.equal(body.max_tokens, 200, "描述任务要限制输出长度");
  assert.match(body.messages[0].content, /不超过 60 字/u);
  assert.match(body.messages[1].content, /END3_CorelTrain_SCENARIO_ORDER/u, "资料名要交给模型");
  assert.match(body.messages[1].content, /第 3 章 古留根尾的宅邸/u, "正文节选要交给模型");
});

test("超长资料只截前 6000 字，模型返回空描述时报错", async () => {
  await describeReferenceWithModel({ name: "long", kind: "other", text: "あ".repeat(9_000) });
  const sent = requests.at(-1).messages[1].content;
  const excerpt = sent.split("正文节选：\n")[1] || "";
  assert.equal([...excerpt].length, 6_000, "只发前 6000 字，避免把整份资料塞进提示词");

  reply = "   ";
  await assert.rejects(() => describeReferenceWithModel({ name: "empty", kind: "other", text: "正文" }), /模型没有返回资料描述/u);
  await assert.rejects(() => describeReferenceWithModel({ name: "blank", kind: "other", text: "   " }), /没有可读正文/u);
});

/**
 * 描述是导入后补的，不能要求重新入库：路由把描述合并回已有的 ingest_report，
 * 并让引用索引失效，否则翻译时看到的还是旧清单。
 */
test("describe 路由把描述写回 ingest_report 并失效索引", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const start = server.indexOf('url.pathname.endsWith("/describe")');
  assert.ok(start >= 0, "服务端要有 describe 路由");
  const body = server.slice(start, server.indexOf('url.pathname.endsWith("/status")', start));
  assert.match(body, /await getReferenceDocument\(id\)/u);
  assert.match(body, /const description = await describeReferenceWithModel\(/u);
  assert.match(body, /ingestReport: \{ \.\.\.\(document\.ingestReport \|\| \{\}\), description,/u);
  assert.match(body, /referenceIndex\.invalidate\(document\.projectId\)/u);
  assert.match(body, /return json\(res, 409, \{ error: "这份资料没有可读正文/u);
});
