/**
 * 回填 translation_memory_*.source_hash。
 *
 * 这个字段是后来加的：按原文查重过去用 `filter[source][_eq]`，长句会把查询串撑爆并触发
 * Directus 的 431。加了哈希列之后，历史行必须补上它，否则按原文去重与"采纳后降权"
 * 都会漏掉老数据。
 *
 * 用法（在 source-code/ 下）：npm run directus:backfill-memory-hash
 * 幂等：只处理 source_hash 为空的行，可以反复执行。
 */

import { createHash } from "node:crypto";

const baseUrl = String(process.env.DIRECTUS_URL || "http://127.0.0.1:18055").replace(/\/$/, "");
const token = process.env.DIRECTUS_TOKEN;
if (!token) {
  console.error("缺少 DIRECTUS_TOKEN，请用 npm run directus:backfill-memory-hash 运行（它会加载 directus/.env）。");
  process.exit(1);
}

const COLLECTIONS = ["translation_memory_zh_cn", "translation_memory_ja_jp", "translation_memory_ko_kr", "translation_memory_zh_hant_tw", "translation_memory_fr_fr", "translation_memory_th_th"];
const CHUNK = 200;

function memorySourceHash(source) {
  const text = String(source || "").trim();
  if (!text) return "";
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok && response.status !== 204) {
    const text = await response.text().catch(() => "");
    throw new Error(`${method} ${path.split("?")[0]} -> ${response.status} ${text.slice(0, 200)}`);
  }
  return response.status === 204 ? null : response.json().catch(() => null);
}

let updated = 0;
for (const collection of COLLECTIONS) {
  let items = [];
  try {
    const payload = await api(`/items/${collection}?limit=-1&fields=id,source,source_hash`);
    items = Array.isArray(payload?.data) ? payload.data : [];
  } catch (error) {
    // 只有当前工作台用到的 zh-CN 表必然存在；历史语言表可能因为权限或未 provision 而不可读。
    console.log(`skip ${collection}: ${error.message}`);
    continue;
  }
  const pending = items.filter((item) => !String(item.source_hash || "").trim() && String(item.source || "").trim());
  for (let offset = 0; offset < pending.length; offset += CHUNK) {
    const chunk = pending.slice(offset, offset + CHUNK).map((item) => ({ id: item.id, source_hash: memorySourceHash(item.source) }));
    await api(`/items/${collection}`, { method: "PATCH", body: chunk });
    updated += chunk.length;
  }
  console.log(`${collection}: ${items.length} 行，补写 ${pending.length} 行`);
}
console.log(`source_hash 回填完成：共 ${updated} 行`);
