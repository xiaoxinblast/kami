import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { memorySourceHash } from "../src/translation-memory.mjs";

/**
 * 真实服务验收：一致性核对接证据 → 自动统一 → 复核 → 资产同步。
 *
 * 默认不跑（`KAMI_ACCEPTANCE=1` 才执行），因为需要可用的 Directus，并且要写一份临时项目。
 * 模型走本地假 OpenAI 兼容服务（临时 provider 目录 + KAMI_PROVIDER_DIRECTORY），
 * 既验证"模型只报漂移、统一值由证据定案"，又不动用户的额度与配置。
 *
 * 用法：`$env:KAMI_ACCEPTANCE='1'; node --test tests/consistency-repair-acceptance.test.mjs`
 */
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ACCEPTANCE = process.env.KAMI_ACCEPTANCE === "1";

const NAV_LONG = "MAIレポートの追加・更新を画面左上の通知のみでお知らせし、ナビマップのアイコン追加演出を省略します。";
const NAV_SHORT = "ナビゲーションマップ、共通チュートリアルスキップなどを設定します。";

/** 假模型：一致性核对第一次返回漂移报告（含一个跟术语库冲突的建议），之后返回空。 */
function startMockModel() {
  let consistencyCalls = 0;
  let revisionCalls = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { body = {}; }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = String(messages.find((message) => message.role === "system")?.content || "");
    let content = "（假模型没有可用输出）";
    if (system.includes("一致性审核员")) {
      consistencyCalls += 1;
      content = consistencyCalls === 1
        ? JSON.stringify({
          findings: [
            {
              type: "term_drift",
              ids: ["seg-1", "seg-2", "seg-3", "seg-4", "seg-5", "seg-6", "seg-7", "seg-8"],
              detail: "同一组 UI 选项在不同条目里分别译为「启用/禁用」和「开启/关闭」",
              suggestion: "统一为一套写法",
              terms: [
                { source: "有効", variants: ["启用", "开启"] },
                { source: "無効", variants: ["禁用", "关闭"] }
              ],
              // 故意给出与主 TM 冲突的一套，服务端必须按证据覆盖它。
              unify: [{ source: "有効", target: "开启" }, { source: "無効", target: "关闭" }],
              evidence: []
            },
            {
              type: "term_drift",
              ids: ["seg-10", "seg-11"],
              detail: "同一个功能在两条里分别译为「导览地图」和「导航地图」",
              suggestion: "统一为导航地图",
              terms: [{ source: "ナビマップ", variants: ["导览地图", "导航地图"] }],
              unify: [{ source: "ナビマップ", target: "导航地图" }],
              evidence: []
            }
          ]
        })
        : JSON.stringify({ findings: [] });
    } else if (system.includes("最终修订译者")) {
      revisionCalls += 1;
      content = "（假模型修订稿）";
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10 }
    }));
  });
  return { server, calls: () => ({ consistency: consistencyCalls, revision: revisionCalls }) };
}

async function readEnvFile() {
  const content = await readFile(new URL("../directus/.env", import.meta.url), "utf8").catch(() => "");
  const env = {};
  for (const line of content.split(/\r?\n/u)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line.trim());
    if (match) env[match[1]] = match[2];
  }
  return env;
}

async function waitForHealth(baseUrl, logs, deadlineMs = 90_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch { /* 还没起来 */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`临时实例未能在 ${deadlineMs / 1000} 秒内就绪；输出：${logs.join("").slice(-2000)}`);
}

async function postJson(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} 返回 ${response.status}：${payload.error || JSON.stringify(payload)}`);
  return payload;
}

async function getJson(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`);
  return response.json();
}

async function findFreePort(preferred) {
  for (let candidate = preferred; candidate < preferred + 200; candidate += 1) {
    const free = await new Promise((resolve) => {
      const probe = createNetServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(candidate, "127.0.0.1");
    });
    if (free) return candidate;
  }
  throw new Error("找不到空闲端口");
}

async function waitForRepair(baseUrl, batchId, deadlineMs = 120_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const payload = await getJson(baseUrl, `/api/batch/run/${batchId}/consistency-check`);
    if (payload?.repair) return payload;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("一致性核对没有在预期时间内写出结论");
}

