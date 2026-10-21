import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import { exportBatchDocument, prepareBatchDocument } from "../src/batch-document.mjs";
import { csvValues, parseCsvDocument } from "../src/csv-document.mjs";

/**
 * 双语导出的三条规则（用户定的）：
 * - 表格：有译文列就填那一列；没有就在原文件末尾新增一列「译文」，原文一个字都不动。
 * - mqxliff / xliff：直接填 target 写回原格式。
 * - 文本文档（txt / md / docx）：没有"列"这回事，给一份 xlsx 双语表。
 * 「导出译文」则是纯译文：docx 给纯译文文档、xlsx/csv 给单列译文，mqxliff 转 xlsx 单列译文表。
 */
async function xlsxBase64(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64");
}

async function readWorkbook(exported) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(exported.base64, "base64"));
  return workbook;
}

test("表格双语导出：没有译文列就在末尾新增一列，原文保持不动", async () => {
  const base64 = await xlsxBase64([["位置", "日文"], ["第 1 章", "こんにちは"], ["第 2 章", "さようなら"]]);
  const prepared = await prepareBatchDocument({ filename: "t.xlsx", base64, segmentationMode: "unit" });
  const segments = prepared.segments.map((segment, index) => ({ ...segment, translation: index ? "再见" : "你好" }));
  const exported = await exportBatchDocument({
    filename: "t.xlsx", format: "bilingual", sourceFormat: "xlsx", locale: "zh-CN",
    segments, structure: prepared.structure, base64
  });
  const sheet = (await readWorkbook(exported)).getWorksheet("Sheet1");
  assert.deepEqual(sheet.getRow(1).values.slice(1), ["位置", "日文", "译文"]);
  assert.deepEqual(sheet.getRow(2).values.slice(1), ["第 1 章", "こんにちは", "你好"]);
  assert.deepEqual(sheet.getRow(3).values.slice(1), ["第 2 章", "さようなら", "再见"]);
  assert.equal(exported.filename, "t.zh-CN.xlsx");
});

test("表格双语导出：上传时指定了译文列就写那一列，不再新增", async () => {
  const base64 = await xlsxBase64([["日文", "说明", "译文"], ["こんにちは", "开场", ""]]);
  const prepared = await prepareBatchDocument({ filename: "t2.xlsx", base64, segmentationMode: "unit" });
  assert.equal(prepared.structure.translationColumns.Sheet1.hasTranslationColumn, true);
  const exported = await exportBatchDocument({
    filename: "t2.xlsx", format: "bilingual", sourceFormat: "xlsx", locale: "zh-CN",
    segments: prepared.segments.map((segment) => ({ ...segment, translation: "你好" })),
    structure: prepared.structure, base64
  });
  const sheet = (await readWorkbook(exported)).getWorksheet("Sheet1");
  assert.deepEqual(sheet.getRow(2).values.slice(1), ["こんにちは", "开场", "你好"]);
});

test("CSV 双语导出：追加译文列；无表头时不写列头，避免顶掉一条正文", async () => {
  const withHeader = "位置,日文\n第 1 章,こんにちは\n";
  const prepared = await prepareBatchDocument({ filename: "a.csv", text: withHeader, segmentationMode: "unit" });
  const exported = await exportBatchDocument({
    filename: "a.csv", format: "bilingual", sourceFormat: "csv", locale: "zh-CN",
    segments: prepared.segments.map((segment) => ({ ...segment, translation: "你好" })),
    structure: prepared.structure, text: withHeader
  });
  assert.deepEqual(csvValues(parseCsvDocument(Buffer.from(exported.base64, "base64").toString("utf8"))), [["位置", "日文", "译文"], ["第 1 章", "こんにちは", "你好"]]);

  const headerless = "海外社媒;80字符内;八月已至。;August sale soon\n";
  const prepared2 = await prepareBatchDocument({ filename: "b.csv", text: headerless, segmentationMode: "paragraph" });
  const exported2 = await exportBatchDocument({
    filename: "b.csv", format: "bilingual", sourceFormat: "csv", locale: "zh-CN",
    segments: prepared2.segments.map((segment) => ({ ...segment, translation: "八月来了。" })),
    structure: prepared2.structure, text: headerless
  });
  const rows2 = csvValues(parseCsvDocument(Buffer.from(exported2.base64, "base64").toString("utf8")));
  assert.equal(rows2.length, 1, "无表头只应有一行正文");
  assert.equal(String(rows2[0][2]), "八月已至。", "原文列不能被覆盖，也不能被列头顶掉");
  assert.equal(String(rows2[0][rows2[0].length - 1]), "八月来了。");
});

test("mqxliff 双语写回 target；导出译文则转成 xlsx 单列", async () => {
  const original = `<?xml version="1.0" encoding="UTF-8"?>
<xliff xmlns="urn:oasis:names:tc:xliff:document:1.2" xmlns:mq="MQXliff" version="1.2"><file original="story"><body>
<trans-unit id="m1" mq:status="NotStarted"><source>こんにちは</source><target></target></trans-unit>
</body></file></xliff>`;
  const prepared = await prepareBatchDocument({ filename: "story.mqxliff", base64: Buffer.from(original, "utf8").toString("base64") });
  const segments = prepared.segments.map((segment) => ({ ...segment, translation: "你好" }));

  const bilingual = await exportBatchDocument({
    filename: "story.mqxliff", format: "bilingual", sourceFormat: "mqxliff", locale: "zh-CN",
    segments, base64: Buffer.from(original, "utf8").toString("base64")
  });
  assert.equal(bilingual.filename, "story.zh-CN.mqxliff");
  assert.match(Buffer.from(bilingual.base64, "base64").toString("utf8"), /<target>你好<\/target>/u);

  const translation = await exportBatchDocument({
    filename: "story.mqxliff", format: "translation", sourceFormat: "mqxliff", locale: "zh-CN", segments
  });
  assert.equal(translation.filename, "story.zh-CN.xlsx", "xliff 没有纯译文文件形态，转成单列译文表");
  const sheet = (await readWorkbook(translation)).getWorksheet("译文");
  assert.deepEqual(sheet.getColumn(1).values.slice(1), ["译文", "你好"], "第一行是列头");
});

test("文本文档的双语导出给 xlsx 双语表，导出译文给纯译文文件", async () => {
  const text = "第一句。\n第二句。\n";
  const prepared = await prepareBatchDocument({ filename: "story.txt", text, segmentationMode: "sentence" });
  const segments = prepared.segments.map((segment, index) => ({ ...segment, translation: `译文${index + 1}。` }));

  const bilingual = await exportBatchDocument({
    filename: "story.txt", format: "bilingual", sourceFormat: "text", locale: "zh-CN", segments
  });
  assert.equal(bilingual.filename, "story.zh-CN.xlsx");
  const sheet = (await readWorkbook(bilingual)).getWorksheet("双语对照");
  assert.deepEqual(sheet.getRow(1).values.slice(1), ["序号", "原文", "译文"]);
  assert.deepEqual(sheet.getRow(2).values.slice(1), [1, "第一句。", "译文1。"]);

  const translation = await exportBatchDocument({
    filename: "story.txt", format: "translation", sourceFormat: "text", locale: "zh-CN", segments
  });
  assert.equal(translation.filename, "story.zh-CN.txt");
  assert.equal(Buffer.from(translation.base64, "base64").toString("utf8"), "译文1。\n译文2。");
});
