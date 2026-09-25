import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stratifyEvidence } from "../src/style-delta.mjs";
import { readFile } from "node:fs/promises";

const dataDir = mkdtempSync(join(tmpdir(), "kami-style-project-"));
process.env.KAMI_DATA_DIR = dataDir;
delete process.env.KAMI_STORE; // 临时数据目录就是要隔离：继承 directus 会写进生产库

const {
  initializeStore,
  activateStyleProfile,
  countStyleEvidence,
  countStyleEvidenceFiles,
  getProjectStyleProfile,
  getStyleEvidence,
  listStyleEvidenceFiles,
  saveStyleEvidence,
  saveStyleProfile
} = await import("../src/store.mjs");
await initializeStore();

function evidence(index, contentType, provenance = "table-import", projectId = "p1") {
  return {
    locale: "zh-CN",
    projectId,
    contentType,
    domain: "general",
    source: `原文-${contentType}-${provenance}-${index}`,
    target: `译文-${index}`,
    provenance,
    status: "accepted"
  };
}

test("分层取样：每个语体都有代表，单语体不超上限，人工采纳优先", () => {
  const bulky = Array.from({ length: 40 }, (_, index) => evidence(index, "general"));
  const accepted = Array.from({ length: 2 }, (_, index) => evidence(index, "general", "human-accept"));
  const dialogue = Array.from({ length: 5 }, (_, index) => evidence(index, "dialogue"));
  const ui = Array.from({ length: 3 }, (_, index) => evidence(index, "ui"));
  const picked = stratifyEvidence([...bulky, ...accepted, ...dialogue, ...ui], { positiveLimit: 12 });
  assert.equal(picked.length, 12, "总量要取满正例上限");
  const types = new Set(picked.map((item) => item.contentType));
  assert.deepEqual([...types].sort(), ["dialogue", "general", "ui"], "每个语体都要有代表");
  assert.ok(picked.filter((item) => item.contentType === "dialogue").length >= 2, "小池子也要分到名额");
  // 单语体上限 = max(3, ceil(12/4)) = 3；回流阶段只补在轮转结束之后。
  assert.ok(picked.filter((item) => item.contentType === "ui").length <= 3, "单语体不超过上限");
});

test("分层取样把反例原样留在列表里，交给统一的限量逻辑", () => {
  const negative = { ...evidence(99, "general"), polarity: "negative", note: "语气不对" };
  const picked = stratifyEvidence([evidence(1, "dialogue"), negative], { positiveLimit: 5 });
  assert.equal(picked.length, 2);
  assert.equal(picked.at(-1).polarity, "negative");
});

test("项目级计数：跨语体证据进同一个池子，并给出语体分布", async () => {
  const projectId = "pool-project";
  for (let index = 0; index < 4; index += 1) await saveStyleEvidence(evidence(index, "dialogue", "table-import", projectId));
  for (let index = 0; index < 3; index += 1) await saveStyleEvidence(evidence(index, "ui", "table-import", projectId));
  for (let index = 0; index < 2; index += 1) await saveStyleEvidence(evidence(index, "general", "human-accept", projectId));

  const totals = await countStyleEvidence("zh-CN", { projectId });
  assert.equal(totals.total, 9, "三种语体计入同一个项目池");
  assert.equal(totals.byProvenance["table-import"], 7);
  assert.equal(totals.byProvenance["human-accept"], 2);
  assert.deepEqual(totals.byContentType.map((bucket) => bucket.contentType), ["dialogue", "ui", "general"]);
  assert.equal((await countStyleEvidence("zh-CN", { projectId: "别的项目" })).total, 0, "项目之间互不串池");
});

test("项目级取值：取同项目最新 active 的那一份，跨语体不再分叉", async () => {
  const projectId = "pick-project";
  const legacy = await saveStyleProfile({
    locale: "zh-CN", projectId, contentType: "dialogue", domain: "game",
    name: "旧的作用域规范", instruction: "旧", rules: [], version: undefined, status: "active"
  });
  const projectLevel = await saveStyleProfile({
    locale: "zh-CN", projectId, contentType: "general", domain: "general",
    name: "项目规范", instruction: "新", rules: [], status: "active"
  });
  assert.ok(projectLevel.version > legacy.version, "项目级那版版本号更高");
  const picked = await getProjectStyleProfile("zh-CN", { projectId });
  assert.equal(picked.id, projectLevel.id);
  assert.equal(picked.name, "项目规范");
  assert.equal(await getProjectStyleProfile("zh-CN", { projectId: "没有这个项目" }), null);
});

