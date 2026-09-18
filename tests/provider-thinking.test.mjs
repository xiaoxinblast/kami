import test from "node:test";
import assert from "node:assert/strict";

/**
 * 模型思考设置：每个模型角色单独决定开关与强度，落到 DeepSeek 的官方参数
 * （thinking.type / reasoning_effort：low / high / max）。上游不认这两个参数时要
 * 自动退回默认思考模式，不能因为加了设置就把翻译整体打断。
 */
const requests = [];
const openAiReply = (content) => ({ status: 200, body: { choices: [{ message: { content } }] } });
const aiqaReply = () => openAiReply(JSON.stringify({ issues: [] }));
let reply = aiqaReply;

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  requests.push({ url: String(url), body });
  const response = reply(body);
  return {
    ok: response.status < 400,
    status: response.status,
    statusText: "OK",
    text: async () => JSON.stringify(response.body)
  };
};

const { updateProviderConfig, evaluateTranslationWithModel, translateWithRoute } = await import("../src/provider.mjs");

const contextPack = {
  source: "プレミアムパスを購入してください。",
  targetLocale: "zh-CN",
  targetLanguage: "简体中文",
  sourceLanguage: "日语",
  contentType: "general",
  contentTypeLabel: "通用内容",
  register: "中性",
  localeInstruction: "自然的简体中文。"
};

test("关闭思考只发 thinking.type=disabled，不带 reasoning_effort", async () => {
  updateProviderConfig({ persist: false, model: "deepseek-flash", mainThinking: "disabled", mainEffort: "max" });
  requests.length = 0;
  reply = aiqaReply;
  await evaluateTranslationWithModel({ contextPack, translation: "请购买高级通行证。" });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body.thinking, { type: "disabled" });
  assert.equal(requests[0].body.reasoning_effort, undefined);
  assert.equal(requests[0].body.model, "deepseek-flash");
});

test("开启思考时按强度发送 reasoning_effort", async () => {
  updateProviderConfig({ persist: false, mainThinking: "enabled", mainEffort: "low" });
  requests.length = 0;
  await evaluateTranslationWithModel({ contextPack, translation: "请购买高级通行证。" });
  assert.equal(requests[0].body.reasoning_effort, "low");
  assert.equal(requests[0].body.thinking, undefined);
});

test("机器翻译底模与高质量模型各用各的思考设置", async () => {
  updateProviderConfig({
    persist: false,
    model: "deepseek-flash",
    qualityModel: "deepseek-v4-pro",
    mtModel: "deepseek-flash",
    mainThinking: "enabled",
    mainEffort: "low",
    mtThinking: "disabled",
    qualityThinking: "enabled",
    qualityEffort: "max"
  });
  requests.length = 0;
  await translateWithRoute(contextPack, { routePlan: { route: "mt_post_edit", model: "deepseek-flash", modelRole: "mt" } });
  assert.equal(requests.length, 2, "机器初译 + LLM 后编辑各一次");
  assert.equal(requests[0].body.model, "deepseek-flash");
  assert.deepEqual(requests[0].body.thinking, { type: "disabled" }, "底模关思考");
  assert.equal(requests[1].body.model, "deepseek-v4-pro");
  assert.equal(requests[1].body.reasoning_effort, "max", "高质量模型用最高强度");
});

test("专用模型留空复用主模型时，思考设置仍按角色生效", async () => {
  updateProviderConfig({ persist: false, model: "deepseek-flash", fastModel: "", mainThinking: "enabled", mainEffort: "max", fastThinking: "disabled" });
  requests.length = 0;
  await translateWithRoute(contextPack, { routePlan: { route: "direct", model: "deepseek-flash", modelRole: "fast" } });
  assert.equal(requests[0].body.model, "deepseek-flash", "快速模型留空 → 复用主模型");
  assert.deepEqual(requests[0].body.thinking, { type: "disabled" }, "但思考设置按快速模型角色走");
});

test("上游不认思考参数时退回默认模式，并且不再重复尝试", async () => {
  updateProviderConfig({ persist: false, mainThinking: "enabled", mainEffort: "max" });
  let rejected = false;
  reply = (body) => {
    if (Object.hasOwn(body, "reasoning_effort") && !rejected) {
      rejected = true;
      return { status: 400, body: { error: { message: "unknown field reasoning_effort" } } };
    }
    return aiqaReply();
  };
  requests.length = 0;
  await evaluateTranslationWithModel({ contextPack, translation: "请购买高级通行证。" });
  assert.equal(requests.length, 2, "被拒后应原样重试一次");
  assert.equal(requests[0].body.reasoning_effort, "max");
  assert.equal(requests[1].body.reasoning_effort, undefined);

  requests.length = 0;
  await evaluateTranslationWithModel({ contextPack, translation: "请购买高级通行证。" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.reasoning_effort, undefined, "记住这家上游不支持，后续不再先失败一次");
});

