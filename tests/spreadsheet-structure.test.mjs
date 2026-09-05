import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildSpreadsheetSnapshot, inferSpreadsheetStructure, mergeSpreadsheetAnalysis } from "../src/spreadsheet-structure.mjs";

function cellText(cell) {
  return String(cell.value ?? cell.text ?? "").trim();
}

test("有表头时区分日语正文、补充信息、约束和已有简中译文", () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("宣发");
  sheet.addRow(["位置", "描述", "DDL", "语种要求", "Japanese", "Chinese Simp."]);
  sheet.addRow(["海外社媒", "无字符限制", "8月3日", "日中", "8月になり、セールが始まります！", "八月已至，折扣活动即将开启！"]);
  const snapshot = buildSpreadsheetSnapshot(workbook, cellText);
  const analysis = inferSpreadsheetStructure(snapshot);
  const result = analysis.sheets[0];
  assert.equal(result.headerRow, 1);
  assert.equal(result.columns.find((column) => column.column === 1).role, "context");
  assert.equal(result.columns.find((column) => column.column === 2).role, "constraint");
  assert.equal(result.columns.find((column) => column.column === 3).role, "constraint");
  assert.equal(result.columns.find((column) => column.column === 4).role, "constraint");
  assert.equal(result.columns.find((column) => column.column === 5).role, "source_text");
  assert.equal(result.columns.find((column) => column.column === 6).role, "existing_translation");
});

test("没有表头时根据整列内容分布推断日语正文", () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("无表头");
  sheet.addRow(["海外社媒", "无字符限制", "8月になり、セールが始まります！任務を完了すると限定報酬も受け取れます。", "八月已至，折扣活动即将开启！完成任务还可领取限定奖励。"]);
  sheet.addRow(["官网/Steam公告标题", "80字符内", "『黒神話：悟空』の30％オフセールがまもなく始まります", "《黑神话：悟空》即将开启七折优惠"]);
  sheet.addRow(["官网/Steam公告副标题", "180字符内", "期間限定セール、どうぞお見逃しなく！", "限时折扣三成，活动期间不要错过！"]);
  const analysis = inferSpreadsheetStructure(buildSpreadsheetSnapshot(workbook, cellText)).sheets[0];
  assert.equal(analysis.headerRow, null);
  assert.equal(analysis.columns.find((column) => column.column === 3).role, "source_text");
  assert.notEqual(analysis.columns.find((column) => column.column === 1).role, "source_text");
  assert.equal(analysis.columns.find((column) => column.column === 2).role, "constraint");
  assert.equal(analysis.columns.find((column) => column.column === 4).role, "existing_translation");
});

test("AI 结构结论只接受存在的列和受支持角色", () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(["海外社媒", "无字符限制", "需要翻译的完整正文。"]);
  const snapshot = buildSpreadsheetSnapshot(workbook, cellText);
  const rules = inferSpreadsheetStructure(snapshot);
  const merged = mergeSpreadsheetAnalysis(snapshot, rules, { sheets: [{
    sheet: "Sheet1",
    headerRow: null,
    confidence: 0.93,
    reason: "无表头但列分布明确",
    columns: [
      { column: 1, label: "位置", role: "context", confidence: 0.92 },
      { column: 2, label: "要求", role: "constraint", confidence: 0.96 },
      { column: 3, label: "中文正文", role: "source_text", confidence: 0.98 },
      { column: 99, label: "不存在", role: "source_text", confidence: 1 },
      { column: 2, label: "非法", role: "translate_everything", confidence: 1 }
    ]
  }] });
  assert.equal(merged.usedModel, true);
  assert.equal(merged.sheets[0].columns.some((column) => column.column === 99), false);
  assert.equal(merged.sheets[0].columns.find((column) => column.column === 3).role, "source_text");
});
