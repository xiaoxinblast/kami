import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { styleProfileDiff } from "../public/style-utils.js";

const rule = (id, text, status = "active") => ({ id, rule: text, category: "用词", status });

const active = {
  id: "p1",
  status: "active",
  version: 1,
  rules: [rule("r-a", "规则 A"), rule("r-b", "规则 B"), rule("r-c", "规则 C")]
};

test("草案与生效版本逐字相同的规则算沿用，不重复展开", () => {
  const draft = {
    id: "p2",
    status: "draft",
    version: 2,
    rules: [rule("r-a", "规则 A"), rule("r-b", "规则 B"), rule("r-d", "规则 D")]
  };
  const diff = styleProfileDiff(draft, active);
  assert.equal(diff.baselineVersion, 1);
  assert.equal(diff.reused, 2);
  assert.deepEqual(diff.reusedTexts.sort(), ["规则 A", "规则 B"]);
  assert.equal(diff.added, 1, "只有草案才有的规则算新增");
  assert.equal(diff.updated, 0);
  assert.equal(diff.retired, 1, "生效版本里消失的规则算退休");
});

test("同 id 改了文案算改写，不算沿用也不算退休", () => {
  const draft = {
    id: "p2",
    status: "draft",
    version: 2,
    rules: [rule("r-a", "规则 A"), rule("r-b", "规则 B（改写）"), rule("r-c", "规则 C")]
  };
  const diff = styleProfileDiff(draft, active);
  assert.equal(diff.updated, 1);
  assert.deepEqual(diff.updatedTexts, ["规则 B（改写）"]);
  assert.equal(diff.retired, 0);
  assert.equal(diff.reused, 2);
});

test("模型换代时给同一条规则换 id，只要文案一致仍算沿用", () => {
  const draft = { id: "p2", status: "draft", version: 2, rules: [rule("r-new-id", "规则 A")] };
  const diff = styleProfileDiff(draft, active);
  assert.equal(diff.reused, 1);
  assert.equal(diff.added, 0);
});

test("自己就是生效版本时不生成差异", () => {
  assert.equal(styleProfileDiff(active, null), null);
  assert.equal(styleProfileDiff(active, undefined), null);
});

test("已退休规则不参与差异计算", () => {
  const draft = { id: "p2", status: "draft", version: 2, rules: [rule("r-a", "规则 A"), rule("r-x", "退休规则", "retired")] };
  const diff = styleProfileDiff(draft, active);
  assert.equal(diff.reused, 1);
  assert.equal(diff.added, 0, "退休规则不该被算成新增");
});

test("风格页面把沿用的规则折叠、把改写标出来", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /import \{ styleProfileDiff \} from "\.\/style-utils\.js";/u);
  assert.match(app, /class="style-rule-reused"/u);
  assert.match(app, /沿用 v\$\{diff\.baselineVersion\} 的 \$\{reused\.length\} 条/u);
  assert.match(app, /对比 v\$\{diff\.baselineVersion\}：新增 \$\{diff\.added\} · 改写 \$\{diff\.updated\} · 逐字沿用 \$\{diff\.reused\} · 已退休 \$\{diff\.retired\}/u);
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.style-rule-reused > summary \{/u);
});
