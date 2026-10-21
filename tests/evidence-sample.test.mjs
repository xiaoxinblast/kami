import test from "node:test";
import assert from "node:assert/strict";
import { collectEvidencePages, evidenceFileCap, evidenceProvenanceRank, stratifyEvidenceSample } from "../src/evidence-sample.mjs";

const row = (overrides = {}) => ({
  id: overrides.id || `e-${Math.random().toString(36).slice(2, 8)}`,
  source: "日语原文",
  target: "简体中文译文",
  contentType: "general",
  sourceFile: "a.xlsx",
  provenance: "table-import",
  polarity: "positive",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides
});

test("人工采纳优先：新导入的表格证据再多也挤不掉它", () => {
  const rows = [
    ...Array.from({ length: 500 }, (_, index) => row({ id: `table-${index}`, createdAt: `2026-09-26T10:00:${String(index % 60).padStart(2, "0")}.000Z` })),
    row({ id: "human-1", provenance: "human-accept", createdAt: "2026-01-01T00:00:00.000Z" })
  ];
  const picked = stratifyEvidenceSample(rows, { limit: 12, positiveOnly: true });
  assert.equal(picked.length, 12);
  assert.ok(picked.some((item) => item.id === "human-1"), "人工采纳必须出现在取样里");
  // limit=2 时应当先给人工采纳 + 外部审校，而不是最新两条表格证据。
  const tiny = stratifyEvidenceSample([
    ...rows,
    row({ id: "external-1", provenance: "external-review-import" })
  ], { limit: 2, positiveOnly: true });
  assert.deepEqual(tiny.map((item) => item.id), ["human-1", "external-1"]);
  assert.equal(evidenceProvenanceRank({ provenance: "human-accept" }), 0);
  assert.equal(evidenceProvenanceRank({ provenance: "external-review-import" }), 1);
  assert.equal(evidenceProvenanceRank({}), 2);
});

test("同一档内按语体轮转：对白和 UI 都有代表", () => {
  const rows = [
    ...Array.from({ length: 50 }, (_, index) => row({ id: `dialogue-${index}`, contentType: "dialogue" })),
    ...Array.from({ length: 50 }, (_, index) => row({ id: `ui-${index}`, contentType: "ui" }))
  ];
  const picked = stratifyEvidenceSample(rows, { limit: 10 });
  const byType = new Map();
  for (const item of picked) byType.set(item.contentType, (byType.get(item.contentType) || 0) + 1);
  assert.equal(byType.get("dialogue"), 5);
  assert.equal(byType.get("ui"), 5);
});

test("单文件上限生效：一个文件不能霸榜，但名额不足时会回流", () => {
  const rows = [
    ...Array.from({ length: 100 }, (_, index) => row({ id: `big-${index}`, sourceFile: "big.xlsx" })),
    ...Array.from({ length: 100 }, (_, index) => row({ id: `small-${index}`, sourceFile: "small.xlsx" }))
  ];
  const limit = 20;
  const picked = stratifyEvidenceSample(rows, { limit });
  assert.equal(picked.length, limit, "取样条数要满足 limit");
  const bigCount = picked.filter((item) => item.sourceFile === "big.xlsx").length;
  const smallCount = picked.filter((item) => item.sourceFile === "small.xlsx").length;
  assert.equal(bigCount, smallCount, "两个文件都要轮到（50/50），不能一个霸榜");
  // 池子里只有一个文件时可读性优先：上限让路，名额照满。
  const singleFile = stratifyEvidenceSample(rows.filter((item) => item.sourceFile === "big.xlsx"), { limit });
  assert.equal(singleFile.length, limit);
  // 池子很小时按实际条数返回。
  const short = stratifyEvidenceSample(rows.slice(0, 2), { limit: 20 });
  assert.equal(short.length, 2);
  assert.equal(evidenceFileCap(20), 5);
});

test("反例：提示词取样剔除，蒸馏取样保留在末尾", () => {
  const rows = [
    row({ id: "pos-1" }),
    row({ id: "neg-1", polarity: "negative", target: "" })
  ];
  const prompt = stratifyEvidenceSample(rows, { limit: 10, positiveOnly: true });
  assert.deepEqual(prompt.map((item) => item.id), ["pos-1"]);
  const distill = stratifyEvidenceSample(rows, { limit: 10 });
  assert.deepEqual(distill.map((item) => item.id), ["pos-1", "neg-1"]);
});

test("同一输入两次取样结果完全一致", () => {
  const rows = Array.from({ length: 40 }, (_, index) => row({ id: `e-${index}`, contentType: index % 2 ? "ui" : "dialogue", sourceFile: index % 3 ? "a.xlsx" : "b.xlsx" }));
  const first = stratifyEvidenceSample(rows, { limit: 12 }).map((item) => item.id);
  const second = stratifyEvidenceSample(rows, { limit: 12 }).map((item) => item.id);
  assert.deepEqual(first, second);
});

test("分页扫描有上限：最多扫 scanBudget 行，页不满就停", async () => {
  const calls = [];
  const pages = new Map([[0, 1_000], [1_000, 1_000], [2_000, 1_000], [3_000, 500]]);
  const rows = await collectEvidencePages({
    scanBudget: 2_500,
    pageSize: 1_000,
    fetchPage: async (offset, limit) => {
      calls.push([offset, limit]);
      return Array.from({ length: Math.min(limit, pages.get(offset) ?? 0) }, (_, index) => row({ id: `p-${offset}-${index}` }));
    }
  });
  assert.deepEqual(calls, [[0, 1_000], [1_000, 1_000], [2_000, 500]], "最多 3 次请求");
  assert.equal(rows.length, 2_500);
  // 空页立刻停，不会一直翻下去。
  const emptyCalls = [];
  await collectEvidencePages({ scanBudget: 5_000, pageSize: 1_000, fetchPage: async (offset) => { emptyCalls.push(offset); return []; } });
  assert.deepEqual(emptyCalls, [0]);
});
