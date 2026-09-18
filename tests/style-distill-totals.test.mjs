import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 假 Directus：证据池真实 8134 条（聚合），但列表接口按 1000 上限只返回 1000 条；
// 已有一版 v1 规范（active，evidence_count 1000）。
const POOL_TOTAL = 8134;
const SAMPLE_SIZE = 1_000;
const createdProfiles = [];

function sampleEvidence(index) {
  return {
    id: `ev-${index}`,
    project_id: "project-pool",
    target_locale: "zh-CN",
    content_type: "general",
    domain: "general",
    source: `サンプル原文 ${index}`,
    target: `样例译文 ${index}`,
    machine_translation: "",
    polarity: "positive",
    provenance: "table-import",
    status: "accepted",
    date_created: "2026-09-18T10:00:00Z"
  };
}

const existingProfile = {
  id: "sp-v1",
  project_id: "project-pool",
  name: "简体中文 general 风格",
  target_locale: "zh-CN",
  content_type: "general",
  domain: "general",
  instructions: "【用词】\n・旧规则",
  rules: [],
  examples: [],
  version: 1,
  evidence_count: 1000,
  status: "active",
  date_updated: "2026-09-18T09:00:00Z"
};

const directus = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  const url = new URL(`http://directus${req.url}`);
  const collection = url.pathname.split("/")[2] || "";
  let data = [];
  if (collection === "style_evidence") {
    data = url.searchParams.get("aggregate[count]") !== null
      ? [{ content_type: "general", domain: "general", provenance: "table-import", count: String(POOL_TOTAL) }]
      : Array.from({ length: SAMPLE_SIZE }, (_, index) => sampleEvidence(index + 1));
  } else if (collection === "style_profiles") {
    if (req.method === "POST") {
      const body = JSON.parse(raw || "{}");
      const saved = { id: `sp-v${createdProfiles.length + 2}`, ...body, date_updated: "2026-09-19T00:00:00Z" };
      createdProfiles.push(saved);
      data = saved;
    } else {
      data = [existingProfile];
    }
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data }));
});
await new Promise((resolve) => directus.listen(0, "127.0.0.1", resolve));
directus.unref();

const dataDir = mkdtempSync(join(tmpdir(), "kami-distill-totals-"));
const providerDir = mkdtempSync(join(tmpdir(), "kami-distill-provider-"));
process.env.KAMI_DATA_DIR = dataDir;
process.env.KAMI_PROVIDER_DIRECTORY = providerDir;
process.env.KAMI_STORE = "directus";
process.env.DIRECTUS_URL = `http://127.0.0.1:${directus.address().port}`;
process.env.DIRECTUS_TOKEN = "test-token";
// 端口要和其它用例错开：style-benchmark.integration 用的是 11439。
process.env.LLM_BASE_URL = "http://127.0.0.1:11440/v1";
process.env.LLM_MODEL = "mock-chat";
process.env.MOCK_OPENAI_PORT = "11440";

await import("./fixtures/mock-openai-server.mjs");
// 不用固定 sleep：整套测试并发跑时 400ms 可能不够，轮询到 mock 模型服务真的应答为止。
const mockChatUrl = `http://127.0.0.1:${process.env.MOCK_OPENAI_PORT}/v1/chat/completions`;
const readyDeadline = Date.now() + 15_000;
for (;;) {
  try {
    const probe = await fetch(mockChatUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "probe" }] })
    });
    if (probe.ok) break;
  } catch { /* 还没监听，继续等 */ }
  if (Date.now() > readyDeadline) throw new Error("mock 模型服务未在 15 秒内就绪");
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const { distillStyleProfileIfReady } = await import("../src/evolution.mjs");
const { countDirectusStyleEvidenceByScope } = await import("../src/directus-store.mjs");

test("蒸馏判定用证据池真实条数，不再被 1000 抓取上限卡死", async () => {
  const totals = await countDirectusStyleEvidenceByScope("zh-CN", { projectId: "project-pool" });
  assert.equal(totals.get("general\u0000general").total, POOL_TOTAL, "聚合要给出真实池子大小");

  const result = await distillStyleProfileIfReady({
    locale: "zh-CN",
    contentType: "general",
    domain: "general",
    projectId: "project-pool",
    threshold: 8,
    growthWindow: 8,
    positiveLimit: 50,
    negativeLimit: 15
  });

  // 池子 8134、基线 1000 → 增长 7134 条，必须判定为"该蒸馏"；
  // 旧实现拿列表长度（被截断成 1000）当池子大小，增长算成 0，会被 growth_window 永久挡住。
  assert.equal(result.skipped, "", `不该被增长窗口挡住：${JSON.stringify({ skipped: result.skipped, reason: result.reason })}`);
  assert.ok(result.distilled?.id, "应该产出新一版草稿");
  assert.equal(result.distilled.evidenceCount, POOL_TOTAL, "记录里要写真实池子条数，下一轮增长窗口才有正确基线");
  assert.equal(result.distilled.version, 2, "新草稿版本号 +1");
  assert.equal(result.distilled.status, "draft", "产出仍是待批准草稿，不会自动生效");
});
