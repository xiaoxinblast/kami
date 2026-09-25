import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import JSZip from "jszip";

import { extractReferenceFile, MAX_VISION_IMAGES_PER_DOCUMENT } from "../src/reference-materials.mjs";

/**
 * 文档里的图片也是资料：截图、示意图、界面标注这些内容正文里根本没有，
 * 所以 DOCX / XLSX / PPTX 的内嵌图片、PDF 扫描页、单独上传的图片都要交给模型识图，
 * 转录结果拼在正文后面并标明来源。
 */
async function pngBuffer(size = 80) {
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(size, size);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size, size);
  context.fillStyle = "#222222";
  context.fillRect(0, 0, Math.ceil(size / 2), Math.ceil(size / 2));
  return canvas.toBuffer("image/png");
}

/**
 * 手写一份最小 PDF：一页文字层 + 一张内嵌图片（RGB 图像 XObject）。
 * 真实 PDF 里"正文 + 截图"就是这种结构，文字抽得到、图片得单独取。
 */
function pdfWithTextAndImage({ withImage = true } = {}) {
  const width = 120;
  const height = 90;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      raw[offset] = (x * 2) % 256;
      raw[offset + 1] = (y * 3) % 256;
      raw[offset + 2] = 90;
    }
  }
  const content = `BT /F1 12 Tf 20 260 Td (SCENARIO ORDER TEXT LAYER SECTION ONE) Tj ET\n${withImage ? "q 120 0 0 90 20 100 cm /Im1 Do Q\n" : ""}`;
  const resources = withImage
    ? "<< /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >>"
    : "<< /Font << /F1 5 0 R >> >>";
  const entries = [
    { text: "<< /Type /Catalog /Pages 2 0 R >>" },
    { text: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { text: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources ${resources} /Contents 4 0 R >>` },
    { text: `<< /Length ${content.length} >>\nstream\n${content}endstream` },
    { text: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" }
  ];
  if (withImage) {
    entries.push({
      text: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${raw.length} >>\nstream\n`,
      binary: raw,
      binaryTail: "\nendstream"
    });
  }
  const parts = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets = [];
  let position = parts[0].length;
  entries.forEach((entry, index) => {
    offsets.push(position);
    const header = Buffer.from(`${index + 1} 0 obj\n`, "latin1");
    const dictionary = Buffer.from(`${entry.text}\n`, "latin1");
    const body = entry.binary || Buffer.alloc(0);
    const tail = Buffer.from(`${entry.binaryTail || ""}\nendobj\n`, "latin1");
    parts.push(header, dictionary, body, tail);
    position += header.length + dictionary.length + body.length + tail.length;
  });
  const xrefOffset = position;
  const rows = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  parts.push(Buffer.from(`xref\n0 ${entries.length + 1}\n0000000000 65535 f \n${rows}`, "latin1"));
  parts.push(Buffer.from(`trailer\n<< /Size ${entries.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}

/** 识图钩子的桩：记录每次调用，返回固定转录文本。 */
function visionStub(text = "图片里的文字：旧魔晄炉") {
  const calls = [];
  return {
    calls,
    hook: async ({ label, mediaType = "image/png", render }) => {
      const base64 = await render();
      calls.push({ label, mediaType, bytes: base64.length });
      return text;
    }
  };
}

test("PPTX 幻灯片里的图片会被送去识图，并标出来源", async () => {
  const archive = new JSZip();
  const slide = (text) => `<?xml version="1.0"?><p:sld xmlns:a="x"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  archive.file("ppt/slides/slide1.xml", slide("第一张：角色一览"));
  archive.file("ppt/slides/slide2.xml", slide(""));
  archive.file("ppt/slides/_rels/slide2.xml.rels", `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>`);
  archive.file("ppt/media/image1.png", await pngBuffer());
  const buffer = await archive.generateAsync({ type: "nodebuffer" });

  const blind = visionStub();
  const parsed = await extractReferenceFile({ filename: "scenario.pptx", base64: buffer.toString("base64"), onScannedPage: blind.hook });
  assert.equal(parsed.pages.length, 2);
  assert.match(parsed.pages[0].text, /第一张：角色一览/u);
  assert.match(parsed.pages[1].text, /〔图片文字〕/u, "图片转录要标出来源");
  assert.match(parsed.pages[1].text, /旧魔晄炉/u);
  assert.equal(parsed.visionImages, 1);
  assert.equal(blind.calls[0].label, "第 2 张幻灯片里的图片 #1");
  assert.equal(blind.calls[0].mediaType, "image/png");
});

