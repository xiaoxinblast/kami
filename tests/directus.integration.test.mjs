import test from "node:test";
import assert from "node:assert/strict";
import { saveBackgroundTask, getBackgroundTask, deleteBackgroundTask, findStyleProfile, saveUserProfile, activateStyleProfile, deleteAsset, disposeQaCase, getAssets, getAssetStats, getBatchRun, getMemories, getQaCases, getQaRuns, getStyleEvidence, getStyleLearningRuns, getStyleProfile, initializeStore, listBatchRuns, listStyleProfiles, rejectStyleProfile, saveAsset, saveBatchRun, saveImportPreview, saveMemory, saveQaCase, saveQaRun, saveStyleEvidence, saveStyleLearningRun, saveStyleProfile } from "../src/store.mjs";

const enabled = process.env.KAMI_STORE === "directus";

test("Directus 简体中文术语集合可读、可统计并可写入", { skip: !enabled }, async () => {
  await initializeStore();

  const stats = await getAssetStats("zh-CN");
  assert.equal(stats.locale, "zh-CN");
  assert.ok(stats.termCount >= 0);

  const temporary = await saveAsset("zh-CN", {
    source: "統合テスト用語",
    target: "集成测试术语",
    domains: ["test"],
    contentTypes: ["general"],
    status: "draft",
    provenance: "integration-test"
  });
  try {
    assert.ok(temporary.id);
    const chinese = await getAssets("zh-CN");
    assert.ok(chinese.terms.some((term) => term.id === temporary.id && term.source === "統合テスト用語" && term.target === "集成测试术语"));
  } finally {
    await deleteAsset("zh-CN", temporary.id);
  }
});

