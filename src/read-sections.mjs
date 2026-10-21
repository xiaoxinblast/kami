/**
 * 并行读取多个互不依赖的只读区块。
 *
 * 任务中心这类聚合接口不该因为一个子查询超时就把整页变成 500：
 * 单块失败时返回 fallback，并把失败原因交给调用方记日志。
 */
export async function settleReadSections(sections = []) {
  const list = Array.isArray(sections) ? sections : [];
  const results = await Promise.allSettled(list.map((section) => section.load()));
  const values = {};
  const failures = [];
  results.forEach((result, index) => {
    const section = list[index];
    const key = String(section?.key || `section-${index}`);
    if (result.status === "fulfilled") {
      values[key] = result.value;
      return;
    }
    failures.push({ key, error: result.reason });
    values[key] = section?.fallback;
  });
  return { values, failures };
}
