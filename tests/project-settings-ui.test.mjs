import test from "node:test";
import assert from "node:assert/strict";
import { createProjectDraft, validateProjectDraft, saveProjectDraft } from "../public/project-settings.js";
import { createDefaultProjectSettings, projectRuleMetadata } from "../src/project-config.mjs";

const project = () => ({ id: "project-1", name: "测试项目", settings: createDefaultProjectSettings(), qaRuleMetadata: projectRuleMetadata() });
const library = (id, role = "reference", priority = 1, kind = "translation_memory") => ({ id, name: id, kind, role, enabled: true, priority, description: "保留说明" });

test("编辑草稿保留零值、未展示的配置与关闭的 QA 规则，并与原项目隔离", () => {
  const source = project();
  source.settings.tm.llmMinRelevance = 0;
  source.settings.tm.retrievalLimit = 12;
  source.settings.batch.structuredMode = "group";
  const draft = createProjectDraft(source, []);
  assert.equal(draft.settings.tm.llmMinRelevance, 0);
  assert.equal(draft.settings.tm.retrievalLimit, 12);
  assert.equal(draft.settings.batch.structuredMode, "group");
  assert.equal(draft.settings.qa.rules.newline_count.enabled, false);
  draft.settings.tm.catMinFuzzy = 70;
  assert.equal(source.settings.tm.catMinFuzzy, 60);
});

test("资源库按同类现有顺序自动使用连续优先级", () => {
  const draft = createProjectDraft(project(), [
    library("tm-low", "reference", 999),
    library("term-second", "reference", 20, "term_base"),
    library("tm-high", "master", 1),
    library("term-first", "reference", 10, "term_base")
  ]);
  assert.deepEqual(draft.libraries.filter((item) => item.kind === "translation_memory").map((item) => [item.id, item.priority]), [["tm-high", 1], ["tm-low", 2]]);
  assert.deepEqual(draft.libraries.filter((item) => item.kind === "term_base").map((item) => [item.id, item.priority]), [["term-first", 1], ["term-second", 2]]);
});

test("保存时会把旧的任意优先级规整为连续顺序", async () => {
  const draft = createProjectDraft(project(), [library("first", "master", 10), library("second", "working", 999)]);
  const writes = [];
  await saveProjectDraft(draft, async (path, options) => {
    const body = JSON.parse(options.body);
    writes.push({ path, body });
    return path.includes("/libraries/") ? { library: { ...body, id: path.split("/").at(-1) } } : { ...project(), settings: body.settings };
  });
  assert.deepEqual(writes.map(({ body }) => body.priority), [1, 2]);
});

test("校验阻止空值、非整数、越界数值和重复启用的主 TM", () => {
  const draft = createProjectDraft(project(), [library("a", "master"), library("b", "master")]);
  draft.settings.tm.catMinFuzzy = "";
  draft.settings.batch.groupMaxEntries = 2.5;
  draft.libraries[0].name = " ";
  const errors = validateProjectDraft(draft);
  for (const key of ["tm.catMinFuzzy", "batch.groupMaxEntries", "library:a:name", "library:b:role"]) assert.ok(errors[key], key);
});

test("主 TM 和工作 TM 互换时先释放原角色，按顺序写入且保留库说明", async () => {
  const draft = createProjectDraft(project(), [library("a", "master", 1), library("b", "working", 2)]);
  draft.libraries[0].role = "working";
  draft.libraries[1].role = "master";
  const server = new Map([library("a", "master", 1), library("b", "working", 2)].map((item) => [item.id, item]));
  const writes = [];
  await saveProjectDraft(draft, async (path, options) => {
    const body = JSON.parse(options.body);
    const id = path.split("/").at(-1);
    writes.push(body);
    if (path.includes("/libraries/")) {
      assert.ok(!body.enabled || body.role === "reference" || ![...server.values()].some((item) => item.id !== id && item.enabled && item.role === body.role));
      const saved = { ...server.get(id), ...body };
      server.set(id, saved);
      return { library: saved };
    }
    return { ...project(), settings: body.settings };
  });
  assert.equal(writes[0].enabled, false);
  assert.equal(writes[1].enabled, false);
  assert.equal(server.get("a").role, "working");
  assert.equal(server.get("b").role, "master");
  assert.equal(server.get("a").description, "保留说明");
});

test("新增库成功后项目保存失败，重试不重复创建且草稿不丢失", async () => {
  const draft = createProjectDraft(project(), []);
  draft.libraries.push({ key: "new-1", name: "新增术语", kind: "term_base", role: "reference", enabled: true, priority: 1 });
  draft.settings.tm.catMinFuzzy = 72;
  let creates = 0;
  let fail = true;
  const api = async (path, options) => {
    const body = JSON.parse(options.body);
    if (options.method === "POST") { creates++; return { library: { ...body, id: "saved-id" } }; }
    if (fail) throw new Error("模拟断线");
    return { ...project(), settings: body.settings };
  };
  await assert.rejects(saveProjectDraft(draft, api), /模拟断线/);
  assert.equal(draft.libraries[0].id, "saved-id");
  assert.equal(draft.settings.tm.catMinFuzzy, 72);
  fail = false;
  const saved = await saveProjectDraft(draft, api);
  assert.equal(creates, 1);
  assert.equal(saved.settings.tm.catMinFuzzy, 72);
});

test("没有更改时不发写请求，非法草稿也不能发写请求", async () => {
  const draft = createProjectDraft(project(), [library("a")]);
  const api = async () => { throw new Error("不应调用"); };
  assert.equal((await saveProjectDraft(draft, api)).id, "project-1");
  draft.settings.tm.catMinFuzzy = 100;
  await assert.rejects(saveProjectDraft(draft, api), /请检查/);
});
