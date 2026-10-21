import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer } from "node:net";
import ExcelJS from "exceljs";

/**
 * 真机验收（`KAMI_ACCEPTANCE=1` + `--env-file=directus/.env`）：TM 导入队列后置。
 *
 *   ① 成功导入：任务 completed → 审计批次行 + 精简候选行（终态）→ 预检缓存删除；
 *   ② 中途中断：任务 needs_attention、库里没有审计行、缓存保留；
 *      用同一个批次号续跑能补完（记忆按原文去重，不会写重）；
 *   ③ 证据分层取样：池子里有一条人工采纳 + 一大批表格证据时，取样必须包含人工采纳。
 */
const ACCEPTANCE = process.env.KAMI_ACCEPTANCE === "1";
const ROOT = fileURLToPath(new URL("../", import.meta.url));

function findFreePort(start) {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once("error", () => resolve(findFreePort(start + 1)));
    probe.listen(start, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, logs) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`工作台没有在 30 秒内就绪：${logs.join("").slice(-800)}`);
}

async function postJson(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}：${payload.error || ""}`);
  return payload;
}

async function waitTask(baseUrl, taskId, { timeoutMs = 300_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await fetch(`${baseUrl}/api/background-tasks/${encodeURIComponent(taskId)}`).then((response) => response.json()).catch(() => null);
    if (task && ["completed", "failed", "needs_attention"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("后台任务没有在超时前结束");
}

async function buildWorkbookBase64(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("sheet");
  sheet.addRow(["ID", "日本語", "简体中文"]);
  for (let index = 0; index < rows; index += 1) {
    sheet.addRow([
      `[0][${index + 1}]`,
      `セリフ${index + 1}：验收用的日语原文，长度足够进入翻译记忆。`,
      `台词${index + 1}：验收用的中文译文，长度足够进入翻译记忆。`
    ]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64");
}

/** 直接数 Directus 里的行（验收断言用，只读）。 */
async function countDirectus(collection, filter) {
  const params = new URLSearchParams({ limit: "-1", fields: "id", filter: JSON.stringify(filter) });
  const response = await fetch(`${process.env.DIRECTUS_URL || "http://127.0.0.1:18055"}/items/${collection}?${params}`, {
    headers: { authorization: `Bearer ${process.env.DIRECTUS_TOKEN}` }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Directus ${collection} 查询失败：${response.status}`);
  return (payload.data || []).length;
}

