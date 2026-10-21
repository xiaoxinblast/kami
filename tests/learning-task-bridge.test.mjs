import test from "node:test";
import assert from "node:assert/strict";

import { createLearningJobTaskBridge, learningJobProgressMessage, learningJobTaskType } from "../src/learning-task-bridge.mjs";

/**
 * 学习中心的评测任务以前只活在自己那一栏：任务中心看不到、完成也没有通知。
 * 桥的职责是把评测任务镜像成一条后台任务记录——一个任务一条记录，进度、结论、
 * 失败原因都跟着评测走。
 */
function memoryTasks() {
  const tasks = new Map();
  return {
    tasks,
    createTask(input) {
      const task = { id: `task-${tasks.size + 1}`, ...input };
      tasks.set(task.id, task);
      return task;
    },
    updateTask(id, update) {
      const task = tasks.get(id);
      if (!task) return false;
      Object.assign(task, update);
      return task;
    }
  };
}

function job(overrides = {}) {
  return {
    jobId: "job-1",
    kind: "skill-evaluation",
    scope: { locale: "zh-CN", contentType: "general", domain: "game", project: "project-1" },
    championId: "champion-1",
    challengerId: "candidate-1",
    status: "queued",
    progress: { requested: 27, completed: 0, failed: 0 },
    error: "",
    result: null,
    finishedAt: "",
    backgroundTaskId: "",
    ...overrides
  };
}

test("首次同步建一条后台任务并把记录 id 记回评测任务", async () => {
  const memory = memoryTasks();
  const patched = [];
  const sync = createLearningJobTaskBridge({
    ...memory,
    patchJob: (jobId, fields) => patched.push({ jobId, fields }),
    describe: () => "候选技能评测 · v3"
  });
  const created = await sync(job());
  assert.equal(memory.tasks.size, 1);
  assert.equal(created.type, "skill_evaluation", "任务中心按类型显示「技能评测」");
  assert.equal(created.title, "候选技能评测 · v3");
  assert.equal(created.projectId, "project-1", "按项目过滤的任务中心要看得到");
  assert.equal(created.locale, "zh-CN");
  assert.equal(created.status, "in_progress");
  assert.equal(created.progress.phase, "queued");
  assert.match(created.progress.message, /等待开跑/u);
  assert.equal(created.payload.learningJobId, "job-1");
  assert.deepEqual(patched, [{ jobId: "job-1", fields: { backgroundTaskId: "task-1" } }], "记录 id 要记回检查点，重启后接同一条");
});

test("进度、完成、失败都更新同一条记录，不再新建", async () => {
  const memory = memoryTasks();
  const sync = createLearningJobTaskBridge({ ...memory, describe: () => "候选技能评测 · v4" });
  await sync(job());
  await sync(job({ backgroundTaskId: "task-1", status: "running", progress: { requested: 27, completed: 12, failed: 1 } }));
  assert.equal(memory.tasks.size, 1);
  assert.equal(memory.tasks.get("task-1").progress.percent, 44);
  assert.match(memory.tasks.get("task-1").progress.message, /正在评测：12 \/ 27 组样本（1 组失败）/u);

  await sync(job({
    backgroundTaskId: "task-1",
    status: "completed",
    progress: { requested: 27, completed: 26, failed: 1 },
    result: { report: { conclusion: "评测未完成：1 组对照失败，本次结果禁止晋升。" } }
  }));
  const completed = memory.tasks.get("task-1");
  assert.equal(completed.status, "completed", "完成要落成任务中心的已完成，通知中心才会提醒");
  assert.equal(completed.progress.percent, 100, "完成的任务不能停在 96%");
  assert.match(completed.payload.conclusion, /禁止晋升/u);

  await sync(job({ backgroundTaskId: "task-1", status: "failed", error: "候选技能已被拒绝，评测终止" }));
  const failed = memory.tasks.get("task-1");
  assert.equal(failed.status, "failed");
  assert.equal(failed.progress.message, "候选技能已被拒绝，评测终止");
  assert.equal(failed.payload.error, "候选技能已被拒绝，评测终止");
});

test("记录被用户在任务中心删掉后不再重建", async () => {
  const memory = memoryTasks();
  const sync = createLearningJobTaskBridge({ ...memory, describe: () => "候选技能评测 · v5" });
  await sync(job());
  memory.tasks.delete("task-1");
  await sync(job({ backgroundTaskId: "task-1", status: "running", progress: { requested: 27, completed: 3, failed: 0 } }));
  assert.equal(memory.tasks.size, 0, "用户删掉的记录不该被进度更新重新建出来");
});

test("标题只查一次库；写任务失败只回调 onError，不影响评测", async () => {
  const memory = memoryTasks();
  let described = 0;
  const failures = [];
  const sync = createLearningJobTaskBridge({
    ...memory,
    describe: () => { described += 1; return "候选技能评测 · v6"; },
    onError: (error) => failures.push(error.message)
  });
  await sync(job());
  await sync(job({ backgroundTaskId: "task-1", status: "running", progress: { requested: 27, completed: 5, failed: 0 } }));
  assert.equal(described, 1, "每轮进度都查一次库太浪费，标题只解析一次");

  const broken = createLearningJobTaskBridge({
    createTask: () => { throw new Error("Directus 抖动"); },
    updateTask: () => true,
    onError: (error) => failures.push(error.message)
  });
  await assert.doesNotReject(() => broken(job()));
  assert.deepEqual(failures, ["Directus 抖动"]);
});

test("风格评测也走同一条桥，只是任务类型不同", () => {
  assert.equal(learningJobTaskType("style-evaluation"), "style_evaluation");
  assert.equal(learningJobTaskType("skill-evaluation"), "skill_evaluation");
  assert.equal(learningJobTaskType(""), "skill_evaluation");
  assert.match(learningJobProgressMessage({ status: "interrupted", progress: { requested: 27, completed: 12, failed: 0 } }), /服务重启中断了本次评测（12 \/ 27 组样本）/u);
});
