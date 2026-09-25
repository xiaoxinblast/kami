/**
 * 参考资料上下文：索引、预算与工具运行器的共用装配。
 *
 * 生产翻译、Auto QA 与技能评测都走这里，避免"评测时的检索和生产不一样"。
 * 索引按项目缓存；评测传入 onlyChunkIds 时只允许考试允许的片段进入检索。
 */

import { createReferenceIndex } from "./reference-index.mjs";
import { createReferenceToolRunner } from "./reference-tools.mjs";
import { getResourceLibraries, listReferenceChunks, listReferenceChunksForProject, listReferenceDocuments } from "./store.mjs";

/** 与技能策略模板保持一致的出厂值。 */
export const REFERENCE_FACTORY_DEFAULTS = Object.freeze({
  enabled: true,
  limit: 4,
  maxResults: 4,
  maxCalls: 3,
  maxRounds: 2,
  maxCharsPerCall: 2_400,
  maxCharsTotal: 6_000
});

/** 组装检索索引：只加载启用资料库里的可用资料。 */
export function createProjectReferenceIndex() {
  return createReferenceIndex({
    loader: async (projectId) => {
      const { items: documents } = await listReferenceDocuments({ projectId, limit: 200 });
      const documentById = new Map(documents.map((document) => [document.id, document]));
      const libraries = await getResourceLibraries(projectId).catch(() => []);
      const libraryEnabled = new Map(libraries.map((library) => [library.id, library.enabled !== false]));
      const chunks = await listReferenceChunksForProject(projectId, { limit: 5_000 });
      return chunks.map((chunk) => {
        const document = documentById.get(chunk.documentId);
        return {
          id: chunk.id,
          documentId: chunk.documentId,
          documentName: document?.name || "",
          documentStatus: document?.status || "ready",
          libraryId: document?.libraryId || "",
          libraryEnabled: document?.libraryId ? libraryEnabled.get(document.libraryId) !== false : true,
          ordinal: chunk.ordinal,
          heading: chunk.heading,
          page: chunk.page,
          origin: chunk.origin,
          text: chunk.text,
          risk: chunk.risk,
          allowed: chunk.allowed,
          embedding: chunk.embedding
        };
      });
    }
  });
}

/** 参数设置给预算，技能里的值偏离出厂值时以技能为准。 */
export function referenceBudgetFrom(settings = {}, skill = null) {
  const factory = REFERENCE_FACTORY_DEFAULTS;
  const budget = {
    enabled: settings.enabled !== false,
    maxResults: Number(settings.maxResults) || factory.maxResults,
    maxCalls: Number(settings.maxCalls) || factory.maxCalls,
    maxRounds: Number(settings.maxRounds) || factory.maxRounds,
    maxCharsPerCall: Number(settings.maxCharsPerCall) || factory.maxCharsPerCall,
    maxCharsTotal: Number(settings.maxCharsTotal) || factory.maxCharsTotal
  };
  const fromSkill = skill?.strategy?.retrieval?.referenceMaterials;
  if (fromSkill && (fromSkill.enabled !== factory.enabled || Number(fromSkill.limit) !== factory.limit)) {
    budget.enabled = fromSkill.enabled !== false;
    const limit = Number(fromSkill.limit);
    if (Number.isFinite(limit) && limit > 0) budget.maxResults = Math.min(10, Math.max(1, Math.trunc(limit)));
  }
  return budget;
}

/**
 * @param onlyChunkIds 评测隔离用：只允许这些片段参与检索（null 表示不限制）
 */
export function buildReferenceToolRunner({ index, projectId = "", settings = {}, skill = null, onActivity = null, onlyChunkIds = null } = {}) {
  const budget = referenceBudgetFrom(settings, skill);
  if (!projectId || !budget.enabled) return null;
  const runner = createReferenceToolRunner({
    index,
    listChunks: async (documentId) => (await listReferenceChunks({ documentId, limit: 200 })).items,
    budget,
    onActivity
  });
  return {
    tools: runner.tools,
    maxRounds: budget.maxRounds,
    execute: (call) => runner.execute({ ...call, projectId, onlyChunkIds }),
    refs: () => runner.refs
  };
}
