import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { exportBatchDocument, prepareBatchDocument, segmentLongText } from "../src/batch-document.mjs";

test("批次只按完整句子或自然段切分，不使用固定字数", () => {
  const source = "第一句内容很长。第二句继续说明！第三句作为结尾。";
  const sentences = segmentLongText(source, "sentence");
  assert.deepEqual(sentences, ["第一句内容很长。", "第二句继续说明！", "第三句作为结尾。"]);
  assert.equal(sentences.join(""), source);
  assert.deepEqual(segmentLongText(source, "paragraph"), [source]);
  assert.equal(segmentLongText("没有标点但非常长".repeat(200), "sentence").length, 1);
});

test("TXT 解析、分段和导出保持换行结构", async () => {
  const source = "第一段。\r\n\r\n第二段。";
  const prepared = await prepareBatchDocument({ filename: "story.txt", text: source, segmentationMode: "sentence" });
  assert.equal(prepared.format, "text");
  assert.equal(prepared.segments.length, 2);

  const exported = await exportBatchDocument({
    filename: prepared.filename,
    locale: "ja-JP",
    format: prepared.format,
    structure: prepared.structure,
    segments: prepared.segments.map((segment) => ({ ...segment, translation: `译${segment.index}` }))
  });
  assert.equal(Buffer.from(exported.base64, "base64").toString("utf8"), "译1\r\n\r\n译2");
  assert.equal(exported.filename, "story.ja-JP.txt");
});

