import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer } from "node:net";
import ExcelJS from "exceljs";

/**
 * 真实服务验收：大表导入。
 *
 * 背景：END過去作訳文.xlsx 有 8.8 万行，旧实现单表只读前 10,000 行且不报错，
 * 界面显示"识别 9,791 条"。这个用例造一份 12,500 行的双语表（> 1 万行）跑完整链路：
 *   ① 预检整份读进来、报出总量，并且只回一页样例；
 *   ② 分页接口能取到后面的行；
 *   ③ 确认导入只回批次号 + 取消勾选的序号，写入条数与总数对得上。
 *
 * 可选集成用例（`KAMI_ACCEPTANCE=1`）：起临时实例，数据落在临时项目里，跑完 purge 复查为 0。
 */
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ACCEPTANCE = process.env.KAMI_ACCEPTANCE === "1";
const ROWS = 11_000;

function findFreePort(start) {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", () => resolve(findFreePort(start + 1)));
    probe.listen(start, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, logs) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`工作台没有在 30 秒内就绪：${logs.join("").slice(-800)}`);
}

async function postJson(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}：${payload.error || ""}`);
  return payload;
}

test("一万行以上的过往译文整份导入（预检不截断、分页取、按批次号提交）", { skip: !ACCEPTANCE, timeout: 900_000 }, async () => {
  const providerDir = await mkdtemp(join(tmpdir(), "kami-scale-provider-"));
  await writeFile(join(providerDir, "provider.json"), JSON.stringify({ baseUrl: "http://127.0.0.1:9/v1", model: "offline", protocol: "openai" }), "utf8");
  const port = await findFreePort(4600 + Math.floor(Math.random() * 300));
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--env-file=directus/.env", "server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), KAMI_PROVIDER_DIRECTORY: providerDir },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  let projectId = "";
  try {
    await waitForHealth(baseUrl, logs);
    const created = await postJson(baseUrl, "/api/projects", { name: `验收-大表导入-${Date.now()}` });
    projectId = created.project.id;

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("sheet");
    sheet.addRow(["ID", "日本語", "简体中文"]);
    for (let index = 0; index < ROWS; index += 1) {
      sheet.addRow([
        `[0][${index + 1}]`,
        `セリフ${index + 1}：これはテスト用に用意した長めの日本語のセリフです。`,
        `台词${index + 1}：这是一句为了测试准备的比较长的中文台词。`
      ]);
    }
    const base64 = Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64");

    const preview = await postJson(baseUrl, "/api/tm-import/preview", {
      projectId,
      filename: "END過去作訳文.xlsx",
      files: [{ filename: "END過去作訳文.xlsx", base64 }]
    });
    assert.equal(preview.total, ROWS, "整份表都要被读进来");
    assert.equal(preview.candidates.length, preview.sampleLimit, "只回一页样例");
    assert.equal(preview.statistics.truncated, false);
    assert.equal(preview.statistics.totalRows, ROWS + 1);
    // 一页样例 + 统计信息：响应体要小到能安全走浏览器（整份 1.25 万条约 7MB）。
    assert.ok(Buffer.byteLength(JSON.stringify(preview)) < 1_000_000, "预检响应不能把整份候选带回来");

    const page = await fetch(`${baseUrl}/api/tm-import/preview/${encodeURIComponent(preview.batchId)}?offset=${preview.sampleLimit}&limit=200`).then((response) => response.json());
    assert.equal(page.total, ROWS);
    assert.equal(page.items.length, 200);
    assert.equal(page.items[0].source, `セリフ${preview.sampleLimit + 1}：これはテスト用に用意した長めの日本語のセリフです。`);

    const committed = await postJson(baseUrl, "/api/tm-import/commit", {
      projectId,
      filename: "END過去作訳文.xlsx",
      batches: [{ batchId: preview.batchId, filename: "END過去作訳文.xlsx", sourceFileType: "xlsx", deselected: [0] }],
      styleEvidence: false
    });
    assert.equal(committed.summary.memories, ROWS - 1, "取消勾选的那一条不写，其余全部写入");
    // 取消勾选的那条按"未选择"记账，不是错误。
    assert.equal(committed.summary.skipped, 1);
    assert.equal(committed.summary.skippedByReason["未选择"], 1);

    const listed = await fetch(`${baseUrl}/api/memories?locale=zh-CN&projectId=${encodeURIComponent(projectId)}&limit=1`).then((response) => response.json());
    assert.equal(listed.total, ROWS - 1);
    // 预检缓存是一次性的：提交后不该在磁盘上留下 49MB 级别的候选副本。
    const cached = await fetch(`${baseUrl}/api/tm-import/preview/${encodeURIComponent(preview.batchId)}`).then((response) => response.status);
    assert.equal(cached, 404, "提交后预检缓存应被清掉");
  } finally {
    if (projectId) {
      await fetch(`${baseUrl}/api/projects/${encodeURIComponent(projectId)}?purge=1`, { method: "DELETE" }).catch(() => {});
      // purge 按 10 条一批删（11,000 条要跑几分钟）：等它收尾再复查残留。
      let remaining = -1;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        remaining = await fetch(`${baseUrl}/api/memories?locale=zh-CN&projectId=${encodeURIComponent(projectId)}&limit=1`)
          .then((response) => response.json())
          .then((payload) => Number(payload.total) || 0)
          .catch(() => 0);
        if (remaining === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      assert.equal(remaining, 0, "临时项目清理后残留必须为 0");
    }
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(providerDir, { recursive: true, force: true });
  }
});
