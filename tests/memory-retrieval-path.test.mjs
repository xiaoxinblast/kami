import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

/** 只取一个导出函数的函数体：从签名到第一行顶格的 `}`。 */
const functionBody = (source, name) => {
  const start = source.indexOf(`export async function ${name}(`);
  if (start < 0) return "";
  return source.slice(start).split(/\r?\n\}\r?\n/u)[0];
};

/**
 * 静态护栏：检索入口必须走"先粗筛候选再精排"，不能再退回整库打分。
 *
 * 背景：8.3 万条时整库打分每段 11–17 秒、要传 369MB；这条护栏防止以后有人
 * 顺手把某个入口改回 `limit: -1` 而没注意到代价。
 */
test("翻译/质检/导出三条检索路径都走候选池，而不是整库打分", async () => {
  const server = await read("../server.mjs");
  const calls = server.match(/getMemoryCandidates\(/gu) || [];
  assert.ok(calls.length >= 4, `三条检索路径都要走候选池（当前 ${calls.length} 处）`);
  assert.doesNotMatch(server, /getMemories\(locale, \{ contentType: classification\.contentType, domain, limit: -1/u, "翻译路径不能退回整库");
  assert.doesNotMatch(server, /getMemories\(locale, \{ projectId, contentType: scopeContentType, domain, limit: -1/u, "质检路径不能退回整库");
  assert.doesNotMatch(server, /getMemories\(locale, \{ contentType, domain, limit: -1, scopeFallback: true, projectId \}\)/u, "上下文包路径不能退回整库");
  // 清单页/一致性回写这类"按条件取少量行"的调用保持原样，不受影响。
  assert.match(server, /getMemories\(locale, \{ projectId, contentType, domain, limit: 50, search: phrase, scopeFallback: true \}\)/u);
});

test("候选池大小可调；单条写入增量更新，批量与库级操作才整体失效", async () => {
  const [settings, store] = await Promise.all([read("../src/settings.mjs"), read("../src/store.mjs")]);
  assert.match(settings, /"retrieval\.candidatePoolSize": \{ min: 0, max: 5000, step: 100, default: 1000/u);
  assert.match(store, /export function invalidateMemoryIndexes\(\) \{[\s\S]{0,160}memoryIndexCache\.clear\(\);/u);
  // 单条写入/删除不能清空索引（8 万行重建一次 22MB）：走增量 upsert / remove。
  for (const fn of ["saveMemory", "updateMemory"]) {
    const body = functionBody(store, fn);
    assert.ok(body, `找不到 ${fn}`);
    assert.match(body, /applyMemoryIndexUpsert\(/u, `${fn} 应该增量更新候选索引`);
    assert.doesNotMatch(body, /invalidateMemoryIndexes\(\);/u, `${fn} 不应让整个索引失效`);
  }
  {
    const body = functionBody(store, "deleteMemory");
    assert.ok(body, "找不到 deleteMemory");
    assert.match(body, /applyMemoryIndexRemoval\(/u, "deleteMemory 应该增量删除候选行");
    assert.doesNotMatch(body, /invalidateMemoryIndexes\(\);/u, "deleteMemory 不应让整个索引失效");
  }
  // 批量导入与库级操作影响面太大，保持整体失效、下次检索重建一次。
  for (const fn of ["saveMemories", "deleteLibraryEntries", "demoteMemories", "purgeProject"]) {
    const body = functionBody(store, fn);
    assert.ok(body, `找不到 ${fn}`);
    assert.match(body, /invalidateMemoryIndexes\(\);/u, `${fn} 写入后要让候选索引整体失效`);
  }
});
