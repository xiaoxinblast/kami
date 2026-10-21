/**
 * 批次的落盘节流。
 *
 * 批次记录是"整行覆盖写"：78 段的文件每写完一段就把整行（含译文、QA 明细）重写一次时，
 * 一次翻译会打出上百次大 JSON 写入，Directus 的事件循环会被压出尖峰并触发压力保护。
 * 但"这段正在翻"这种状态并不需要每次都落盘——真正必须落地的是**每段的结果**，
 * 它决定崩溃/中断后从哪继续。
 *
 * 所以：段落开始时只更新内存，按"每 N 段或每 T 毫秒"落一次；段落结束、暂停、取消、
 * 收尾一律强制落盘。
 */

export const BATCH_CHECKPOINT_MIN_SEGMENTS = 10;
export const BATCH_CHECKPOINT_MIN_INTERVAL_MS = 30_000;

export function createCheckpointWriter({
  save,
  now = () => Date.now(),
  minSegments = BATCH_CHECKPOINT_MIN_SEGMENTS,
  minIntervalMs = BATCH_CHECKPOINT_MIN_INTERVAL_MS
} = {}) {
  if (typeof save !== "function") throw new TypeError("checkpoint writer 需要 save 回调");
  const segmentThreshold = Math.max(1, Number(minSegments) || BATCH_CHECKPOINT_MIN_SEGMENTS);
  const intervalThreshold = Math.max(0, Number(minIntervalMs) || 0);
  let lastSavedAt = null;
  let segmentsSinceSave = 0;
  let writes = 0;

  const flush = async () => {
    await save();
    lastSavedAt = now();
    segmentsSinceSave = 0;
    writes += 1;
    return true;
  };

  return {
    /** 段落开始：更新内存状态，按阈值决定要不要落盘。 */
    async mark() {
      segmentsSinceSave += 1;
      const at = now();
      const dueByCount = segmentsSinceSave >= segmentThreshold;
      const dueByTime = lastSavedAt === null || at - lastSavedAt >= intervalThreshold;
      if (!dueByCount && !dueByTime) return false;
      return flush();
    },
    /** 段落结束 / 暂停 / 取消 / 收尾：必须落盘。 */
    commit() {
      return flush();
    },
    get writeCount() {
      return writes;
    },
    get pendingSegments() {
      return segmentsSinceSave;
    }
  };
}
