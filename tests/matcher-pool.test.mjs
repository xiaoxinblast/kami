import test from "node:test";
import assert from "node:assert/strict";

import { createMatcherPool } from "../src/matcher-pool.mjs";
import { matchTerms } from "../src/matcher.mjs";

const assets = {
  locale: "ja-JP",
  terms: [{
    id: "t1",
    source: "ナビマップ",
    aliases: [],
    target: "导览地图",
    forbidden: [],
    domains: ["game"],
    contentTypes: ["general"],
    enforcement: "required",
    status: "approved"
  }]
};

test("术语匹配 worker 的结果与同步实现一致，并复用同一份资产", async () => {
  const pool = createMatcherPool();
  try {
    const text = "ナビマップを起動して、設定画面を開きます。";
    const options = { contentType: "general", domain: "game" };
    const [viaWorker, second] = await Promise.all([
      pool.match(text, assets, options),
      pool.match("ナビマップを終了します。", assets, options)
    ]);
    assert.deepEqual(viaWorker, matchTerms(text, assets, options));
    assert.deepEqual(second, matchTerms("ナビマップを終了します。", assets, options));
    // 命中结果里必须保留条目对象，后续提示词/QA 依赖这些字段。
    assert.equal(viaWorker[0].term.target, "导览地图");
  } finally {
    await pool.close();
  }
});
