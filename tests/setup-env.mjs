/**
 * 测试统一使用 OpenAI Chat Completions 协议。
 *
 * 本机 `data/runtime/provider.json` 可能存着 responses / anthropic 协议（真实使用配置），
 * 而绝大多数用例 mock 的是 chat completions 的响应形状。测试不该依赖用户配置，
 * 所以这里只在没有显式指定时给一个默认值；需要测其它协议的用例自己覆盖。
 */
process.env.LLM_PROTOCOL ??= "openai";
