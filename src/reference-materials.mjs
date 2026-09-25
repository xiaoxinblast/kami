/**
 * 参考资料：文件解析、分块与风险扫描。
 *
 * 参考资料和术语/TM 不同——它们不随每次翻译注入提示词，只在模型主动查询时
 * 才作为工具结果返回片段。因此这里只负责把上传文件变成可检索的片段，
 * 不做任何审批与权重计算。
 */

import { extname, basename } from "node:path";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { csvValues, parseCsvDocument } from "./csv-document.mjs";
import { hasInjectionSignature } from "./style-rules.mjs";

export const REFERENCE_KINDS = Object.freeze({
  character: "角色设定",
  script: "剧本",
  synopsis: "故事梗概",
  setting: "设定资料",
  other: "其他"
});

export const REFERENCE_FORMATS = Object.freeze([".txt", ".md", ".docx", ".xlsx", ".csv", ".pdf", ".pptx"]);

/** 与双语资产导入保持一致的单文件上限。 */
export const MAX_REFERENCE_FILE_BYTES = 20 * 1024 * 1024;
/** 低于这个字符数的 PDF 页面按扫描页处理，交给模型看图。 */
const SCANNED_PAGE_MIN_CHARS = 20;
export const CHUNK_TARGET_CHARS = 600;
export const CHUNK_OVERLAP_CHARS = 80;
export const MAX_CHUNKS_PER_DOCUMENT = 2_000;

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&")
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function normalizeText(value) {
  return String(value || "")
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t ]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function decodeBase64(base64) {
  return Buffer.from(String(base64 || "").replace(/^data:[^;]+;base64,/u, ""), "base64");
}

async function docxPages(buffer) {
  const archive = await JSZip.loadAsync(buffer);
  const documentFile = archive.file("word/document.xml");
  if (!documentFile) throw Object.assign(new Error("DOCX 中缺少正文内容"), { statusCode: 422 });
  const xml = await documentFile.async("string");
  const text = decodeXml(xml
    .replace(/<w:tab\b[^>]*\/>/gu, "\t")
    .replace(/<w:(?:br|cr)\b[^>]*\/>/gu, "\n")
    .replace(/<\/w:p>/gu, "\n")
    .replace(/<[^>]+>/gu, ""));
  return [{ page: null, text: normalizeText(text), origin: "text" }];
}

async function spreadsheetPages(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const pages = [];
  for (const worksheet of workbook.worksheets) {
    const rows = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      for (let index = 1; index <= worksheet.columnCount; index += 1) {
        cells.push(spreadsheetCellText(row.getCell(index)));
      }
      const line = cells.join("\t").trimEnd();
      if (line.trim()) rows.push(line);
    });
    const text = normalizeText(rows.join("\n"));
    if (text) pages.push({ page: worksheet.name || null, text, origin: "text" });
  }
  return pages;
}

/**
 * 单元格文本：不能直接用 ExcelJS 的 `cell.text`。
 *
 * 合并区域的从属单元格拿到的是 MergeValue，它的 `toString()` 会对 master 的值调用
 * `.toString()`；master 本身是空值时就是 `null.toString()` —— 实测上传
 * END3_CorelTrain_SCENARIO_ORDER.xlsx 时整份参考资料导入直接失败，报的就是
 * "Cannot read properties of null (reading 'toString')"。
 * 这里自己取原始值再格式化：数字 / 日期 / 富文本 / 公式结果 / 超链接各按需要拼。
 */
function spreadsheetCellText(cell) {
  const raw = cell?.value ?? null;
  // MergeValue 的内部形态：指向 master，取它的值即可（绝不调用 toString）。
  const value = raw && typeof raw === "object" && "_master" in raw ? raw.value : raw;
  return plainCellText(value).trim();
}

function plainCellText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value.richText)) return value.richText.map((part) => String(part?.text ?? "")).join("");
  if (Array.isArray(value)) return value.map(plainCellText).join(" ");
  if (value.error) return String(value.error);
  if (Object.hasOwn(value, "result")) return plainCellText(value.result);
  // 超链接单元格是 { text, hyperlink }。
  if (Object.hasOwn(value, "text")) return plainCellText(value.text);
  if (Object.hasOwn(value, "hyperlink")) return String(value.hyperlink);
  return "";
}

/**
 * PPTX：每张幻灯片算一页，取 <a:t> 里的文字（形状、表格、备注文本框都在这套标签里）。
 * 图片型幻灯片抽不到文字，会在导入报告里体现为"没有可读文字"。
 */
async function pptxPages(buffer) {
  const archive = await JSZip.loadAsync(buffer);
  const slides = Object.keys(archive.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort((left, right) => Number(left.match(/(\d+)/u)[1]) - Number(right.match(/(\d+)/u)[1]));
  if (!slides.length) throw Object.assign(new Error("PPTX 中找不到幻灯片"), { statusCode: 422 });
  const pages = [];
  for (const [index, name] of slides.entries()) {
    const xml = await archive.file(name).async("string");
    const text = normalizeText(decodeXml(xml
      .replace(/<a:br\b[^>]*\/>/gu, "\n")
      .replace(/<\/a:p>/gu, "\n")
      .replace(/<[^>]+>/gu, "")));
    if (text) pages.push({ page: index + 1, text, origin: "text" });
  }
  return pages;
}

function csvPages(buffer) {
  const document = parseCsvDocument(buffer.toString("utf8"));
  const text = normalizeText(csvValues(document).map((row) => (Array.isArray(row) ? row.join("\t") : String(row ?? ""))).join("\n"));
  return text ? [{ page: null, text, origin: "text" }] : [];
}

/**
 * PDF：先取文字层；抽不到文字的页面渲染成图片，交给调用方用模型识图。
 * `onScannedPage` 缺省时这类页面会被标记为需要识图但不阻塞其余页面。
 */
async function pdfPages(buffer, { onScannedPage = null } = {}) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: false, disableFontFace: true }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    let text = "";
    try {
      const content = await page.getTextContent();
      text = normalizeText(content.items.map((item) => String(item.str || "")).join(" "));
    } catch {
      text = "";
    }
    if ([...text].length >= SCANNED_PAGE_MIN_CHARS) {
      pages.push({ page: pageNumber, text, origin: "text" });
      continue;
    }
    if (typeof onScannedPage !== "function") {
      pages.push({ page: pageNumber, text, origin: "text", needsVision: true });
      continue;
    }
    const recognized = normalizeText(await onScannedPage({ page: pageNumber, render: () => renderPdfPage(page) }));
    pages.push({ page: pageNumber, text: recognized, origin: "vision", needsVision: recognized === "" });
  }
  return pages;
}

