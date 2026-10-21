/**
 * TM 预检缓存：解析出来的候选留在服务端，浏览器只拿"总数 + 一页样例"。
 *
 * 旧实现把整份候选塞进响应发给浏览器，确认导入时再整份传回来。一份 8.8 万行的
 * 过往译文解析出 8.3 万条候选、序列化接近 49MB：一来一回近百 MB，而且会撞上
 * 服务端 48MB 的请求体上限，表现为点「确认写入」直接失败。候选改落磁盘
 * （NDJSON，一行一条），浏览器按页取，只有真正导入时才在服务端读回来。
 *
 * 缓存是临时文件，不是数据：导入完成、或超过保留期都会删掉；删了只是要求重新预检。
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DATA_ROOT } from "./store.mjs";

/** 保留期：跨天回来接着导入仍然可用，放太久就该重新预检（源文件可能已经改了）。 */
export const PREVIEW_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function cacheDir() {
  return join(DATA_ROOT, "runtime", "tm-preview");
}

/** 批次号只用来拼文件名，必须挡住路径穿越：不合法就当作没有这份缓存。 */
function safeBatchId(batchId) {
  const value = String(batchId || "").trim();
  return /^[A-Za-z0-9_-]{1,80}$/u.test(value) ? value : "";
}

function dataPath(batchId) {
  return join(cacheDir(), `${batchId}.ndjson`);
}

function metaPath(batchId) {
  return join(cacheDir(), `${batchId}.meta.json`);
}

export async function writePreviewCache({ batchId, meta = {}, candidates = [] } = {}) {
  const id = safeBatchId(batchId);
  if (!id) throw new Error("预检缓存批次号无效");
  await mkdir(cacheDir(), { recursive: true });
  const lines = candidates.map((candidate) => JSON.stringify(candidate));
  await writeFile(dataPath(id), lines.length ? `${lines.join("\n")}\n` : "", "utf8");
  await writeFile(metaPath(id), JSON.stringify({
    ...meta,
    batchId: id,
    total: candidates.length,
    createdAt: new Date().toISOString()
  }), "utf8");
  // 顺手清过期缓存：这里是最自然的钩子，不必再多一条启动流程。
  await sweepPreviewCaches().catch(() => 0);
  return { batchId: id, total: candidates.length };
}

export async function readPreviewMeta(batchId) {
  const id = safeBatchId(batchId);
  if (!id) return null;
  try {
    const raw = await readFile(metaPath(id), "utf8");
    const meta = JSON.parse(raw);
    return meta && typeof meta === "object" ? meta : null;
  } catch {
    return null;
  }
}

/**
 * 按页读候选：列表要能"加载更多"，不能每次把 49MB 全读进内存再切片。
 * 返回 null 表示缓存不存在（过期 / 已清理 / 换了实例），调用方据此提示重新预检。
 */
export async function readPreviewPage(batchId, { offset = 0, limit = 200 } = {}) {
  const meta = await readPreviewMeta(batchId);
  if (!meta) return null;
  const start = Math.max(0, Math.trunc(Number(offset)) || 0);
  const size = Math.max(0, Math.trunc(Number(limit)) || 0);
  const items = [];
  if (size) {
    const reader = createInterface({ input: createReadStream(dataPath(meta.batchId), { encoding: "utf8" }), crlfDelay: Infinity });
    let index = 0;
    try {
      for await (const line of reader) {
        if (!line.trim()) continue;
        if (index >= start && items.length < size) items.push(JSON.parse(line));
        index += 1;
        if (items.length >= size) break;
      }
    } finally {
      reader.close();
    }
  }
  return { batchId: meta.batchId, total: Number(meta.total) || 0, offset: start, limit: size, items };
}

/** 导入前把候选全读回来：这一步本来就要把整批放进内存，只是不再经过浏览器。 */
export async function readPreviewCandidates(batchId) {
  const meta = await readPreviewMeta(batchId);
  if (!meta) return null;
  const raw = await readFile(dataPath(meta.batchId), "utf8");
  return raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

export async function deletePreviewCache(batchId) {
  const id = safeBatchId(batchId);
  if (!id) return false;
  await Promise.all([
    rm(dataPath(id), { force: true }),
    rm(metaPath(id), { force: true })
  ]);
  return true;
}

/** 过期缓存清理：只删自己写出来的两种文件，不碰目录里的其它东西。 */
export async function sweepPreviewCaches({ maxAgeMs = PREVIEW_CACHE_MAX_AGE_MS, now = Date.now() } = {}) {
  const dir = cacheDir();
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!/\.(ndjson|meta\.json)$/u.test(name)) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs <= maxAgeMs) continue;
      await rm(path, { force: true });
      removed += 1;
    } catch {
      // 清理失败只影响磁盘占用，不能阻断导入。
    }
  }
  return removed;
}
