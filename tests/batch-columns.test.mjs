import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { applyColumnMapping } from "../src/spreadsheet-structure.mjs";
import { describeBatchColumns, prepareBatchDocument } from "../src/batch-document.mjs";
import { prepareXliffDocument } from "../src/xliff-document.mjs";

async function workbookBase64(rows, sheetName = "对白") {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64");
}

test("列含义弹窗的数据源：返回每个工作表的列、建议角色与样例", async () => {
  const base64 = await workbookBase64([
    ["ID", "日语", "备注", "字数限制"],
    ["CARD2_QST_13", "プレミアムパスを購入してください。", "系统提示", "20 字以内"],
    ["CARD2_QST_14", "メンテナンスは明日開始します。", "公告", "30 字以内"]
  ]);
  const described = await describeBatchColumns({ filename: "对白.xlsx", base64 });
  assert.equal(described.format, "xlsx");
  assert.equal(described.sheets.length, 1);
  const sheet = described.sheets[0];
  assert.equal(sheet.headerRow, 1);
  assert.equal(sheet.rowCount, 3);
  const byLetter = new Map(sheet.columns.map((column) => [column.letter, column]));
  assert.equal(byLetter.get("A").role, "entry_id");
  assert.equal(byLetter.get("B").role, "source_text");
  assert.equal(byLetter.get("D").role, "constraint");
  assert.equal(byLetter.get("B").header, "日语");
  assert.ok(byLetter.get("B").samples[0].startsWith("プレミアムパス"), "样例要给用户看内容");
});

test("非表格文件不进列弹窗的数据源", async () => {
  await assert.rejects(() => describeBatchColumns({ filename: "对白.txt", base64: Buffer.from("x").toString("base64") }), /只有 .xlsx \/ .csv/u);
});

test("表头为空但下面有内容的列，仍然出现在列映射里", async () => {
  const base64 = await workbookBase64([
    ["日语", "", "备注"],
    ["プレミアムパスを購入してください。", "CARD-0001", "系统提示"],
    ["メンテナンスは明日開始します。", "CARD-0002", "公告"]
  ]);
  const described = await describeBatchColumns({ filename: "无表头列.xlsx", base64 });
  const sheet = described.sheets[0];
  const letters = sheet.columns.map((column) => column.letter);
  assert.deepEqual(letters, ["A", "B", "C"], "B 列表头为空但下面有内容，必须出现在设置里");
  const emptyHeader = sheet.columns[1];
  assert.equal(emptyHeader.header, "");
  assert.equal(emptyHeader.headerEmpty, true);
  assert.deepEqual(emptyHeader.samples.slice(0, 2), ["CARD-0001", "CARD-0002"], "表头为空时样例直接给数据行，用户才判断得出这列是什么");
  assert.notEqual(emptyHeader.role, undefined);
  // CSV 同样要保住这种列（有些导出的 CSV 只在数据行里补列）。
  const csv = Buffer.from("日语,,备注\nプレミアムパス,CARD-0009,系统提示\n", "utf8").toString("base64");
  const describedCsv = await describeBatchColumns({ filename: "无表头列.csv", base64: csv });
  assert.equal(describedCsv.sheets[0].columns.length, 3);
});

test("表头写作「原文(ja)/译文(zh)」的列要按表头识别，不整列降级成数据", async () => {
  const base64 = await workbookBase64([
    ["原文(ja)", "译文(zh)", "注释"],
    ["ABILITY", "能力", "System | [System]"],
    ["AP", "行动值", "System | [System]"]
  ]);
  const described = await describeBatchColumns({ filename: "term_base.xlsx", base64 });
  const sheet = described.sheets[0];
  assert.equal(sheet.headerRow, 1);
  const byLetter = new Map(sheet.columns.map((column) => [column.letter, column]));
  assert.equal(byLetter.get("A").role, "source_text");
  assert.equal(byLetter.get("B").role, "existing_translation");
  assert.equal(byLetter.get("C").role, "context", "注释列属于上下文，不能顶替原文列");
  assert.equal(byLetter.get("A").header, "原文(ja)");
  assert.deepEqual(byLetter.get("A").samples.slice(0, 2), ["ABILITY", "AP"], "表头行不该再混进样例");
});

test("表头行整格缺失的列（表头 2 格、数据 4 列）照样能设置", async () => {
  const base64 = await workbookBase64([
    ["原文(ja)", "译文(zh)"],
    ["ABILITY", "能力", "System | [System]", "备注A"],
    ["AP", "行动值", "System | [System]", "备注B"]
  ]);
  const described = await describeBatchColumns({ filename: "ragged.xlsx", base64 });
  const sheet = described.sheets[0];
  assert.deepEqual(sheet.columns.map((column) => column.letter), ["A", "B", "C", "D"]);
  assert.equal(sheet.headerRow, 1);
  const byLetter = new Map(sheet.columns.map((column) => [column.letter, column]));
  assert.equal(byLetter.get("A").role, "source_text");
  assert.equal(byLetter.get("D").headerEmpty, true, "没有表头的列要标记出来，用户才知道它按内容识别");
  assert.deepEqual(byLetter.get("D").samples.slice(0, 2), ["备注A", "备注B"]);
});

