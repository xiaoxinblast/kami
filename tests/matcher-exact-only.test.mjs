import test from "node:test";
import assert from "node:assert/strict";

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

test("exactOnly 只保留精确命中，跳过滑窗编辑距离", () => {
  const fuzzyText = "ナビマッブを起動します。";
  const full = matchTerms(fuzzyText, assets, { contentType: "general", domain: "game" });
  assert.ok(full.some((match) => match.mode !== "exact"), "默认路径应给出模糊命中");
  const exactOnly = matchTerms(fuzzyText, assets, { contentType: "general", domain: "game", exactOnly: true });
  assert.equal(exactOnly.length, 0, "exactOnly 不能再走模糊/智能匹配");

  const exactText = "ナビマップを起動します。";
  const exact = matchTerms(exactText, assets, { contentType: "general", domain: "game", exactOnly: true });
  assert.equal(exact.length, 1);
  assert.equal(exact[0].mode, "exact");
  assert.equal(exact[0].expectedTarget, "导览地图");
});

test("exactOnly 与默认路径的 exact 结果一致", () => {
  const text = "ナビマップを起動して、設定画面を開きます。";
  const full = matchTerms(text, assets, { contentType: "general", domain: "game" }).filter((match) => match.mode === "exact");
  const exactOnly = matchTerms(text, assets, { contentType: "general", domain: "game", exactOnly: true });
  assert.deepEqual(
    exactOnly.map((match) => `${match.term.id}:${match.mode}:${match.matchPhrase}`),
    full.map((match) => `${match.term.id}:${match.mode}:${match.matchPhrase}`)
  );
});
