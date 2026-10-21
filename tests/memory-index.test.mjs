import test from "node:test";
import assert from "node:assert/strict";
import { buildMemoryIndex, compactMemoryIndex, gramsOf, indexText, removeMemoryRow, selectMemoryCandidates, upsertMemoryRow } from "../src/memory-index.mjs";

const row = (id, source, libraryId = "master") => ({ id, source, libraryId, qualityStatus: "human_approved" });

test("n-gram 集合按行去重，短文本不产 gram", () => {
  assert.deepEqual([...gramsOf("あいう")], ["あいう"]);
  // 同一行里重复的 gram 只算一次：重复用词不能靠刷次数挤进候选。
  assert.deepEqual([...gramsOf("あいあいあい")].sort(), ["あいあ", "いあい"]);
  assert.equal(gramsOf("あい").size, 0);
  assert.equal(indexText("  ナビ\nマップ "), "ナビマップ");
});

test("完全相同的原文无条件进候选（哪怕候选池只有 1 条）", () => {
  const rows = [
    row("a", "クエストをクリアすると報酬を受け取れます。"),
    row("b", "クエストをクリアすると報酬を獲得できます。"),
    row("c", "まったく関係のない別の文章です。")
  ];
  const index = buildMemoryIndex(rows);
  const picked = selectMemoryCandidates(index, "クエストをクリアすると報酬を受け取れます。", { limit: 1 });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].id, "a");
});

test("模糊查询（删掉中段）仍能取到目标行", () => {
  const rows = Array.from({ length: 500 }, (_, index) =>
    row(`m${index}`, `セリフ${index}：これはテスト用に用意した長めの日本語のセリフです。`));
  const target = rows[321];
  const index = buildMemoryIndex(rows);
  const query = [...target.source].filter((_, position) => position % 9 < 5).join("");
  const picked = selectMemoryCandidates(index, query, { limit: 50 });
  assert.ok(picked.some((item) => item.id === target.id), "被扰动过的目标行仍要在候选池里");
});

test("短查询退回子串匹配：2 个字也能找到包含它的行", () => {
  const rows = [
    row("a", "ナビマップを開いて目的地を設定します。"),
    row("b", "設定画面の項目一覧です。"),
    row("c", "レポートを送信しました。")
  ];
  const index = buildMemoryIndex(rows);
  const navi = selectMemoryCandidates(index, "ナビ", { limit: 10 }).map((item) => item.id);
  assert.deepEqual(navi, ["a"]);
  const config = selectMemoryCandidates(index, "設定", { limit: 10 }).map((item) => item.id);
  assert.deepEqual(config.sort(), ["a", "b"], "两行都含「設定」，都要进候选");
  assert.deepEqual(selectMemoryCandidates(index, "", { limit: 10 }), []);
});

test("候选池上限生效、结果可复现、库过滤生效", () => {
  const rows = [
    row("m1", "同じ文言がここに何度も出てきます。", "master"),
    row("m2", "同じ文言がここに何度も出てきます。", "working"),
    row("m3", "同じ文言がここに何度も出てきます。", "master")
  ];
  const index = buildMemoryIndex(rows);
  const limited = selectMemoryCandidates(index, "同じ文言がここに何度も出てきます。", { limit: 2 });
  assert.equal(limited.length, 2);
  const first = selectMemoryCandidates(index, "同じ文言がここに何度も出てきます。", { limit: 3 }).map((item) => item.id);
  const second = selectMemoryCandidates(index, "同じ文言がここに何度も出てきます。", { limit: 3 }).map((item) => item.id);
  assert.deepEqual(first, second, "同一查询必须给出同一批候选");
  const onlyMaster = selectMemoryCandidates(index, "同じ文言がここに何度も出てきます。", { limit: 10, libraryIds: ["master"] }).map((item) => item.id);
  assert.deepEqual(onlyMaster, ["m1", "m3"], "停用的库不进候选");
});

const indexedRow = (id, source, libraryId = "master") => ({ id, source, libraryId, qualityStatus: "human_approved", projectId: "p1" });

test("增量更新/删除/新增后的候选与全量重建一致", () => {
  const base = Array.from({ length: 120 }, (_, index) =>
    indexedRow(`id-${String(index).padStart(3, "0")}`, `候補${index}：これはテスト用に用意した長めの日本語のセリフです。`));
  const index = buildMemoryIndex(base);
  const finalRows = new Map(base.map((item) => [item.id, item]));

  const updated = indexedRow("id-050", "差し替えた原文：ナビマップを起動します。");
  upsertMemoryRow(index, updated);
  finalRows.set(updated.id, updated);

  removeMemoryRow(index, "id-077");
  finalRows.delete("id-077");

  // 同原文的重复行：候选池截断时也要和全量重建保持同一顺序。
  for (const added of [indexedRow("new-001", "同じ原文の重複行です。"), indexedRow("new-000", "同じ原文の重複行です。")]) {
    upsertMemoryRow(index, added);
    finalRows.set(added.id, added);
  }

  const rebuilt = buildMemoryIndex([...finalRows.values()]);
  const queries = [
    "ナビマップ",
    "設定",
    "候補1：",
    "同じ原文の重複行です。",
    "差し替えた原文：ナビマップを起動します。",
    "これはどの行にも含まれない非常用の查询です。"
  ];
  for (const query of queries) {
    assert.deepEqual(
      selectMemoryCandidates(index, query, { limit: 12 }).map((item) => item.id),
      selectMemoryCandidates(rebuilt, query, { limit: 12 }).map((item) => item.id),
      `查询「${query}」的候选必须与全量重建一致`
    );
  }
  // 更新后的原文要能命中，旧原文不能继续以"完全相同"进入候选。
  assert.deepEqual(
    selectMemoryCandidates(index, "差し替えた原文：ナビマップを起動します。", { limit: 5 }).map((item) => item.id),
    ["id-050"]
  );
  assert.equal(
    selectMemoryCandidates(index, "候補77：", { limit: 10 }).some((item) => item.id === "id-077"),
    false,
    "删掉的行不能还在候选里"
  );
});

