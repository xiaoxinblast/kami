/**
 * 重启后残留的"进行中"后台任务。
 *
 * 任务跑在进程内存里：工作台一重启，上一轮跑到一半的门禁/导入就再也没人推进它了，
 * 但库里那行还是 in_progress，任务中心会一直转圈。判定规则刻意保守——只看
 * "多久没有进度更新"：正在被本进程或另一个实例推进的任务每隔几十秒就会写一次进度，
 * 因此静默超过阈值才按中断处理，不会误伤真正在跑的任务。
 */

export const BACKGROUND_TASK_STALE_MS = 5 * 60_000;

export function selectStaleRunningTasks(tasks = [], { now = Date.now(), staleMs = BACKGROUND_TASK_STALE_MS } = {}) {
  const limit = Number.isFinite(Number(staleMs)) && Number(staleMs) > 0 ? Number(staleMs) : BACKGROUND_TASK_STALE_MS;
  return (Array.isArray(tasks) ? tasks : []).filter((task) => {
    if (String(task?.status || "") !== "in_progress") return false;
    const updated = Date.parse(String(task?.updatedAt || task?.createdAt || ""));
    // 时间戳缺失却还挂着"进行中"：按陈旧处理，否则它会永远留在列表里。
    if (!Number.isFinite(updated)) return true;
    return now - updated >= limit;
  });
}

/** 收尾时统一写这一份状态：沿用任务中心既有的"已中断"口径（status + progress.phase）。 */
export function interruptedTaskPatch(task, message = "已中断：长时间没有进度更新（多半是工作台重启时被打断）") {
  return {
    status: "needs_attention",
    progress: { ...(task?.progress || {}), phase: "interrupted", message },
    payload: { ...(task?.payload || {}), interrupted: true }
  };
}
