/**
 * 学习中心的评测任务 → 任务中心 / 通知中心。
 *
 * 评测任务有自己的检查点与轮询（学习中心那一栏），以前完全不出现在任务中心：
 * "评测跑完了 / 失败了"既没有通知，也没法在任务列表里回看，用户只能盯着按钮文字。
 * 这里把每个评测任务镜像成一条后台任务记录：
 *
 * - 一个评测任务固定复用同一条记录（记录 id 记在检查点上，服务重启也不新建）
 * - 进度、状态、失败原因、结论都跟着评测走
 * - 记录被用户在任务中心删掉后就不再重建（update 返回 false 即视为放弃）
 *
 * 模块本身不碰存储：读写任务都通过注入的 createTask / updateTask。
 */

const TERMINAL = ["completed", "failed"];

export function learningJobTaskType(kind = "") {
  return String(kind || "") === "style-evaluation" ? "style_evaluation" : "skill_evaluation";
}

/** 任务中心与通知中心读到的一句话进度。 */
export function learningJobProgressMessage(job = {}) {
  const requested = Number(job.progress?.requested) || 0;
  const completed = Number(job.progress?.completed) || 0;
  const failed = Number(job.progress?.failed) || 0;
  const done = `${completed} / ${requested} 组样本`;
  const status = String(job.status || "");
  if (status === "completed") return String(job.result?.report?.conclusion || "").trim() || `评测完成：${done}`;
  if (status === "failed") return String(job.error || "").trim() || "评测失败";
  if (status === "interrupted") return `服务重启中断了本次评测（${done}），等待续跑`;
  if (status === "queued") return "已进入评测队列，等待开跑";
  return `正在评测：${done}${failed ? `（${failed} 组失败）` : ""}`;
}

export function createLearningJobTaskBridge({ createTask, updateTask, patchJob = null, describe = null, onError = null } = {}) {
  if (typeof createTask !== "function" || typeof updateTask !== "function") {
    throw new TypeError("学习任务桥需要 createTask 与 updateTask");
  }
  // 标题只查一次：候选版本/草稿名在评测期间不会变，别每一轮进度都打一次库。
  const titles = new Map();

  return async function syncLearningJobTask(job = {}) {
    const jobId = String(job.jobId || "");
    if (!jobId) return null;
    const status = TERMINAL.includes(String(job.status)) ? String(job.status) : "in_progress";
    const requested = Number(job.progress?.requested) || 0;
    const completed = Number(job.progress?.completed) || 0;
    const progress = {
      phase: String(job.status || ""),
      message: learningJobProgressMessage(job),
      percent: status === "completed" ? 100 : requested ? Math.min(99, Math.round((completed / requested) * 100)) : 0,
      completed,
      total: requested
    };
    const payload = {
      learningJobId: jobId,
      learningJobKind: String(job.kind || ""),
      challengerId: String(job.challengerId || ""),
      championId: String(job.championId || ""),
      error: status === "failed" ? String(job.error || "") : "",
      conclusion: String(job.result?.report?.conclusion || ""),
      finishedAt: String(job.finishedAt || "")
    };
    try {
      const existingTaskId = String(job.backgroundTaskId || "");
      if (existingTaskId) {
        // 记录被删掉时返回 false：用户已经把它从列表里拿掉了，不再重建。
        const updated = await updateTask(existingTaskId, { status, progress, payload });
        return updated === false ? null : updated;
      }
      let title = titles.get(jobId);
      if (!title) {
        title = (typeof describe === "function" ? await describe(job) : "") || "评测任务";
        titles.set(jobId, title);
      }
      const created = await createTask({
        type: learningJobTaskType(job.kind),
        title,
        status,
        locale: String(job.scope?.locale || ""),
        projectId: String(job.scope?.project || ""),
        progress,
        payload
      });
      if (created?.id) await patchJob?.(jobId, { backgroundTaskId: created.id }, job);
      return created;
    } catch (error) {
      // 任务中心写不进去（库抖了、字段缺失）绝不能影响评测本身。
      onError?.(error);
      return null;
    }
  };
}
