import test from "node:test";
import assert from "node:assert/strict";

import { resolveSegmentMatches } from "../src/batch-matches.mjs";

test("批次详情复用翻译时保存的术语匹配，不再为每次轮询重算", () => {
  const saved = [{ mode: "exact", term: { source: "既存" } }];
  let calls = 0;
  const reused = resolveSegmentMatches(
    { source: "既存のテキスト", result: { matches: saved } },
    { revision: 1, terms: [{ source: "既存" }] },
    { contentType: "general", domain: "game" },
    () => {
      calls += 1;
      return [];
    }
  );
  assert.equal(reused, saved, "返回的应该就是保存的那份匹配结果");
  assert.equal(calls, 0, "有保存结果时不能调用重算函数");
});

test("没有保存结果时才计算，并按资源版本缓存", () => {
  let calls = 0;
  const compute = () => {
    calls += 1;
    return [{ mode: "exact" }];
  };
  const segment = { source: `未保存的原文-${Date.now()}` };
  const scope = { contentType: "general", domain: "game" };
  const assets = { revision: 100, terms: [{}, {}] };
  const first = resolveSegmentMatches(segment, assets, scope, compute);
  const second = resolveSegmentMatches(segment, assets, scope, compute);
  assert.equal(first, second, "同一原文同版本应命中缓存");
  assert.equal(calls, 1, "同版本同一原文只计算一次");
  resolveSegmentMatches(segment, { revision: 101, terms: [{}, {}] }, scope, compute);
  assert.equal(calls, 2, "术语资源版本变化后要重算");
  resolveSegmentMatches({ source: segment.source, result: { matches: [] } }, assets, scope, compute);
  assert.equal(calls, 2, "空数组也是已保存结果，不再计算");
});
