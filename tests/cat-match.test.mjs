import test from "node:test";
import assert from "node:assert/strict";
import { classifyCatMatch, rankTranslationMemories } from "../src/translation-memory.mjs";

const base = { source: "活动开始", target: "活动开始", entryId: "u1", previousSource: "上一句", nextSource: "下一句" };

test("CAT 100 是原文精确一致", () => {
  assert.equal(classifyCatMatch("活动开始", { ...base, entryId: "other", previousSource: "", nextSource: "" }).rate, 100);
});

test("CAT 101 支持稳定条目 ID或前后文一致", () => {
  assert.equal(classifyCatMatch("活动开始", base, { entryId: "u1" }).rate, 101);
  assert.equal(classifyCatMatch("活动开始", base, { previousSource: "上一句", nextSource: "下一句" }).rate, 101);
});

test("CAT 102 要求条目 ID与前后文同时一致", () => {
  assert.equal(classifyCatMatch("活动开始", base, { entryId: "u1", previousSource: "上一句", nextSource: "下一句" }).rate, 102);
});

test("CAT 文本匹配忽略换行标签但不忽略非换行标签结构", () => {
  const memory = { source: "甲<tag id='b1' type='br' desc='换行'/>乙<tag id='p1' type='inline' desc='ph'/>", target: "译文" };
  assert.equal(classifyCatMatch("甲<tag id='b9' type='br' desc='换行'/>乙<tag id='p8' type='inline' desc='ph'/>", memory).rate, 100);
  assert.equal(classifyCatMatch("甲乙<tag id='p8' type='inline' desc='other'/>", memory).rate, null);
});

test("项目 TM 阈值会过滤低于 CAT 与 LLM 门槛的模糊译例", () => {
  const memories = [
    { id: "exact", source: "活动开始", target: "活动开始", qualityStatus: "human_approved", assetTier: "formal", libraryRole: "master", projectId: "p1" },
    { id: "fuzzy", source: "活动将开始", target: "活动即将开始", qualityStatus: "human_approved", assetTier: "formal", libraryRole: "reference", projectId: "p1" }
  ];
  const ranked = rankTranslationMemories("活动开始", memories, { projectId: "p1", retrievalPurpose: "production", catMinFuzzy: 99, llmMinRelevance: 99 });
  assert.ok(ranked.some((item) => item.id === "exact"));
  assert.ok(!ranked.some((item) => item.id === "fuzzy"));
});