test("日语到简体中文的术语与翻译记忆使用独立集合", { skip: !enabled }, async () => {
  await initializeStore();
  const marker = `日中分库隔离-${Date.now()}`;
  const term = await saveAsset("zh-CN", {
    source: marker,
    target: "术语测试",
    domains: ["integration"],
    contentTypes: ["general"],
    status: "draft",
    provenance: "integration-test"
  });
  const memory = await saveMemory("zh-CN", {
    source: marker,
    target: "简体中文测试句。",
    domain: "integration",
    contentType: "general",
    qualityStatus: "human_approved",
    qaScore: 100,
    provenance: "integration-test"
  });
  const base = String(process.env.DIRECTUS_URL || "http://127.0.0.1:18055").replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${process.env.DIRECTUS_ADMIN_TOKEN}` };
  try {
    const assets = await getAssets("zh-CN");
    const memories = await getMemories("zh-CN", { domain: "integration", contentType: "general", limit: -1 });
    assert.equal(assets.terms.some((item) => item.id === term.id), true);
    assert.equal(assets.terms.some((item) => item.id === memory.id), false, "记忆不能进入术语检索");
    assert.equal(memories.some((item) => item.id === memory.id), true);
    assert.equal(memories.some((item) => item.id === term.id), false, "术语不能进入记忆召回");
  } finally {
    await fetch(`${base}/items/terms_zh_cn/${term.id}`, { method: "DELETE", headers });
    await fetch(`${base}/items/translation_memory_zh_cn/${memory.id}`, { method: "DELETE", headers });
  }
});

test("日语到简体中文的翻译记忆、风格版本和 AIQA 资产形成闭环", { skip: !enabled }, async () => {
  await initializeStore();
  const marker = `集成记忆-${Date.now()}`;
  const created = [];
  const memory = await saveMemory("zh-CN", { source: marker, target: "集成记忆", domain: "integration", contentType: "marketing", qualityStatus: "human_approved", qaScore: 100 });
  created.push(["translation_memory_zh_cn", memory.id]);
  const importBatchId = `integration-${Date.now()}`;
  const evidence = await saveStyleEvidence({ locale: "zh-CN", source: marker, target: "集成记忆", domain: "integration", contentType: "marketing", status: "accepted", batchId: importBatchId });
  created.push(["style_evidence", evidence.id]);
  const learningRun = await saveStyleLearningRun({ batchId: importBatchId, filename: "integration.xlsx", locale: "zh-CN", contentType: "marketing", domain: "integration", evidenceCount: 1, summary: "集成测试风格摘要", rules: ["使用自然简体中文"], examples: [], caveat: "仅限测试", confidence: 0.9, status: "draft", generatedBy: "integration" });
  created.push(["style_learning_runs", learningRun.id]);
  const profile = await saveStyleProfile({ locale: "zh-CN", contentType: "marketing", domain: "integration", name: "集成风格", instruction: "使用自然简体中文。", examples: [], evidenceCount: 1, evidenceIds: [evidence.id], generatedBy: "integration", sourceBatchId: importBatchId, learningRunId: learningRun.id, status: "active" });
  created.push(["style_profiles", profile.id]);
  await saveStyleLearningRun({ id: learningRun.id, status: "promoted", promotedProfileId: profile.id });
  const run = await saveQaRun({ locale: "zh-CN", contentType: "marketing", domain: "integration", source: marker, initialTranslation: "集成记忆", finalTranslation: "集成记忆", score: null, status: "review", issues: [], termDecisions: [{ officialSource: "豪華内容", officialTarget: "豪华内容", decision: "not_applicable", reason: "集成测试" }], humanDecisions: [{ decision: "approved_as_is", reason: "集成测试人工批准" }], references: [], model: "integration", fallbackReason: "integration-timeout" });
  created.push(["qa_runs", run.id]);
  const qaCase = await saveQaCase({ locale: "zh-CN", contentType: "marketing", domain: "integration", source: marker, rejectedTranslation: "误译", correctedTranslation: "集成记忆", issues: [], scoreBefore: 80, scoreAfter: 100, status: "human_approved" });
  created.push(["qa_cases", qaCase.id]);
  try {
    const memories = await getMemories("zh-CN", { contentType: "marketing", domain: "integration" });
    assert.equal(memories.find((item) => item.source === marker)?.target, "集成记忆");
    assert.equal((await getStyleProfile("zh-CN", "marketing", "integration"))?.id, profile.id);
    assert.equal((await getStyleProfile("zh-CN", "marketing", "integration"))?.sourceBatchId, importBatchId);
    assert.equal((await getStyleProfile("zh-CN", "marketing", "integration"))?.learningRunId, learningRun.id);
    assert.equal((await listStyleProfiles("zh-CN", "active")).styleProfiles.find((item) => item.id === profile.id)?.sourceBatchId, importBatchId);
    assert.equal((await getStyleEvidence("zh-CN", { batchId: importBatchId, contentType: "marketing", domain: "integration", exactScope: true }))[0]?.id, evidence.id);
    const storedLearningRun = (await getStyleLearningRuns("zh-CN", { batchId: importBatchId, status: "promoted" }))[0];
    assert.equal(storedLearningRun?.id, learningRun.id);
    assert.equal(storedLearningRun?.promotedProfileId, profile.id);
    await rejectStyleProfile(profile.id);
    assert.equal(await getStyleProfile("zh-CN", "marketing", "integration"), null, "关闭后不再注入翻译");
    await activateStyleProfile(profile.id);
    assert.equal((await getStyleProfile("zh-CN", "marketing", "integration"))?.id, profile.id, "重新启用后恢复注入");
    assert.equal((await getQaCases("zh-CN", { contentType: "marketing", domain: "integration" })).some((item) => item.id === qaCase.id), true);
    assert.equal((await getQaRuns("zh-CN", { contentType: "marketing", domain: "integration" })).find((item) => item.id === run.id)?.fallbackReason, "integration-timeout");
    assert.equal((await getQaRuns("zh-CN", { contentType: "marketing", domain: "integration" })).find((item) => item.id === run.id)?.termDecisions[0]?.decision, "not_applicable");
    assert.equal((await getQaRuns("zh-CN", { contentType: "marketing", domain: "integration" })).find((item) => item.id === run.id)?.humanDecisions[0]?.decision, "approved_as_is");
    await disposeQaCase(qaCase.id);
    assert.equal((await getQaCases("zh-CN", { contentType: "marketing", domain: "integration" })).some((item) => item.id === qaCase.id), false);
  } finally {
    const base = String(process.env.DIRECTUS_URL || "http://127.0.0.1:18055").replace(/\/$/, "");
    const headers = { Authorization: `Bearer ${process.env.DIRECTUS_ADMIN_TOKEN}` };
    for (const [collection, id] of created.reverse()) await fetch(`${base}/items/${collection}/${id}`, { method: "DELETE", headers });
  }
});

test("Directus 批次进度首次创建后可继续 PATCH 更新", { skip: !enabled }, async () => {
  await initializeStore();
  const batchId = crypto.randomUUID();
  const base = String(process.env.DIRECTUS_URL || "http://127.0.0.1:18055").replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${process.env.DIRECTUS_ADMIN_TOKEN}` };
  try {
    await saveBatchRun({ batchId, filename: "首次保存.txt", locale: "zh-CN", contentType: "announcement", domain: "game", format: "text", segmentationMode: "sentence", segments: [{ id: "1", source: "最初の文。", status: "pending" }] });
    assert.equal((await getBatchRun(batchId))?.segments[0]?.status, "pending");
    await saveBatchRun({ batchId, filename: "首次保存.txt", locale: "zh-CN", contentType: "announcement", domain: "game", format: "text", segmentationMode: "sentence", segments: [{ id: "1", source: "最初の文。", translation: "第一句。", status: "done" }] });
    assert.equal((await getBatchRun(batchId))?.segments[0]?.status, "done");
    const summary = (await listBatchRuns({ locale: "zh-CN", search: "首次保存" })).find((item) => item.batchId === batchId);
    assert.equal(summary?.status, "completed");
    assert.equal(summary?.completedSegments, 1);
  } finally {
    await fetch(`${base}/items/batch_runs/${batchId}`, { method: "DELETE", headers });
  }
});

