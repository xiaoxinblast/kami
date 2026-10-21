import test from "node:test";
import assert from "node:assert/strict";

import { parsePruneArgs } from "../scripts/prune-directus-revisions.mjs";

test("清理历史默认 dry-run、保留 21 天", () => {
  assert.deepEqual(parsePruneArgs([]), { days: 21, apply: false, vacuum: false, batch: 10_000 });
});

test("可以指定天数和 apply/vacuum/batch", () => {
  assert.deepEqual(parsePruneArgs(["--days=30", "--apply", "--vacuum", "--batch=5000"]), {
    days: 30, apply: true, vacuum: true, batch: 5_000
  });
});

test("拒绝过短保留期和非法 batch", () => {
  assert.throws(() => parsePruneArgs(["--days=3"]), /保留期太短/u);
  assert.throws(() => parsePruneArgs(["--batch=10"]), /batch/u);
  assert.throws(() => parsePruneArgs(["--unknown"]), /未知参数/u);
});
