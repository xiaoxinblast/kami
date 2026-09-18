import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KAMI_DATA_DIR = mkdtempSync(join(tmpdir(), "kami-tm-entry-"));
delete process.env.KAMI_STORE;

const { getMemories, getStyleEvidence, initializeStore, saveMemory, saveStyleEvidence } = await import("../src/store.mjs");
const { memoryMatchAttempts, styleEvidenceMatch } = await import("../src/translation-memory.mjs");
const { extractXliffPairs } = await import("../src/xliff-document.mjs");
const { buildContextPack } = await import("../src/context-pack.mjs");
const { classifyContent } = await import("../src/classifier.mjs");

await initializeStore();

const ENTRY_KEY = "CARD2_QST_13_0300_0500_00_vns";
const save = (input) => saveMemory("zh-CN", { qualityStatus: "human_approved", projectId: "project-1", ...input });

test("条目 ID 决定 TM 行的身份：改稿重导覆盖原行，不再堆新译文", async () => {
  await save({ source: "ヴァネッサ", target: "ヴァネッサ（旧）", entryKey: ENTRY_KEY, sourceFile: "Batch16.mqxliff" });
  await save({ source: "ヴァネッサ", target: "瓦妮莎", entryKey: ENTRY_KEY, sourceFile: "Batch16_updated.mqxliff" });

  const rows = await getMemories("zh-CN", { projectId: "project-1" });
  assert.equal(rows.length, 1, "同一个条目 ID 只应保留一行");
  assert.equal(rows[0].target, "瓦妮莎");
  assert.equal(rows[0].entryKey, ENTRY_KEY);
  assert.equal(rows[0].sourceFile, "Batch16_updated.mqxliff");
});

test("没有条目 ID 时仍然按原文+译文去重", async () => {
  await save({ source: "プレミアムパス", target: "高级通行证" });
  await save({ source: "プレミアムパス", target: "高级通行证" });
  await save({ source: "プレミアムパス", target: "高级月卡" });

  const rows = await getMemories("zh-CN", { projectId: "project-1" });
  assert.equal(rows.filter((row) => row.source === "プレミアムパス").length, 2, "不同译文各自一行，完全相同只留一行");
});

test("不同条目 ID 但原文译文相同仍按原文+译文去重", async () => {
  await save({ source: "シド", target: "希德", entryKey: "NIBLE_QST_11_1000_2400_30_blt", sourceFile: "a.mqxliff" });
  await save({ source: "シド", target: "希德", entryKey: "menu_Colosseum_CourseFlavor_COL10", sourceFile: "b.mqxliff" });

  const rows = await getMemories("zh-CN", { projectId: "project-1" });
  const matched = rows.filter((row) => row.source === "シド");
  assert.equal(matched.length, 1, "同原文同译文不该因为换了条目 ID 就重复入库");
  assert.equal(matched[0].entryKey, "menu_Colosseum_CourseFlavor_COL10", "保留最新一次导入的条目身份");
});

test("条目 ID 只在同一项目内生效，不会跨项目覆盖", async () => {
  await save({ source: "エアリス", target: "爱丽丝", entryKey: ENTRY_KEY, projectId: "project-1" });
  await save({ source: "エアリス", target: "艾莉丝", entryKey: ENTRY_KEY, projectId: "project-2" });

  const first = await getMemories("zh-CN", { projectId: "project-1" });
  const second = await getMemories("zh-CN", { projectId: "project-2" });
  assert.equal(first.filter((row) => row.source === "エアリス")[0].target, "爱丽丝");
  assert.equal(second.filter((row) => row.source === "エアリス")[0].target, "艾莉丝");
});

