import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";

const enabled = process.env.KAMI_API_E2E === "1" && process.env.KAMI_STORE === "directus";
const appUrl = "http://127.0.0.1:4173";
const directusUrl = String(process.env.DIRECTUS_URL || "http://127.0.0.1:18055").replace(/\/$/, "");

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const payload = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(payload)}`);
  return payload?.data ?? payload;
}

test("日中术语表预览、入库与清理形成完整闭环", { skip: !enabled }, async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("术语表");
  sheet.addRows([
    ["日语", "简体中文"],
    ["スターライトバッジテスト", "星辉徽章测试"]
  ]);
  const progressId = randomUUID();
  const preview = await request(`${appUrl}/api/term-import/preview`, {
    method: "POST",
    body: JSON.stringify({ filename: "术语闭环测试.xlsx", locale: "auto", useModel: false, progressId, base64: Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64") })
  });
  const imported = [];
  try {
    const progress = await request(`${appUrl}/api/term-import/progress/${progressId}`);
    assert.equal(progress.status, "completed");
    assert.equal(progress.percent, 100);
    assert.equal(preview.candidates.length, 1);
    assert.deepEqual(new Set(preview.candidates.map((item) => item.locale)), new Set(["zh-CN"]));
    const committed = await request(`${appUrl}/api/term-import/commit`, {
      method: "POST",
      body: JSON.stringify({
        batchId: preview.batchId,
        filename: preview.filename,
        domain: "test",
        contentType: "item_name",
        enforcement: "required",
        candidates: preview.candidates.map((candidate) => ({ ...candidate, selected: true }))
      })
    });
    imported.push(...committed.imported);
    assert.equal(committed.imported.length, 1);
    for (const item of imported) {
      const assets = await request(`${appUrl}/api/assets?locale=${encodeURIComponent(item.locale)}`);
      assert.ok(assets.terms.some((term) => term.id === item.id));
      assert.equal(assets.terms.some((term) => term.source === item.source && term.target !== item.target), false);
    }
  } finally {
    for (const item of imported) await request(`${appUrl}/api/assets/${item.id}?locale=${encodeURIComponent(item.locale)}`, { method: "DELETE" });
    const adminHeaders = { Authorization: `Bearer ${process.env.DIRECTUS_ADMIN_TOKEN}` };
    const candidateIds = preview.candidates.map((item) => item.candidateId).filter(Boolean);
    if (candidateIds.length) await request(`${directusUrl}/items/term_candidates`, { method: "DELETE", headers: adminHeaders, body: JSON.stringify(candidateIds) });
    await request(`${directusUrl}/items/term_import_batches/${preview.batchId}`, { method: "DELETE", headers: adminHeaders });
  }
});

test("Directus 候选审核队列接受超过 255 字符的日中句段", { skip: !enabled }, async () => {
  const adminHeaders = { Authorization: `Bearer ${process.env.DIRECTUS_ADMIN_TOKEN}` };
  const longSource = "長文候補です。".repeat(60);
  const longTarget = "简体中文长句候选。".repeat(60);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("长句候选");
  sheet.addRows([["日语", "简体中文"], [longSource, longTarget]]);
  const preview = await request(`${appUrl}/api/term-import/preview`, {
    method: "POST",
    body: JSON.stringify({
      filename: "长句候选容量测试.xlsx",
      locale: "zh-CN",
      useModel: false,
      base64: Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64")
    })
  });
  try {
    assert.equal(preview.candidates.length, 1);
    assert.equal(preview.candidates[0].source.length, longSource.length);
    assert.equal(preview.candidates[0].target.length, longTarget.length);
  } finally {
    const candidateIds = preview.candidates.map((item) => item.candidateId).filter(Boolean);
    if (candidateIds.length) await request(`${directusUrl}/items/term_candidates`, { method: "DELETE", headers: adminHeaders, body: JSON.stringify(candidateIds) });
    await request(`${directusUrl}/items/term_import_batches/${preview.batchId}`, { method: "DELETE", headers: adminHeaders });
  }
});
