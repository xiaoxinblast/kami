import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { scopeFallbackChain, scopeRankOf } from "../src/scope-fallback.mjs";

const requests = [];
const memoryRows = [
  { id: "m-exact", source: "同じ文です。", target: "同一句话（对白）", domain: "game", content_type: "dialogue", quality_status: "human_approved", asset_tier: "formal", project_id: "project-a", date_created: "2026-09-18T10:00:00Z" },
  { id: "m-general", source: "同じ文です。", target: "同一句话（通用）", domain: "general", content_type: "general", quality_status: "human_approved", asset_tier: "formal", project_id: "project-a", date_created: "2026-09-18T10:00:00Z" },
  { id: "m-other", source: "同じ文です。", target: "同一句话（别的语体）", domain: "game", content_type: "ui", quality_status: "human_approved", asset_tier: "formal", project_id: "project-a", date_created: "2026-09-18T10:00:00Z" }
];
const profileRows = [
  { id: "sp-general", name: "通用规范", content_type: "general", domain: "general", instructions: "通用规则", rules: [], examples: [], version: 1, evidence_count: 10, status: "active", project_id: "project-a", target_locale: "zh-CN" }
];

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const server = http.createServer(async (req, res) => {
  await readBody(req);
  const url = new URL(`http://directus${req.url}`);
  const collection = url.pathname.split("/")[2] || "";
  requests.push({ collection, query: url.search });
  const data = collection === "style_profiles" ? profileRows : memoryRows;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
process.env.DIRECTUS_URL = `http://127.0.0.1:${server.address().port}`;
process.env.DIRECTUS_TOKEN = "test-token";

const { getDirectusMemories, getDirectusStyleProfile } = await import("../src/directus-store.mjs");
const { rankQaCases, rankTranslationMemories } = await import("../src/translation-memory.mjs");

test("降级链顺序固定：同语体同领域 → 同语体通用 → 通用同领域 → 通用×通用", () => {
  assert.deepEqual(scopeFallbackChain("dialogue", "game").map((entry) => `${entry.contentType}×${entry.domain}`), [
    "dialogue×game", "dialogue×general", "general×game", "general×general"
  ]);
  // 本身就是通用时去重，链会变短
  assert.deepEqual(scopeFallbackChain("general", "game").map((entry) => `${entry.contentType}×${entry.domain}`), ["general×game", "general×general"]);
  assert.deepEqual(scopeFallbackChain("general", "general").map((entry) => `${entry.contentType}×${entry.domain}`), ["general×general"]);
});

test("scopeRankOf 给出资产落在链上的第几档", () => {
  assert.equal(scopeRankOf({ contentType: "dialogue", domain: "game" }, { contentType: "dialogue", domain: "game" }), 0);
  assert.equal(scopeRankOf({ contentType: "dialogue", domain: "general" }, { contentType: "dialogue", domain: "game" }), 1);
  assert.equal(scopeRankOf({ contentType: "general", domain: "game" }, { contentType: "dialogue", domain: "game" }), 2);
  assert.equal(scopeRankOf({ contentType: "general", domain: "general" }, { contentType: "dialogue", domain: "game" }), 3);
  assert.equal(scopeRankOf({ contentType: "ui", domain: "game" }, { contentType: "dialogue", domain: "game" }), 4, "不在链上的给最差档");
});

test("翻译记忆按降级链取回并标注档位（同语体与通用都要进来）", async () => {
  requests.length = 0;
  const memories = await getDirectusMemories("zh-CN", { projectId: "project-a", contentType: "dialogue", domain: "game", scopeFallback: true, limit: -1 });
  const query = decodeURIComponent(requests.at(-1).query);
  assert.ok(query.includes("[content_type][_in]=dialogue,general"), `语体要按链取：${query}`);
  assert.ok(query.includes("[domain][_in]=game,general"), `领域要按链取：${query}`);
  const byId = new Map(memories.map((item) => [item.id, item]));
  assert.equal(byId.get("m-exact").scopeRank, 0);
  assert.equal(byId.get("m-general").scopeRank, 3);
});

test("风格规范按链位硬选：没有同语体时用通用兜底", async () => {
  const profile = await getDirectusStyleProfile("zh-CN", "dialogue", "game", { projectId: "project-a", scopeFallback: true });
  assert.ok(profile, "通用规范要在没有专用规范时兜底命中");
  assert.equal(profile.id, "sp-general");
  assert.equal(profile.scopeRank, 3, "兜底命中要标出它在链上的档位");
  const query = decodeURIComponent(requests.at(-1).query);
  assert.ok(query.includes("[content_type][_in]=dialogue,general"), `规范查询要按链取：${query}`);
});

test("译例排序：同作用域优先，但更相关的通用译例仍能胜出", () => {
  const same = { id: "same", source: "同じ文です。", target: "对白版", qualityStatus: "human_approved", contentType: "dialogue", domain: "game", scopeRank: 0 };
  const general = { id: "general", source: "同じ文です。", target: "通用版", qualityStatus: "human_approved", contentType: "general", domain: "general", scopeRank: 3 };
  const ranked = rankTranslationMemories("同じ文です。", [general, same], { limit: 2, contentType: "dialogue", domain: "game" });
  assert.equal(ranked[0].id, "same", "同作用域应该有加成");

  // 加成 0.06 不足以把"沾点边"的通用译例顶过明显更相关的同作用域译例：反过来也一样。
  const unrelatedGeneral = { id: "far", source: "まったく別の文章です。", target: "完全不同的句子", qualityStatus: "human_approved", contentType: "general", domain: "general", scopeRank: 3 };
  const ranked2 = rankTranslationMemories("同じ文です。", [unrelatedGeneral, general], {
    limit: 2, contentType: "dialogue", domain: "game", llmMinRelevance: 0
  });
  assert.equal(ranked2[0].id, "general", "相关性仍然主导排序");
  assert.ok(ranked2.every((item) => item.similarity >= 0.28), "作用域加成不参与相关度门槛");
});

test("QA 反例同样按作用域加成排序", () => {
  const same = { id: "qa-exact", source: "同じ文です。", rejectedTranslation: "错译 A", correctedTranslation: "对 A", scoreAfter: 90, scopeRank: 0 };
  const general = { id: "qa-general", source: "同じ文です。", rejectedTranslation: "错译 B", correctedTranslation: "对 B", scoreAfter: 90, scopeRank: 3 };
  const ranked = rankQaCases("同じ文です。", [general, same], { limit: 2, contentType: "dialogue", domain: "game" });
  assert.equal(ranked[0].id, "qa-exact");
  assert.equal(ranked[0].rankScore >= ranked[1].rankScore, true);
});
