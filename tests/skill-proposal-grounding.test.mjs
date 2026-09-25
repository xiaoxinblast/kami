import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 候选技能提案的"接地"约束。
 *
 * 实测事故：输出预算紧张时，模型会把系统提示词里的示例 JSON 原样抄回来
 * （name="候选技能名"、evidenceIds=[]），旧代码照单全收，直接入库一个毫无依据的候选。
 * 现在要求补丁必须引用至少一条真实轨迹；抄示例的回复按格式失败走重试，重试仍不合格就报错。
 */

const providerDir = await mkdtemp(join(tmpdir(), "kami-proposal-grounding-"));
await writeFile(join(providerDir, "provider.json"), JSON.stringify({ baseUrl: "", model: "", embeddingModel: "", embeddingBaseUrl: "" }));
process.env.KAMI_PROVIDER_DIRECTORY = providerDir;

const replies = [];
const calls = [];
const mockServer = http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    calls.push(JSON.parse(body || "{}"));
    const content = replies.length > 1 ? replies.shift() : replies[0];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] }));
  });
});
await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
mockServer.unref();
process.env.LLM_BASE_URL = `http://127.0.0.1:${mockServer.address().port}/v1`;
process.env.LLM_MODEL = "mock-model";

const { describeJsonFailure, extractJsonObject, proposeTranslationSkillWithModel } = await import("../src/provider.mjs");

const echoExample = JSON.stringify({
  name: "候选技能名",
  reason: "为什么提出该补丁",
  strategyPatch: { prompting: { additionalInstruction: "整体执行指导", additionalRules: ["可执行规则"] } },
  evidenceIds: []
});
const grounded = JSON.stringify({
  name: "真实候选",
  reason: "轨迹里反复出现的语体修订模式",
  strategyPatch: { prompting: { additionalRules: ["说明句用动词前置的效果句式"] } },
  evidenceIds: ["probe-1", "不存在的轨迹"]
});

const trajectories = [{
  id: "probe-1", source: "新しいパスが登場！", initialTranslation: "新通行证登场！", finalTranslation: "全新通行证登场！",
  humanDecision: { accepted: true, finalTranslation: "全新通行证登场！" }
}];
const champion = { id: "c1", version: 1, name: "生效版本", description: "Kami 默认翻译策略", strategy: {} };
const propose = () => proposeTranslationSkillWithModel({ locale: "zh-CN", contentType: "general", domain: "game", project: "p1", champion, trajectories });

test("抄提示词示例的补丁会被判不合格，重试后拿到接地结果", async () => {
  replies.length = 0;
  replies.push(echoExample);
  replies.push(grounded);
  calls.length = 0;
  const result = await propose();
  assert.equal(calls.length, 2, "抄示例要触发一次格式重试");
  assert.equal(result.name, "真实候选");
  assert.deepEqual(result.evidenceIds, ["probe-1"], "只保留真实轨迹 id，伪造的 id 丢掉");
});

test("重试仍然只有示例时直接报错，不入库空候选", async () => {
  replies.length = 0;
  replies.push(echoExample);
  calls.length = 0;
  await assert.rejects(() => propose(), (error) => {
    assert.match(error.message, /没有引用任何一条真实轨迹/u);
    return true;
  });
});

test("JSON 提取容忍代码围栏与多个对象，并能说明截断", () => {
  assert.equal(extractJsonObject("```json\n{\"a\":1}\n```"), "{\"a\":1}");
  // 贪婪匹配会从第一个 { 吃到最后一个 }，拼出非法 JSON；按括号配对只取第一个完整对象。
  assert.equal(extractJsonObject('先给示例 {"name":"示例"}，正式结果 {"name":"正式"}'), '{"name":"示例"}');
  assert.equal(extractJsonObject('{"text":"花括号 } 在字符串里","a":1}'), '{"text":"花括号 } 在字符串里","a":1}');
  assert.equal(extractJsonObject('{"a":1'), "", "截断的 JSON 不算完整对象");
  assert.match(describeJsonFailure('{"a":1'), /没有收尾/u);
  assert.match(describeJsonFailure("我无法完成这个请求"), /没有 JSON 对象/u);
  assert.match(describeJsonFailure(""), /为空/u);
});
