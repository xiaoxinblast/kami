import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { DEFAULT_CANDIDATE_POOL } from "../src/memory-index.mjs";

/**
 * 真机验收（`KAMI_ACCEPTANCE=1`）：候选池检索在真实 Directus 上的读写行为。
 *
 *   ① 批量写入后，精确与扰动查询都能取到目标行；
 *   ② 候选池给出的 top-1/top-5 与整库打分一致（小语料、无标签噪声的场景）；
 *   ③ 写入/删除会让索引失效：新行立刻可检索、删掉的行立刻消失；
 *   ④ 验收后 purge 临时项目，复查残留为 0。
 *
 * 运行方式（需要 directus/.env）：`node --env-file=directus/.env --test tests/memory-candidate-pool-acceptance.test.mjs`
 */
const ACCEPTANCE = process.env.KAMI_ACCEPTANCE === "1";
const ROOT = fileURLToPath(new URL("../", import.meta.url));

test("候选池检索的真机读写行为", { skip: !ACCEPTANCE, timeout: 300_000 }, async () => {
  assert.ok(process.env.DIRECTUS_TOKEN, "验收需要用 --env-file=directus/.env 启动，并带上 DIRECTUS_TOKEN");
  process.env.KAMI_STORE = "directus";
  process.env.KAMI_DATA_DIR = process.env.KAMI_DATA_DIR || `${ROOT}data`;
  const {
    countMemories,
    deleteMemory,
    getMemories,
    getMemoryCandidates,
    purgeProject,
    saveMemories,
    saveMemory,
    saveProject,
    saveResourceLibrary
  } = await import("../src/store.mjs");
  const { rankTranslationMemories } = await import("../src/translation-memory.mjs");
  const { embedSource } = await import("../src/embedding.mjs");

  const project = await saveProject({ name: `验收-候选池-${Date.now()}`, description: "candidate pool acceptance" });
  const projectId = project.id;
  try {
    const library = await saveResourceLibrary({ projectId, name: "主 TM", kind: "translation_memory", role: "master", enabled: true, priority: 1 });
    const corpus = Array.from({ length: 300 }, (_, index) => ({
      source: `セリフ${index}：これはテスト用に用意した長めの日本語のセリフです。`,
      target: `台词${index}：这是一句为了测试准备的比较长的中文台词。`,
      projectId,
      libraryId: library.id,
      qualityStatus: "human_approved",
      qaScore: 100
    }));
    const written = await saveMemories("zh-CN", corpus);
    assert.equal(written.filter((item) => item.id).length, corpus.length, "批量写入要全部成功");
    assert.equal(await countMemories("zh-CN", { projectId }), corpus.length);

    // ① 精确与扰动查询都要取到目标行。
    const target = corpus[187];
    const mutated = [...target.source].filter((_, position) => position % 9 < 5).join("");
    for (const [label, query] of [["精确", target.source], ["扰动", mutated]]) {
      const candidates = await getMemoryCandidates("zh-CN", { projectId, source: query, limit: DEFAULT_CANDIDATE_POOL, libraryIds: [library.id] });
      assert.ok(candidates.some((item) => item.source === target.source), `${label}查询要取到目标行`);
      assert.ok(candidates.every((item) => typeof item.target === "string"), "候选必须是完整记忆行");
    }

    // ② 小语料上没有标签噪声，候选池与整库打分的相关性曲线必须一致。
    //    注意：模板句语料里会有大量"同分不同行"（同一句式只差编号），
    //    因此这里比对的是相似度序列 + 被扰动目标行是否仍在 top-5，而不是行 id。
    const all = await getMemories("zh-CN", { projectId, limit: -1, scopeFallback: true, contentType: "general", domain: "general" });
    let sameCurve = 0;
    let targetChecks = 0;
    let targetHits = 0;
    for (const index of [0, 60, 120, 180, 240, 299]) {
      const targetSource = corpus[index].source;
      const query = [...targetSource].filter((_, position) => position % 8 < 5).join("");
      const queryEmbedding = await embedSource(query);
      const baseline = rankTranslationMemories(query, all, { limit: 5, queryEmbedding, contentType: "general", domain: "general", projectId });
      const candidates = await getMemoryCandidates("zh-CN", { projectId, source: query, limit: DEFAULT_CANDIDATE_POOL, scopeFallback: true, contentType: "general", domain: "general", libraryIds: [library.id] });
      const filtered = rankTranslationMemories(query, candidates, { limit: 5, queryEmbedding, contentType: "general", domain: "general", projectId });
      const baselineCurve = baseline.map((item) => Number(item.similarity).toFixed(3));
      const filteredCurve = filtered.map((item) => Number(item.similarity).toFixed(3));
      if (JSON.stringify(baselineCurve) === JSON.stringify(filteredCurve)) sameCurve += 1;
      // 整库把这一行排进前 5 时，候选池也必须把它排进前 5。
      if (baseline.some((item) => item.source === targetSource)) {
        targetChecks += 1;
        if (filtered.some((item) => item.source === targetSource)) targetHits += 1;
      }
    }
    assert.equal(sameCurve, 6, "候选池给出的相关性序列必须与整库打分一致（同分不同行不算差异）");
    assert.ok(targetChecks > 0, "样本里应当有能进入整库 top5 的目标行");
    assert.equal(targetHits, targetChecks, "整库能排进前 5 的目标行，候选池也必须排进前 5");

    // ③ 写入与删除都要让索引失效。
    const added = await saveMemory("zh-CN", {
      source: "追加：ナビマップを起動します。",
      target: "追加：启动导览地图。",
      projectId,
      libraryId: library.id,
      qualityStatus: "human_approved"
    });
    const afterWrite = await getMemoryCandidates("zh-CN", { projectId, source: "ナビ", limit: 50, libraryIds: [library.id] });
    assert.ok(afterWrite.some((item) => item.id === added.id), "写入后新行必须立刻可检索");
    await deleteMemory("zh-CN", added.id);
    const afterDelete = await getMemoryCandidates("zh-CN", { projectId, source: "起動します", limit: 50, libraryIds: [library.id] });
    assert.equal(afterDelete.filter((item) => item.id === added.id).length, 0, "删除后不能再出现在候选里");
  } finally {
    const purged = await purgeProject(projectId);
    assert.ok(purged, "临时项目必须被清除");
    assert.equal(await countMemories("zh-CN", { projectId }), 0, "临时项目清理后残留必须为 0");
  }
});
