import { splitBatchSubBatches, splitTranslationGroups } from "./batch-document.mjs";

function compactResult(result) {
  if (!result) return null;
  const clip = (value, limit = 800) => String(value || "").slice(0, limit);
  return {
    translation: clip(result.translation, 10_000),
    qaScore: Number.isFinite(result.qaScore) ? result.qaScore : null,
    matches: (result.matches || []).slice(0, 20),
    issues: (result.issues || []).slice(0, 30),
    aiQa: result.aiQa ? {
      score: Number.isFinite(result.aiQa.score) ? result.aiQa.score : null,
      status: result.aiQa.status,
      iterations: result.aiQa.iterations || 0,
      used: Boolean(result.aiQa.used),
      fallbackReason: clip(result.aiQa.fallbackReason, 500),
      termDecisions: (result.aiQa.termDecisions || []).slice(0, 12),
      humanDecisions: (result.aiQa.humanDecisions || []).slice(0, 30)
    } : null,
    styleProfile: result.styleProfile ? { id: result.styleProfile.id, name: result.styleProfile.name, version: result.styleProfile.version } : null,
    trajectoryId: result.trajectoryId || ""
  };
}

function contextBoundary(segment = {}) {
  return `${segment.locator?.type || ""}\u0000${segment.locator?.sheet || segment.context?.sheet || ""}`;
}

function executionGroups(segments, settings, segmentationMode) {
  if (segmentationMode !== "group") return new Map();
  const groups = splitTranslationGroups(segments, {
    maxEntries: settings.groupMaxEntries,
    maxChars: settings.groupMaxChars
  });
  const byId = new Map();
  for (const group of groups) {
    const entries = segments.filter((segment) => group.segmentIds.includes(segment.id));
    for (const segment of entries) byId.set(segment.id, entries);
  }
  return byId;
}

function checkpointSubBatches(subBatches, segments) {
  return subBatches.map((batch) => {
    const entries = batch.segmentIds.map((id) => segments.find((segment) => segment.id === id)).filter(Boolean);
    const completed = entries.filter((segment) => segment.status === "done").length;
    const failed = entries.filter((segment) => segment.status === "error").length;
    return {
      ...batch,
      completed,
      failed,
      status: failed ? "needs_attention" : completed === entries.length ? "completed" : completed ? "running" : "queued"
    };
  });
}

export async function runServerBatch(batchId, {
  loadRun,
  saveRun,
  loadProject,
  classifyDocument,
  translateSegment,
  shouldPause = () => false,
  touch = () => {},
  review = async () => {}
} = {}) {
  const run = await loadRun(batchId);
  if (!run) throw new Error("未找到批次任务");
  const project = await loadProject(run.projectId);
  if (!project) throw new Error("批次所属项目不存在");
  const batchSettings = project.settings?.batch || {};
  const tmSettings = project.settings?.tm || {};
  const selected = (run.segments || []).filter((segment) => segment.selected !== false);
  const contentType = run.contentType && run.contentType !== "general"
    ? run.contentType
    : await classifyDocument(selected.map((segment) => segment.source).join("\n").slice(0, 8_000));
  const subBatches = splitBatchSubBatches(selected, {
    maxEntries: batchSettings.subBatchMaxEntries,
    maxChars: batchSettings.subBatchMaxChars
  });
  const groupById = executionGroups(selected, batchSettings, run.segmentationMode);
  const options = run.runnerOptions || {};
  run.contentType = contentType || "general";
  run.runState = "running";
  run.subBatches = checkpointSubBatches(subBatches, run.segments);
  await saveRun(run);

  for (const subBatch of subBatches) {
    for (const segmentId of subBatch.segmentIds) {
      touch();
      if (shouldPause()) {
        run.runState = "paused";
        run.subBatches = checkpointSubBatches(subBatches, run.segments);
        await saveRun(run);
        return run;
      }
      const segment = run.segments.find((item) => item.id === segmentId);
      if (!segment || segment.selected === false || segment.status === "done") continue;
      segment.status = "running";
      segment.error = "";
      await saveRun(run);
      const position = run.segments.indexOf(segment);
      const context = {
        ...(segment.context || {}),
        previous: segment.context?.previous || run.segments[position - 1]?.source || "",
        next: segment.context?.next || run.segments[position + 1]?.source || "",
        document: run.filename,
        segmentIndex: position + 1,
        segmentCount: run.segments.length
      };
      const anchorCount = Math.max(0, Number(tmSettings.contextAnchorCount ?? 5));
      const boundary = contextBoundary(segment);
      const batchReferences = run.segments.slice(0, position)
        .filter((item) => item.status === "done" && item.translation && contextBoundary(item) === boundary)
        .slice(-anchorCount)
        .map((item) => ({ source: item.source, target: item.translation }));
      try {
        const result = await translateSegment({
          projectId: run.projectId,
          source: segment.source,
          locale: run.locale,
          contentType: run.contentType,
          domain: run.domain,
          neighborContext: context,
          batchId: run.batchId,
          segmentId: segment.id,
          entryId: segment.locator?.unitId || segment.locator?.entryId || segment.context?.entryId || "",
          sourceFile: run.filename,
          sourceRow: segment.locator?.row || segment.context?.row || null,
          previousSource: context.previous,
          nextSource: context.next,
          batchReferences,
          batchGroupEntries: (groupById.get(segment.id) || []).map((item) => ({ id: item.id, source: item.source, context: item.context })),
          route: options.route || "auto",
          reflect: options.reflect !== false,
          useModelClassification: false
        });
        segment.translation = result.translation;
        segment.result = compactResult(result);
        segment.status = "done";
        segment.accepted = false;
      } catch (error) {
        segment.status = "error";
        segment.error = String(error?.message || error);
      }
      run.subBatches = checkpointSubBatches(subBatches, run.segments);
      await saveRun(run);
    }
  }

  const failed = selected.filter((segment) => segment.status === "error").length;
  run.runState = failed ? "needs_attention" : "completed";
  run.subBatches = checkpointSubBatches(subBatches, run.segments);
  await saveRun(run);
  if (!failed) await review(run);
  return run;
}