test("TM 导入队列后置：成功写审计、中断零残留且可续跑、证据分层取样", { skip: !ACCEPTANCE, timeout: 900_000 }, async () => {
  assert.ok(process.env.DIRECTUS_TOKEN, "验收需要用 --env-file=directus/.env 启动");
  process.env.KAMI_STORE = "directus";
  const store = await import("../src/store.mjs");

  const providerDir = await mkdtemp(join(tmpdir(), "kami-queue-pos-provider-"));
  await writeFile(join(providerDir, "provider.json"), JSON.stringify({ baseUrl: "http://127.0.0.1:9/v1", model: "offline", protocol: "openai" }), "utf8");
  const port = await findFreePort(4700 + Math.floor(Math.random() * 200));
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--env-file=directus/.env", "server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), KAMI_PROVIDER_DIRECTORY: providerDir },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  const projectIds = [];
  try {
    await waitForHealth(baseUrl, logs);

    // ① 成功路径：300 条，主 TM 就绪
    const projectA = await store.saveProject({ name: `验收-队列后置-成功-${Date.now()}` });
    projectIds.push(projectA.id);
    await store.saveResourceLibrary({ projectId: projectA.id, name: "主 TM", kind: "translation_memory", role: "master", enabled: true, priority: 1 });
    const workbook = await buildWorkbookBase64(300);
    const preview = await postJson(baseUrl, "/api/tm-import/preview", {
      projectId: projectA.id,
      filename: "验收-队列后置.xlsx",
      files: [{ filename: "验收-队列后置.xlsx", base64: workbook }]
    });
    assert.equal(preview.total, 300);
    const started = await postJson(baseUrl, "/api/tm-import/commit", {
      projectId: projectA.id,
      batches: [{ batchId: preview.batchId, filename: "验收-队列后置.xlsx" }],
      styleEvidence: false,
      background: true
    });
    const task = await waitTask(baseUrl, started.taskId);
    assert.equal(task.status, "completed", `任务应完成：${JSON.stringify(task.progress)}`);
    assert.equal(await store.countMemories("zh-CN", { projectId: projectA.id }), 300);
    const audit = await store.getImportPreview(preview.batchId);
    assert.ok(audit, "成功后要有审计批次行");
    assert.equal(audit.status, "completed");
    assert.equal(audit.candidates.length, 300);
    assert.ok(audit.candidates.every((row) => row.status === "accepted"), "全部写入的记忆应是 accepted");
    assert.equal((await fetch(`${baseUrl}/api/tm-import/preview/${preview.batchId}`)).status, 404, "成功后预检缓存要删掉");

    // ①' 同一个文件再导入一次：记忆不翻倍、审计只留最新一批
    const previewAgain = await postJson(baseUrl, "/api/tm-import/preview", {
      projectId: projectA.id,
      filename: "验收-队列后置.xlsx",
      files: [{ filename: "验收-队列后置.xlsx", base64: workbook }]
    });
    const startedAgain = await postJson(baseUrl, "/api/tm-import/commit", {
      projectId: projectA.id,
      batches: [{ batchId: previewAgain.batchId, filename: "验收-队列后置.xlsx" }],
      styleEvidence: false,
      background: true
    });
    assert.equal((await waitTask(baseUrl, startedAgain.taskId)).status, "completed");
    assert.equal(await store.countMemories("zh-CN", { projectId: projectA.id }), 300, "重复导入同一文件不能把 TM 写重");
    assert.equal(await countDirectus("term_import_batches", { project_id: { _eq: projectA.id } }), 1, "同项目 + 同文件名只留最新一批审计");
    assert.equal(await countDirectus("term_candidates", { project_id: { _eq: projectA.id } }), 300, "上一批候选行要被替换掉，而不是再堆 300 行");
    assert.equal(await store.getImportPreview(preview.batchId), null, "旧批次审计要被删除");
    assert.ok(await store.getImportPreview(previewAgain.batchId), "最新批次审计要在");

    // ② 中断路径：3,000 条导入中途取消
    const projectB = await store.saveProject({ name: `验收-队列后置-中断-${Date.now()}` });
    projectIds.push(projectB.id);
    await store.saveResourceLibrary({ projectId: projectB.id, name: "主 TM", kind: "translation_memory", role: "master", enabled: true, priority: 1 });
    const bigWorkbook = await buildWorkbookBase64(3_000);
    const previewB = await postJson(baseUrl, "/api/tm-import/preview", {
      projectId: projectB.id,
      filename: "验收-队列后置-中断.xlsx",
      files: [{ filename: "验收-队列后置-中断.xlsx", base64: bigWorkbook }]
    });
    assert.equal(previewB.total, 3_000);
    const startedB = await postJson(baseUrl, "/api/tm-import/commit", {
      projectId: projectB.id,
      batches: [{ batchId: previewB.batchId, filename: "验收-队列后置-中断.xlsx" }],
      styleEvidence: false,
      background: true
    });
    // 等它真的开始写（进度 > 0）再中断，模拟"跑到一半服务被打断"。
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const current = await fetch(`${baseUrl}/api/background-tasks/${encodeURIComponent(startedB.taskId)}`).then((response) => response.json()).catch(() => null);
      if (Number(current?.progress?.completed) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await postJson(baseUrl, `/api/background-tasks/${encodeURIComponent(startedB.taskId)}/cancel`, {});
    const cancelled = await waitTask(baseUrl, startedB.taskId);
    assert.equal(cancelled.status, "needs_attention");
    assert.equal(cancelled.payload?.resumable, true, "中断的任务要标成可续传");
    assert.equal(await store.getImportPreview(previewB.batchId), null, "中断时不该写审计批次行");
    const partial = await store.countMemories("zh-CN", { projectId: projectB.id });
    assert.ok(partial > 0 && partial < 3_000, `中断时应只写了一部分（实际 ${partial}）`);
    assert.equal((await fetch(`${baseUrl}/api/tm-import/preview/${previewB.batchId}`)).status, 200, "中断后预检缓存要保留");

    // 续跑：只带批次号，候选从预检缓存读回来；已写入的行按原文去重。
    const resumed = await postJson(baseUrl, "/api/tm-import/commit", {
      projectId: projectB.id,
      batchId: previewB.batchId,
      styleEvidence: false,
      background: true
    });
    const resumedTask = await waitTask(baseUrl, resumed.taskId);
    assert.equal(resumedTask.status, "completed", `续跑应完成：${JSON.stringify(resumedTask.progress)}`);
    assert.equal(await store.countMemories("zh-CN", { projectId: projectB.id }), 3_000, "续跑不能写重也不能漏");
    const auditB = await store.getImportPreview(previewB.batchId);
    assert.equal(auditB.candidates.length, 3_000);
    assert.equal((await fetch(`${baseUrl}/api/tm-import/preview/${previewB.batchId}`)).status, 404, "续跑成功后缓存也要删掉");

    // ③ 证据分层取样：人工采纳 + 一批表格证据
    const projectC = await store.saveProject({ name: `验收-分层取样-${Date.now()}` });
    projectIds.push(projectC.id);
    await store.saveResourceLibrary({ projectId: projectC.id, name: "主 TM", kind: "translation_memory", role: "master", enabled: true, priority: 1 });
    const humanEvidence = await store.saveStyleEvidence({
      locale: "zh-CN",
      projectId: projectC.id,
      source: "人工采纳的验收原文",
      target: "人工采纳的验收译文",
      contentType: "dialogue",
      domain: "general",
      provenance: "human-accept"
    });
    const previewC = await postJson(baseUrl, "/api/tm-import/preview", {
      projectId: projectC.id,
      filename: "验收-分层取样.xlsx",
      files: [{ filename: "验收-分层取样.xlsx", base64: await buildWorkbookBase64(300) }]
    });
    const startedC = await postJson(baseUrl, "/api/tm-import/commit", {
      projectId: projectC.id,
      batches: [{ batchId: previewC.batchId, filename: "验收-分层取样.xlsx" }],
      styleEvidence: true,
      background: true
    });
    assert.equal((await waitTask(baseUrl, startedC.taskId)).status, "completed");
    // 300 条表格证据必须真的落库（旧实现一次请求塞 7 万行会超时、整批失败）。
    assert.equal(await countDirectus("style_evidence", { project_id: { _eq: projectC.id } }), 301, "1 条人工采纳 + 300 条导入证据");
    const sampled = await store.sampleStyleEvidence("zh-CN", { projectId: projectC.id, limit: 12, positiveOnly: true });
    assert.equal(sampled.length, 12);
    assert.ok(sampled.some((item) => item.id === humanEvidence.id), "人工采纳证据必须进取样（旧实现只看最新 1000 条，会被表格证据挤掉）");
  } finally {
    for (const projectId of projectIds) {
      await fetch(`${baseUrl}/api/projects/${encodeURIComponent(projectId)}?purge=1`, { method: "DELETE" }).catch(() => {});
    }
    const leftovers = await Promise.all(projectIds.map((projectId) => store.countMemories("zh-CN", { projectId }).catch(() => 0)));
    assert.deepEqual(leftovers, projectIds.map(() => 0), "临时项目清理后记忆残留必须为 0");
    assert.equal(logs.some((line) => /UnhandledPromiseRejection/u.test(line)), false, `临时实例不应有未处理异常：${logs.join("").slice(-1000)}`);
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(providerDir, { recursive: true, force: true });
  }
});
