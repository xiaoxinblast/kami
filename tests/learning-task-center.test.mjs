import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/**
 * 学习中心的任务要进任务中心与通知中心，落不了的评测要能只重试失败样本。
 * 这里查的是服务端与页面的接线（纯逻辑在 learning-task-bridge / evaluation-jobs 的用例里）。
 */
async function sources() {
  const [server, script, html] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8")
  ]);
  return { server, script, html };
}

test("技能评测与风格评测都镜像进任务中心，状态变化即时回传", async () => {
  const { server } = await sources();
  assert.match(server, /import \{ createLearningJobTaskBridge \} from "\.\/src\/learning-task-bridge\.mjs";/u);
  assert.match(server, /const syncLearningJobTask = createLearningJobTaskBridge\(\{/u);
  assert.match(server, /createTask: \(input\) => createBackgroundTask\(input\),/u);
  assert.match(server, /updateTask: \(id, update\) => updateBackgroundTaskProgress\(id, update\),/u);
  assert.match(server, /patchJob: \(jobId, fields, job\) => \(String\(job\?\.kind \|\| ""\) === "style-evaluation" \? styleEvaluationJobs : evaluationJobs\)\.patch\(jobId, fields\),/u);
  // 两个 runner 都要挂上：只挂技能评测，风格评测就又会"跑完没通知"。
  assert.equal((server.match(/onChanged: syncLearningJobTask,/gu) || []).length, 2);
  // 标题要能看出是哪条候选/哪份风格草稿。
  assert.match(server, /return candidate \? `候选技能评测 · \$\{candidate\.name \|\| `v\$\{candidate\.version\}`\}` : "候选技能评测";/u);
  assert.match(server, /return draft \? `风格评测 · \$\{draft\.name \|\| `v\$\{draft\.version\}`\}` : "风格评测";/u);
  assert.match(server, /payload: payload \|\| \{\}/u, "镜像任务要把 learningJobId 之类的 payload 一起写进去");
});

test("候选被拒绝/删除、生效版本换人时，相关评测就地判失败", async () => {
  const { server } = await sources();
  assert.match(server, /async function failEvaluationJobs\(runner, predicate, reason\) \{/u);
  assert.match(server, /await failEvaluationJobs\(evaluationJobs, \(job\) => String\(job\.challengerId\) === String\(id\), "候选技能已被拒绝，评测终止"\);/u);
  assert.match(server, /await failEvaluationJobs\(evaluationJobs, \(job\) => String\(job\.challengerId\) === String\(id\), "候选技能已被删除，评测终止"\);/u);
  assert.match(server, /"生效版本已更新，本次评测终止"\);/u);
  assert.match(server, /"生效版本已回滚，本次评测终止"\);/u);
  assert.match(server, /await failEvaluationJobs\(styleEvaluationJobs, \(job\) => String\(job\.challengerId\) === String\(id\), "风格草稿已被拒绝，评测终止"\);/u);
  assert.match(server, /await failEvaluationJobs\(styleEvaluationJobs, \(job\) => String\(job\.challengerId\) === String\(id\), "风格草稿已被删除，评测终止"\);/u);
});

test("只重试失败样本的接口：校验候选、复用同一条任务、失败样本才让重试", async () => {
  const { server } = await sources();
  assert.match(server, /url\.pathname\.endsWith\("\/retry-failed"\)/u);
  assert.match(server, /if \(!Number\(job\.progress\?\.failed\)\) return json\(res, 409, \{ error: "这条评测没有失败样本，不需要重试" \}\);/u);
  assert.match(server, /const retried = await evaluationJobs\.retryFailed\(jobId\);/u);
  assert.match(server, /logInfo\("只重试失败的评测样本", \{ jobId, challengerId: job\.challengerId, progress: retried\?\.progress \}\);/u);
});

test("任务中心与通知中心认得评测任务，卡片上有「仅重试失败」", async () => {
  const { script } = await sources();
  assert.match(script, /skill_evaluation: "技能评测", style_evaluation: "风格评测"/u);
  // 评测不能中途掐：不给假的"中断"按钮，改成跳回学习中心看结论。
  assert.match(script, /const canOpenLearning = Boolean\(task\.payload\?\.learningJobId\);/u);
  assert.match(script, /const canCancel = task\.status === "in_progress" && !canOpenLearning;/u);
  assert.match(script, /data-action="open-learning"/u);
  assert.match(script, /else if \(action === "open-learning"\) switchView\("learning"\);/u);
  // 评测完成/失败的通知要跳回学习中心。
  assert.match(script, /const view = task\.payload\?\.learningJobId \? "learning" : "tasks";/u);
  // 只重试失败：按钮只在"有失败样本且没有在跑的评测"时出现。
  assert.match(script, /function retryableEvaluationJobFor\(skillId\) \{/u);
  assert.match(script, /const retryableJob = activeJob \? null : retryableEvaluationJobFor\(id\);/u);
  assert.match(script, /data-learning-action="retry-failed"/u);
  assert.match(script, /if \(action === "retry-failed"\) return retryFailedEvaluation\(button\?\.dataset\.jobId, button\);/u);
  assert.match(script, /await api\(`\/api\/learning\/evaluation-jobs\/\$\{encodeURIComponent\(jobId\)\}\/retry-failed`, \{ method: "POST" \}\)/u);
  assert.match(script, /已成功的样本会沿用，可以只重试失败的 \$\{failedSamples\} 组。/u);
});
