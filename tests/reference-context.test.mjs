import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = await mkdtemp(join(tmpdir(), "kami-reference-snapshot-"));
process.env.KAMI_DATA_DIR = DATA_DIR;
const {
  readReferenceSnapshot,
  referenceDocumentsFingerprint,
  referenceSnapshotPath,
  writeReferenceSnapshot
} = await import("../src/reference-context.mjs");

test.after(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
});

test("资料文档或库开关变化会改变指纹", () => {
  const documents = [{ id: "d1", updatedAt: "2026-10-01T00:00:00.000Z", chunkCount: 3 }];
  const libraries = [{ id: "l1", enabled: true }];
  const base = referenceDocumentsFingerprint(documents, libraries);
  assert.notEqual(base, referenceDocumentsFingerprint([{ ...documents[0], updatedAt: "2026-10-02T00:00:00.000Z" }], libraries));
  assert.notEqual(base, referenceDocumentsFingerprint([{ ...documents[0], chunkCount: 4 }], libraries));
  assert.notEqual(base, referenceDocumentsFingerprint(documents, [{ id: "l1", enabled: false }]));
});

test("磁盘快照命中同指纹，指纹或 TTL 变化后失效", async () => {
  const path = referenceSnapshotPath("project-1");
  const items = [{ id: "c1", text: "正文", embedding: [0.1, 0.2] }];
  const fingerprint = referenceDocumentsFingerprint([{ id: "d1", updatedAt: "v1", chunkCount: 1 }]);
  await writeReferenceSnapshot(path, fingerprint, items);
  assert.deepEqual(await readReferenceSnapshot(path, fingerprint), items);
  assert.equal(await readReferenceSnapshot(path, `${fingerprint}-other`), null, "指纹变化必须重载");
  assert.equal(await readReferenceSnapshot(path, fingerprint, { now: Date.now() + 11 * 60_000 }), null, "超过 TTL 必须重载");
});
