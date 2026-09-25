import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 必须在加载任何 src 模块前设置运行环境：mock 模型服务、隔离的 JSON 存储与空配置目录。
const dataDir = await mkdtemp(join(tmpdir(), "kami-eval-jobs-"));
const providerDir = await mkdtemp(join(tmpdir(), "kami-provider-"));
await writeFile(join(providerDir, "provider.json"), JSON.stringify({ baseUrl: "", model: "", embeddingModel: "", embeddingBaseUrl: "" }));
process.env.KAMI_DATA_DIR = dataDir;
process.env.KAMI_PROVIDER_DIRECTORY = providerDir;
delete process.env.KAMI_STORE;
process.env.MOCK_OPENAI_PORT = "11437";
process.env.LLM_BASE_URL = "http://127.0.0.1:11437/v1";
process.env.LLM_MODEL = "mock-model";
process.env.LLM_INPUT_PRICE_PER_MTOK = "0.5";
process.env.LLM_OUTPUT_PRICE_PER_MTOK = "1.5";

await import("./fixtures/mock-openai-server.mjs");
const store = await import("../src/store.mjs");
const engine = await import("../src/learning-engine.mjs");
const benchmarkModule = await import("../src/skill-benchmark.mjs");
const jobsModule = await import("../src/evaluation-jobs.mjs");

const savedEvaluations = [];

function makeDeps(overrides = {}) {
  return {
    getSkill: (id) => store.getTranslationSkill(id),
    getCurrentChampion: async (scope) => (await store.listTranslationSkills({ ...scope, status: "champion", limit: 1 }))[0] || null,
    validatePromotionState: (input) => engine.validateCandidatePromotionState(input),
    saveEvaluation: async (payload) => {
      savedEvaluations.push(payload);
      return store.saveSkillEvaluation(payload);
    },
    updateSkillMetrics: (id, metrics) => store.updateTranslationSkill(id, { metrics }),
    buildUiReport: (result) => ({ promotable: result.promotable, status: result.status, conclusion: result.reportZh, gates: result.gates }),
    ...overrides
  };
}

async function waitForTerminal(runner, jobId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = runner.get(jobId);
    if (["completed", "failed"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return runner.get(jobId);
}

/**
 * 完成钩子报错后的检查点由 runner 自己补写：等那次写入真的落盘再断言。
 * 只等"钩子已经跑完"之后的这段毫秒级写入，不跟整轮评测抢时序。
 */
function withDeadline(promise, timeoutMs, message) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

async function waitForCheckpointWarning(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = JSON.parse(await readFile(path, "utf8"));
      if (last?.completionHookWarning) return last;
    } catch { /* 文件可能还在写 */ }
    // 放慢轮询：读得太勤会和 runner 的"写临时文件 + 改名"撞在 Windows 的文件锁上
    // （实测会报 EPERM），那时是测试自己制造的抖动，不是评测出错。
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`检查点里始终没有 completionHookWarning：${JSON.stringify(last)}`);
}

test("后台评测任务完成全流程：双变体重跑、成本采集、保存评测记录", async () => {
  await store.initializeStore();
  const scope = { locale: "ja-JP", contentType: "general", domain: "game", project: "default" };
  const template = engine.createDefaultTranslationSkill({ scope });
  const champion = await store.saveTranslationSkill({ ...scope, ...template });
  const challengerTemplate = engine.mergeTranslationSkillPatch(
    template,
    { name: "候选技能", changeReason: "测试候选", strategy: { retrieval: { translationMemory: { limit: 8 } } } },
    { candidateId: `${champion.id}@candidate-v2` }
  );
  const challenger = await store.saveTranslationSkill({ ...scope, ...challengerTemplate });

  const trajectories = [];
  for (let index = 0; index < 20; index += 1) {
    const created = await store.saveLearningTrajectory({
      ...scope,
      batchId: "manual-review",
      segmentId: "",
      source: `登录后即可领取每日奖励第${index}号说明文案`,
      contextPack: { neighborContext: "" },
      assetRefs: {},
      model: "mock-model",
      promptVersion: "kami-translation-v1",
      status: "running",
      events: []
    });
    const finalTranslation = `デイリー報酬第${index}号`;
    trajectories.push(await store.updateLearningTrajectory(created.id, {
      finalTranslation,
      humanDecision: { accepted: true, finalTranslation },
      status: "completed"
    }));
  }

  const jobsDirectory = join(dataDir, "learning", "jobs");
  const runner = jobsModule.createEvaluationJobRunner({
    benchmark: benchmarkModule.benchmarkTranslationSkill,
    jobsDirectory,
    concurrency: 3,
    deps: makeDeps()
  });
  await runner.initialize();

  const createdJob = await runner.create({ scope, champion, challenger, trajectories, requireCost: true });
  assert.ok(["queued", "running"].includes(createdJob.status), "创建后任务应立即进入排队或运行状态");
  const finalJob = await waitForTerminal(runner, createdJob.jobId);
  assert.equal(finalJob.status, "completed", finalJob.error || "任务未完成");
  assert.deepEqual(finalJob.progress, { requested: 20, completed: 20, failed: 0 });

  const report = finalJob.result.report;
  assert.equal(report.benchmark.completedPairs, 20);
  assert.equal(report.benchmark.failedPairs, 0);
  assert.equal(report.benchmark.isolation.totalExcluded, 0, "空记忆库不应有同源剔除");

  // mock 服务每次返回 42 输入 / 7 输出 token，每 case 翻译 + AIQA 各一次，定价 0.5 / 1.5 每百万。
  const expectedPerCase = 2 * ((42 / 1_000_000) * 0.5 + (7 / 1_000_000) * 1.5);
  assert.ok(savedEvaluations.length === 1, "应保存一条评测记录");
  assert.ok(savedEvaluations[0].championMetrics.cost.average > 0);
  assert.ok(Math.abs(savedEvaluations[0].championMetrics.cost.average - expectedPerCase) < 1e-9);
  assert.ok(savedEvaluations[0].challengerMetrics.cost.average > 0);

  const evaluations = await store.listSkillEvaluations({ challengerSkillId: challenger.id, limit: 1 });
  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0].sampleCount, 20);
  assert.equal(evaluations[0].decision, savedEvaluations[0].decision);

  const persistedFiles = (await readdir(jobsDirectory)).filter((file) => file.endsWith(".json"));
  assert.equal(persistedFiles.length, 1, "任务检查点应持久化到磁盘");

  const reusedJob = await runner.create({ scope, champion, challenger, trajectories, requireCost: true });
  const reusedFinal = await waitForTerminal(runner, reusedJob.jobId);
  assert.equal(reusedFinal.status, "completed");
  assert.equal(reusedFinal.reproducibility.reusedFromJobId, createdJob.jobId, "输入未变化时应复用已保存译文，只重算门禁");
  assert.equal(reusedFinal.result.report.reproducibility.reusedFromJobId, createdJob.jobId);
});

