import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 出口协议：同一个工作台要能挂 OpenAI 兼容 / OpenAI Responses / Anthropic Messages 三种服务。
 *
 * 参数形态按官方文档核对过：
 * - Responses：/responses，input 输入项 + output 输出项，工具是扁平的
 *   { type:"function", name, description, parameters }，工具结果用 function_call_output 回灌，
 *   图片是 input_image + data URL，思考强度在 reasoning.effort，没有 seed。
 * - Anthropic：/messages，必填 max_tokens，system 单独一个字段，图片是 base64 源块，
 *   工具用 tool_use / tool_result，认证 x-api-key（官方现在也认 Authorization: Bearer），
 *   版本头 anthropic-version: 2023-06-01。
 */
const providerDir = await mkdtemp(join(tmpdir(), "kami-provider-protocol-"));
await writeFile(join(providerDir, "provider.json"), JSON.stringify({ baseUrl: "", model: "", embeddingModel: "", embeddingBaseUrl: "" }));
process.env.KAMI_PROVIDER_DIRECTORY = providerDir;

const requests = [];
let handler = () => ({ status: 200, body: {} });
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  requests.push({ url: String(url), headers: init.headers, body });
  const response = handler(body);
  return {
    ok: response.status < 400,
    status: response.status,
    statusText: "OK",
    text: async () => JSON.stringify(response.body)
  };
};

const { chatWithTools, extractTextFromImageWithModel, probeModelAvailability, updateProviderConfig } = await import("../src/provider.mjs");

const echoTool = {
  type: "function",
  function: {
    name: "search_references",
    description: "检索参考资料",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
  }
};

function configure(protocol) {
  updateProviderConfig({ persist: false, protocol, baseUrl: "http://gateway.test/v1", model: "test-model", mainThinking: "enabled", mainEffort: "low" });
  requests.length = 0;
}

test("OpenAI 兼容协议保持原样：/chat/completions + 原始工具形态 + tool 结果回灌", async () => {
  configure("openai");
  handler = (body) => (body.messages.some((message) => message.role === "tool")
    ? { status: 200, body: { choices: [{ message: { content: "最终译文" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 4 } } }
    : {
      status: 200,
      body: {
        choices: [{
          message: { content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "search_references", arguments: JSON.stringify({ query: "林晚" }) } }] },
          finish_reason: "tool_calls"
        }],
        usage: { prompt_tokens: 5, completion_tokens: 2 }
      }
    });
  const result = await chatWithTools(
    [{ role: "system", content: "系统提示" }, { role: "user", content: "翻译：私は林晚" }],
    { protocol: "openai", baseUrl: "http://gateway.test/v1", model: "test-model", apiKey: "sk-test", thinking: "enabled", reasoningEffort: "low" },
    { tools: [echoTool], executeTool: async () => ({ text: "林晚是主角。" }), maxRounds: 2, seed: 7, responseFormat: { type: "json_object" } }
  );
  assert.equal(result.content, "最终译文");
  assert.equal(requests[0].url, "http://gateway.test/v1/chat/completions");
  assert.equal(requests[0].headers.authorization, "Bearer sk-test");
  assert.deepEqual(requests[0].body.tools, [echoTool], "OpenAI 兼容沿用原始工具定义");
  assert.equal(requests[0].body.seed, 7);
  assert.deepEqual(requests[0].body.response_format, { type: "json_object" });
  assert.equal(requests[0].body.reasoning_effort, "low");
  assert.equal(requests[1].body.messages.at(-1).role, "tool");
  assert.equal(requests[1].body.messages.at(-1).tool_call_id, "call_1");
});