test("历史任务可导出包含 AIQA 与人工决定的 Excel", async () => {
  const exported = await exportBatchDocument({
    filename: "历史公告.txt", locale: "ja-JP", format: "task-xlsx",
    segments: [{ id: "1", source: "欢迎回来。", translation: "おかえりなさい。", status: "done", selected: true, result: { qaScore: 100, issues: [{ message: "语气建议" }], aiQa: { humanDecisions: [{ decision: "approved_as_is", issue: { message: "语气建议" } }] } } }]
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(exported.base64, "base64"));
  const sheet = workbook.getWorksheet("翻译任务");
  assert.equal(sheet.getCell("B2").value, "欢迎回来。");
  assert.equal(sheet.getCell("C2").value, "おかえりなさい。");
  assert.match(String(sheet.getCell("F2").value), /语气建议/);
  assert.match(String(sheet.getCell("G2").value), /批准当前译文/);
  assert.equal(exported.filename, "历史公告.ja-JP.xlsx");
});

test("同一自然段可选择逐句或整段翻译", async () => {
  const source = "第一句。第二句！第三句？";
  const sentenceMode = await prepareBatchDocument({ filename: "story.md", text: source, segmentationMode: "sentence" });
  const paragraphMode = await prepareBatchDocument({ filename: "story.md", text: source, segmentationMode: "paragraph" });
  assert.equal(sentenceMode.segments.length, 3);
  assert.equal(paragraphMode.segments.length, 1);
  assert.equal(paragraphMode.segments[0].source, source);
});

test("XLIFF 导入仅选择空且未锁定的 trans-unit，并在导出时恢复内联标签", async () => {
  const original = `<?xml version="1.0" encoding="UTF-8"?>
<xliff xmlns="urn:oasis:names:tc:xliff:document:1.2" version="1.2"><file original="story"><body>
<trans-unit id="u1"><source>こんにちは <ph id="p1">{player}</ph>！</source><context-group><context context-type="x-location">menu</context></context-group><note>主菜单问候</note></trans-unit>
<trans-unit id="u2" translate="no"><source>固定文</source><target>已锁定</target></trans-unit>
<trans-unit id="u3"><source><g id="g1">強調</g></source></trans-unit>
<trans-unit id="u4"><source>既存テキスト</source><target>已有译文</target></trans-unit>
</body></file></xliff>`;
  const prepared = await prepareBatchDocument({ filename: "story.xliff", base64: Buffer.from(original, "utf8").toString("base64") });
  assert.equal(prepared.format, "xliff");
  assert.equal(prepared.segments.length, 2);
  assert.match(prepared.segments[0].source, /<tag id='tag-1' type='inline' desc='ph'\/>/);
  assert.match(prepared.segments[1].source, /inline-open/);
  assert.match(prepared.segments[0].context.note, /menu.*主菜单问候/);

  const translated = prepared.segments.map((segment) => ({
    ...segment,
    translation: segment.source.replace("こんにちは", "你好").replace("強調", "强调")
  }));
  const exported = await exportBatchDocument({
    filename: prepared.filename,
    locale: "zh-CN",
    format: prepared.format,
    structure: prepared.structure,
    base64: Buffer.from(original, "utf8").toString("base64"),
    segments: translated
  });
  const output = Buffer.from(exported.base64, "base64").toString("utf8");
  assert.equal(exported.filename, "story.zh-CN.xliff");
  assert.match(output, /<target xml:space="preserve">你好 <ph id="p1">\{player\}<\/ph>！<\/target>/);
  assert.match(output, /<target xml:space="preserve"><g id="g1">强调<\/g><\/target>/);
  assert.match(output, /<trans-unit id="u2" translate="no"><source>固定文<\/source><target>已锁定<\/target>/);
  assert.match(output, /<trans-unit id="u4"><source>既存テキスト<\/source><target>已有译文<\/target>/);

  await assert.rejects(
    exportBatchDocument({
      filename: prepared.filename,
      locale: "zh-CN",
      format: prepared.format,
      base64: Buffer.from(original, "utf8").toString("base64"),
      segments: [{ ...prepared.segments[0], translation: "Hello!" }]
    }),
    /内联标签/
  );
});

test("MQXLIFF 导出保留锁定单元和 bpt/ept 标签，并写入 Pretranslated 状态", async () => {
  const original = `<?xml version="1.0" encoding="UTF-8"?>
<xliff xmlns="urn:oasis:names:tc:xliff:document:1.2" xmlns:mq="MQXliff" version="1.2"><file original="story"><body>
<trans-unit id="m1" mq:status="NotStarted"><source>こんにちは <bpt id="1">&lt;b&gt;</bpt>世界<ept id="1">&lt;/b&gt;</ept>！</source><target></target></trans-unit>
<trans-unit id="m2" mq:locked="locked" mq:status="Translated"><source>変更不可</source><target>保留</target></trans-unit>
</body></file></xliff>`;
  const prepared = await prepareBatchDocument({ filename: "story.mqxliff", base64: Buffer.from(original, "utf8").toString("base64") });
  assert.equal(prepared.format, "mqxliff");
  assert.equal(prepared.segments.length, 1);
  assert.match(prepared.segments[0].source, /desc='bpt'/);
  assert.match(prepared.segments[0].source, /desc='ept'/);

  const exported = await exportBatchDocument({
    filename: prepared.filename,
    locale: "zh-CN",
    format: prepared.format,
    base64: Buffer.from(original, "utf8").toString("base64"),
    segments: [{ ...prepared.segments[0], translation: prepared.segments[0].source.replace("こんにちは", "你好") }]
  });
  const output = Buffer.from(exported.base64, "base64").toString("utf8");
  assert.equal(exported.filename, "story.zh-CN.mqxliff");
  assert.match(output, /<trans-unit id="m1" mq:status="Pretranslated">/);
  assert.match(output, /<target>.*<bpt id="1">&lt;b&gt;<\/bpt>世界<ept id="1">&lt;\/b&gt;<\/ept>！<\/target>/);
  assert.match(output, /<trans-unit id="m2" mq:locked="locked" mq:status="Translated"><source>変更不可<\/source><target>保留<\/target>/);
});

test("DOCX 翻译导出保留文档容器并替换段落", async () => {
  const zip = new JSZip();
  zip.file("word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>第一段。</w:t></w:r></w:p><w:p><w:r><w:t>第二段。</w:t></w:r></w:p></w:body></w:document>');
  zip.file("[Content_Types].xml", "<Types></Types>");
  const original = await zip.generateAsync({ type: "nodebuffer" });
  const prepared = await prepareBatchDocument({ filename: "story.docx", base64: original.toString("base64") });
  assert.equal(prepared.segments.length, 2);

  const exported = await exportBatchDocument({
    filename: prepared.filename,
    locale: "ko-KR",
    format: prepared.format,
    structure: prepared.structure,
    base64: original.toString("base64"),
    segments: prepared.segments.map((segment) => ({ ...segment, translation: `번역${segment.index}` }))
  });
  const outputZip = await JSZip.loadAsync(Buffer.from(exported.base64, "base64"));
  const xml = await outputZip.file("word/document.xml").async("string");
  assert.match(xml, /번역1/);
  assert.match(xml, /번역2/);
});

test("XLSX 只抽取日语单元格并在原位置写回简体中文译文", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("剧情");
  sheet.getCell("A1").value = "日语原文";
  sheet.getCell("A2").value = "おかえりなさい！";
  sheet.getCell("B1").value = "简体中文";
  sheet.getCell("B2").value = "保留";
  const original = Buffer.from(await workbook.xlsx.writeBuffer());
  const prepared = await prepareBatchDocument({ filename: "lines.xlsx", base64: original.toString("base64") });
  assert.equal(prepared.segments.length, 1);

  const exported = await exportBatchDocument({
    filename: prepared.filename,
    locale: "zh-CN",
    format: prepared.format,
    structure: prepared.structure,
    base64: original.toString("base64"),
    segments: prepared.segments.map((segment) => ({ ...segment, translation: "欢迎回来！" }))
  });
  const result = new ExcelJS.Workbook();
  await result.xlsx.load(Buffer.from(exported.base64, "base64"));
  assert.equal(result.getWorksheet("剧情").getCell("A2").value, "欢迎回来！");
  assert.equal(result.getWorksheet("剧情").getCell("B2").value, "保留");
});

test("XLSX 只把日语正文列做成翻译单元，行内字段作为上下文", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("交付表");
  sheet.addRow(["位置", "描述", "DDL", "语种要求", "Japanese", "Chinese Simp."]);
  sheet.addRow(["海外社媒", "无字符限制", "8月3日", "日中", "8月になり、セールが始まります！", "八月已至，折扣活动即将开启！"]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const prepared = await prepareBatchDocument({ filename: "delivery.xlsx", base64: buffer.toString("base64"), segmentationMode: "paragraph" });
  assert.equal(prepared.segments.length, 1);
  assert.equal(prepared.segments[0].source, "8月になり、セールが始まります！");
  assert.deepEqual(prepared.segments[0].context.metadata.map((item) => item.value), ["海外社媒", "无字符限制", "8月3日", "日中"]);
  assert.equal(prepared.segments[0].context.referenceTranslations[0].value, "八月已至，折扣活动即将开启！");
  assert.equal(prepared.structure.cells[0].address, "E2");
});

test("无表头 XLSX 也能自动找到正文列且不翻译元数据", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("无表头");
  sheet.addRow(["海外社媒", "无字符限制", "八月已至，折扣活动即将开启！完成任务还可领取奖励。", "August is here and the sale is coming!"]);
  sheet.addRow(["官网标题", "80字符内", "《黑神话：悟空》即将开启七折优惠。", "Black Myth sale soon"]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const prepared = await prepareBatchDocument({ filename: "headerless.xlsx", base64: buffer.toString("base64"), segmentationMode: "paragraph" });
  assert.equal(prepared.spreadsheetAnalysis.sheets[0].headerRow, null);
  assert.deepEqual(prepared.segments.map((segment) => segment.locator.address), ["C1", "C2"]);
  assert.equal(prepared.segments.some((segment) => segment.source === "海外社媒"), false);
});

test("XLSX 可采用 AI 返回的无表头列角色", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("AI识别");
  sheet.addRow(["官网标题", "80字符内", "限时折扣现已开启。"]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  let snapshotSeen = false;
  const prepared = await prepareBatchDocument({ filename: "ai.xlsx", base64: buffer.toString("base64"), segmentationMode: "paragraph" }, {
    analyzeSpreadsheet: async (snapshot) => {
      snapshotSeen = snapshot.sheets[0].columns.length === 3;
      return { sheets: [{ sheet: "AI识别", headerRow: null, confidence: 0.96, reason: "按列内容推断", columns: [
        { column: 1, label: "位置", role: "context", confidence: 0.94 },
        { column: 2, label: "字数限制", role: "constraint", confidence: 0.98 },
        { column: 3, label: "中文正文", role: "source_text", confidence: 0.99 }
      ] }] };
    }
  });
  assert.equal(snapshotSeen, true);
  assert.equal(prepared.spreadsheetAnalysis.usedModel, true);
  assert.equal(prepared.segments.length, 1);
  assert.deepEqual(prepared.segments[0].context.metadata.map((item) => item.value), ["官网标题", "80字符内"]);
});

test("CSV 有表头时复用日中表格结构识别并原位回写译文", async () => {
  const source = '\uFEFF位置,字数限制,Japanese,Chinese Simp.\r\n官网标题,80字符内,"8月になり、セールが始まります！","八月已至，折扣活动即将开启！"\r\n';
  const base64 = Buffer.from(source, "utf8").toString("base64");
  const prepared = await prepareBatchDocument({ filename: "delivery.csv", base64, segmentationMode: "paragraph" });

  assert.equal(prepared.format, "csv");
  assert.equal(prepared.spreadsheetAnalysis.sheets[0].headerRow, 1);
  assert.equal(prepared.segments.length, 1);
  assert.equal(prepared.segments[0].source, "8月になり、セールが始まります！");
  assert.deepEqual(prepared.segments[0].context.metadata.map((item) => item.value), ["官网标题", "80字符内"]);
  assert.equal(prepared.segments[0].context.referenceTranslations[0].value, "八月已至，折扣活动即将开启！");

  const exported = await exportBatchDocument({
    filename: prepared.filename,
    locale: "zh-CN",
    format: prepared.format,
    structure: prepared.structure,
    base64,
    segments: prepared.segments.map((segment) => ({ ...segment, translation: "八月已至，折扣活动即将开启！" }))
  });
  const output = Buffer.from(exported.base64, "base64").toString("utf8");
  assert.equal(output, '\uFEFF位置,字数限制,Japanese,Chinese Simp.\r\n官网标题,80字符内,"八月已至，折扣活动即将开启！","八月已至，折扣活动即将开启！"\r\n');
  assert.equal(exported.filename, "delivery.zh-CN.csv");
  assert.equal(exported.mimeType, "text/csv; charset=utf-8");
});

test("无表头分号 CSV 自动找到正文列且不改动其他列", async () => {
  const source = "海外社媒;80字符内;八月已至，折扣活动即将开启！完成任务还可领取奖励。;August sale soon\n官网标题;30字符内;限时折扣现已开启。;Sale now";
  const prepared = await prepareBatchDocument({ filename: "headerless.csv", text: source, segmentationMode: "paragraph" });

  assert.equal(prepared.structure.csv.delimiter, ";");
  assert.equal(prepared.spreadsheetAnalysis.sheets[0].headerRow, null);
  assert.deepEqual(prepared.segments.map((segment) => [segment.locator.row, segment.locator.column]), [[1, 3], [2, 3]]);

  const exported = await exportBatchDocument({
    filename: prepared.filename,
    locale: "ko-KR",
    format: "csv",
    structure: prepared.structure,
    text: source,
    segments: prepared.segments.map((segment) => ({ ...segment, translation: `번역 ${segment.index}` }))
  });
  assert.equal(Buffer.from(exported.base64, "base64").toString("utf8"), "海外社媒;80字符内;번역 1;August sale soon\n官网标题;30字符内;번역 2;Sale now");
});

test("CSV 支持带换行的引号字段并仅重写目标单元格", async () => {
  const source = '位置,Chinese Simp.,English\r\n剧情,"第一句。\n第二句。","Existing translation"\r\n';
  const prepared = await prepareBatchDocument({ filename: "multiline.csv", text: source, segmentationMode: "paragraph" });
  assert.equal(prepared.segments.length, 1);
  assert.equal(prepared.segments[0].source, "第一句。\n第二句。");

  const exported = await exportBatchDocument({
    filename: prepared.filename,
    locale: "th-TH",
    format: "csv",
    structure: prepared.structure,
    text: source,
    segments: [{ ...prepared.segments[0], translation: 'บรรทัดหนึ่ง,\n"บรรทัดสอง"' }]
  });
  assert.equal(Buffer.from(exported.base64, "base64").toString("utf8"), '位置,Chinese Simp.,English\r\n剧情,"บรรทัดหนึ่ง,\n""บรรทัดสอง""","Existing translation"\r\n');
});

test("单列 CSV 的日语表头不会被当作待翻译正文", async () => {
  const source = "日语原文\nおかえりなさい！\nイベントが始まりました。";
  const prepared = await prepareBatchDocument({ filename: "single-column.csv", text: source, segmentationMode: "paragraph" });
  assert.equal(prepared.spreadsheetAnalysis.sheets[0].headerRow, 1);
  assert.deepEqual(prepared.segments.map((segment) => segment.source), ["おかえりなさい！", "イベントが始まりました。"]);
});