test("DOCX 里的插图会被送去识图，正文与图片文字都保留", async () => {
  const archive = new JSZip();
  archive.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>角色设定：林晚。</w:t></w:r></w:p></w:body></w:document>`);
  archive.file("word/media/image1.png", await pngBuffer());
  const buffer = await archive.generateAsync({ type: "nodebuffer" });

  const blind = visionStub();
  const parsed = await extractReferenceFile({ filename: "setting.docx", base64: buffer.toString("base64"), onScannedPage: blind.hook });
  assert.equal(parsed.format, "docx");
  assert.match(parsed.pages[0].text, /角色设定：林晚。/u);
  assert.match(parsed.pages[0].text, /〔图片文字〕/u);
  assert.equal(parsed.visionImages, 1);
  assert.equal(blind.calls[0].label, "文档里的图片 #1");
});

test("XLSX 里贴的图片会被送去识图", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("截图");
  sheet.addRow(["位置", "说明"]);
  sheet.addRow(["第 1 章", "旧魔晄炉"]);
  const imageId = workbook.addImage({ name: "shot", buffer: await pngBuffer(), extension: "png" });
  sheet.addImage(imageId, { tl: { col: 3, row: 1 }, br: { col: 6, row: 6 } });
  const buffer = await workbook.xlsx.writeBuffer();

  const blind = visionStub();
  const parsed = await extractReferenceFile({ filename: "shots.xlsx", base64: Buffer.from(buffer).toString("base64"), onScannedPage: blind.hook });
  assert.equal(parsed.format, "xlsx");
  assert.match(parsed.pages[0].text, /旧魔晄炉/u);
  assert.match(parsed.pages[0].text, /〔图片文字〕/u);
  assert.equal(parsed.visionImages, 1);
  assert.equal(blind.calls[0].label, "工作表「截图」里的图片 #1");
});

test("单独上传的图片直接整张识图；没有识图能力时标记待识图而不是失败", async () => {
  const base64 = (await pngBuffer()).toString("base64");
  const blind = visionStub("界面截图上的按钮：开始游戏");
  const parsed = await extractReferenceFile({ filename: "shot.png", base64, onScannedPage: blind.hook });
  assert.equal(parsed.format, "png");
  assert.equal(parsed.recognizedPages, 1);
  assert.equal(parsed.visionImages, 0, "独立图片算页，不算内嵌图片，避免统计重算两次");
  assert.equal(parsed.pages[0].origin, "vision");
  assert.match(parsed.pages[0].text, /开始游戏/u);
  assert.equal(blind.calls[0].label, "这张图片");
  assert.equal(blind.calls[0].mediaType, "image/png");

  const withoutModel = await extractReferenceFile({ filename: "shot.webp", base64 });
  assert.equal(withoutModel.pendingPages, 1);
  assert.equal(withoutModel.characters, 0);
});

test("PDF 有文字层的页面里嵌的图片也要单独取出来识图", async () => {
  const blind = visionStub("图片里的文字：地图标注 旧魔晄炉");
  const withImage = await extractReferenceFile({
    filename: "scenario.pdf",
    base64: pdfWithTextAndImage().toString("base64"),
    onScannedPage: blind.hook
  });
  assert.match(withImage.pages[0].text, /SCENARIO ORDER TEXT LAYER SECTION ONE/u, "文字层照旧抽出来");
  assert.match(withImage.pages[0].text, /〔图片文字〕/u, "同一页里的图片也要转录");
  assert.equal(withImage.visionImages, 1);
  assert.equal(withImage.pages[0].origin, "text", "有文字层就不算扫描页");
  assert.equal(blind.calls.length, 1);
  assert.match(blind.calls[0].label, /第 1 页里的图片 #1/u);

  const textOnly = await extractReferenceFile({
    filename: "text-only.pdf",
    base64: pdfWithTextAndImage({ withImage: false }).toString("base64"),
    onScannedPage: blind.hook
  });
  assert.match(textOnly.pages[0].text, /SCENARIO ORDER TEXT LAYER SECTION ONE/u);
  assert.doesNotMatch(textOnly.pages[0].text, /〔图片文字〕/u);
  assert.equal(textOnly.visionImages, 0, "纯文字页不做任何识图，不白花 token");
});

test("图标级小图跳过并计数，超出限额的图片记为超额", async () => {
  const archive = new JSZip();
  archive.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body></w:document>`);
  archive.file("word/media/icon.png", await pngBuffer(16));
  archive.file("word/media/diagram.emf", Buffer.from("<xml/>", "utf8"));
  const small = await archive.generateAsync({ type: "nodebuffer" });
  const blind = visionStub();
  const parsed = await extractReferenceFile({ filename: "small.docx", base64: small.toString("base64"), onScannedPage: blind.hook });
  assert.equal(parsed.visionImages, 0);
  assert.equal(parsed.skippedImages, 1, "16px 的图标不送去识图，矢量图不认");
  assert.equal(blind.calls.length, 0);

  const many = new JSZip();
  many.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body></w:document>`);
  const png = await pngBuffer();
  const total = MAX_VISION_IMAGES_PER_DOCUMENT + 2;
  for (let index = 1; index <= total; index += 1) many.file(`word/media/image${index}.png`, png);
  const big = await many.generateAsync({ type: "nodebuffer" });
  const capped = visionStub();
  const parsedMany = await extractReferenceFile({ filename: "many.docx", base64: big.toString("base64"), onScannedPage: capped.hook });
  assert.equal(parsedMany.visionImages, MAX_VISION_IMAGES_PER_DOCUMENT);
  assert.equal(parsedMany.cappedImages, 2);
  assert.equal(capped.calls.length, MAX_VISION_IMAGES_PER_DOCUMENT);
});
