import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KAMI_DATA_DIR = mkdtempSync(join(tmpdir(), "kami-project-isolation-"));
delete process.env.KAMI_STORE;

const store = await import("../src/store.mjs");
await store.initializeStore();

test("风格、QA、任务、分享和后台记录按项目隔离", async () => {
  const a = "project-a";
  const b = "project-b";
  await store.saveStyleProfile({ projectId: a, locale: "zh-CN", contentType: "dialogue", domain: "game", name: "A 风格", instruction: "A", status: "active" });
  await store.saveStyleProfile({ projectId: b, locale: "zh-CN", contentType: "dialogue", domain: "game", name: "B 风格", instruction: "B", status: "active" });
  assert.equal((await store.getStyleProfile("zh-CN", "dialogue", "game", { projectId: a })).instruction, "A");
  assert.equal((await store.getStyleProfile("zh-CN", "dialogue", "game", { projectId: b })).instruction, "B");

  await store.saveStyleEvidence({ projectId: a, locale: "zh-CN", contentType: "dialogue", domain: "game", source: "同じ", target: "相同 A" });
  await store.saveStyleEvidence({ projectId: b, locale: "zh-CN", contentType: "dialogue", domain: "game", source: "同じ", target: "相同 B" });
  assert.deepEqual((await store.getStyleEvidence("zh-CN", { projectId: a })).map((item) => item.target), ["相同 A"]);

  await store.saveMemory("zh-CN", { projectId: a, source: "同じ", target: "相同 A", domain: "game", contentType: "dialogue", qualityStatus: "human_approved", qaScore: 100 });
  await store.saveMemory("zh-CN", { projectId: b, source: "同じ", target: "相同 B", domain: "game", contentType: "dialogue", qualityStatus: "human_approved", qaScore: 100 });
  assert.deepEqual((await store.getMemories("zh-CN", { projectId: a })).map((item) => item.target), ["相同 A"]);
  assert.deepEqual((await store.getMemories("zh-CN", { projectId: b })).map((item) => item.target), ["相同 B"]);

  await store.saveQaRun({ projectId: a, locale: "zh-CN", contentType: "dialogue", domain: "game", source: "A", initialTranslation: "A", finalTranslation: "A", status: "passed" });
  await store.saveQaRun({ projectId: b, locale: "zh-CN", contentType: "dialogue", domain: "game", source: "B", initialTranslation: "B", finalTranslation: "B", status: "passed" });
  assert.deepEqual((await store.getQaRuns("zh-CN", { projectId: a })).map((item) => item.source), ["A"]);

  const qaA = await store.saveQaCase({ projectId: a, locale: "zh-CN", contentType: "dialogue", domain: "game", source: "QA-A", rejectedTranslation: "x", status: "review" });
  const qaB = await store.saveQaCase({ projectId: b, locale: "zh-CN", contentType: "dialogue", domain: "game", source: "QA-B", rejectedTranslation: "x", status: "review" });
  assert.deepEqual((await store.listPendingQaCases("zh-CN", { projectId: a })).map((item) => item.id), [qaA.id]);
  assert.equal((await store.listPendingQaCases("zh-CN", { projectId: a })).some((item) => item.id === qaB.id), false);

  const taskA = await store.saveQaTask({ projectId: a, locale: "zh-CN", title: "A QA", sourceText: "A", translationText: "A" });
  await store.saveQaTask({ projectId: b, locale: "zh-CN", title: "B QA", sourceText: "B", translationText: "B" });
  assert.deepEqual((await store.listQaTasks({ projectId: a })).map((item) => item.id), [taskA.id]);

  const shareA = await store.saveShare({ projectId: a, locale: "zh-CN", filename: "A", segments: [] });
  await store.saveShare({ projectId: b, locale: "zh-CN", filename: "B", segments: [] });
  assert.deepEqual((await store.listShares({ projectId: a })).map((item) => item.token), [shareA.token]);

  const backgroundA = await store.saveBackgroundTask({ projectId: a, type: "batch_export", title: "A 后台" });
  await store.saveBackgroundTask({ projectId: b, type: "batch_export", title: "B 后台" });
  assert.deepEqual((await store.listBackgroundTasks({ projectId: a })).map((item) => item.id), [backgroundA.id]);
});

test("删除项目会归档并从活动项目列表移除", async () => {
  const project = await store.saveProject({ name: "待删除项目", description: "删除回归测试" });
  const archived = await store.deleteProject(project.id);
  assert.equal(archived.status, "archived");
  assert.equal((await store.getProjects()).some((item) => item.id === project.id), false);
  assert.equal((await store.getProject(project.id)).status, "archived");
});

test("彻底删除项目会清理项目作用域数据", async () => {
  const project = await store.saveProject({ name: "待彻底删除项目", description: "彻底删除回归测试" });
  await store.saveMemory("zh-CN", { projectId: project.id, source: "purge-source", target: "purge-target", domain: "general", contentType: "general", qualityStatus: "human_approved", qaScore: 100 });
  await store.saveStyleProfile({ projectId: project.id, locale: "zh-CN", contentType: "dialogue", domain: "game", name: "purge-style", instruction: "purge", status: "active" });
  await store.saveResourceLibrary({ projectId: project.id, name: "purge-library", kind: "term_base", role: "reference", priority: 1 });
  const result = await store.purgeProject(project.id);
  assert.ok(result.total >= 2);
  assert.equal(await store.getProject(project.id), null);
  assert.equal((await store.getMemories("zh-CN", { projectId: project.id })).length, 0);
  assert.equal(await store.getStyleProfile("zh-CN", "dialogue", "game", { projectId: project.id }), null);
  assert.deepEqual(await store.getResourceLibraries(project.id), []);
});