/** 把一页 PDF 渲染成 PNG（base64），交给模型识图。 */
async function renderPdfPage(page) {
  const { createCanvas } = await import("@napi-rs/canvas");
  const viewport = page.getViewport({ scale: 1.5 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvas, viewport }).promise;
  return canvas.toBuffer("image/png").toString("base64");
}

export function referenceFormatOf(filename) {
  const extension = extname(basename(String(filename || "").trim())).toLowerCase();
  if (!REFERENCE_FORMATS.includes(extension)) {
    throw Object.assign(new Error(`参考资料仅支持 ${REFERENCE_FORMATS.join("、")}`), { statusCode: 400 });
  }
  return extension.replace(/^\./u, "");
}

/**
 * 解析上传的参考资料。返回按"页/工作表"分组的分段文本；PDF 的扫描页由
 * `onScannedPage` 决定怎么识图，测试里可以注入桩函数。
 */
export async function extractReferenceFile({ filename, base64, onScannedPage = null } = {}) {
  const safeName = basename(String(filename || "").trim());
  const format = referenceFormatOf(safeName);
  const buffer = decodeBase64(base64);
  if (!buffer.length) throw Object.assign(new Error("文件内容为空"), { statusCode: 400 });
  if (buffer.length > MAX_REFERENCE_FILE_BYTES) {
    throw Object.assign(new Error(`单个参考资料不能超过 ${Math.round(MAX_REFERENCE_FILE_BYTES / 1024 / 1024)}MB`), { statusCode: 400 });
  }
  let pages;
  if (format === "docx") pages = await docxPages(buffer);
  else if (format === "xlsx") pages = await spreadsheetPages(buffer);
  else if (format === "pptx") pages = await pptxPages(buffer);
  else if (format === "csv") pages = await csvPages(buffer);
  else if (format === "pdf") pages = await pdfPages(buffer, { onScannedPage });
  else pages = [{ page: null, text: normalizeText(buffer.toString("utf8")), origin: "text" }];
  pages = pages.filter((page) => page && (String(page.text || "").trim() || page.needsVision));
  return {
    name: safeName.replace(/\.[^.]+$/u, ""),
    format,
    pages,
    characters: pages.reduce((total, page) => total + [...String(page.text || "")].length, 0),
    recognizedPages: pages.filter((page) => page.origin === "vision").length,
    pendingPages: pages.filter((page) => page.needsVision === true).length
  };
}

const HEADING_PATTERN = /^(?:#{1,6}\s+.+|第[0-9一二三四五六七八九十百]+[章节幕场][^\n]{0,30}|[【\[].{1,40}[】\]])$/u;

function isHeading(line) {
  const text = String(line || "").trim();
  if (!text || [...text].length > 40) return false;
  return HEADING_PATTERN.test(text);
}

/**
 * 按标题与段落切块。长段落按目标字数硬切，块之间保留一段重叠，
 * 避免答案正好落在切口上。
 */
export function chunkReferencePages(pages = [], { targetChars = CHUNK_TARGET_CHARS, overlapChars = CHUNK_OVERLAP_CHARS, maxChunks = MAX_CHUNKS_PER_DOCUMENT } = {}) {
  const chunks = [];
  let heading = "";
  for (const page of Array.isArray(pages) ? pages : []) {
    const pageLabel = page?.page == null ? "" : String(page.page);
    const blocks = String(page?.text || "").split(/\n{2,}/u).map((block) => block.trim()).filter(Boolean);
    for (const block of blocks) {
      const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
      if (lines.length && isHeading(lines[0])) heading = lines[0].replace(/^#+\s*/u, "").trim();
      const body = (lines.length && isHeading(lines[0]) ? lines.slice(1) : lines).join("\n").trim();
      if (!body) continue;
      const pieces = [...body].length <= targetChars
        ? [body]
        : spliceLongText(body, targetChars, overlapChars);
      for (const piece of pieces) {
        if (!piece.trim()) continue;
        if (chunks.length >= maxChunks) return chunks;
        chunks.push({
          ordinal: chunks.length,
          heading,
          text: piece.trim(),
          page: pageLabel,
          origin: page?.origin === "vision" ? "vision" : "text"
        });
      }
    }
  }
  return chunks;
}

function spliceLongText(text, targetChars, overlapChars) {
  const characters = [...text];
  const pieces = [];
  const step = Math.max(1, targetChars - overlapChars);
  for (let start = 0; start < characters.length; start += step) {
    const piece = characters.slice(start, start + targetChars).join("").trim();
    if (piece) pieces.push(piece);
    if (start + targetChars >= characters.length) break;
  }
  return pieces;
}

/** 参考资料同样是不可信输入：命中注入特征就默认不参与检索。 */
export function scanReferenceRisk(text) {
  return hasInjectionSignature(text);
}
