import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 与其它 store 用例同法：先定数据目录与后端，再 import。
const DATA_DIR = await mkdtemp(join(tmpdir(), "kami-tm-audit-"));
process.env.KAMI_DATA_DIR = DATA_DIR;
process.env.KAMI_STORE = "json";
const {
  getImportPreview,
  getStyleEvidence,
  initializeStore,
  sampleStyleEvidence,
  saveStyleEvidence,
  saveTmImportAudit
} = await import("../src/store.mjs");

await initializeStore();

test.after(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
});

const candidates = Array.from({ length: 5 }, (_, index) => ({
  source: `セリフ${index}：テスト用の日本語です。`,
  target: `台词${index}：这是测试用的中文。`,
  locale: "zh-CN",
  assetType: "memory",
  contentType: "general",
  domain: "general",
  sourceFile: "big.xlsx",
  rowNumber: index + 2,
  selected: index !== 3
}));

test("TM 导入审计：批次直接 completed，候选行写终态且字段精简", async () => {
  const decisions = candidates.map((candidate) => ({
    status: candidate.selected ? "accepted" : "rejected",
    decision: candidate.selected ? "ready" : "excluded"
  }));
  const written = await saveTmImportAudit({
    batchId: "audit-batch-1",
    filename: "big.xlsx",
    fileType: "xlsx",
    projectId: "p1",
    requestedLocale: "zh-CN",
    summary: { imported: 4, memories: 4, skipped: 1 },
    candidates,
    decisions
  });
  assert.equal(written.candidates, 5);
  const preview = await getImportPreview("audit-batch-1");
  assert.equal(preview.status, "completed");
  assert.equal(preview.summary.memories, 4);
  assert.equal(preview.candidates.length, 5);
  const rejected = preview.candidates.filter((item) => item.status === "rejected");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].decision, "excluded");
  // 审计行只留必需字段：原来写队列用的那批空列不再出现。
  for (const row of preview.candidates) {
    for (const key of ["parentEvidence", "sourceSpan", "termCategory", "extractionConfidence"]) {
      assert.equal(key in row, false, `审计行不该带 ${key}`);
    }
  }
});

test("重复导入同一个文件：替换上一批审计，只留最新一批", async () => {
  const options = { projectId: "p9", requestedLocale: "zh-CN", summary: { imported: 5 }, candidates, decisions: candidates.map(() => ({ status: "accepted", decision: "ready" })) };
  await saveTmImportAudit({ ...options, batchId: "audit-old", filename: "same.xlsx", fileType: "xlsx" });
  await saveTmImportAudit({ ...options, batchId: "audit-new", filename: "same.xlsx", fileType: "xlsx" });
  assert.equal(await getImportPreview("audit-old"), null, "同一项目 + 同一文件名的上一批审计要被替换");
  assert.ok(await getImportPreview("audit-new"), "最新一批要留着");
  // 文件名不同、项目不同都不受影响。
  await saveTmImportAudit({ ...options, batchId: "audit-other-file", filename: "other.xlsx", fileType: "xlsx" });
  await saveTmImportAudit({ ...options, batchId: "audit-other-project", filename: "same.xlsx", fileType: "xlsx", projectId: "p10" });
  assert.ok(await getImportPreview("audit-new"));
  assert.ok(await getImportPreview("audit-other-file"));
  assert.ok(await getImportPreview("audit-other-project"));
});

test("历史批次（队列后置之前、没有 tm-audit 标记）同样会被替换，资产导入批次不碰", async () => {
  const options = { projectId: "p11", requestedLocale: "zh-CN", summary: { imported: 5 }, candidates, decisions: candidates.map(() => ({ status: "accepted", decision: "ready" })) };
  // 手工造两个"老格式"批次文件：TM 导入（没有 fileMode）与资产导入（带 fileMode）。
  await writeFile(join(DATA_DIR, "imports", "legacy-tm.json"), JSON.stringify({
    batchId: "legacy-tm", filename: "legacy.xlsx", fileType: "xlsx", projectId: "p11", status: "completed", candidates: [], summary: { imported: 5 }
  }), "utf8");
  await writeFile(join(DATA_DIR, "imports", "legacy-asset.json"), JSON.stringify({
    batchId: "legacy-asset", filename: "legacy.xlsx", fileType: "xlsx", projectId: "p11", status: "completed", fileMode: "dialogue", candidates: [], summary: { imported: 5 }
  }), "utf8");
  await saveTmImportAudit({ ...options, batchId: "legacy-new", filename: "legacy.xlsx", fileType: "xlsx" });
  assert.equal(await getImportPreview("legacy-tm"), null, "老的 TM 导入批次要被替换");
  assert.ok(await getImportPreview("legacy-asset"), "资产导入批次不能被误删");
  assert.ok(await getImportPreview("legacy-new"));
});

test("风格证据不再写向量，读取路径不受影响", async () => {
  const saved = await saveStyleEvidence({
    locale: "zh-CN",
    projectId: "p1",
    source: "用語のテスト原文です。",
    target: "术语测试的译文。",
    contentType: "dialogue",
    domain: "general",
    provenance: "table-import"
  });
  assert.ok(saved.id);
  const rows = await getStyleEvidence("zh-CN", { projectId: "p1", limit: 100 });
  const hit = rows.find((item) => item.id === saved.id);
  assert.ok(hit);
  assert.equal(hit.embedding, undefined, "证据行不该再带向量");
  const raw = JSON.parse(await readFile(join(DATA_DIR, "styles", "evidence.json"), "utf8"));
  assert.equal("embedding" in raw.find((item) => item.id === saved.id), false);
});

test("分层取样：新导入的表格证据再多也挤不掉人工采纳", async () => {
  await saveStyleEvidence({
    locale: "zh-CN",
    projectId: "p2",
    source: "人工采纳的原文",
    target: "人工采纳的译文",
    contentType: "dialogue",
    domain: "general",
    provenance: "human-accept"
  });
  for (let index = 0; index < 300; index += 1) {
    await saveStyleEvidence({
      locale: "zh-CN",
      projectId: "p2",
      source: `一括インポート原文${index}`,
      target: `批量导入译文${index}`,
      contentType: "general",
      domain: "general",
      provenance: "table-import",
      sourceFile: "bulk.xlsx"
    });
  }
  const sampled = await sampleStyleEvidence("zh-CN", { projectId: "p2", limit: 12, positiveOnly: true });
  assert.equal(sampled.length, 12);
  assert.ok(sampled.some((item) => item.provenance === "human-accept"), "人工采纳必须进取样");
});