test("MQXLIFF 的 x-mmq-context 被当作条目 ID 提取出来", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xliff version="1.2" xmlns:mq="MQXliff">
<file original="Batch16.xlsx" source-language="ja-JP" target-language="zh-CN">
<body>
<trans-unit id="1" mq:status="Translated">
<source xml:space="preserve">ヴァネッサ</source>
<target xml:space="preserve">瓦妮莎</target>
<context-group><context context-type="x-mmq-context">${ENTRY_KEY}</context></context-group>
</trans-unit>
<trans-unit id="2" mq:status="Translated">
<source xml:space="preserve">シド</source>
<target xml:space="preserve">希德</target>
</trans-unit>
</body></file></xliff>`;
  const pairs = extractXliffPairs(Buffer.from(xml, "utf8"), "Batch16.mqxliff");
  assert.equal(pairs[0].entryKey, ENTRY_KEY);
  assert.equal(pairs[0].entryId, "1", "unit 序号仍然保留在 entryId 里");
  assert.equal(pairs[1].entryKey, "", "没有 context 的单元不带条目身份键");
});

test("发给模型的参考译例带上条目 ID 与文件名", () => {
  const pack = buildContextPack({
    source: "ヴァネッサが来た。",
    locale: "ja-JP",
    classification: classifyContent("ヴァネッサが来た。", "dialogue"),
    matches: [],
    domain: "game",
    translationReferences: [{
      source: "ヴァネッサ", target: "瓦妮莎", similarity: 0.93, qualityStatus: "human_approved",
      entryId: "1", entryKey: ENTRY_KEY, sourceFile: "Batch16.xlsx_zho-CN.mqxliff", sourceRow: 12,
      libraryName: "主 TM", libraryRole: "master"
    }]
  });
  assert.equal(pack.translationReferences[0].entryKey, ENTRY_KEY);
  assert.equal(pack.translationReferences[0].sourceFile, "Batch16.xlsx_zho-CN.mqxliff");
  // 提示词是把整条参考译例 JSON 序列化后交给模型的，所以字段必须在包里。
  const serialized = JSON.stringify(pack.translationReferences);
  assert.match(serialized, new RegExp(ENTRY_KEY, "u"));
  assert.match(serialized, /Batch16\.xlsx_zho-CN\.mqxliff/u);
});

test("定位顺序：先按条目 ID，再退回原文+译文", () => {
  assert.deepEqual(memoryMatchAttempts({ source: "s", target: "t", entryKey: "k" }), [
    { kind: "entry", entryKey: "k", source: "s" },
    { kind: "pair", source: "s", target: "t" }
  ]);
  assert.deepEqual(memoryMatchAttempts({ source: "s", target: "t" }), [{ kind: "pair", source: "s", target: "t" }]);
  // 只有 ID 没有原文时不按 ID 匹配：无法确认是哪一条。
  assert.deepEqual(memoryMatchAttempts({ target: "t", entryKey: "k" }), []);
});

test("同一 ID 但原文不同（跨文件撞 ID）不覆盖，各自成行", async () => {
  const sharedKey = "SHARED_CONTEXT_ID";
  await save({ source: "同一 ID 的第一句", target: "第一句译文", entryKey: sharedKey, sourceFile: "a.mqxliff" });
  await save({ source: "同一 ID 的第二句", target: "第二句译文", entryKey: sharedKey, sourceFile: "b.mqxliff" });

  const rows = (await getMemories("zh-CN", { projectId: "project-1" })).filter((row) => row.entryKey === sharedKey);
  assert.equal(rows.length, 2, "ID 相同但原文不同，说明是另一个文件里的段落，不能互相覆盖");
  assert.deepEqual(rows.map((row) => row.source).sort(), ["同一 ID 的第一句", "同一 ID 的第二句"]);
});

test("同一 ID 且原文一致时仍然原地覆盖", async () => {
  const key = "SAME_CONTEXT_ID";
  await save({ source: "同一条原文", target: "旧译文", entryKey: key, sourceFile: "x.mqxliff" });
  await save({ source: "同一条原文", target: "新译文", entryKey: key, sourceFile: "x_updated.mqxliff" });

  const rows = (await getMemories("zh-CN", { projectId: "project-1" })).filter((row) => row.entryKey === key);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target, "新译文");
});

const evidence = (input) => saveStyleEvidence({ locale: "zh-CN", projectId: "project-1", contentType: "dialogue", domain: "game", ...input });

test("风格证据：同条目 ID 同作用域只保留最新一条", async () => {
  await evidence({ source: "ヴァネッサ", target: "ヴァネッサ（旧）", machineTranslation: "旧机翻", entryKey: "EVIDENCE_KEY_1", sourceFile: "a.mqxliff" });
  await evidence({ source: "ヴァネッサ", target: "瓦妮莎", machineTranslation: "新机翻", note: "改稿", entryKey: "EVIDENCE_KEY_1", sourceFile: "a.mqxliff" });

  const rows = (await getStyleEvidence("zh-CN", { projectId: "project-1" })).filter((item) => item.entryKey === "EVIDENCE_KEY_1");
  assert.equal(rows.length, 1, "同 ID 同作用域只应留一条");
  assert.equal(rows[0].target, "瓦妮莎");
  assert.equal(rows[0].machineTranslation, "新机翻");
  assert.equal(rows[0].note, "改稿");
});

test("风格证据：同条目 ID 但换了作用域各自留一条", async () => {
  await evidence({ source: "シド", target: "希德", entryKey: "EVIDENCE_KEY_2", contentType: "dialogue", domain: "game" });
  await evidence({ source: "シド", target: "希德", entryKey: "EVIDENCE_KEY_2", contentType: "ui", domain: "game" });

  const rows = (await getStyleEvidence("zh-CN", { projectId: "project-1" })).filter((item) => item.entryKey === "EVIDENCE_KEY_2");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((item) => item.contentType).sort(), ["dialogue", "ui"]);
});

test("风格证据：没有条目 ID 时保持追加语义", async () => {
  await evidence({ source: "プレミアムパス", target: "高级通行证" });
  await evidence({ source: "プレミアムパス", target: "高级通行证" });

  const rows = (await getStyleEvidence("zh-CN", { projectId: "project-1" })).filter((item) => item.source === "プレミアムパス");
  assert.equal(rows.length, 2, "表格导入等没有条目 ID 的证据仍逐条累积");
  assert.equal(styleEvidenceMatch({ entryKey: "" }), null);
  assert.deepEqual(styleEvidenceMatch({ entryKey: "k", locale: "zh-CN", contentType: "dialogue", domain: "game", projectId: "p" }), {
    entryKey: "k", locale: "zh-CN", contentType: "dialogue", domain: "game", projectId: "p"
  });
});