test("合并表头盖住的列不会被当成主格同义的列", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("合并表头");
  sheet.addRow(["日语原文", "", "中文"]);
  sheet.mergeCells("A1:B1");
  sheet.addRow(["プレミアムパス", "CARD-0001", "高级通行证"]);
  sheet.addRow(["メンテナンスは明日開始します。", "CARD-0002", "维护明天开始。"]);
  const base64 = Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64");
  const described = await describeBatchColumns({ filename: "合并表头.xlsx", base64 });
  const describedSheet = described.sheets[0];
  assert.equal(describedSheet.headerRow, 1);
  const byLetter = new Map(describedSheet.columns.map((column) => [column.letter, column]));
  assert.equal(byLetter.get("A").role, "source_text");
  assert.notEqual(byLetter.get("B").role, "source_text", "B 列没有自己的表头，不能跟着主格算原文");
  assert.equal(byLetter.get("B").headerEmpty, true);
  assert.deepEqual(byLetter.get("B").samples.slice(0, 2), ["CARD-0001", "CARD-0002"]);
});

test("人工列映射覆盖自动识别：换原文列、标条目 ID、关掉表头", async () => {
  const base64 = await workbookBase64([
    ["A", "B", "C"],
    ["CARD2_QST_13", "プレミアムパス", "コメント"]
  ]);
  // 默认规则会把 B 当原文；人工改成"无表头 + B 仍是原文 + A 是条目 ID"。
  const mapped = await prepareBatchDocument({ filename: "对白.xlsx", base64 }, {
    segmentationMode: "unit",
    columnMapping: { sheets: [{ sheet: "对白", headerRow: null, columns: [{ column: 1, role: "entry_id" }, { column: 2, role: "source_text" }, { column: 3, role: "context" }] }] }
  });
  assert.equal(mapped.segments.length, 2, "关掉表头后第一行也当数据");
  // 人工指定的原文列是 B 列，所以两行都取 B 列的值（第一行原表头 "B" 也变成数据）。
  assert.deepEqual(mapped.segments.map((segment) => segment.source), ["B", "プレミアムパス"]);
  const second = mapped.segments[1];
  assert.equal(second.locator.entryId, "CARD2_QST_13");
  assert.deepEqual(second.context.metadata.map((item) => `${item.label}:${item.value}`), ["C列:コメント"]);
});

test("applyColumnMapping 只覆盖人工指定的部分", () => {
  const analysis = {
    source: "rules",
    usedModel: false,
    sheets: [{ sheet: "S", headerRow: 1, confidence: 0.6, reason: "自动", columns: [
      { column: 1, letter: "A", label: "ID", role: "context", confidence: 0.6, reason: "自动" },
      { column: 2, letter: "B", label: "日语", role: "source_text", confidence: 0.8, reason: "自动" }
    ] }]
  };
  const mapped = applyColumnMapping(analysis, { sheets: [{ sheet: "S", headerRow: null, columns: [{ column: 1, role: "entry_id" }] }] });
  assert.equal(mapped.source, "rules+manual");
  assert.equal(mapped.sheets[0].headerRow, null);
  assert.equal(mapped.sheets[0].columns[0].role, "entry_id");
  assert.equal(mapped.sheets[0].columns[0].reason, "人工指定");
  assert.equal(mapped.sheets[0].columns[1].role, "source_text", "没被人工改的列保持自动结论");
  assert.deepEqual(applyColumnMapping(analysis, null), analysis, "没有映射时原样返回");
});

test("批次待译的 MQXLIFF 段落带上条目 ID，注释里不再重复它", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xliff version="1.2" xmlns:mq="MQXliff"><file original="Batch16.xlsx" source-language="ja-JP" target-language="zh-CN"><body>
<trans-unit id="7" mq:status="NotStarted"><source xml:space="preserve">ヴァネッサ</source><target xml:space="preserve"></target>
<context-group><context context-type="x-mmq-context">CARD2_QST_13_0300_0500_00_vns</context></context-group>
<note>字幕種別：字幕</note></trans-unit>
</body></file></xliff>`;
  const prepared = prepareXliffDocument(Buffer.from(xml, "utf8"), "Batch16.mqxliff");
  const segment = prepared.segments[0];
  assert.equal(segment.entryKey, "CARD2_QST_13_0300_0500_00_vns");
  assert.equal(segment.locator.unitId, "7", "unit 序号仍然保留在 locator 里");
  assert.equal(segment.context.note, "字幕種別：字幕", "注释只留 memoQ 的 note，不再混入条目 ID");
});
