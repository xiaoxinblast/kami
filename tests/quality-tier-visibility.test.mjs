import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describeQualityTiers, summarizeQualityTiers } from "../src/quality-tier.mjs";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const directusStore = await readFile(new URL("../src/directus-store.mjs", import.meta.url), "utf8");

/**
 * 质量档可见性：文件行/任务行要能直接看出"自动档实际用了哪几档"，
 * 段落徽标要有文字，旧版本翻的段落（没有档位字段）如实标"未记录"，不许猜。
 */
const segments = [
  { id: "s1", selected: true, status: "done", translation: "甲", result: { qualityTier: "fast" } },
  { id: "s2", selected: true, status: "done", translation: "乙", result: { qualityTier: "standard" } },
  { id: "s3", selected: true, status: "done", translation: "丙", result: { qualityTier: "strict" } },
  { id: "s4", selected: true, status: "done", translation: "丁", result: { qaScore: 97 } },
  { id: "s5", selected: false, status: "done", translation: "戊", result: { qualityTier: "fast" } },
  { id: "s6", selected: true, status: "pending" }
];

test("按段统计实际档位，未选中的段落不计入", () => {
  const tiers = summarizeQualityTiers(segments);
  assert.deepEqual(tiers, { fast: 1, standard: 1, strict: 1, unrecorded: 2 }, "s5 未选中不计；s4/s6 没有档位字段");
  assert.equal(describeQualityTiers(tiers), "快速 1 · 标准 1 · 严苛 1 · 未记录 2");
  assert.equal(describeQualityTiers({ fast: 0, standard: 0, strict: 0, unrecorded: 78 }), "未记录（旧版本翻译）");
  assert.equal(describeQualityTiers(null), "");
});

test("服务端把档位分布随批次一起返回，文件列表与任务列表都用得上", () => {
  assert.match(directusStore, /runner_options: \{ \.\.\.\(input\.runnerOptions \|\| \{\}\), qualityTierSummary: metrics\.qualityTiers, batchSummary:/u,
    "列表只查聚合列，不取 segments：汇总要落进 runner_options");
  assert.match(directusStore, /qualityTiers: directusJson\(item\.runner_options, \{\}\)\?\.qualityTierSummary \|\| null,/u);
  assert.match(directusStore, /qualityTiers: arrayValue\(item\.segments\)\.length \? summarizeQualityTiers/u);
  assert.match(server, /qaPending: run\.qaPending,\n\s+qualityTiers: run\.qualityTiers \|\| null,/u, "/api/batch/files 要带上档位分布");
});

test("界面把档位分布显示在文件行与任务行，段落徽标带文字", () => {
  assert.match(app, /const tierText = describeQualityTiers\(file\.qualityTiers\);/u);
  assert.match(app, /class="batch-file-tiers"/u);
  assert.match(app, /const tierText = describeQualityTiers\(task\.qualityTiers\);/u);
  assert.match(app, /class="task-tiers"/u);
  // 段落徽标：有档位给文字，没档位的旧段落也要说明，而不是空白。
  assert.match(app, /const QUALITY_TIER_LABELS = \{ fast: "快速", standard: "标准", strict: "严苛" \};/u);
  assert.match(app, /档位未记录/u);
  assert.match(app, /这一段是较早版本翻译的，结果里没有记录质量档/u);
});
