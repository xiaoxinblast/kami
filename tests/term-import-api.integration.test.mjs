import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";

const enabled = process.env.KAMI_API_E2E === "1" && process.env.KAMI_STORE === "directus";
const appUrl = String(process.env.KAMI_APP_URL || "http://127.0.0.1:4173").replace(/\/$/, "");
const directusUrl = String(process.env.DIRECTUS_URL || "http://127.0.0.1:18055").replace(/\/$/, "");

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const payload = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(payload)}`);
  return payload?.data ?? payload;
}

test("日中术语表预览、入库与清理形成完整闭环", { skip: !enabled }, async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("术语表");
  sheet.addRows([
    ["日语", "简体中文"],
    ["スターライトバッジテスト", "星辉徽章测试"]
  ]);
  const progressId = randomUUID();
  const preview = await request(`${appUrl}/api/term-import/preview`, {
    method: "POST",
    body: JSON.stringify({ filename: "术语闭环测试.xlsx", locale: "auto", useModel: false, progressId, base64: Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64") })
  });
  const imported = [];
  try {
    const progress = await request(`${appUrl}/api/term-import/progress/${progressId}`);
    assert.equal(progress.status, "completed");
    assert.equal(progress.percent, 100);
    assert.equal(preview.candidates.length, 1);
    assert.deepEqual(new Set(preview.candidates.map((item) => item.locale)), new Set(["zh-CN"]));
    const committed = await request(`${appUrl}/api/term-import/commit`, {
      method: "POST",
      body: JSON.stringify({
        batchId: preview.batchId,
        filename: preview.filename,
        domain: "test",
        contentType: "item_name",
        enforcement: "required",
        candidates: preview.candidates.map((candidate) => ({ ...candidate, selected: true }))
      })
    });
    imported.push(...committed.imported);
    assert.equal(committed.imported.length, 1);
    for (const item of imported) {
      const assets = await request(`${appUrl}/api/assets?locale=${encodeURIComponent(item.locale)}`);
      assert.ok(assets.terms.some((term) => term.id === item.id));
      assert.equal(assets.terms.some((term) => term.source === item.source && term.target !== item.target), false);
    }
  } finally {
    for (const item of imported) await request(`${appUrl}/api/assets/${item.id}?locale=${encodeURIComponent(item.locale)}`, { method: "DELETE" });
    const adminHeaders = { Authorization: `Bearer ${process.env.DIRECTUS_ADMIN_TOKEN}` };
    const candidateIds = preview.candidates.map((item) => item.candidateId).filter(Boolean);
    if (candidateIds.length) await request(`${directusUrl}/items/term_candidates`, { method: "DELETE", headers: adminHeaders, body: JSON.stringify(candidateIds) });
    await request(`${directusUrl}/items/term_import_batches/${preview.batchId}`, { method: "DELETE", headers: adminHeaders });
  }
});

test("单条新增术语会挂到项目术语库，列表里立刻能搜到", { skip: !enabled }, async () => {
  // 术语列表与模型参考只认"项目里启用的术语库"的条目。过去单条新增不写
  // library_id，保存成功后既不在列表里、也不参与翻译，用户以为没存进去。
  const project = await request(`${appUrl}/api/projects`, {
    method: "POST",
    body: JSON.stringify({ name: `单条术语归属测试 ${randomUUID().slice(0, 8)}` })
  });
  try {
    const source = `バアル归属测试${randomUUID().slice(0, 6)}`;
    const saved = await request(`${appUrl}/api/assets`, {
      method: "POST",
      body: JSON.stringify({
        locale: "zh-CN",
        projectId: project.project.id,
        term: { source, target: "巴尔归属测试", contentTypes: ["item_name"], domains: ["game"], enforcement: "preferred" }
      })
    });
    assert.ok(saved.libraryId, "新增单条术语必须带上项目术语库的 libraryId");
    const listed = await request(`${appUrl}/api/assets?locale=zh-CN&projectId=${encodeURIComponent(project.project.id)}`);
    const hit = listed.terms.find((term) => term.id === saved.id);
    assert.ok(hit, "刚保存的术语要出现在同一个项目的术语列表里");
    assert.equal(hit.source, source);
    assert.equal(hit.libraryId, saved.libraryId);
  } finally {
    await request(`${appUrl}/api/projects/${encodeURIComponent(project.project.id)}?purge=1`, { method: "DELETE" });
  }
});

test("Directus 候选审核队列接受超过 255 字符的日中句段", { skip: !enabled }, async () => {
  const adminHeaders = { Authorization: `Bearer ${process.env.DIRECTUS_ADMIN_TOKEN}` };
  const longSource = "長文候補です。".repeat(60);
  const longTarget = "简体中文长句候选。".repeat(60);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("长句候选");
  sheet.addRows([["日语", "简体中文"], [longSource, longTarget]]);
  const preview = await request(`${appUrl}/api/term-import/preview`, {
    method: "POST",
    body: JSON.stringify({
      filename: "长句候选容量测试.xlsx",
      locale: "zh-CN",
      useModel: false,
      base64: Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64")
    })
  });
  try {
    assert.equal(preview.candidates.length, 1);
    assert.equal(preview.candidates[0].source.length, longSource.length);
    assert.equal(preview.candidates[0].target.length, longTarget.length);
  } finally {
    const candidateIds = preview.candidates.map((item) => item.candidateId).filter(Boolean);
    if (candidateIds.length) await request(`${directusUrl}/items/term_candidates`, { method: "DELETE", headers: adminHeaders, body: JSON.stringify(candidateIds) });
    await request(`${directusUrl}/items/term_import_batches/${preview.batchId}`, { method: "DELETE", headers: adminHeaders });
  }
});

test("双语资产导入预检就比对库内术语：已存在与冲突分开计数", { skip: !enabled }, async () => {
  const project = await request(`${appUrl}/api/projects`, {
    method: "POST",
    body: JSON.stringify({ name: `双语预检查重测试 ${randomUUID().slice(0, 8)}` })
  });
  const projectId = project.project.id;
  try {
    const suffix = randomUUID().slice(0, 4);
    const knownSource = `本体${suffix}`;
    const knownAlias = `別名${suffix}`;
    await request(`${appUrl}/api/assets`, {
      method: "POST",
      body: JSON.stringify({
        locale: "zh-CN",
        projectId,
        term: {
          source: knownSource, target: "巴尔预检", aliases: [knownAlias],
          contentTypes: ["item_name"], domains: ["game"], enforcement: "preferred"
        }
      })
    });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("术语表");
    sheet.addRows([
      ["日语", "简体中文"],
      [knownSource, "巴尔预检"],
      [knownSource, "巴尔预检改"],
      [knownAlias, "巴尔别名改"],
      [`新規${suffix}`, "巴尔新规"]
    ]);
    const preview = await request(`${appUrl}/api/assets-import/preview`, {
      method: "POST",
      body: JSON.stringify({
        projectId,
        locale: "zh-CN",
        purpose: "term",
        files: [{ filename: "预检查重.xlsx", base64: Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64") }]
      })
    });
    assert.equal(preview.statistics.entries, 4);
    assert.deepEqual(preview.duplicates, { existing: 1, conflict: 2 }, "预检要分别报出已存在与冲突的条数");
    const byTarget = new Map(preview.candidates.map((candidate) => [candidate.target, candidate]));
    assert.equal(byTarget.get("巴尔预检").existing, true);
    assert.equal(byTarget.get("巴尔预检改").conflict, true);
    assert.equal(byTarget.get("巴尔预检改").existingTarget, "巴尔预检");
    assert.equal(byTarget.get("巴尔别名改").conflict, true, "库内条目的别名命中同样算重复");
    assert.equal(byTarget.get("巴尔新规").existing, undefined);
    // 入库阶段的口径必须和预检一致：重复跳过、只有新条目写进术语库。
    const started = await request(`${appUrl}/api/assets-import/commit`, {
      method: "POST",
      body: JSON.stringify({
        projectId, batchId: preview.batchId, filename: "预检查重.xlsx",
        candidates: preview.candidates, purpose: "term", aiCleaning: false, styleEvidence: false
      })
    });
    assert.ok(started.taskId, "双语资产导入要转成后台任务");
    const deadline = Date.now() + 90_000;
    let task = null;
    while (Date.now() < deadline) {
      task = await request(`${appUrl}/api/background-tasks/${encodeURIComponent(started.taskId)}`);
      if (["completed", "failed", "needs_attention"].includes(task.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(task?.status, "completed", `后台导入应跑完：${JSON.stringify(task?.progress || {})}`);
    assert.equal(task.payload?.summary?.terms, 1);
    assert.equal(task.payload?.summary?.skippedByReason?.["已存在"], 1);
    assert.equal(task.payload?.summary?.skippedByReason?.["库内已有译法：巴尔预检"], 2, "冲突行要按「库内已有译法」跳过，而不是覆盖或新增");
  } finally {
    await request(`${appUrl}/api/projects/${encodeURIComponent(projectId)}?purge=1`, { method: "DELETE" });
  }
});
