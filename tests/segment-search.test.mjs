import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { segmentIds, segmentMatchesQuery, segmentNotes } from "../public/segment-search.js";

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");

const segment = {
  id: "seg-7",
  source: "クエスト　ヤマスキー絶壁：登山口",
  translation: "任务　亚马斯基绝壁：登山口",
  locator: { type: "xliff-unit", unitIndex: 6, unitId: "6" },
  entryKey: "menu_options_graphics_multi_frame_generation_off",
  context: {
    note: "Resident_Level_Other_CheckPoint // チェックポイントのテキスト",
    metadata: [
      { label: "位置", value: "菜单", role: "context" },
      { label: "字数", value: "20 字以内", role: "constraint" }
    ]
  }
};

test("分段搜索：原文、译文、ID、注释都能命中", () => {
  assert.equal(segmentMatchesQuery(segment, ""), true, "空查询等于不过滤");
  assert.equal(segmentMatchesQuery(segment, "登山口"), true, "命中原文");
  assert.equal(segmentMatchesQuery(segment, "亚马斯基"), true, "命中译文");
  assert.equal(segmentMatchesQuery(segment, "6"), true, "命中 unitId");
  assert.equal(segmentMatchesQuery(segment, "seg-7"), true, "命中段落 id");
  assert.equal(segmentMatchesQuery(segment, "menu_options"), true, "命中条目键");
  assert.equal(segmentMatchesQuery(segment, "checkpoint"), true, "命中注释（大小写不敏感）");
  assert.equal(segmentMatchesQuery(segment, "菜单"), true, "命中表格里判为上下文的列");
  assert.equal(segmentMatchesQuery(segment, "不存在的词"), false);
});

test("分段搜索：全半角归一，约束列不算注释", () => {
  assert.equal(segmentMatchesQuery(segment, "ＭＥＮＵ"), true, "全角输入也能命中半角原文");
  assert.equal(segmentMatchesQuery(segment, "２０ 字以内"), false, "交付约束不当注释用（它有自己的标签）");
  assert.deepEqual(segmentNotes(segment), ["Resident_Level_Other_CheckPoint // チェックポイントのテキスト", "位置：菜单"]);
  assert.ok(segmentIds(segment).includes("6"));
  // 旧数据缺 locator/context/result 也不能抛。
  assert.equal(segmentMatchesQuery({ id: "seg-1", source: "あ", translation: "" }, "seg-1"), true);
  assert.deepEqual(segmentNotes({}), []);
});

test("分段队列接线：常显元信息行 + 搜索框 + 已显示计数", async () => {
  const [html, app, styles] = await Promise.all([read("public/index.html"), read("public/app.js"), read("public/styles.css")]);
  assert.match(html, /id="batchSegmentSearch"[^>]*placeholder="搜原文 \/ 译文 \/ ID \/ 注释"/u);
  assert.match(html, /id="batchSegmentCount">已显示 0 \/ 共 0 条/u);
  assert.match(app, /function renderSegmentMeta\(segment = \{\}\)/u);
  // 分段列表分页：计数按已渲染条数算，全量总数另写。
  assert.match(app, /已显示 \$\{renderedSegments\.length\} \/ 共 \$\{segments\.length\} 条/u);
  assert.match(app, /const BATCH_SEGMENT_PAGE_SIZE = 200/u);
  assert.match(app, /id="batchLoadMore"/u);
  assert.match(app, /<span class="row-ref">\$\{position\}<\/span>/u, "行号用数组序号，不再渲染 undefined");
  assert.doesNotMatch(app, /<span class="row-ref">\$\{segment\.index\}<\/span>/u);
  assert.match(styles, /\.batch-segment-meta \{ grid-column: 1 \/ -1;/u);
});
