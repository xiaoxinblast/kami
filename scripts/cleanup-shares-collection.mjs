/**
 * 一次性清理分享验证的历史数据（分享子系统已下线）。
 *
 * 用法：
 *   npm run directus:drop-shares            # 只做只读检查，报告条数与备份路径
 *   npm run directus:drop-shares -- --yes   # 先备份成 JSON，再删除整个 shares 集合
 *
 * 备份写在 data/exports/ 下（已 gitignore）。删除前会核对导出条数与库内条数，
 * 不一致就中止；备份文件写失败也会中止，绝不先删后备份。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const baseUrl = String(process.env.DIRECTUS_URL || "").replace(/\/+$/u, "");
const token = String(process.env.DIRECTUS_TOKEN || process.env.DIRECTUS_ADMIN_TOKEN || "").trim();
const apply = process.argv.includes("--yes");

if (!baseUrl || !token) {
  console.error("缺少 DIRECTUS_URL 或 DIRECTUS_TOKEN，请用 npm run directus:drop-shares（会加载 directus/.env）运行。");
  process.exit(1);
}

async function api(path, { method = "GET" } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` }
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok && response.status !== 404 && response.status !== 403) {
    throw new Error(`${method} ${path} 失败（${response.status}）：${payload?.errors?.[0]?.message || response.statusText}`);
  }
  return { status: response.status, data: payload?.data ?? payload };
}

const probe = await api("/collections/shares").catch(() => ({ status: 404, data: null }));
if (probe.status === 403 || probe.status === 404 || !probe.data) {
  console.log("库中已没有 shares 集合，无需清理。");
  process.exit(0);
}

const rows = [];
const pageSize = 500;
for (let page = 1; page <= 200; page += 1) {
  const { data } = await api(`/items/shares?limit=${pageSize}&page=${page}&fields=*`);
  if (!Array.isArray(data) || !data.length) break;
  rows.push(...data);
  if (data.length < pageSize) break;
}

const counted = await api("/items/shares?aggregate[count]=*");
const total = Number(counted.data?.[0]?.count) || 0;
console.log(`shares 集合存在，库内 ${total} 条，已读取 ${rows.length} 条。`);
if (rows.length !== total) {
  console.error("读取条数与库内条数不一致，已中止。请检查分页或权限后重试。");
  process.exit(1);
}
if (!apply) {
  console.log("这是只读检查。确认无误后加 --yes 执行「备份 → 删除集合」。");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const backupPath = join(ROOT, "data", "exports", `shares-backup-${stamp}.json`);
await mkdir(dirname(backupPath), { recursive: true });
await writeFile(backupPath, `${JSON.stringify({ exportedAt: new Date().toISOString(), count: rows.length, items: rows }, null, 2)}\n`, "utf8");
console.log(`已备份 ${rows.length} 条到 ${backupPath}`);

await api("/collections/shares", { method: "DELETE" });
const after = await api("/collections/shares").catch(() => ({ status: 404 }));
if (after.status === 404 || after.status === 403) {
  console.log("shares 集合已删除。备份文件保留在上面那个路径。");
} else {
  console.error("删除后仍能读到 shares 集合，请手动确认 Directus 状态。");
  process.exit(1);
}
