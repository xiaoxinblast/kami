/**
 * 风格规范的版本差异。
 *
 * 蒸馏是累积式的：新一轮把上一版规则原样带过来，再叠加新增与改写。所以「当前生效」
 * 与「待批准草案」两张卡片并排时，会看到大量逐字相同的规则，人工复核反而要自己
 * 去找哪几条真的变了。这里只做一件事：把两份规则集按"逐字相同 / 改写 / 新增 / 消失"
 * 分开，界面据只展开变化的部分。
 *
 * 判等以规则文本为准（模型换代时可能给同一条规则换 id），id 只用来识别"改写"。
 */

function pureRules(profile) {
  const rules = Array.isArray(profile?.rules) ? profile.rules : [];
  return rules
    .filter((rule) => rule && String(rule.status || "active") !== "retired")
    .map((rule) => ({
      id: String(rule.id || ""),
      text: String(rule.rule ?? rule.text ?? "").trim()
    }))
    .filter((rule) => rule.text);
}

/**
 * `profile` 相对 `baseline`（通常是同作用域当前生效版本）的差异。
 * 没有 baseline（自己就是生效版本）时返回 null，界面照原样列规则。
 */
export function styleProfileDiff(profile, baseline) {
  if (!baseline) return null;
  const current = pureRules(profile);
  const previous = pureRules(baseline);
  const previousTexts = new Set(previous.map((rule) => rule.text));
  const previousById = new Map(previous.map((rule) => [rule.id, rule.text]));
  const currentTexts = new Set(current.map((rule) => rule.text));
  const currentIds = new Set(current.map((rule) => rule.id).filter(Boolean));
  const reusedTexts = [];
  const updatedTexts = [];
  let added = 0;
  for (const rule of current) {
    if (previousTexts.has(rule.text)) {
      reusedTexts.push(rule.text);
      continue;
    }
    if (rule.id && previousById.has(rule.id)) {
      updatedTexts.push(rule.text);
      continue;
    }
    added += 1;
  }
  const retired = previous.filter((rule) => !currentTexts.has(rule.text) && !currentIds.has(rule.id)).length;
  return {
    baselineVersion: Number(baseline.version) || 1,
    added,
    updated: updatedTexts.length,
    reused: reusedTexts.length,
    retired,
    reusedTexts,
    updatedTexts
  };
}