test("Directus 候选队列保存完整句段与句内术语的父子血缘", { skip: !enabled }, async () => {
  await initializeStore();
  const candidateKey = `pair-${Date.now()}`;
  const preview = await saveImportPreview({
    filename: "dialogue-lineage.xlsx",
    fileType: "xlsx",
    requestedLocale: "zh-CN",
    statistics: { rowsScanned: 1, candidates: 2, ready: 1, review: 1, excluded: 0 },
    ai: { used: true },
    candidates: [
      { source: "今、水簾洞を見に行こう。", target: "现在去水帘洞看看。", locale: "zh-CN", assetType: "memory", contentType: "dialogue", domain: "game", enforcement: "preferred", contentTypeConfidence: 0.95, contentTypeSource: "ai", candidateKey, candidateRole: "full_pair", candidateOrigin: "table-pair", rowNumber: 2, occurrences: 1, score: 0.92, decision: "ready", reasons: ["完整句段"] },
      { source: "水簾洞", target: "水帘洞", locale: "zh-CN", assetType: "term", contentType: "general", domain: "game", enforcement: "required", contentTypeConfidence: 0.91, contentTypeSource: "ai", candidateKey: `${candidateKey}-term`, candidateRole: "embedded_term", parentCandidateKey: candidateKey, parentCandidateKeys: [candidateKey], parentRowNumber: 2, parentEvidence: [{ parentCandidateKey: candidateKey, parentRowNumber: 2, sourceSpan: { start: 2, end: 5 }, targetSpan: { start: 3, end: 6 } }], candidateOrigin: "ai-term-extraction", termCategory: "location", extractionConfidence: 0.93, sourceSpan: { start: 2, end: 5 }, targetSpan: { start: 3, end: 6 }, rowNumber: 2, occurrences: 1, score: 0.91, decision: "review", reasons: ["句内专名"] }
    ]
  });
  const base = String(process.env.DIRECTUS_URL || "http://127.0.0.1:18055").replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${process.env.DIRECTUS_ADMIN_TOKEN}` };
  try {
    const response = await fetch(`${base}/items/term_candidates?limit=-1&filter[batch_id][_eq]=${preview.batchId}&fields=id,candidate_key,candidate_role,parent_candidate_key,parent_candidate_keys,parent_row_number,parent_evidence,candidate_origin,term_category,extraction_confidence,source_span,target_span`, { headers });
    const items = (await response.json()).data;
    assert.equal(items.length, 2);
    assert.equal(items.find((item) => item.candidate_role === "full_pair")?.candidate_key, candidateKey);
    const term = items.find((item) => item.candidate_role === "embedded_term");
    assert.equal(term?.parent_candidate_key, candidateKey);
    assert.deepEqual(term?.parent_candidate_keys, [candidateKey]);
    assert.equal(term?.parent_evidence?.[0]?.parentCandidateKey, candidateKey);
    assert.equal(term?.parent_row_number, 2);
    assert.equal(term?.term_category, "location");
    assert.equal(Number(term?.extraction_confidence), 0.93);
    assert.deepEqual(term?.source_span, { start: 2, end: 5 });
  } finally {
    for (const candidate of preview.candidates) await fetch(`${base}/items/term_candidates/${candidate.candidateId}`, { method: "DELETE", headers });
    await fetch(`${base}/items/term_import_batches/${preview.batchId}`, { method: "DELETE", headers });
  }
});

test("不归属单一批次的后台任务允许没有目标语言", { skip: !enabled }, async () => {
  await initializeStore();
  // 清理、导出等后台操作不归属某一条翻译任务，target_locale 必须允许为空。
  const task = await saveBackgroundTask({ type: "term_import", title: "后台任务空语言回归测试", locale: "" });
  assert.ok(task.id);
  try {
    const stored = await getBackgroundTask(task.id);
    assert.ok(stored, "无目标语言的任务必须能落库并读回");
    assert.ok(!stored.locale, "不归属单一批次的任务 locale 应为空而不是被塞一个假语言");
  } finally {
    await deleteBackgroundTask(task.id);
  }
});

test("激活与拒绝译者画像都不会被 Directus 的缺失项 403 挡住", { skip: !enabled }, async () => {
  await initializeStore();
  // Directus 对"条目不存在"和"无权访问"一律返回 403，从不返回 404。
  // 激活和拒绝都会先查 style_profiles，本该在 403 后回退查 user_profiles。
  const activationDraft = await saveUserProfile({ locale: "zh-CN", name: "激活回归测试画像", instruction: "激活回归测试", examples: [], evidenceCount: 3, status: "draft" });
  const rejectionDraft = await saveUserProfile({ locale: "zh-CN", name: "拒绝回归测试画像", instruction: "拒绝回归测试", examples: [], evidenceCount: 3, status: "draft" });
  try {
    const rejectionLocated = await findStyleProfile(rejectionDraft.id);
    assert.equal(rejectionLocated?.kind, "user_profile");
    const rejected = await rejectStyleProfile(rejectionDraft.id);
    assert.equal(rejected.status, "inactive");
    assert.equal(rejected.kind, "user_profile");

    const located = await findStyleProfile(activationDraft.id);
    assert.equal(located?.kind, "user_profile", "两个后端都要能分辨画像与风格规范");
    const activated = await activateStyleProfile(activationDraft.id);
    assert.equal(activated.status, "active");
    assert.equal(activated.kind, "user_profile");
  } finally {
    const base = String(process.env.DIRECTUS_URL || "http://127.0.0.1:18055").replace(/\/$/, "");
    const headers = { Authorization: `Bearer ${process.env.DIRECTUS_ADMIN_TOKEN}` };
    for (const id of [activationDraft.id, rejectionDraft.id]) {
      await fetch(`${base}/items/user_profiles/${id}`, { method: "DELETE", headers });
    }
  }
});
