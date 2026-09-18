import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORIGINAL_UPLOAD_DIRECTORY, deleteBatchOriginal, originalRelativePath, readBatchOriginal, saveBatchOriginal } from "../src/batch-originals.mjs";

/**
 * 批次原文件存档：导入时上传的原文件按批次存到磁盘，导出写回时直接用，
 * 不用再让用户重新选一遍（这是"选择原文件并写回"那一步的替代方案）。
 */
test("原文件按批次存档，可读回，也可删除", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "kami-originals-"));
  const saved = await saveBatchOriginal({ dataRoot, batchId: "batch-1", filename: "lines.mqxliff", buffer: Buffer.from("hello") });
  assert.equal(saved.relative, `${ORIGINAL_UPLOAD_DIRECTORY}/batch-1.mqxliff`);
  assert.equal(saved.bytes, 5);
  assert.equal((await readBatchOriginal({ dataRoot, relativePath: saved.relative })).toString("utf8"), "hello");
  assert.equal(await deleteBatchOriginal({ dataRoot, relativePath: saved.relative }), true);
  assert.equal(await readBatchOriginal({ dataRoot, relativePath: saved.relative }), null);
});

test("只接受已知扩展名，拒绝路径穿越与超大文件", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "kami-originals-"));
  assert.equal(originalRelativePath("b", "a.txt"), "uploads/b.txt");
  assert.equal(originalRelativePath("b", "a.exe"), "uploads/b", "未知扩展名不拼后缀");
  assert.equal(await readBatchOriginal({ dataRoot, relativePath: "../directus/.env" }), null, "不能读到存档目录之外");
  assert.equal(await readBatchOriginal({ dataRoot, relativePath: "other/b.txt" }), null);
  assert.equal(await readBatchOriginal({ dataRoot, relativePath: "" }), null);
  await assert.rejects(() => saveBatchOriginal({ dataRoot, batchId: "b", filename: "a.xlsx", buffer: Buffer.alloc(21 * 1024 * 1024) }), /超过/u);
  await assert.rejects(() => saveBatchOriginal({ dataRoot, batchId: "", filename: "a.xlsx", buffer: Buffer.from("x") }), /缺少批次 ID/u);
  await assert.rejects(() => saveBatchOriginal({ dataRoot, batchId: "b", filename: "a.xlsx", buffer: Buffer.alloc(0) }), /内容为空/u);
});
