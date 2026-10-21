import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 真实服务验收：审校回填 → 自动派生回归集 → 门禁资产口径。
 *
 * 这是**可选**的集成用例（`KAMI_ACCEPTANCE=1` 才跑），因为它需要一个可用的
 * Directus，并且要往里面写一份临时项目。跑起来的是 PORT 独立的临时实例，
 * 不依赖用户正在打开的工作台；结束时用项目级 purge 把临时数据全部删掉，
 * 并复查残留为 0。默认 `npm test` 不执行它。
 *
 * 用法：`$env:KAMI_ACCEPTANCE='1'; node --test tests/regression-import-acceptance.test.mjs`
 */
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ACCEPTANCE = process.env.KAMI_ACCEPTANCE === "1";

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

/** 本机有别的软件（QQ 等）也占着 4xxx 端口：随机挑之前先真的试听一下。 */
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

test("审校回填后自动带上改动过的段落，且没有候选时不空跑门禁", { skip: !ACCEPTANCE, timeout: 300_000 }, async () => {
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
      ["background_tasks", "project_id"], ["terms_zh_cn", "project_id"], ["term_import_batches", "project_id"], ["term_candidates", "project_id"]
    ];
    const counts = {};
    for (const [collection, field] of targets) {
      const filter = encodeURIComponent(JSON.stringify({ [field]: { _eq: projectId } }));
      const rows = await directus(`/items/${collection}?limit=-1&fields=id&filter=${filter}`);
      counts[collection] = (rows.data || []).length;
    }
    return counts;
  };

  const port = await findFreePort(4200 + Math.floor(Math.random() * 400));
  const baseUrl = `http://127.0.0.1:${port}`;
  const stamp = Date.now();
  // 验收不调用任何真实模型：给临时实例一个空的 provider 目录，
  // 「术语对齐」这类需要模型的步骤会按设计失败并降级为待审核。
  const providerDir = await mkdtemp(join(tmpdir(), "kami-acceptance-provider-"));
  // batch_runs 的主键是 uuid：拿字符串当 id 会被 Directus 直接判成非法 UUID。
  const batchId = randomUUID();
  const sources = ["浄璃の架", "星葬の玉座", "幽骨の礫"];
  const machineDrafts = ["净璃架", "星葬的玉座", "幽骨砾石"];
  const humanFinals = ["净璃之架", "星葬王座", "幽骨砾石"];

  const child = spawn(process.execPath, ["--env-file=directus/.env", "server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), KAMI_DISABLE_AUTO_SHUTDOWN: "1", KAMI_PROVIDER_DIRECTORY: providerDir },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  let projectId = "";
  let before = null;
  try {
    await waitForHealth(baseUrl, logs);
    const created = await postJson(baseUrl, "/api/projects", { name: `验收-自动回归-${stamp}` });
    projectId = created.project.id;

    // 前置状态：一条已完成的批次 + 三条机器稿轨迹，等价于"上一轮 Kami 翻完待审校"。
    // runnerOptions.termSurvey 就是"翻译期术语普查"落库后的样子，这里直接种进去。
    await postJson(baseUrl, "/api/batch/run", {
      batchId, filename: "acceptance.csv", projectId, locale: "zh-CN", contentType: "general", domain: "game",
      format: "csv", segmentationMode: "unit", runState: "completed",
      runnerOptions: {
        termSurvey: {
          version: 1,
          filename: "acceptance.csv",
          generatedAt: "2026-09-26T00:00:00.000Z",
          terms: [
            { source: "星葬の玉座", suggestedTarget: "星葬王座", reason: "地名", confidence: 0.92 },
            { source: "浄璃の架", suggestedTarget: "净璃架", reason: "地图名", confidence: 0.88 },
            { source: "存在しない語", suggestedTarget: "不存在的词", reason: "误报", confidence: 0.6 }
          ]
        }
      },
      segments: sources.map((source, index) => ({
        id: `seg-${index + 1}`, source, translation: machineDrafts[index], status: "done", selected: true, accepted: false,
        locator: {}, context: {}, result: {}
      }))
    });
    for (const [index, source] of sources.entries()) {
      await directus("/items/learning_trajectories", {
        method: "POST",
        body: JSON.stringify({
          target_locale: "zh-CN", content_type: "general", domain: "game", project: projectId,
          batch_id: batchId, segment_id: `seg-${index + 1}`, source,
          initial_translation: machineDrafts[index], final_translation: machineDrafts[index],
          human_decision: { accepted: false }, events: [], status: "completed"
        })
      });
    }
    before = await countProjectRows(projectId);

    // 审校回填：第 1、2 条大改，第 3 条与机器稿一致（不该进回归集）。
    const csv = sources.map((source, index) => `${source},${humanFinals[index]}`).join("\n");
    const body = { projectId, filename: "acceptance_reviewed.csv", base64: `data:text/csv;base64,${Buffer.from(csv, "utf8").toString("base64")}` };
    const imported = await postJson(baseUrl, `/api/batch/run/${batchId}/import-review`, body);
    assert.equal(imported.matched, 3, "三条都应命中批次段落");
    assert.equal(imported.changed, 2, "只有两条是真的改过");
    assert.equal(imported.regression?.changed, true, "回填后应自动重建回归集");
    assert.equal(imported.regression?.externalCases, 2, "两条大改进集，未改动的段落不进");

    // 术语：AI 建议的译法被人工终稿逐字保留 → 自动入库；被改掉 → 转待审；原文没出现 → 忽略。
    assert.equal(imported.termSurvey?.surveyed, 3, "普查结果三条都进入确认流程");
    assert.equal(imported.termSurvey?.autoWritten, 1, `只有终稿逐字保留的那条自动入库：${JSON.stringify(imported.termSurvey)}`);
    assert.equal(imported.termSurvey?.pendingReview, 1, `被人工改掉的那条转待审核：${JSON.stringify(imported.termSurvey)}`);
    assert.equal(imported.termSurvey?.skipped, 1, "回填段落里没出现的源词直接忽略");
    assert.ok(imported.termSurvey?.libraryName, "要写明写入了哪个术语库");
    const writtenTerms = await directus(`/items/terms_zh_cn?limit=-1&fields=id,source,target&filter=${encodeURIComponent(JSON.stringify({ _and: [{ project_id: { _eq: projectId } }, { source: { _eq: "星葬の玉座" } }] }))}`);
    assert.equal((writtenTerms.data || []).length, 1, "自动入库的术语确实落到了项目术语库");
    assert.equal(writtenTerms.data[0].target, "星葬王座");
    const pendingTasks = await (await fetch(`${baseUrl}/api/tasks?limit=100&projectId=${encodeURIComponent(projectId)}`)).json();
    const reviewTask = (Array.isArray(pendingTasks) ? pendingTasks : []).find((task) => task.projectId === projectId && task.taskType === "term_import" && task.status === "review");
    assert.ok(reviewTask, "待审核术语要在任务中心留一条可继续审核的任务");
    assert.equal(reviewTask.payload?.candidateCount, 1);

    const gate = await (await fetch(`${baseUrl}/api/quality/gate?locale=zh-CN&contentType=general&domain=game&project=${projectId}`)).json();
    assert.equal(gate.assets.regressionCaseTotal, 2);
    assert.deepEqual(gate.assets.sources, { externalReview: 2, qaApproved: 0 });
    assert.equal(gate.status, "not_run");
    assert.equal(gate.assets.coverage.valid, false);
    assert.match(gate.assets.coverage.reason, /尚未运行门禁/u);

    // 同一份文件再来一次：内容没变就不该再堆版本。
    const again = await postJson(baseUrl, `/api/batch/run/${batchId}/import-review`, body);
    assert.equal(again.regression?.changed, false, "内容未变时复用现版本");
    assert.equal(again.regression?.suiteVersion, imported.regression?.suiteVersion);

    // 没有候选技能时自动门禁必须跳过：不空跑生效版本、不留任务。
    const tasks = await (await fetch(`${baseUrl}/api/tasks?limit=100&projectId=${encodeURIComponent(projectId)}`)).json();
    // 任务列表是跨项目返回的：只看临时项目自己有没有被自动排门禁任务。
    const qualityTasks = (Array.isArray(tasks) ? tasks : []).filter((task) => task.projectId === projectId
      && (task.taskType === "quality-gate" || task.type === "quality-gate"));
    assert.equal(qualityTasks.length, 0, `没有待晋升候选时不应该自动跑门禁：${JSON.stringify(qualityTasks)}`);
    assert.equal(logs.some((line) => /UnhandledPromiseRejection/u.test(line)), false, `临时实例不应有未处理异常：${logs.join("").slice(-1000)}`);
  } finally {
    if (projectId) {
      // 项目级 purge：批次、轨迹、回归集、任务与 TM 一并对齐删除，再复查残留为 0。
      // 必须带 purge=1：不带只会把项目行从工作台移除，作用域数据会变成孤儿。
      // 也要在实例还活着的时候删：先 kill 子进程，请求会直接打不到服务。
      const purged = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(projectId)}?purge=1`, { method: "DELETE" }).then((response) => response.json()).catch(() => null);
      const after = await countProjectRows(projectId);
      assert.deepEqual(Object.values(after), Object.values(after).map(() => 0), `临时项目数据必须清干净（purge=${JSON.stringify(purged)}，before=${JSON.stringify(before)}，after=${JSON.stringify(after)}）`);
    }
    child.kill();
    await rm(providerDir, { recursive: true, force: true }).catch(() => {});
  }
});
