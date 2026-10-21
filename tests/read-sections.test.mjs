import test from "node:test";
import assert from "node:assert/strict";

import { settleReadSections } from "../src/read-sections.mjs";

test("单个区块失败时保留其它区块，并返回失败清单", async () => {
  const { values, failures } = await settleReadSections([
    { key: "batches", load: async () => [{ id: "b1" }] },
    { key: "qaTasks", load: async () => { throw new Error("Directus请求超时（10 秒）"); }, fallback: [] },
    { key: "backgroundTasks", load: async () => [{ id: "t1" }] }
  ]);
  assert.deepEqual(values.batches, [{ id: "b1" }]);
  assert.deepEqual(values.qaTasks, [], "失败的区块用 fallback，不能拖垮整页");
  assert.deepEqual(values.backgroundTasks, [{ id: "t1" }]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].key, "qaTasks");
  assert.match(String(failures[0].error.message), /超时/);
});

test("全部成功时 failures 为空", async () => {
  const { values, failures } = await settleReadSections([
    { key: "a", load: async () => 1 },
    { key: "b", load: async () => 2 }
  ]);
  assert.deepEqual(values, { a: 1, b: 2 });
  assert.deepEqual(failures, []);
});
