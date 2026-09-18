import test from "node:test";
import assert from "node:assert/strict";
import { japaneseMatchForms, matchTerms } from "../src/matcher.mjs";

function term(source, target, extra = {}) {
  return {
    id: `t-${source}`,
    source,
    aliases: [],
    target,
    forbidden: [],
    domains: ["game"],
    contentTypes: ["general"],
    enforcement: "preferred",
    status: "approved",
    ...extra
  };
}

const assets = {
  locale: "ja-JP",
  terms: [
    term("リミットブレイク", "极限爆发"),
    term("解放する", "解开"),
    term("プレミアムパス", "高级通行证")
  ]
};

test("日语形态归一：片假名长短音、假名互写与动词活用尾折叠", () => {
  const forms = japaneseMatchForms("リミットブレイク");
  assert.ok(forms.includes("りみっとぶれいく"), "片假名折叠成平假名并去掉长音符");
  assert.ok(japaneseMatchForms("解放する").includes("解放"), "去掉动词活用语尾");
  assert.ok(japaneseMatchForms("解放して").includes("解放"));
});

test("长音符与活用形差异也能命中登记术语", () => {
  const source = "リミットブレークを放つ";
  const longVowel = matchTerms(source, assets, { contentType: "general", domain: "game" });
  assert.equal(longVowel.length, 1);
  assert.equal(longVowel[0].term.target, "极限爆发");
  assert.ok(source.includes(longVowel[0].matchPhrase), "命中的片段必须是原文里真实存在的字符串");
  assert.ok(["exact", "fuzzy", "smart"].includes(longVowel[0].mode));

  const conjugation = matchTerms("敵を解放して進む", assets, { contentType: "general", domain: "game" });
  assert.ok(conjugation.some((match) => match.term.target === "解开"), "解放して 命中 解放する");

  const kana = matchTerms("ぷれみあむぱすを買う", assets, { contentType: "general", domain: "game" });
  const folded = kana.find((match) => match.term.target === "高级通行证");
  assert.ok(folded, "平假名写法命中片假名术语");
  assert.equal(folded.mode, "exact", "假名互写属于同一术语形态差异，按精确命中处理");
  assert.equal(folded.matchPhrase, "プレミアムパス", "不把折叠出来的假名串当成命中片段");
  assert.ok(folded.variantForm, "记录折叠形态便于排查");
});

test("命中上限不会截掉必须原样保留的术语", () => {
  const limited = {
    locale: "ja-JP",
    terms: [
      term("アルファ", "A", { enforcement: "required", preserveOriginal: true }),
      term("ベータ", "B"),
      term("ガンマ", "C")
    ]
  };
  const matches = matchTerms("アルファ ベータ ガンマ", limited, { contentType: "general", domain: "game", limit: 2 });
  assert.equal(matches.length, 2);
  assert.ok(matches.some((match) => match.term.source === "アルファ"), "保留原文的术语永不被上限截掉");
});

test("短术语嵌在长术语里时，只下发最长的那条", () => {
  const nested = {
    locale: "ja-JP",
    terms: [
      term("パス", "帕斯"),
      term("プレミアムパス", "高级通行证"),
      term("運", "运气"),
      term("運営", "运营方")
    ]
  };
  const matches = matchTerms("プレミアムパスを買う。運営に問い合わせる。", nested, { contentType: "general", domain: "game" });
  const sources = matches.map((match) => match.term.source).sort();
  assert.deepEqual(sources, ["プレミアムパス", "運営"], "短术语不再作为独立命中下发");
});

test("长术语只是模糊命中时不遮挡更短的精确命中", () => {
  const nested = {
    locale: "ja-JP",
    terms: [term("パス", "帕斯"), term("プレミアムパスポート", "高级通行护照")]
  };
  const matches = matchTerms("パスを買う。", nested, { contentType: "general", domain: "game" });
  assert.deepEqual(matches.map((match) => match.term.source), ["パス"], "模糊的长术语不能把精确短术语挤掉");
});
