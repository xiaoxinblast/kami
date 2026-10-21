/**
 * 分段队列的搜索：只匹配用户看得懂的四个字段——原文、译文、ID、注释。
 * NFKC 归一 + 小写，所以全角/半角、大小写都能命中。纯函数，Node 里可直接单测。
 */

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase();
}

/** 一条分段上的 ID 候选：MQXLIFF 的 unitId、表格的条目 ID、段落 id 与条目键。 */
export function segmentIds(segment = {}) {
  const locator = segment.locator || {};
  const context = segment.context || {};
  return [
    locator.unitId,
    locator.entryId,
    context.entryId,
    segment.id,
    segment.entryKey,
    locator.entryKey,
    locator.sheet && locator.row ? `${locator.sheet}!${locator.row}` : ""
  ].map((value) => String(value ?? "").trim()).filter(Boolean);
}

/** 注释：MQXLIFF 的 note + 表格里 role=context 的列（约束列另算，不进注释）。 */
export function segmentNotes(segment = {}) {
  const context = segment.context || {};
  const notes = [];
  if (context.note) notes.push(String(context.note));
  for (const item of Array.isArray(context.metadata) ? context.metadata : []) {
    if (!item || item.role === "constraint") continue;
    notes.push(`${item.label || "补充"}：${item.value || ""}`);
  }
  return notes.map((value) => value.trim()).filter(Boolean);
}

export function segmentMatchesQuery(segment = {}, query = "") {
  const needle = normalize(query).trim();
  if (!needle) return true;
  const haystack = [
    ...segmentIds(segment),
    ...segmentNotes(segment),
    segment.source,
    segment.translation
  ];
  return haystack.some((value) => normalize(value).includes(needle));
}
