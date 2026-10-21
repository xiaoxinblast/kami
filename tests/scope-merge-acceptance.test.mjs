import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 真实服务验收：语体/领域降级为参考之后
 *   ① 两个旧范围（general/game 与 ui/game）的技能与资产合流成一条项目级流水线，生效版本唯一；
 *   ② 规则冲突审查按项目比对四方（人工指南 > 蒸馏规范 > 技能规则 > 译者画像），
 *      并给出可执行动作：退休蒸馏规则 / 停用未生效候选技能；
 *   ③ 停用候选后它退出候选列表。
 *
 * 可选集成用例（`KAMI_ACCEPTANCE=1`），模型走本地假服务，数据落在临时项目里，跑完 purge 复查为 0。
 */
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ACCEPTANCE = process.env.KAMI_ACCEPTANCE === "1";

function startMockModel() {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { body = {}; }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = String(messages.find((message) => message.role === "system")?.content || "");
    const user = String(messages.find((message) => message.role === "user")?.content || "");
    let content = "{}";
    if (system.includes("一致性审查员") || system.includes("规则冲突")) {
      // 把所有候选对都判为冲突：真实模型不会这么激进，但验收要覆盖每条动作分支。
      let pairs = [];
      try { pairs = JSON.parse(user).pairs || []; } catch { pairs = []; }
      content = JSON.stringify({
        verdicts: pairs.map((_, index) => ({
          index,
          conflict: true,
          situation: "同一句既要简体句尾又要敬体句尾",
          recommendation: "保留优先级更高的一条"
        }))
      });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10 }
    }));
  });
  return server;
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

