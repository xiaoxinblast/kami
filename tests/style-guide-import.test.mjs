import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { extractStyleGuideFile } from "../src/style-guide-import.mjs";

test("TXT 与 Markdown 风格指南保留正文并生成名称", async () => {
  const result = await extractStyleGuideFile({
    filename: "日中风格指南.md",
    base64: Buffer.from("# 对白\r\n\r\n使用自然口语。", "utf8").toString("base64")
  });
  assert.equal(result.name, "日中风格指南");
  assert.equal(result.text, "# 对白\n\n使用自然口语。");
  assert.equal(result.characters, [...result.text].length);
});

test("DOCX 风格指南按段落提取可审核正文", async () => {
  const archive = new JSZip();
  archive.file("word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>公告简洁</w:t></w:r></w:p><w:p><w:r><w:t>对白自然&amp;克制</w:t></w:r></w:p></w:body></w:document>');
  const result = await extractStyleGuideFile({ filename: "guide.docx", base64: await archive.generateAsync({ type: "base64" }) });
  assert.equal(result.text, "公告简洁\n对白自然&克制");
});

test("拒绝不支持格式和没有正文的文件", async () => {
  await assert.rejects(extractStyleGuideFile({ filename: "guide.pdf", base64: Buffer.from("x").toString("base64") }), /仅支持/);
  await assert.rejects(extractStyleGuideFile({ filename: "guide.txt", base64: Buffer.from(" \n ").toString("base64") }), /没有可读取的正文/);
});
