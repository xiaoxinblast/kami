import test from "node:test";
import assert from "node:assert/strict";

import { createTokenCache } from "../src/token-cache.mjs";

test("代际 token 不变时命中缓存，token 变化立即重新加载", async () => {
  let clock = 0;
  let loads = 0;
  const cache = createTokenCache({ ttlMs: 30_000, now: () => clock });
  const load = async () => {
    loads += 1;
    return { version: loads };
  };
  const first = await cache.get("zh-CN\u0000p1", 1, load);
  clock += 1_000;
  const second = await cache.get("zh-CN\u0000p1", 1, load);
  assert.equal(second, first, "同 token 同 TTL 内应返回同一个缓存对象");
  assert.equal(loads, 1);
  const changed = await cache.get("zh-CN\u0000p1", 2, load);
  assert.equal(changed.version, 2);
  assert.equal(loads, 2, "术语写入后 token 变化，必须立即重新加载");
});

test("TTL 过期后重新加载，clear 清空缓存", async () => {
  let clock = 0;
  let loads = 0;
  const cache = createTokenCache({ ttlMs: 1_000, now: () => clock });
  const load = async () => {
    loads += 1;
    return loads;
  };
  await cache.get("k", 7, load);
  clock += 1_001;
  await cache.get("k", 7, load);
  assert.equal(loads, 2, "超过 TTL 必须重新加载");
  await cache.get("k", 7, load);
  assert.equal(loads, 2);
  cache.clear();
  await cache.get("k", 7, load);
  assert.equal(loads, 3, "clear 后必须重新加载");
});
