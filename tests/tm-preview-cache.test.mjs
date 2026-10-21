import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 数据目录必须在 import 之前指定：模块顶层就会读 KAMI_DATA_DIR。
const DATA_DIR = await mkdtemp(join(tmpdir(), "kami-tm-preview-"));
process.env.KAMI_DATA_DIR = DATA_DIR;
process.env.KAMI_STORE = "json";
const {
  deletePreviewCache,
  readPreviewCandidates,
  readPreviewPage,
  readPreviewMeta,
  sweepPreviewCaches,
  writePreviewCache
} = await import("../src/tm-preview-cache.mjs");

test.after(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
});

const candidates = Array.from({ length: 5 }, (_, index) => ({
  source: `原文${index + 1}`,
  target: `译文${index + 1}`,
  sourceFile: "big.xlsx",
  sourceRow: index + 2
}));

test("预检缓存按页读回，8 万条候选不必整份发给浏览器", async () => {
  await writePreviewCache({
    batchId: "batch-demo",
    meta: { filename: "big.xlsx", projectId: "p1", statistics: { totalRows: 8, truncated: false } },
    candidates
  });
  const meta = await readPreviewMeta("batch-demo");
  assert.equal(meta.total, 5);
  assert.equal(meta.filename, "big.xlsx");
  const first = await readPreviewPage("batch-demo", { offset: 0, limit: 2 });
  assert.deepEqual(first.items.map((item) => item.source), ["原文1", "原文2"]);
  assert.equal(first.total, 5);
  const second = await readPreviewPage("batch-demo", { offset: 2, limit: 2 });
  assert.deepEqual(second.items.map((item) => item.source), ["原文3", "原文4"]);
  const all = await readPreviewCandidates("batch-demo");
  assert.equal(all.length, 5);
  assert.equal(all[4].target, "译文5");
});

test("缓存不存在、批次号不合法、删除之后都当作没有这份缓存", async () => {
  assert.equal(await readPreviewMeta("missing-batch"), null);
  assert.equal(await readPreviewPage("missing-batch", { offset: 0, limit: 10 }), null);
  assert.equal(await readPreviewCandidates("../../etc/passwd"), null);
  await deletePreviewCache("batch-demo");
  assert.equal(await readPreviewMeta("batch-demo"), null);
});

test("过期清理只删自己写出来的文件", async () => {
  await writePreviewCache({ batchId: "old-batch", meta: { filename: "old.xlsx" }, candidates: candidates.slice(0, 2) });
  const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const dir = join(DATA_DIR, "runtime", "tm-preview");
  await utimes(join(dir, "old-batch.ndjson"), stale, stale);
  await utimes(join(dir, "old-batch.meta.json"), stale, stale);
  // 别人放在同一目录里的文件不能被误删。
  await writeFile(join(dir, "notes.txt"), "keep me", "utf8");
  const removed = await sweepPreviewCaches({ maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
  assert.equal(removed, 2);
  assert.equal(await readPreviewMeta("old-batch"), null);
  const { readFile } = await import("node:fs/promises");
  assert.equal(await readFile(join(dir, "notes.txt"), "utf8"), "keep me");
});