test("Responses 协议：/responses + instructions/input 输入项 + 扁平工具 + function_call_output", async () => {
  configure("responses");
  handler = (body) => (body.input.some((item) => item.type === "function_call_output")
    ? { status: 200, body: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "最终译文" }] }], usage: { input_tokens: 20, output_tokens: 6 } } }
    : {
      status: 200,
      body: {
        status: "completed",
        output: [{ type: "function_call", call_id: "call_1", name: "search_references", arguments: JSON.stringify({ query: "林晚" }) }],
        usage: { input_tokens: 12, output_tokens: 3 }
      }
    });
  const usage = [];
  const result = await chatWithTools(
    [{ role: "system", content: "系统提示" }, { role: "user", content: "翻译：私は林晚" }],
    { protocol: "responses", baseUrl: "http://gateway.test/v1", model: "gpt-test", apiKey: "sk-test", thinking: "enabled", reasoningEffort: "low" },
    { tools: [echoTool], executeTool: async () => ({ text: "林晚是主角。" }), maxRounds: 2, onUsage: (item) => usage.push(item) }
  );
  assert.equal(result.content, "最终译文");
  assert.equal(requests[0].url, "http://gateway.test/v1/responses");
  assert.equal(requests[0].headers.authorization, "Bearer sk-test");
  assert.equal(requests[0].body.instructions, "系统提示", "system 消息走 instructions");
  assert.deepEqual(requests[0].body.input[0], { type: "message", role: "user", content: [{ type: "input_text", text: "翻译：私は林晚" }] });
  assert.deepEqual(requests[0].body.tools, [{
    type: "function",
    name: "search_references",
    description: "检索参考资料",
    parameters: echoTool.function.parameters
  }], "Responses 的工具定义是扁平的");
  assert.equal(requests[0].body.tool_choice, "auto");
  assert.deepEqual(requests[0].body.reasoning, { effort: "low" });
  assert.equal(requests[0].body.seed, undefined, "Responses 没有 seed 参数");
  const followUp = requests[1].body.input;
  assert.deepEqual(followUp.find((item) => item.type === "function_call"), { type: "function_call", call_id: "call_1", name: "search_references", arguments: JSON.stringify({ query: "林晚" }) });
  assert.deepEqual(followUp.find((item) => item.type === "function_call_output"), { type: "function_call_output", call_id: "call_1", output: "林晚是主角。" });
  assert.deepEqual(usage, [{ promptTokens: 12, completionTokens: 3 }, { promptTokens: 20, completionTokens: 6 }], "usage 要按 Responses 字段归一化");
});

test("Anthropic 协议：/messages + system 字段 + tool_use/tool_result + 必填 max_tokens", async () => {
  configure("anthropic");
  handler = (body) => (body.messages.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result"))
    ? { status: 200, body: { stop_reason: "end_turn", content: [{ type: "text", text: "最终译文" }], usage: { input_tokens: 18, output_tokens: 5 } } }
    : {
      status: 200,
      body: {
        stop_reason: "tool_use",
        content: [{ type: "text", text: "" }, { type: "tool_use", id: "toolu_1", name: "search_references", input: { query: "林晚" } }],
        usage: { input_tokens: 11, output_tokens: 2 }
      }
    });
  const result = await chatWithTools(
    [{ role: "system", content: "系统提示" }, { role: "user", content: "翻译：私は林晚" }],
    { protocol: "anthropic", baseUrl: "http://gateway.test/v1", model: "claude-test", apiKey: "sk-ant-test" },
    { tools: [echoTool], executeTool: async () => ({ text: "林晚是主角。" }), maxRounds: 2, seed: 7, responseFormat: { type: "json_object" } }
  );
  assert.equal(result.content, "最终译文");
  assert.equal(requests[0].url, "http://gateway.test/v1/messages");
  assert.equal(requests[0].headers["x-api-key"], "sk-ant-test");
  assert.equal(requests[0].headers.authorization, "Bearer sk-ant-test");
  assert.equal(requests[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(requests[0].body.system, "系统提示");
  assert.deepEqual(requests[0].body.messages, [{ role: "user", content: [{ type: "text", text: "翻译：私は林晚" }] }]);
  assert.equal(requests[0].body.max_tokens, 4096, "Anthropic 的 max_tokens 是必填项");
  assert.deepEqual(requests[0].body.tools, [{
    name: "search_references",
    description: "检索参考资料",
    input_schema: echoTool.function.parameters
  }]);
  assert.deepEqual(requests[0].body.tool_choice, { type: "auto" });
  assert.equal(requests[0].body.seed, undefined, "Anthropic 没有 seed");
  assert.equal(requests[0].body.response_format, undefined, "Anthropic 没有 JSON 模式");
  assert.equal(requests[0].body.reasoning_effort, undefined, "Anthropic 不发 reasoning_effort");
  const toolResult = requests[1].body.messages.find((message) => message.content.some((block) => block.type === "tool_result"));
  assert.deepEqual(toolResult.content, [{ type: "tool_result", tool_use_id: "toolu_1", content: "林晚是主角。" }]);
  assert.ok(requests[1].body.messages.some((message) => message.role === "assistant"
    && message.content.some((block) => block.type === "tool_use" && block.name === "search_references" && block.input.query === "林晚")), "上一轮的 tool_use 要原样回灌");
});

test("参考资料识图在三种协议下都能把图片发给模型", async () => {
  const read = {
    openai: (request) => request.body.messages[1].content[1].image_url.url,
    responses: (request) => request.body.input[0].content[1].image_url,
    anthropic: (request) => request.body.messages[0].content[1]
  };
  const replies = {
    openai: () => ({ status: 200, body: { choices: [{ message: { content: "第 1 页正文" }, finish_reason: "stop" }] } }),
    responses: () => ({ status: 200, body: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "第 1 页正文" }] }] } }),
    anthropic: () => ({ status: 200, body: { stop_reason: "end_turn", content: [{ type: "text", text: "第 1 页正文" }] } })
  };
  for (const protocol of ["openai", "responses", "anthropic"]) {
    configure(protocol);
    handler = replies[protocol];
    const text = await extractTextFromImageWithModel({ base64: "QUJD", mediaType: "image/jpeg" });
    assert.equal(text, "第 1 页正文", protocol);
    const image = read[protocol](requests.at(-1));
    if (protocol === "anthropic") {
      assert.deepEqual(image, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } });
    } else {
      assert.equal(image, "data:image/jpeg;base64,QUJD");
    }
  }
});

