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
    assert.equal(tmEntries.items[0].sourceFile, "库接口测试.xlsx", "条目要记住来自哪个翻译文件");
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

    // 3b) 库 → 文件 → 条目：同一个库里按翻译文件分开，导出/清理都能只针对某个文件
    const commitTm = (filename, candidates) => request(`${appUrl}/api/tm-import/commit`, {
      method: "POST",
      body: JSON.stringify({ batchId: randomUUID(), projectId, filename, styleEvidence: false, tmLibraryId: masterTm.id, candidates })
    });
    await commitTm("Asia_batch18_new.xlsx_zho-CN.mqxliff", [
      { source: "崩兆の片", target: "崩兆碎片", locale: "zh-CN", assetType: "memory", selected: true },
      { source: "幽骨の礫", target: "幽骨砾石", locale: "zh-CN", assetType: "memory", selected: true }
    ]);
    await commitTm("Trophy.xlsx_zho-CN.mqxliff", [
      { source: "トロフィー", target: "奖杯", locale: "zh-CN", assetType: "memory", selected: true }
    ]);
    const files = await request(`${appUrl}/api/library-files?locale=zh-CN&projectId=${encodeURIComponent(projectId)}&libraryId=${encodeURIComponent(masterTm.id)}`);
    assert.equal(files.files.length, 2, "两个翻译文件应该分成两组");
    const batch18 = files.files.find((file) => file.sourceFile === "Asia_batch18_new.xlsx_zho-CN.mqxliff");
    assert.equal(batch18.entryCount, 2);
    assert.ok(batch18.batchId, "文件组要带上它来自哪个批次");
    // 文件层还要回答两件事：这个文件翻到哪一步、有没有学习轨迹（人工终稿就写在轨迹里）。
    assert.equal(batch18.batch, null, "双语资产导入的条目没有对应翻译批次");
    assert.deepEqual(batch18.learning, { count: 0, humanReviewed: 0 }, "文件层要带上按文件分桶的轨迹统计");
    const scopedEntries = await request(`${appUrl}/api/library-entries?locale=zh-CN&kind=tm&projectId=${encodeURIComponent(projectId)}&libraryId=${encodeURIComponent(masterTm.id)}&sourceFile=${encodeURIComponent("Asia_batch18_new.xlsx_zho-CN.mqxliff")}&limit=50`);
    assert.equal(scopedEntries.total, 2, "只取这个文件的条目");

    const fileExport = await request(`${appUrl}/api/library-export`, {
      method: "POST",
      body: JSON.stringify({ locale: "zh-CN", projectId, kind: "tm", libraryId: masterTm.id, sourceFile: "Asia_batch18_new.xlsx_zho-CN.mqxliff" })
    });
    let fileTask = null;
    const fileDeadline = Date.now() + 60_000;
    while (Date.now() < fileDeadline) {
      fileTask = await request(`${appUrl}/api/background-tasks/${encodeURIComponent(fileExport.taskId)}`);
      if (["completed", "failed"].includes(fileTask.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    assert.equal(fileTask?.status, "completed");
    assert.equal(fileTask.payload.sourceFile, "Asia_batch18_new.xlsx_zho-CN.mqxliff");
    assert.equal(fileTask.payload.count, 2, "文件级导出只导这个文件");
    await request(`${appUrl}/api/background-tasks/${encodeURIComponent(fileExport.taskId)}`, { method: "DELETE" });

    const removed = await request(`${appUrl}/api/library-entries?locale=zh-CN&kind=tm&projectId=${encodeURIComponent(projectId)}&libraryId=${encodeURIComponent(masterTm.id)}&sourceFile=${encodeURIComponent("Asia_batch18_new.xlsx_zho-CN.mqxliff")}`, { method: "DELETE" });
    assert.equal(removed.deleted, 2, "按文件清理只删这个文件的机器草稿");
    const remaining = await request(`${appUrl}/api/library-entries?locale=zh-CN&kind=tm&projectId=${encodeURIComponent(projectId)}&libraryId=${encodeURIComponent(masterTm.id)}&limit=50`);
    assert.equal(remaining.total, 1, "别的文件的条目不受影响");
    assert.equal(remaining.items[0].sourceFile, "Trophy.xlsx_zho-CN.mqxliff");

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

    // 6) 选中的目标库必须是真正落库的那个：选参考 TM 不能悄悄写进主 TM
    const referenceTm = (await request(`${appUrl}/api/projects/${encodeURIComponent(projectId)}/libraries`, {
      method: "POST",
      body: JSON.stringify({ name: "参考 TM", kind: "translation_memory", role: "reference", priority: 3, enabled: true })
    })).library;
    const referenceImport = await request(`${appUrl}/api/assets-import/commit`, {
      method: "POST",
      body: JSON.stringify({
        projectId, batchId: randomUUID(), filename: "参考库导入.xlsx", purpose: "tm",
        styleEvidence: false, tmLibraryId: referenceTm.id,
        candidates: [{ source: "参考ライブラリはこちらです。", target: "参考库在这边。", locale: "zh-CN", selected: true }]
      })
    });
    const referenceDeadline = Date.now() + 60_000;
    let referenceTask = null;
    while (Date.now() < referenceDeadline) {
      referenceTask = await request(`${appUrl}/api/background-tasks/${encodeURIComponent(referenceImport.taskId)}`);
      if (["completed", "failed"].includes(referenceTask.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    assert.equal(referenceTask?.status, "completed", `选中库的导入要跑完：${JSON.stringify(referenceTask?.progress || {})}`);
    const referenceEntries = await request(`${appUrl}/api/library-entries?locale=zh-CN&kind=tm&projectId=${encodeURIComponent(projectId)}&libraryId=${encodeURIComponent(referenceTm.id)}&limit=50`);
    assert.equal(referenceEntries.total, 1, "条目要落进选中的参考 TM");
    assert.equal(referenceEntries.items[0].libraryId, referenceTm.id);
    const masterAfterReference = await request(`${appUrl}/api/library-entries?locale=zh-CN&kind=tm&projectId=${encodeURIComponent(projectId)}&libraryId=${encodeURIComponent(masterTm.id)}&limit=50`);
    assert.ok(!masterAfterReference.items.some((item) => item.source === "参考ライブラリはこちらです。"), "选了参考 TM 就不该写进主 TM");
    await request(`${appUrl}/api/background-tasks/${encodeURIComponent(referenceImport.taskId)}`, { method: "DELETE" });
  } finally {
    await request(`${appUrl}/api/projects/${encodeURIComponent(projectId)}?purge=1`, { method: "DELETE" });
  }
});

/**
 * 参考资料的真实入库链路：上传（原始字节）→ 预扫 → 解析 → 分块入库 → 删除时连存档一起清掉。
 *
 * 单测只覆盖解析器本身，服务端这条流水线（文档记录、预扫阶段、片段落库、原文件路径）
 * 只有跑真实例才能验到——实测就因为这里残留了一个未定义的 projectId 变量，
 * 大文件上传后直接 failed，而单测全绿。
 */
test("参考资料：上传后能预扫并入库，删除时连原文件存档一起清掉", { skip: !enabled, timeout: 120_000 }, async () => {
  const project = await request(`${appUrl}/api/projects`, {
    method: "POST",
    body: JSON.stringify({ name: `参考资料接口测试 ${randomUUID().slice(0, 8)}` })
  });
  const projectId = project.project.id;
  const text = `角色设定：林晚是主角，习惯自称“我”。\n她的搭档叫陆遥。\n${"补充设定。".repeat(40)}`;
  try {
    const upload = await request(`${appUrl}/api/references/file?projectId=${encodeURIComponent(projectId)}&filename=${encodeURIComponent("setting.txt")}&name=${encodeURIComponent("setting")}`, {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: Buffer.from(text, "utf8")
    });
    assert.ok(upload.documentId, "上传要立刻返回 documentId（解析在后台）");

    let document = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const list = await request(`${appUrl}/api/references?projectId=${encodeURIComponent(projectId)}&limit=10`);
      const found = list.items.find((item) => item.id === upload.documentId);
      if (found && found.status === "ready") { document = found; break; }
      if (found?.status === "failed") throw new Error(`资料导入失败：${found.error}`);
    }
    assert.ok(document, "资料应在 1 分钟内就绪");
    assert.ok(document.chunkCount > 0, "文本资料要有可检索片段");
    assert.match(document.ingestReport.stage, /ready/u);
    assert.ok(document.ingestReport.bytes > 0, "导入报告要记下原文件大小");
    assert.equal(document.ingestReport.sourcePath, `uploads/references/${upload.documentId}.txt`);

    const chunks = await request(`${appUrl}/api/references/${encodeURIComponent(upload.documentId)}/chunks?limit=5`);
    assert.ok(chunks.items.some((chunk) => String(chunk.text).includes("林晚")), "片段里要有正文");

    await request(`${appUrl}/api/references/${encodeURIComponent(upload.documentId)}`, { method: "DELETE" });
    const after = await request(`${appUrl}/api/references?projectId=${encodeURIComponent(projectId)}&limit=10`);
    assert.equal(after.total, 0, "删除后列表里不该还有这条资料");
    if (upload.taskId) await request(`${appUrl}/api/background-tasks/${encodeURIComponent(upload.taskId)}`, { method: "DELETE" }).catch(() => {});
  } finally {
    await request(`${appUrl}/api/projects/${encodeURIComponent(projectId)}?purge=1`, { method: "DELETE" });
  }
});

test("参考资料目录：拖入文件树、同名覆盖、移动与递归删除都落到真实存储", { skip: !enabled, timeout: 120_000 }, async () => {
  const project = await request(`${appUrl}/api/projects`, {
    method: "POST",
    body: JSON.stringify({ name: `参考资料目录测试 ${randomUUID().slice(0, 8)}` })
  });
  const projectId = project.project.id;
  const waitReady = async (documentId) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const list = await request(`${appUrl}/api/references?projectId=${encodeURIComponent(projectId)}&limit=50`);
      const found = list.items.find((item) => item.id === documentId);
      if (found?.status === "ready") return found;
      if (found?.status === "failed") throw new Error(found.error || "参考资料导入失败");
    }
    throw new Error("参考资料未在预期时间内就绪");
  };
  try {
    const root = (await request(`${appUrl}/api/reference-folders`, {
      method: "POST",
      body: JSON.stringify({ projectId, name: "设定集" })
    })).folder;
    const ensured = await request(`${appUrl}/api/reference-folders/ensure`, {
      method: "POST",
      body: JSON.stringify({ projectId, parentId: root.id, paths: [["角色"], ["角色", "表情"]] })
    });
    const characterFolder = ensured.items[0].folderId;
    assert.equal(ensured.folders.filter((folder) => folder.parentId === root.id).length, 1);

    const upload = await request(`${appUrl}/api/references/file?projectId=${encodeURIComponent(projectId)}&folderId=${encodeURIComponent(characterFolder)}&filename=setting.txt&vision=none`, {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: Buffer.from("第一版：林晚是主角。", "utf8")
    });
    assert.equal(upload.visionMode, "none");
    assert.equal(upload.replaced, false);
    const ready = await waitReady(upload.documentId);
    assert.equal(ready.folderId, characterFolder);
    assert.equal(ready.ingestReport.visionEnabled, false);

    const replacement = await request(`${appUrl}/api/references/file?projectId=${encodeURIComponent(projectId)}&folderId=${encodeURIComponent(characterFolder)}&filename=setting.txt&vision=all`, {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: Buffer.from("第二版：林晚与陆遥是搭档。", "utf8")
    });
    assert.equal(replacement.documentId, upload.documentId, "同目录同名文件要覆盖同一条资料");
    assert.equal(replacement.replaced, true);
    const replaced = await waitReady(upload.documentId);
    const chunks = await request(`${appUrl}/api/references/${encodeURIComponent(upload.documentId)}/chunks?limit=10`);
    assert.match(chunks.items.map((item) => item.text).join("\n"), /陆遥/u);

    await request(`${appUrl}/api/references/${encodeURIComponent(upload.documentId)}`, {
      method: "PATCH",
      body: JSON.stringify({ folderId: root.id })
    });
    const inRootFolder = await request(`${appUrl}/api/references?projectId=${encodeURIComponent(projectId)}&folderId=${encodeURIComponent(root.id)}&limit=10`);
    assert.equal(inRootFolder.total, 1);

    await request(`${appUrl}/api/references/${encodeURIComponent(upload.documentId)}`, {
      method: "PATCH",
      body: JSON.stringify({ folderId: characterFolder })
    });
    const deletion = await request(`${appUrl}/api/reference-folders/${encodeURIComponent(root.id)}`, { method: "DELETE" });
    let deleteTask = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      deleteTask = await request(`${appUrl}/api/background-tasks/${encodeURIComponent(deletion.taskId)}`);
      if (["completed", "failed", "needs_attention"].includes(deleteTask.status)) break;
    }
    assert.equal(deleteTask?.status, "completed", JSON.stringify(deleteTask?.progress || {}));
    const after = await request(`${appUrl}/api/references?projectId=${encodeURIComponent(projectId)}&limit=10`);
    assert.equal(after.total, 0, "递归删除文件夹要连同资料一起清掉");
    const foldersAfter = await request(`${appUrl}/api/reference-folders?projectId=${encodeURIComponent(projectId)}`);
    assert.equal(foldersAfter.items.length, 0);
    await request(`${appUrl}/api/background-tasks/${encodeURIComponent(deletion.taskId)}`, { method: "DELETE" }).catch(() => {});
    await request(`${appUrl}/api/background-tasks/${encodeURIComponent(replacement.taskId)}`, { method: "DELETE" }).catch(() => {});
    await request(`${appUrl}/api/background-tasks/${encodeURIComponent(upload.taskId)}`, { method: "DELETE" }).catch(() => {});
  } finally {
    await request(`${appUrl}/api/projects/${encodeURIComponent(projectId)}?purge=1`, { method: "DELETE" });
  }
});