test("压缩回收作废槽位后，候选结果与全量重建一致", () => {
  const base = [indexedRow("id-000", "最初の原文：設定画面を開きます。"), indexedRow("id-001", "別の原文：レポートを送信しました。")];
  const index = buildMemoryIndex(base);
  let latest = base[0];
  for (let version = 1; version <= 20; version += 1) {
    latest = indexedRow("id-000", `更新後の原文 ${version}：ナビマップを起動します。`);
    upsertMemoryRow(index, latest);
  }
  assert.ok(index.rows.length > index.live, "反复更新期间会留下作废槽位");
  compactMemoryIndex(index);
  assert.equal(index.rows.length, index.live, "压缩后槽位数应等于存活行数");
  const rebuilt = buildMemoryIndex([latest, base[1]]);
  for (const query of ["ナビマップ", "設定", "レポート"]) {
    assert.deepEqual(
      selectMemoryCandidates(index, query, { limit: 5 }).map((item) => item.id),
      selectMemoryCandidates(rebuilt, query, { limit: 5 }).map((item) => item.id),
      `压缩后查询「${query}」仍要一致`
    );
  }
  // 旧原文不应再命中；用新原文做精确查询必须把存活行排在最前（同 gram 的其它行仍可能是低分候选）。
  const exact = selectMemoryCandidates(index, "更新後の原文 20：ナビマップを起動します。", { limit: 5 });
  assert.equal(exact[0].id, "id-000", "精确匹配必须排第一");
  assert.equal(exact.filter((item) => item.id === "id-000").length, 1, "更新后的行不能在索引里出现两次");
  assert.equal(
    selectMemoryCandidates(index, "最初の原文：設定画面を開きます。", { limit: 5 }).some((item) => item.source === "最初の原文：設定画面を開きます。"),
    false,
    "旧原文不能被当成同一行继续返回"
  );
});

test("空索引可以直接增量加入第一行", () => {
  const index = buildMemoryIndex([]);
  assert.deepEqual(selectMemoryCandidates(index, "ナビ", { limit: 5 }), []);
  upsertMemoryRow(index, indexedRow("only", "ナビマップを起動します。"));
  assert.deepEqual(selectMemoryCandidates(index, "ナビ", { limit: 5 }).map((item) => item.id), ["only"]);
  assert.equal(index.live, 1);
});

test("大量增量更新后（未压缩）倒排存活计数与全量重建一致", () => {
  const base = Array.from({ length: 400 }, (_, index) =>
    indexedRow(`id-${String(index).padStart(3, "0")}`, `共通フレーズ${index % 7}：これはテスト用の日本語テキストです。`));
  const index = buildMemoryIndex(base);
  const finalRows = new Map(base.map((item) => [item.id, item]));
  for (let round = 0; round < 300; round += 1) {
    const target = base[(round * 7) % base.length];
    const updated = indexedRow(target.id, `更新版${round}：共通フレーズを含む日本語テキストです。`);
    upsertMemoryRow(index, updated);
    finalRows.set(target.id, updated);
  }
  removeMemoryRow(index, "id-000");
  finalRows.delete("id-000");
  const rebuilt = buildMemoryIndex([...finalRows.values()]);
  assert.ok(index.rows.length > index.live, "此时仍有作废槽位（尚未触发压缩）");
  // IDF 用的是"存活行数"：作废槽位还挂在倒排数组里，但不能把 gram 的计数算进去，
  // 否则增量索引的排序会随着废数据增加而漂移。
  for (const [gram, bucket] of rebuilt.postings) {
    assert.equal(index.postings.get(gram)?.live, bucket.live, `gram「${gram}」的存活计数要与全量重建一致`);
  }
  for (const query of ["共通フレーズ", "更新版1：", "テキストです。", "存在しないクエリ語"]) {
    assert.deepEqual(
      selectMemoryCandidates(index, query, { limit: 25 }).map((item) => item.id),
      selectMemoryCandidates(rebuilt, query, { limit: 25 }).map((item) => item.id),
      `增量索引查询「${query}」的候选必须与全量重建一致`
    );
  }
});
