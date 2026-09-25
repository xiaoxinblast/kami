/**
 * 浏览器用例的等待辅助。
 *
 * 并行跑全量时（同时起十几个 headless 浏览器 + 各自的假服务），接口返回和渲染都会明显变慢：
 * "切到某个页面就直接读 DOM 断言"会读到空状态，看起来像功能坏了，其实只是没等。
 * 这里把这类断言统一成"等状态出现再断言"，失败时把最后读到的内容一起抛出来。
 *
 * 注意：等待只用于**同步**测试与界面，不是掩盖功能问题的宽限；状态一直不出现就必须失败。
 */

export async function waitForText(locator, pattern, { timeoutMs = 45_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    text = await locator.textContent().catch(() => "");
    if (pattern.test(String(text ?? ""))) return text;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`等待文本匹配超时（${Math.round(timeoutMs / 1000)} 秒）：期望 ${pattern}，最近读到 ${JSON.stringify(text)}`);
}

export async function waitForCount(locator, expected, { timeoutMs = 45_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let count = -1;
  while (Date.now() < deadline) {
    count = await locator.count().catch(() => -1);
    if (count === expected) return count;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`等待数量相等超时（${Math.round(timeoutMs / 1000)} 秒）：期望 ${expected}，最近读到 ${count}`);
}