test("语体/领域合流：项目级流水线 + 四方冲突审查 + 停用候选", { skip: !ACCEPTANCE, timeout: 300_000 }, async () => {
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
    const targets = [["translation_skills", "project"], ["style_profiles", "project_id"], ["user_profiles", "project_id"], ["quality_assets", "project"], ["background_tasks", "project_id"]];
    const counts = {};
    for (const [collection, field] of targets) {
      const filter = encodeURIComponent(JSON.stringify({ [field]: { _eq: projectId } }));
      const rows = await directus(`/items/${collection}?limit=-1&fields=id&filter=${filter}`);
      counts[collection] = (rows.data || []).length;
    }
    return counts;
  };
  const scopeKey = (locale, project) => createHash("sha256").update([locale, project].join("\u0000")).digest("hex");

  const port = await findFreePort(4400 + Math.floor(Math.random() * 400));
  const baseUrl = `http://127.0.0.1:${port}`;
  const mock = startMockModel();
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const providerDir = await mkdtemp(join(tmpdir(), "kami-scope-provider-"));
  await writeFile(join(providerDir, "provider.json"), JSON.stringify({ baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model: "mock-model", protocol: "openai" }), "utf8");
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
    const created = await postJson(baseUrl, "/api/projects", { name: `验收-范围合流-${Date.now()}` });
    projectId = created.project.id;
    const hash = scopeKey("zh-CN", projectId);

    // 人工风格指南（priority 0）：导入即 active。
    await postJson(baseUrl, "/api/style-guides/import", {
      locale: "zh-CN",
      projectId,
      filename: "guide.txt",
      base64: `data:text/plain;base64,${Buffer.from("句尾统一用简体。\n不要使用「您」。", "utf8").toString("base64")}`
    });
    // 蒸馏规范（priority 1）：与人工指南在「句尾」上冲突。
    await directus("/items/style_profiles", {
      method: "POST",
      body: JSON.stringify({
        project_id: projectId, target_locale: "zh-CN", name: "蒸馏规范 v1", domain: "general", content_type: "general",
        instructions: "句尾统一使用敬体ます形", version: 1, status: "active", evidence_count: 520,
        rules: [{ id: "r1", category: "语气", rule: "句尾统一使用敬体ます形", evidenceCount: 520, rounds: 6, status: "active" }]
      })
    });
    const strategy = { prompting: { additionalRules: [] } };
    // 两个旧范围各自的生效版本（champion）+ 一个候选：合流后必须只剩一个 champion。
    const champions = [];
    for (const [contentType, domain, version, rule] of [["general", "game", 1, "句尾一律改用だ・である体"], ["ui", "game", 2, "按钮文案省略句号"]]) {
      const saved = await directus("/items/translation_skills", {
        method: "POST",
        body: JSON.stringify({
          target_locale: "zh-CN", content_type: contentType, domain, project: projectId,
          name: `${contentType} 生效版本 v${version}`, status: "champion", version,
          strategy: { ...strategy, prompting: { additionalRules: [rule] } }, evidence_ids: [], metrics: {}, metadata: {},
          // 模拟历史数据：两个旧范围各有一个 champion，champion_scope_key 留空（项目级唯一键由后续晋升写入）。
          champion_scope_key: null, version_scope_key: createHash("sha256").update(`${hash}\u0000${version}`).digest("hex")
        })
      });
      champions.push(saved.data);
    }
    const candidate = (await directus("/items/translation_skills", {
      method: "POST",
      body: JSON.stringify({
        target_locale: "zh-CN", content_type: "general", domain: "game", project: projectId,
        name: "候选 v9", status: "challenger", version: 9,
        strategy: { ...strategy, prompting: { additionalRules: ["对白避免使用敬体，保持常体口吻"] } },
        evidence_ids: [], metrics: {}, metadata: {},
        version_scope_key: createHash("sha256").update(`${hash}\u0000${9}`).digest("hex")
      })
    })).data;
    before = await countProjectRows(projectId);

    // ① 项目级总览：一条流水线看到两个旧范围的技能，生效版本取最新那个。
    const overview = await (await fetch(`${baseUrl}/api/learning/overview?locale=zh-CN&project=${encodeURIComponent(projectId)}`)).json();
    assert.equal(overview.scopes.length, 1, "总览只有项目级一条");
    assert.equal(overview.scopes[0].champion.version, 2, "生效版本取项目内最新的 champion");
    assert.equal(overview.scopes[0].candidateCount, 1);
    assert.equal(overview.scopes[0].scope.contentType, "general");
    assert.equal(overview.scopes[0].scope.domain, "general");

    // ② 冲突审查：四方来源都参与，人工指南优先，候选技能可一键停用。
    const report = await postJson(baseUrl, "/api/learning/conflict-scan", { locale: "zh-CN", project: projectId });
    assert.ok(report.sources.guide >= 1, `人工指南要参与比对：${JSON.stringify(report.sources)}`);
    assert.ok(report.sources.style >= 1, "蒸馏规范要参与比对");
    assert.ok(report.sources.skills.length >= 2, "全部技能版本都要参与比对");
    assert.ok(report.conflicts.some((conflict) => conflict.action === "retire-style-rule"), "人工指南赢时要能退休蒸馏规则");
    const disableConflict = report.conflicts.find((conflict) => conflict.action === "disable-skill");
    assert.ok(disableConflict, `候选技能冲突要给出停用动作：${JSON.stringify(report.conflicts.map((item) => item.action))}`);
    assert.equal(disableConflict.skillId, candidate.id);
    assert.equal(
      report.conflicts.filter((conflict) => conflict.action === "review").length > 0,
      true,
      "生效版本的技能冲突只出结论、不自动处置"
    );

    // ③ 停用候选：状态转 inactive，且退出候选列表。
    const disabled = await postJson(baseUrl, `/api/learning/skills/${encodeURIComponent(candidate.id)}/disable`, {});
    assert.equal(disabled.skill.status, "inactive");
    const after = await (await fetch(`${baseUrl}/api/learning/overview?locale=zh-CN&project=${encodeURIComponent(projectId)}`)).json();
    assert.equal(after.scopes[0].candidateCount, 0, "停用后不再是候选");
    // 生效版本不能被停用。
    const blocked = await fetch(`${baseUrl}/api/learning/skills/${encodeURIComponent(champions[1].id)}/disable`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    });
    assert.equal(blocked.status, 409, "生效版本只能走回滚或新候选");
    assert.equal(logs.some((line) => /UnhandledPromiseRejection/u.test(line)), false, `临时实例不应有未处理异常：${logs.join("").slice(-1000)}`);
  } finally {
    if (projectId) {
      const purged = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(projectId)}?purge=1`, { method: "DELETE" }).then((response) => response.json()).catch(() => null);
      const after = await countProjectRows(projectId);
      assert.deepEqual(Object.values(after), Object.values(after).map(() => 0), `临时项目数据必须清干净（purge=${JSON.stringify(purged)}，before=${JSON.stringify(before)}，after=${JSON.stringify(after)}）`);
    }
    child.kill();
    await rm(providerDir, { recursive: true, force: true }).catch(() => {});
    await new Promise((resolve) => mock.close(resolve));
  }
});