test("一致性核对按术语库/主 TM 定案并自动统一，改完不留分叉", { skip: !ACCEPTANCE, timeout: 300_000 }, async () => {
  const directusEnv = await readEnvFile();
  const directusUrl = directusEnv.DIRECTUS_URL || "http://127.0.0.1:18055";
  const adminToken = directusEnv.DIRECTUS_ADMIN_TOKEN || "";
  assert.ok(adminToken, "验收需要 directus/.env 里的 DIRECTUS_ADMIN_TOKEN");
  const directus = async (path, options = {}) => {
    const response = await fetch(`${directusUrl}${path}`, {
      ...options,
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json", ...(options.headers || {}) }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Directus ${path} 返回 ${response.status}：${payload.errors?.[0]?.message || ""}`);
    return payload;
  };
  const countProjectRows = async (projectId) => {
    const targets = [
      ["batch_runs", "project_id"], ["learning_trajectories", "project"], ["quality_assets", "project"],
      ["background_tasks", "project_id"], ["terms_zh_cn", "project_id"], ["translation_memory_zh_cn", "project_id"]
    ];
    const counts = {};
    for (const [collection, field] of targets) {
      const filter = encodeURIComponent(JSON.stringify({ [field]: { _eq: projectId } }));
      const rows = await directus(`/items/${collection}?limit=-1&fields=id&filter=${filter}`);
      counts[collection] = (rows.data || []).length;
    }
    return counts;
  };

  const port = await findFreePort(4300 + Math.floor(Math.random() * 400));
  const baseUrl = `http://127.0.0.1:${port}`;
  const mock = startMockModel();
  await new Promise((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
  const mockBaseUrl = `http://127.0.0.1:${mock.server.address().port}/v1`;
  // 临时 provider 目录：不动用户的 provider.json，也不会真的调用外部模型。
  const providerDir = await mkdtemp(join(tmpdir(), "kami-consistency-provider-"));
  await writeFile(join(providerDir, "provider.json"), JSON.stringify({ baseUrl: mockBaseUrl, model: "mock-model", protocol: "openai" }), "utf8");
  const batchId = randomUUID();
  const segments = [
    { id: "seg-1", source: "有効", translation: "启用" },
    { id: "seg-2", source: "有効", translation: "启用" },
    { id: "seg-3", source: "有効", translation: "开启" },
    { id: "seg-4", source: "有効", translation: "开启" },
    { id: "seg-5", source: "無効", translation: "禁用" },
    { id: "seg-6", source: "無効", translation: "禁用" },
    { id: "seg-7", source: "無効", translation: "关闭" },
    { id: "seg-8", source: "無効", translation: "关闭" },
    { id: "seg-9", source: "セーブしますか？", translation: "要保存吗？" },
    { id: "seg-10", source: NAV_LONG, translation: "仅通过画面左上角的通知告知MAI报告的添加·更新，省略导览地图的图标添加演出。" },
    { id: "seg-11", source: NAV_SHORT, translation: "设定导航地图、跳过通用教程等内容。" }
  ].map((segment) => ({ ...segment, status: "done", selected: true, accepted: false, locator: {}, context: {}, result: {} }));

  const child = spawn(process.execPath, ["--env-file=directus/.env", "server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), KAMI_PROVIDER_DIRECTORY: providerDir },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  let projectId = "";
  let before = null;
  try {
    await waitForHealth(baseUrl, logs);
    const created = await postJson(baseUrl, "/api/projects", { name: `验收-一致性修复-${Date.now()}` });
    projectId = created.project.id;
    const libraries = created.libraries || [];
    const termLibrary = libraries.find((library) => library.kind === "term_base");
    const masterTm = libraries.find((library) => library.kind === "translation_memory" && library.role === "master");
    const workingTm = libraries.find((library) => library.kind === "translation_memory" && library.role === "working");
    assert.ok(termLibrary && masterTm && workingTm, `新项目应自带术语库与主/工作 TM：${JSON.stringify(libraries)}`);

    // 术语库：批准术语 ナビマップ → 导览地图（用来覆盖模型建议的"导航地图"）。
    await postJson(baseUrl, "/api/assets", {
      locale: "zh-CN",
      projectId,
      term: { source: "ナビマップ", target: "导览地图", status: "approved", assetTier: "formal", libraryId: termLibrary.id, domains: ["general"], contentTypes: ["general"], projectId }
    });
    // 主 TM：一条人工批准译例 無効 → 禁用（配对方案的锚点）。
    await directus("/items/translation_memory_zh_cn", {
      method: "POST",
      body: JSON.stringify({
        source: "無効", target: "禁用", source_hash: memorySourceHash("無効"),
        domain: "game", content_type: "general", quality_status: "human_approved", asset_tier: "formal",
        provenance: "acceptance-seed", project_id: projectId, library_id: masterTm.id
      })
    });
    // 工作 TM：这一批翻译留下的机器条，两条原文各有两个写法（用来验证改完不留分叉）。
    for (const [source, targets] of [["有効", ["启用", "开启"]], ["無効", ["禁用", "关闭"]]]) {
      for (const target of targets) {
        await directus("/items/translation_memory_zh_cn", {
          method: "POST",
          body: JSON.stringify({
            source, target, source_hash: memorySourceHash(source),
            domain: "game", content_type: "general", quality_status: "machine_verified", asset_tier: "working",
            provenance: "batch-working-tm", project_id: projectId, library_id: workingTm.id, batch_id: batchId
          })
        });
      }
    }
    await postJson(baseUrl, "/api/batch/run", {
      batchId, filename: "consistency-acceptance.csv", projectId, locale: "zh-CN", contentType: "general", domain: "game",
      format: "csv", segmentationMode: "unit", runState: "completed", segments
    });
    before = await countProjectRows(projectId);

    await postJson(baseUrl, `/api/batch/run/${batchId}/consistency-check`, { projectId });
    const payload = await waitForRepair(baseUrl, batchId);
    const repair = payload.repair;
    assert.equal(repair.blocked, null, `不该被阻断：${JSON.stringify(repair.blocked)}`);

    // ① 有効 组按"与权威值配对的那套写法"统一为 启用；無効 组按主 TM 人工条统一为 禁用；
    //    ナビ 组按术语库登记译法统一为 导览地图（覆盖模型建议的导航地图）。
    const changedById = new Map(repair.changed.map((change) => [change.segmentId, change]));
    assert.deepEqual([...changedById.keys()].sort(), ["seg-11", "seg-3", "seg-4", "seg-7", "seg-8"]);
    assert.equal(changedById.get("seg-3").target, "启用");
    assert.equal(changedById.get("seg-3").evidence.kind, "paired_scheme");
    assert.equal(changedById.get("seg-3").overrodeModel, true);
    assert.equal(changedById.get("seg-7").target, "禁用");
    assert.equal(changedById.get("seg-7").evidence.kind, "tm_master");
    assert.equal(changedById.get("seg-11").target, "导览地图");
    assert.equal(changedById.get("seg-11").evidence.kind, "term");
    assert.equal(changedById.get("seg-11").overrodeModel, true);
    assert.equal(mock.calls().revision, 0, "能确定性替换的段落不该再花一次修订调用");

    // ② 批次段落真的改了，而且整批只剩一种写法。
    const run = await getJson(baseUrl, `/api/batch/run/${batchId}`);
    const bySegment = new Map(run.segments.map((segment) => [segment.id, segment.translation]));
    assert.equal(bySegment.get("seg-3"), "启用");
    assert.equal(bySegment.get("seg-4"), "启用");
    assert.equal(bySegment.get("seg-7"), "禁用");
    assert.equal(bySegment.get("seg-8"), "禁用");
    assert.match(bySegment.get("seg-11"), /导览地图/u);
    assert.equal(/导航地图/u.test(bySegment.get("seg-11")), false);
    assert.equal(bySegment.get("seg-9"), "要保存吗？", "没被点到的段落不动");

    // ③ 改动所在段落带修复记录；复核跑过一次且没有剩余问题。
    assert.equal(repair.verification.checkedChunks, 1);
    assert.deepEqual(repair.verification.remaining, []);
    assert.equal(mock.calls().consistency, 2, "核对一次 + 复核一次");
    assert.equal(run.segments.find((segment) => segment.id === "seg-3").result.consistencyRepair.target, "启用");
    const repaired = payload.findings.filter((finding) => finding.repair?.status === "repaired");
    assert.ok(repaired.length >= 1, `报告里要写清哪条已自动统一：${JSON.stringify(payload.findings.map((item) => item.repair))}`);

    // ④ 工作 TM 不留分叉：同原文同批次只剩统一后的那一条；主 TM 人工条原样保留。
    const workingRows = await directus(`/items/translation_memory_zh_cn?limit=-1&fields=id,source,target,quality_status,batch_id,library_id&filter=${encodeURIComponent(JSON.stringify({ _and: [{ project_id: { _eq: projectId } }, { library_id: { _eq: workingTm.id } }] }))}`);
    const rowsFor = (source) => (workingRows.data || []).filter((row) => row.source === source);
    assert.deepEqual(rowsFor("有効").map((row) => row.target), ["启用"], "有効 只留统一后的机器条");
    assert.deepEqual(rowsFor("無効").map((row) => row.target), ["禁用"], "無効 只留统一后的机器条");
    const masterRows = await directus(`/items/translation_memory_zh_cn?limit=-1&fields=id,source,target,quality_status,library_id&filter=${encodeURIComponent(JSON.stringify({ _and: [{ project_id: { _eq: projectId } }, { library_id: { _eq: masterTm.id } }] }))}`);
    assert.equal((masterRows.data || []).length, 1, "主 TM 人工条不能被动");
    assert.equal(masterRows.data[0].quality_status, "human_approved");
    assert.equal(logs.some((line) => /UnhandledPromiseRejection/u.test(line)), false, `临时实例不应有未处理异常：${logs.join("").slice(-1000)}`);
  } finally {
    if (projectId) {
      const purged = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(projectId)}?purge=1`, { method: "DELETE" }).then((response) => response.json()).catch(() => null);
      const after = await countProjectRows(projectId);
      assert.deepEqual(Object.values(after), Object.values(after).map(() => 0), `临时项目数据必须清干净（purge=${JSON.stringify(purged)}，before=${JSON.stringify(before)}，after=${JSON.stringify(after)}）`);
    }
    child.kill();
    await rm(providerDir, { recursive: true, force: true }).catch(() => {});
    await new Promise((resolve) => mock.server.close(resolve));
  }
});
