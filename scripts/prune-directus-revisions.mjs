import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * 清理 Directus 版本历史（directus_revisions）的维护脚本。
 *
 * 为什么需要：Directus 每次 create/update/delete 都会写一条 revision；批次翻译、
 * 术语导入这类高频覆盖写会把表撑到 GB 级。删掉旧历史不影响当前数据，只影响后台的
 * 「回滚到某版本」能力，所以保留期由调用方决定。
 *
 * 默认只做 dry-run；确认后加 --apply。VACUUM 可选：普通 VACUUM 只标记空间可复用，
 * 文件不会立刻变小；要缩小文件需要 VACUUM FULL / pg_repack，会锁表，另行安排。
 *
 * 用法：
 *   npm run directus:prune-history                 # dry-run，默认保留 21 天
 *   npm run directus:prune-history -- --days=30 --apply
 *   npm run directus:prune-history -- --days=21 --apply --vacuum
 */

export function parsePruneArgs(argv = []) {
  const options = { days: 21, apply: false, vacuum: false, batch: 10_000 };
  for (const raw of argv) {
    const arg = String(raw || "");
    if (arg === "--apply") { options.apply = true; continue; }
    if (arg === "--vacuum") { options.vacuum = true; continue; }
    const days = arg.match(/^--days=(\d+)$/u);
    if (days) { options.days = Number(days[1]); continue; }
    const batch = arg.match(/^--batch=(\d+)$/u);
    if (batch) { options.batch = Number(batch[1]); continue; }
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isInteger(options.days) || options.days < 7) throw new Error("--days 必须是 >= 7 的整数（保留期太短会丢审计）");
  if (!Number.isInteger(options.batch) || options.batch < 100 || options.batch > 100_000) throw new Error("--batch 必须是 100–100000 的整数");
  return options;
}

function composeDatabaseContainer() {
  return execFileSync("docker", ["compose", "--env-file", "directus/.env", "-f", "directus/docker-compose.yml", "ps", "-q", "database"], { encoding: "utf8" }).trim();
}

function psql(sql) {
  const container = composeDatabaseContainer();
  if (!container) throw new Error("找不到 database 容器，请先运行 npm run directus:up");
  const user = process.env.POSTGRES_USER;
  const database = process.env.POSTGRES_DB;
  const password = process.env.POSTGRES_PASSWORD;
  if (!user || !database || !password) throw new Error("缺少 POSTGRES_USER/POSTGRES_DB/POSTGRES_PASSWORD");
  return execFileSync("docker", ["exec", "-e", `PGPASSWORD=${password}`, container, "psql", "-U", user, "-d", database, "-t", "-A", "-c", sql], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  }).trim();
}

function retentionStats(days) {
  const [rows, bytes] = psql(`select count(*), coalesce(sum(pg_column_size(r.delta)),0) from directus_revisions r join directus_activity a on a.id = r.activity where a.timestamp < now() - interval '${days} days';`).split("|");
  return { rows: Number(rows) || 0, bytes: Number(bytes) || 0 };
}

function deleteBatch(days, batch) {
  const output = psql(`delete from directus_revisions where id in (select r.id from directus_revisions r join directus_activity a on a.id = r.activity where a.timestamp < now() - interval '${days} days' limit ${batch});`);
  return Number(String(output).replace(/^DELETE\s+/u, "")) || 0;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function main() {
  const options = parsePruneArgs(process.argv.slice(2));
  if (options.help) {
    console.log("用法：node --env-file=directus/.env scripts/prune-directus-revisions.mjs [--days=21] [--apply] [--vacuum] [--batch=10000]");
    return;
  }

  const before = retentionStats(options.days);
  console.log(`保留最近 ${options.days} 天：将删除 ${before.rows} 条 revisions（约 ${formatBytes(before.bytes)} delta）`);
  if (!options.apply) {
    console.log("dry-run：没有删除任何数据。确认后加 --apply。");
    return;
  }

  let deleted = 0;
  for (;;) {
    const count = deleteBatch(options.days, options.batch);
    deleted += count;
    console.log(`已删除 ${deleted} / ${before.rows}`);
    if (!count) break;
  }
  if (options.vacuum) {
    console.log("VACUUM (ANALYZE) directus_revisions…");
    psql("vacuum (analyze) directus_revisions;");
  }
  console.log(`完成：删除 ${deleted} 条 revisions。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