test("激活任一版本时同项目其它 active 全部退役", async () => {
  const projectId = "activate-project";
  const first = await saveStyleProfile({
    locale: "zh-CN", projectId, contentType: "general", domain: "general",
    name: "第一版", instruction: "一", rules: [], status: "active"
  });
  const second = await saveStyleProfile({
    locale: "zh-CN", projectId, contentType: "ui", domain: "game",
    name: "第二版", instruction: "二", rules: [], status: "draft"
  });
  await activateStyleProfile(second.id);
  const active = await getProjectStyleProfile("zh-CN", { projectId });
  assert.equal(active.id, second.id);
  assert.equal(active.name, "第二版");
  // 旧的那条必须已经退役，否则同时存在两份"当前规范"。
  const { listStyleProfiles } = await import("../src/store.mjs");
  const all = await listStyleProfiles("zh-CN", null, { projectId });
  assert.equal(all.styleProfiles.filter((item) => item.status === "active").length, 1);
  assert.equal(all.styleProfiles.find((item) => item.id === first.id).status, "inactive");
});

test("同条目 ID 换了语体：证据只留一条并更新标签", async () => {
  const projectId = "dedupe-project";
  await saveStyleEvidence({ locale: "zh-CN", projectId, contentType: "dialogue", domain: "game", entryKey: "K-1", source: "シド", target: "希德", provenance: "table-import", status: "accepted" });
  await saveStyleEvidence({ locale: "zh-CN", projectId, contentType: "ui", domain: "game", entryKey: "K-1", source: "シド", target: "希德", provenance: "table-import", status: "accepted" });
  const rows = (await getStyleEvidence("zh-CN", { projectId })).filter((item) => item.entryKey === "K-1");
  assert.equal(rows.length, 1, "语体不再参与判重，改判用途只更新同一条");
  assert.equal(rows[0].contentType, "ui");
});

/**
 * 蒸馏出来的规则要能回溯到具体交付物：证据池按来源文件计数，某个版本再按它自己的
 * 取样 id 回溯"这一版是从哪些文件学出来的"。
 */
test("风格证据的来源文件：池子按文件计数，版本按取样 id 回溯", async () => {
  const projectId = "style-files-project";
  const saved = [];
  for (const [file, count] of [["Asia_Batch15_new.xlsx_zho-CN.mqxliff", 3], ["Trophy.xlsx_zho-CN.mqxliff", 2]]) {
    for (let index = 0; index < count; index += 1) {
      // 原文/译文按文件区分：同一个 (原文, 译文) 会被当成重复证据去重，那不是本用例要验的东西。
      saved.push(await saveStyleEvidence({
        ...evidence(index, "general", "table-import", projectId),
        source: `原文-${file}-${index}`,
        target: `译文-${file}-${index}`,
        sourceFile: file
      }));
    }
  }
  assert.deepEqual(await countStyleEvidenceFiles("zh-CN", { projectId }), [
    { name: "Asia_Batch15_new.xlsx_zho-CN.mqxliff", count: 3 },
    { name: "Trophy.xlsx_zho-CN.mqxliff", count: 2 }
  ]);
  const firstFileIds = saved.filter((item) => item.sourceFile === "Asia_Batch15_new.xlsx_zho-CN.mqxliff").map((item) => item.id);
  const rows = await listStyleEvidenceFiles("zh-CN", { ids: firstFileIds });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.sourceFile === "Asia_Batch15_new.xlsx_zho-CN.mqxliff"));
  assert.deepEqual(await listStyleEvidenceFiles("zh-CN", { ids: [] }), [], "没有取样 id 时不发多余查询");
});

test("界面把来源文件写在证据池与蒸馏版本上，老版本证据被清掉时说明原因", async () => {
  const [app, server] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../server.mjs", import.meta.url), "utf8")
  ]);
  assert.match(app, /function formatEvidenceFiles\(files = \[\]\)/u);
  assert.match(app, /来源文件：\$\{escapeHtml\(evidenceFiles\)\}/u);
  assert.match(app, /来源文件：原证据已不在库中（本版取样/u);
  assert.match(app, /const poolFiles = formatEvidenceFiles\(pool\.files\);/u);
  assert.match(server, /const poolFiles = await countStyleEvidenceFiles\(locale, \{ projectId \}\)\.catch\(\(\) => \[\]\);/u);
  assert.match(server, /const styleProfiles = profiles\.styleProfiles\.map\(\(item\) => \{/u);
  assert.match(server, /evidenceFilesMissing: ids\.length/u);
});