test("重启恢复把运行中任务标记为 interrupted，续跑前校验候选与冠军配对", async () => {
  const scope = { locale: "ko-KR", contentType: "general", domain: "game", project: "default" };
  const jobsDirectory = join(dataDir, "learning", "jobs-restore");
  const fakeJob = {
    jobId: "fake-1",
    kind: "skill-evaluation",
    scope,
    championId: "champion-x",
    challengerId: "challenger-x",
    requireCost: false,
    requestedCaseIds: ["case-1", "case-2"],
    caseTrajectories: {},
    caseSamples: {},
    caseFailures: {},
    status: "running",
    result: null,
    error: "",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    finishedAt: ""
  };
  await mkdir(jobsDirectory, { recursive: true });
  await writeFile(join(jobsDirectory, "fake-1.json"), JSON.stringify(fakeJob));
  const runner = jobsModule.createEvaluationJobRunner({
    benchmark: async () => ({ caseId: "unused" }),
    jobsDirectory,
    concurrency: 1,
    deps: makeDeps()
  });
  await runner.initialize();
  assert.equal(runner.get("fake-1").status, "interrupted");
  const resumed = await runner.resume("fake-1");
  assert.ok(["queued", "running"].includes(resumed.status), "续跑后任务应进入排队或运行状态");
  const finalJob = await waitForTerminal(runner, "fake-1");
  assert.equal(finalJob.status, "failed");
  assert.match(finalJob.error, /候选技能不存在|Champion/);
});

test("表达型 Skill 的重复采样结论相反时标记 unstable 并禁止晋升", async () => {
  const scope = { locale: "ja-JP", contentType: "dialogue", domain: "game", project: "default" };
  const champion = { id: "stable-champion", ...scope, scope, status: "champion" };
  const challenger = { id: "unstable-challenger", ...scope, scope, status: "challenger", parentId: champion.id };
  const trajectories = Array.from({ length: 20 }, (_, index) => ({
    id: `unstable-case-${index}`,
    source: `台词${index}`,
    finalTranslation: `台詞${index}`,
    humanDecision: { accepted: true, finalTranslation: `台詞${index}` }
  }));
  const jobsDirectory = join(dataDir, "learning", "jobs-unstable");
  let saved;
  const runner = jobsModule.createEvaluationJobRunner({
    jobsDirectory,
    concurrency: 4,
    benchmark: async (skill, trajectory, { repetition }) => ({
      caseId: `${trajectory.id}#r${repetition + 1}`,
      sourceCaseId: trajectory.id,
      repetition,
      scope,
      requiredTermHits: 0,
      requiredTermTotal: 0,
      hardErrorCount: 0,
      qaScore: skill.id === challenger.id ? (repetition === 0 ? 95 : 85) : 90,
      humanEditDistance: skill.id === challenger.id ? (repetition === 0 ? 0.1 : 0.2) : 0.15,
      humanAccepted: true,
      latencyMs: 10
    }),
    deps: {
      getSkill: async (id) => id === champion.id ? champion : id === challenger.id ? challenger : null,
      getCurrentChampion: async () => champion,
      validatePromotionState: () => ({ valid: true, reasons: [] }),
      saveEvaluation: async (payload) => { saved = payload; return { id: "unstable-evaluation" }; },
      updateSkillMetrics: async () => undefined,
      buildUiReport: (result) => ({ promotable: result.promotable, status: result.status, conclusion: result.reportZh, gates: result.gates })
    }
  });
  await runner.initialize();
  const created = await runner.create({ scope, champion, challenger, trajectories, requireCost: false });
  const finalJob = await waitForTerminal(runner, created.jobId);
  assert.equal(finalJob.status, "completed");
  assert.equal(finalJob.result.report.status, "unstable");
  assert.equal(finalJob.result.report.promotable, false);
  assert.equal(finalJob.result.report.reproducibility.stable, false);
  assert.deepEqual(finalJob.result.report.reproducibility.repeatConclusions.map((item) => item.status), ["promote", "reject"]);
  assert.equal(saved.decision, "needs_review");
});

