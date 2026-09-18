import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

/**
 * 审校回填：导出 → memoQ 人工审校 → 导回来自动接回同一条批次。
 * 这条链路必须同时做到"覆盖译文 + 写主 TM + 接回轨迹 + 报出未匹配/歧义"。
 */
test("批次支持导入审校结果：覆盖译文、写主 TM、接回学习轨迹", async () => {
  const server = await read("../server.mjs");
  assert.match(server, /\^\\\/api\\\/batch\\\/run\\\/\[\^\/\]\+\\\/import-review\$/u);
  const job = server.slice(server.indexOf("async function importBatchReview"), server.indexOf("function startBatchWorker"));
  assert.match(job, /matchReviewPairsToSegments\(selected, pairs\)/u);
  assert.match(job, /segment\.translation = String\(pair\.target \|\| ""\)\.trim\(\);/u);
  assert.match(job, /segment\.accepted = true;/u);
  assert.match(job, /humanReview: \{/u);
  assert.match(job, /provenance: "external-review-import"/u);
  assert.match(job, /externalReviewTrajectoryPatch\(\{/u);
  assert.match(job, /logInfo\("审校回填完成"/u);
  // 报告要带未匹配/歧义明细，不能只给一个总数
  assert.match(job, /details: \{\s*\n\s*unmatched: matched\.unmatched\.slice\(0, 50\),\s*\n\s*ambiguous: matched\.ambiguous\.slice\(0, 50\)/u);
  // 页面侧入口
  const app = await read("../public/app.js");
  assert.match(app, /data-action="import-review">导入审校结果/u);
  assert.match(app, /\/api\/batch\/run\/\$\{encodeURIComponent\(batchId\)\}\/import-review/u);
  const html = await read("../public/index.html");
  assert.match(html, /id="reviewImportDialog"/u);
  assert.match(html, /id="reviewImportFile"/u);
});

test("人工确认过的段落不再计入「QA 待处理」", async () => {
  const store = await read("../src/directus-store.mjs");
  const metrics = store.slice(store.indexOf("function batchMetrics"), store.indexOf("export async function saveDirectusBatchRun"));
  assert.match(metrics, /if \(segment\.accepted === true\) return false;/u);
  assert.match(metrics, /const qaPending = selected\.filter/u);
});
