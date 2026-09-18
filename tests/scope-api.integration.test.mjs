import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// 真实 Directus 上的作用域兜底验收：只放一条「通用×通用」规范，
// 用「对白×游戏」去解析必须命中它（旧口径返回空 —— 那就是"配错语体就静默失效"的坑）。
const enabled = process.env.KAMI_API_E2E === "1" && process.env.KAMI_STORE === "directus";
const directusUrl = String(process.env.DIRECTUS_URL || "http://127.0.0.1:18055").replace(/\/$/, "");
const adminToken = process.env.DIRECTUS_ADMIN_TOKEN || "";

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "content-type": "application/json", Authorization: `Bearer ${adminToken}`, ...(options.headers || {}) } });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(payload)}`);
  return payload?.data ?? payload;
}

test("通用风格规范对任意语体兜底命中（真实 Directus）", { skip: !enabled }, async () => {
  const { getDirectusStyleProfile } = await import("../src/directus-store.mjs");
  const projectId = randomUUID();
  const profileId = randomUUID();
  await request(`${directusUrl}/items/style_profiles`, {
    method: "POST",
    body: JSON.stringify({
      id: profileId, project_id: projectId, target_locale: "zh-CN",
      content_type: "general", domain: "general",
      name: "端到端校验·通用规范", instructions: "【用词】\n・校验用",
      rules: [], examples: [], version: 1, evidence_count: 8, status: "active"
    })
  });
  try {
    for (const [contentType, domain] of [["dialogue", "game"], ["ui", "game"], ["announcement", "marketing"]]) {
      const scoped = await getDirectusStyleProfile("zh-CN", contentType, domain, { projectId, scopeFallback: true });
      assert.ok(scoped, `${contentType}×${domain} 应该兜底命中通用规范`);
      assert.equal(scoped.id, profileId);
      assert.equal(scoped.scopeRank, 3, "兜底命中要落在链上最后一档");
      const strict = await getDirectusStyleProfile("zh-CN", contentType, domain, { projectId, scopeFallback: false });
      assert.equal(strict, null, `旧口径在 ${contentType}×${domain} 下取不到（这正是本次修掉的坑）`);
    }
    // 同语体同领域的规范仍然优先于通用
    const specificId = randomUUID();
    await request(`${directusUrl}/items/style_profiles`, {
      method: "POST",
      body: JSON.stringify({
        id: specificId, project_id: projectId, target_locale: "zh-CN",
        content_type: "dialogue", domain: "game",
        name: "端到端校验·对白规范", instructions: "【用词】\n・对白专用",
        rules: [], examples: [], version: 1, evidence_count: 8, status: "active"
      })
    });
    const preferred = await getDirectusStyleProfile("zh-CN", "dialogue", "game", { projectId, scopeFallback: true });
    assert.equal(preferred.id, specificId, "同语体同领域优先");
    assert.equal(preferred.scopeRank, 0);
    await request(`${directusUrl}/items/style_profiles/${specificId}`, { method: "DELETE" });
  } finally {
    await request(`${directusUrl}/items/style_profiles/${profileId}`, { method: "DELETE" });
  }
});