test("完成钩子失败只记录警告，不把已完成的评测伪装成失败", async () => {
  const scope = { locale: "ja-JP", contentType: "general", domain: "game", project: "default" };
  const champion = { id: "hook-champion", ...scope, scope, status: "champion" };
  const challenger = { id: "hook-challenger", ...scope, scope, status: "challenger", parentId: champion.id };
  const trajectories = Array.from({ length: 20 }, (_, index) => ({
    id: `hook-case-${index}`,
    source: `公告第${index}条说明文案`,
    finalTranslation: `お知らせ第${index}号`,
    humanDecision: { accepted: true, finalTranslation: `お知らせ第${index}号` }
  }));
  const jobsDirectory = join(dataDir, "learning", "jobs-hook");
  let hookCalls = 0;
  // 钩子是"评测落盘之后"才跑的异步收尾，而且只在完成时调用一次：
  // 用 promise 事件驱动地等它跑完，别再用固定等待窗口跟它抢时序
  // （全量并行跑时 5 秒窗口会偶发超时，那是测试自身的抖动，不是评测出错）。
  let resolveHook = () => {};
  const hookFinished = new Promise((resolve) => { resolveHook = resolve; });
  const runner = jobsModule.createEvaluationJobRunner({
    jobsDirectory,
    concurrency: 4,
    benchmark: async (skill, trajectory, { repetition }) => ({
      caseId: `${trajectory.id}#r${repetition + 1}`,
      sourceCaseId: trajectory.id,
      repetition,
      scope,
      requiredTermHits: 1,
      requiredTermTotal: 1,
      hardErrorCount: 0,
      qaScore: 92,
      humanEditDistance: 0.1,
      humanAccepted: true,
      latencyMs: 10
    }),
    onCompleted: async () => {
      hookCalls += 1;
      resolveHook();
      throw new Error("门禁编排失败");
    },
    deps: {
      getSkill: async (id) => id === champion.id ? champion : id === challenger.id ? challenger : null,
      getCurrentChampion: async () => champion,
      validatePromotionState: () => ({ valid: true, reasons: [] }),
      saveEvaluation: async () => ({ id: "hook-evaluation" }),
      updateSkillMetrics: async () => undefined,
      buildUiReport: (result) => ({ promotable: result.promotable, status: result.status, conclusion: result.reportZh, gates: result.gates })
    }
  });
  await runner.initialize();
  const created = await runner.create({ scope, champion, challenger, trajectories, requireCost: false });
  const finalJob = await waitForTerminal(runner, created.jobId);
  assert.equal(finalJob.status, "completed", finalJob.error || "评测本身已经完成");
  // 钩子在状态落盘之后才跑：等它真的结束（事件驱动）再断言。
  await withDeadline(hookFinished, 30_000, "完成钩子在 30 秒内没有被调用：评测收尾没有走到钩子");
  // 让 runner 的 catch 先跑完（它在这一拍把警告写进内存态），再读内存与检查点。
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hookCalls, 1, "钩子只在完成时调用一次");
  assert.match(runner.get(created.jobId).completionHookWarning, /门禁编排失败/);
  const checkpoint = await waitForCheckpointWarning(join(jobsDirectory, `${created.jobId}.json`));
  assert.match(checkpoint.completionHookWarning, /门禁编排失败/, "警告要落盘，重启后仍能解释后续编排为何没跑");
});

/**
 * 检查点是"写临时文件 + 改名"落盘的：Windows 上改名会被并发打开的句柄短暂挡住（EPERM）。
 * 这类抖动不能让整条队列崩掉，更不能把已经有终态的评测降级成失败。
 */
test("检查点落盘遇到 Windows 文件锁会退避重试，收尾异常不降级终态", async () => {
  const source = await readFile(new URL("../src/evaluation-jobs.mjs", import.meta.url), "utf8");
  assert.match(source, /const TRANSIENT_RENAME_CODES = new Set\(\["EPERM", "EACCES", "EBUSY"\]\);/u);
  assert.match(source, /async function renameWithRetry\(from, to, attempts = 4\)/u);
  assert.match(source, /await renameWithRetry\(temporary, path\);/u);
  assert.match(source, /if \(\[COMPLETED, FAILED\]\.includes\(next\.status\)\) \{/u);
  assert.match(source, /评测收尾异常（评测结论已落盘，保持原状态）/u);
});