test("Responses 被 max_output_tokens 截断时加倍预算重试", async () => {
  configure("responses");
  handler = () => (requests.length === 1
    ? { status: 200, body: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: { input_tokens: 5, output_tokens: 1 } } }
    : { status: 200, body: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }], usage: { input_tokens: 5, output_tokens: 1 } } });
  await probeModelAvailability({ timeoutMs: 2_000 });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.max_output_tokens, 64);
  assert.equal(requests[1].body.max_output_tokens, 128);
});

test("Anthropic 的 stop_reason=max_tokens 同样加倍预算重试", async () => {
  configure("anthropic");
  handler = () => (requests.length === 1
    ? { status: 200, body: { stop_reason: "max_tokens", content: [{ type: "text", text: "" }] } }
    : { status: 200, body: { stop_reason: "end_turn", content: [{ type: "text", text: "OK" }] } });
  await probeModelAvailability({ timeoutMs: 2_000 });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.max_tokens, 64);
  assert.equal(requests[1].body.max_tokens, 128);
});

test("协议跟着配置一起落盘，白名单外的取值退回 OpenAI 兼容", async () => {
  const { loadProviderConfig, normalizeProviderProtocol, saveProviderConfig } = await import("../src/provider-store.mjs");
  assert.equal(normalizeProviderProtocol("anthropic"), "anthropic");
  assert.equal(normalizeProviderProtocol("Responses"), "responses");
  assert.equal(normalizeProviderProtocol("gemini"), "openai");
  assert.equal(normalizeProviderProtocol(""), "openai");

  const directory = await mkdtemp(join(tmpdir(), "kami-provider-protocol-store-"));
  saveProviderConfig({ protocol: "responses", baseUrl: "http://gateway.test/v1", model: "gpt-test" }, directory);
  assert.equal(loadProviderConfig(directory).config.protocol, "responses");
  saveProviderConfig({ protocol: "gemini", baseUrl: "http://gateway.test/v1", model: "gpt-test" }, directory);
  assert.equal(loadProviderConfig(directory).config.protocol, "openai", "白名单外的取值一律按 OpenAI 兼容处理");
  assert.equal(JSON.parse(await readFile(join(directory, "provider.json"), "utf8")).protocol, "openai");
});
