/**
 * 合并翻译记忆里的重复行。
 *
 * 旧版本导入留下过两类重复：
 *   1. 同一条目 ID + 同一段原文（按归一化判等）却有两行——改稿重导时旧行没被覆盖；
 *   2. 同一段原文 + 同一译文出现多行——历史导入没有按 ID 去重。
 * 两组都把更旧的那条删掉，只保留最新一条（"只保留最新"就是条目身份语义）。
 *
 * 用法（在 source-code/ 下）：
 *   npm run directus:dedupe-memory            # 只报告，不删除
 *   npm run directus:dedupe-memory -- --apply # 真正删除
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const baseUrl = String(process.env.DIRECTUS_URL || "http://127.0.0.1:18055").replace(/\/$/, "");
let token = process.env.DIRECTUS_TOKEN || "";
if (!token) {
  try {
    const env = Object.fromEntries(readFileSync("directus/.env", "utf8").split(/\r?\n/u)
      .map((line) => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u))
      .filter(Boolean)
      .map((match) => [match[1], match[2].trim()]));
    token = env.DIRECTUS_ADMIN_TOKEN || env.DIRECTUS_TOKEN || "";
  } catch { /* 下面统一报错 */ }
}
if (!token) {
  console.error("缺少 Directus token：请用 npm run directus:dedupe-memory 运行（会加载 directus/.env）。");
  process.exit(1);
}

const apply = process.argv.includes("--apply");
const projectId = String(process.env.KAMI_DEDUPE_PROJECT || "").trim();
const collections = ["translation_memory_zh_cn"];

const headers = { Authorization: `Bearer ${token}` };
const norm = (value) => String(value || "").replace(/<tag\b[^<>]*\/>/giu, "").replace(/\s+/gu, " ").trim();
const stamp = (row) => String(row.date_updated || row.date_created || "");

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok && response.status !== 204) {
    const text = await response.text().catch(() => "");
    throw new Error(`${method} ${path.split("?")[0]} -> ${response.status} ${text.slice(0, 200)}`);
  }
  return response.status === 204 ? null : response.json().catch(() => null);
}

let removedTotal = 0;
for (const collection of collections) {
  const params = new URLSearchParams({ limit: "-1", fields: "id,entry_key,source,target,source_file,batch_id,date_created,date_updated" });
  if (projectId) params.set("filter[project_id][_eq]", projectId);
  const rows = (await api(`/items/${collection}?${params}`))?.data || [];
  const removable = new Map();
  const collect = (keyOf, label) => {
    const groups = new Map();
    for (const row of rows) {
      const key = keyOf(row);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    let groupCount = 0;
    for (const [, group] of groups) {
      if (group.length < 2) continue;
      groupCount += 1;
      const sorted = [...group].sort((left, right) => stamp(right).localeCompare(stamp(left)));
      for (const row of sorted.slice(1)) removable.set(row.id, label);
    }
    console.log(`  ${label}: ${groupCount} 组重复`);
  };
  collect((row) => (row.entry_key ? `${String(row.entry_key).trim()}\u0000${norm(row.source)}` : ""), "同条目 ID + 同原文");
  collect((row) => `${norm(row.source)}\u0000${norm(row.target)}`, "同原文 + 同译文");
  console.log(`${collection}: ${rows.length} 行，可删除 ${removable.size} 行 → 保留 ${rows.length - removable.size} 行`);
  if (!apply || !removable.size) continue;
  const ids = [...removable.keys()];
  for (let offset = 0; offset < ids.length; offset += 200) {
    await api(`/items/${collection}`, { method: "DELETE", body: { keys: ids.slice(offset, offset + 200) } });
  }
  removedTotal += ids.length;
  const after = (await api(`/items/${collection}?aggregate[count]=*`))?.data?.[0]?.count;
  console.log(`已删除 ${ids.length} 行，现存 ${after} 行`);
}
if (!apply) console.log("这是预演（dry-run）。确认无误后加 --apply 执行删除。");
else console.log(`清理完成：共删除 ${removedTotal} 行`);
