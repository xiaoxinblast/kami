import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";

const enabled = process.env.KAMI_API_E2E === "1" && process.env.KAMI_STORE === "directus";
const appUrl = String(process.env.KAMI_APP_URL || "http://127.0.0.1:4173").replace(/\/$/, "");

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(payload)}`);
  return payload?.data ?? payload;
}

/** 库条目、编辑、删除、导出与导入目标校验的端到端用例（需要真实 Directus + 工作台）。 */
test("库页面能用：条目按库过滤、条目编辑删除、库导出、导入目标校验", { skip: !enabled, timeout: 180_000 }, async () => {
  const project = await request(`${appUrl}/api/projects`, {
    method: "POST",
    body: JSON.stringify({ name: `库接口测试 ${randomUUID().slice(0, 8)}` })
  });
  const projectId = project.project.id;
  const termLibrary = project.libraries.find((library) => library.kind === "term_base");
  const masterTm = project.libraries.find((library) => library.role === "master");
  const workingTm = project.libraries.find((library) => library.role === "working");
  try {
    // 1) 库列表统计与条目数一致
    const withStats = await request(`${appUrl}/api/projects/${encodeURIComponent(projectId)}/libraries?withStats=1`);
    assert.equal(withStats.libraries.find((library) => library.id === termLibrary.id).entryCount, 0);

    // 2) 单条术语挂到指定库，编辑后归属不变
    const term = await request(`${appUrl}/api/assets`, {
      method: "POST",
      body: JSON.stringify({
        locale: "zh-CN",
        projectId,
        term: { source: "バアル庫テスト", target: "巴尔库测试", contentTypes: ["item_name"], domains: ["game"], libraryId: termLibrary.id }
      })
    });
    assert.equal(term.libraryId, termLibrary.id);
    const patched = await request(`${appUrl}/api/assets/${encodeURIComponent(term.id)}?locale=zh-CN`, {
      method: "PATCH",
      body: JSON.stringify({ target: "巴尔库测试（改）", note: "编辑过" })
    });
    assert.equal(patched.libraryId, termLibrary.id, "编辑术语不得改动库归属");
    assert.equal(patched.note, "编辑过");

    const termEntries = await request(`${appUrl}/api/library-entries?locale=zh-CN&kind=term&projectId=${encodeURIComponent(projectId)}&libraryId=${encodeURIComponent(termLibrary.id)}&limit=50`);
    assert.equal(termEntries.total, 1);
    assert.equal(termEntries.items[0].target, "巴尔库测试（改）");

    // 3) TM 条目写入指定库后可以按库查、编辑、删除
    await request(`${appUrl}/api/tm-import/commit`, {
      method: "POST",
      body: JSON.stringify({
        batchId: randomUUID(),
        projectId,
        filename: "库接口测试.xlsx",
        styleEvidence: false,
        tmLibraryId: masterTm.id,
        candidates: [{ source: "メンテナンスは明日開始します。", target: "维护明天开始。", locale: "zh-CN", assetType: "memory", selected: true }]
      })
    });
    const tmEntries = await request(`${appUrl}/api/library-entries?locale=zh-CN&kind=tm&projectId=${encodeURIComponent(projectId)}&libraryId=${encodeURIComponent(masterTm.id)}&limit=50`);
    assert.equal(tmEntries.total, 1);
    assert.equal(tmEntries.items[0].libraryId, masterTm.id);
    const memoryId = tmEntries.items[0].id;
    const updated = await request(`${appUrl}/api/memories/${encodeURIComponent(memoryId)}?locale=zh-CN`, {
      method: "PATCH",
      body: JSON.stringify({ target: "维护将于明天开始。" })
    });
    assert.equal(updated.memory.target, "维护将于明天开始。");
    assert.equal(updated.memory.libraryId, masterTm.id);
    await request(`${appUrl}/api/memories/${encodeURIComponent(memoryId)}?locale=zh-CN`, { method: "DELETE" });
    const afterDelete = await request(`${appUrl}/api/library-entries?locale=zh-CN&kind=tm&projectId=${encodeURIComponent(projectId)}&libraryId=${encodeURIComponent(masterTm.id)}&limit=50`);
    assert.equal(afterDelete.total, 0);

    // 4) 库导出：后台任务 → 下载 Excel → 列头与条目数正确
    const exportStarted = await request(`${appUrl}/api/library-export`, {
      method: "POST",
      body: JSON.stringify({ locale: "zh-CN", projectId, kind: "term", libraryId: termLibrary.id })
    });
    const deadline = Date.now() + 60_000;
    let task = null;
    while (Date.now() < deadline) {
      task = await request(`${appUrl}/api/background-tasks/${encodeURIComponent(exportStarted.taskId)}`);
      if (["completed", "failed"].includes(task.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    assert.equal(task?.status, "completed", `库导出应跑完：${JSON.stringify(task?.progress || {})}`);
    assert.equal(task.payload.kind, "library_export");
    assert.equal(task.payload.libraryId, termLibrary.id);
    assert.equal(task.payload.count, 1);
    const download = await fetch(`${appUrl}${task.payload.downloadUrl}`);
    assert.equal(download.status, 200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await download.arrayBuffer()));
    const sheet = workbook.worksheets[0];
    assert.deepEqual(sheet.getRow(1).values.slice(1), ["日语原文", "简体中文译法", "别名", "禁用译法", "注释", "语体", "强制级别", "来源", "更新时间"]);
    assert.equal(sheet.getRow(2).getCell(1).value, "バアル庫テスト");
    assert.equal(sheet.getRow(2).getCell(2).value, "巴尔库测试（改）");
    await request(`${appUrl}/api/background-tasks/${encodeURIComponent(exportStarted.taskId)}`, { method: "DELETE" });

    // 5) 导入目标校验：类型不匹配 / 未启用 / 跨项目一律 400，而不是悄悄写进别的库
    const badKind = await fetch(`${appUrl}/api/assets-import/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, batchId: randomUUID(), purpose: "term", termLibraryId: masterTm.id, candidates: [{ source: "a", target: "b", locale: "zh-CN", selected: true }] })
    });
    assert.equal(badKind.status, 400, "术语导入不能写到 TM 库");
    assert.match((await badKind.json()).error, /不是术语库/u);

    await request(`${appUrl}/api/projects/${encodeURIComponent(projectId)}/libraries/${encodeURIComponent(workingTm.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false })
    });
    const disabled = await fetch(`${appUrl}/api/assets-import/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, batchId: randomUUID(), purpose: "tm", tmLibraryId: workingTm.id, candidates: [{ source: "a", target: "b", locale: "zh-CN", selected: true }] })
    });
    assert.equal(disabled.status, 400, "未启用的库不能作为导入目标");
    assert.match((await disabled.json()).error, /未启用/u);

    const crossProject = await fetch(`${appUrl}/api/assets-import/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, batchId: randomUUID(), purpose: "term", termLibraryId: randomUUID(), candidates: [{ source: "a", target: "b", locale: "zh-CN", selected: true }] })
    });
    assert.equal(crossProject.status, 400, "不属于本项目的库不能作为目标");
  } finally {
    await request(`${appUrl}/api/projects/${encodeURIComponent(projectId)}?purge=1`, { method: "DELETE" });
  }
});
