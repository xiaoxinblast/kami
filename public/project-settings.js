const fields = [
  { key: "tm.catMinFuzzy", tab: "matching", section: "CAT 匹配", label: "最低模糊匹配率", hint: "仅筛选低于 100% 的 CAT 候选，100 / 101 / 102 匹配不受影响。", min: 50, max: 99, fallback: 60, unit: "%" },
  { key: "tm.llmMinRelevance", tab: "matching", section: "模型参考", label: "最低参考相关度", hint: "达到此相关度的模糊或语义译例，才会进入模型上下文。", min: 0, max: 100, fallback: 60, unit: "%" },
  { key: "tm.contextAnchorCount", tab: "matching", section: "连续上下文", label: "保留的双语上下文", hint: "跨联译组和子批次传递最近完成的条目；设为 0 则不传递。", min: 0, max: 10, fallback: 5, unit: "条" },
  { key: "batch.subBatchMaxEntries", tab: "batch", section: "子批次", label: "最大条目数", hint: "划分进度、恢复和 QA 检查的边界。", min: 10, max: 500, fallback: 100, unit: "条" },
  { key: "batch.subBatchMaxChars", tab: "batch", section: "子批次", label: "最大源字符数", hint: "条目数或源字符数，先达到任意上限即分批。", min: 1000, max: 50000, fallback: 8000, unit: "字符" },
  { key: "batch.groupMaxEntries", tab: "batch", section: "联译小组", label: "最大条目数", hint: "仅影响“相邻条目联译”模式。", min: 2, max: 50, fallback: 10, unit: "条" },
  { key: "batch.groupMaxChars", tab: "batch", section: "联译小组", label: "最大源字符数", hint: "限制一次联译请求中的源文总量。", min: 300, max: 12000, fallback: 1500, unit: "字符" }
];
const tabs = [
  { id: "libraries", title: "术语库与 TM", subtitle: "管理项目的翻译参考", icon: "books" },
  { id: "matching", title: "匹配与上下文", subtitle: "控制参考内容的选取", icon: "sliders" },
  { id: "batch", title: "批次与联译", subtitle: "设置批次与请求规模", icon: "grid" },
  { id: "qa", title: "QA 规则", subtitle: "配置检查项与严重度", icon: "check" }
];
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const getValue = (settings, key) => key.split(".").reduce((value, part) => value?.[part], settings);
const libraryBody = ({ name, kind, role, enabled, priority }) => ({ name: name.trim(), kind, role, enabled, priority: Number(priority) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function orderLibraries(libraries) {
  const indexed = libraries.map((library, index) => ({ ...structuredClone(library), index }));
  const ordered = [];
  for (const kind of ["term_base", "translation_memory"]) {
    ordered.push(...indexed
      .filter((library) => library.kind === kind)
      .sort((left, right) => Number(left.priority) - Number(right.priority) || left.index - right.index)
      .map((library, index) => ({ ...library, priority: index + 1 })));
  }
  return ordered;
}

function normalizeLibraryPriorities(libraries, kind) {
  libraries.filter((library) => library.kind === kind).forEach((library, index) => { library.priority = index + 1; });
}

export function createProjectDraft(project, libraries) {
  const settings = structuredClone(project.settings || {});
  for (const field of fields) {
    const [group, key] = field.key.split(".");
    settings[group] ||= {};
    settings[group][key] ??= field.fallback;
  }
  settings.qa ||= {};
  settings.qa.rules ||= {};
  for (const rule of project.qaRuleMetadata || []) {
    settings.qa.rules[rule.id] ||= { enabled: rule.defaultEnabled, severity: rule.defaultSeverity };
    if (rule.fixed) settings.qa.rules[rule.id] = { enabled: true, severity: rule.defaultSeverity };
  }
  return {
    project: structuredClone(project), settings,
    libraries: orderLibraries(libraries).map((library) => ({ ...library, key: library.id })),
    persisted: new Map(libraries.map((library) => [library.id, libraryBody(library)])),
    savedSettings: structuredClone(settings), partial: false
  };
}

export function validateProjectDraft(draft) {
  const errors = {};
  const check = (key, value, min, max) => {
    if (value === "" || !Number.isInteger(Number(value)) || Number(value) < min || Number(value) > max) errors[key] = `请输入 ${min}–${max} 之间的整数`;
  };
  for (const field of fields) check(field.key, getValue(draft.settings, field.key), field.min, field.max);
  const roles = new Set();
  for (const library of draft.libraries) {
    if (!library.name.trim()) errors[`library:${library.key}:name`] = "请填写资源库名称";
    if (library.kind === "translation_memory" && library.enabled && library.role !== "reference") {
      if (roles.has(library.role)) errors[`library:${library.key}:role`] = `只能启用一个${library.role === "master" ? "主 TM" : "工作 TM"}，请先调整其他库`;
      roles.add(library.role);
    }
  }
  return errors;
}

export async function saveProjectDraft(draft, api) {
  if (Object.keys(validateProjectDraft(draft)).length) throw new Error("请检查标记的设置项");
  const root = `/api/projects/${encodeURIComponent(draft.project.id)}`;
  // Release occupied roles before assigning new ones, including master/working swaps.
  for (const library of draft.libraries) {
    const before = draft.persisted.get(library.id);
    if (before?.enabled && ["master", "working"].includes(before.role) && (!library.enabled || before.role !== library.role)) {
      await api(`${root}/libraries/${encodeURIComponent(library.id)}`, { method: "PATCH", body: JSON.stringify({ ...before, enabled: false }) });
      draft.persisted.set(library.id, { ...before, enabled: false });
      draft.partial = true;
    }
  }
  for (const library of draft.libraries) {
    const body = libraryBody(library);
    if (library.id && same(body, draft.persisted.get(library.id))) continue;
    const path = library.id ? `${root}/libraries/${encodeURIComponent(library.id)}` : `${root}/libraries`;
    const result = await api(path, { method: library.id ? "PATCH" : "POST", body: JSON.stringify(body) });
    library.id = result.library.id;
    draft.persisted.set(library.id, body);
    draft.partial = true;
  }
  if (!same(draft.settings, draft.savedSettings)) {
    draft.project = await api(root, { method: "PATCH", body: JSON.stringify({ settings: draft.settings }) });
    draft.savedSettings = structuredClone(draft.settings);
  }
  return draft.project;
}

function icon(name) {
  const paths = {
    books: '<path d="M4 4h5v16H4zM9 4h5v16H9zM16 4l4-1 4 16-4 1z"/>',
    sliders: '<path d="M4 7h6m4 0h6M4 17h10m4 0h2"/><circle cx="12" cy="7" r="2"/><circle cx="16" cy="17" r="2"/>',
    grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
    check: '<path d="M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>'
  };
  return `<svg viewBox="0 0 26 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

function toggle(attributes, enabled, label) {
  return `<label class="ps-switch"><input type="checkbox" role="switch" ${attributes} ${enabled ? "checked" : ""} aria-label="${escape(label)}"><span class="ps-switch-track" aria-hidden="true"></span><span class="ps-switch-text">${enabled ? "已启用" : "已停用"}</span></label>`;
}

export function createProjectSettingsPanel(dialog, { api, onSaved }) {
  let draft;
  let initial;
  let saving = false;
  let tab = "libraries";
  let validationShown = false;
  const find = (selector) => dialog.querySelector(selector);
  const all = (selector) => [...dialog.querySelectorAll(selector)];
  const signature = () => JSON.stringify({ settings: draft.settings, libraries: draft.libraries.map(({ key, name, kind, role, enabled, priority }) => ({ key, name, kind, role, enabled, priority })) });
  const dirty = () => signature() !== initial;

  function renderLibrary(library, index, total) {
    const key = escape(library.key);
    const tm = library.kind === "translation_memory";
    return `<article class="ps-library" data-library="${key}">
      <div class="ps-library-top"><span class="ps-badge">${tm ? "TM" : "术语库"}</span>${!library.id ? '<span class="ps-new">新增 · 保存后生效</span><button type="button" class="ps-remove" data-remove="' + key + '">移除草稿</button>' : ""}</div>
      <div class="ps-library-fields">
        <label class="ps-library-name"><span>资源库名称</span><input data-library-field="name" data-key="${key}" data-error-key="library:${key}:name" aria-describedby="ps-error-library:${key}:name" value="${escape(library.name)}" placeholder="输入资源库名称" required><small class="ps-error" id="ps-error-library:${key}:name" data-error="library:${key}:name"></small></label>
        ${tm ? `<label><span>用途</span><select data-library-field="role" data-key="${key}" data-error-key="library:${key}:role" aria-describedby="ps-error-library:${key}:role">${[["master", "主 TM"], ["working", "工作 TM"], ["reference", "参考 TM"]].map(([value, label]) => `<option value="${value}" ${library.role === value ? "selected" : ""}>${label}</option>`).join("")}</select><small class="ps-error" id="ps-error-library:${key}:role" data-error="library:${key}:role"></small></label>` : '<div class="ps-library-purpose"><span>用途</span><strong>术语检索</strong></div>'}
        <div class="ps-library-order"><span>优先顺序</span><div><strong data-priority-rank>${index + 1}</strong><button type="button" data-move="up" data-key="${key}" aria-label="上调 ${escape(library.name || "新资源库")}" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" data-move="down" data-key="${key}" aria-label="下调 ${escape(library.name || "新资源库")}" ${index === total - 1 ? "disabled" : ""}>↓</button></div></div>
        <div class="ps-library-status"><span>检索状态</span>${toggle(`data-library-field="enabled" data-key="${key}"`, library.enabled, `启用 ${library.name || "新资源库"}`)}</div>
      </div></article>`;
  }

  function renderLibraries() {
    for (const kind of ["term_base", "translation_memory"]) {
      const items = draft.libraries.filter((library) => library.kind === kind);
      find(`[data-library-list="${kind}"]`).innerHTML = items.length ? items.map((library, index) => renderLibrary(library, index, items.length)).join("") : '<div class="ps-empty">尚未添加资源库，点击右上方按钮开始添加。</div>';
      find(`[data-count="${kind}"]`).textContent = items.length;
    }
  }

  function fieldMarkup(field) {
    return `<div class="ps-setting-row"><label for="ps-${field.key}"><strong>${field.label}</strong><small>${field.hint}</small></label><div class="ps-value"><div class="ps-number"><input id="ps-${field.key}" data-setting="${field.key}" data-error-key="${field.key}" aria-describedby="ps-range-${field.key} ps-error-${field.key}" type="number" min="${field.min}" max="${field.max}" step="1" value="${getValue(draft.settings, field.key)}" required><span>${field.unit}</span></div><small id="ps-range-${field.key}">${field.min}–${field.max} ${field.unit}</small><small class="ps-error" id="ps-error-${field.key}" data-error="${field.key}"></small></div></div>`;
  }

  function renderRules() {
    const rules = draft.project.qaRuleMetadata || [];
    find("[data-rule-list]").innerHTML = rules.map((rule) => {
      const value = draft.settings.qa.rules[rule.id];
      return `<article class="ps-rule" data-rule="${escape(rule.id)}" data-group="${escape(rule.group)}" data-search="${escape(`${rule.label} ${rule.description} ${rule.group}`.toLowerCase())}"><div class="ps-rule-copy"><span class="ps-rule-group">${escape(rule.group)}</span><strong>${escape(rule.label)}</strong><p>${escape(rule.description)}</p></div><div class="ps-rule-controls">${rule.fixed ? '<span class="ps-fixed">始终启用</span><span class="ps-severity-fixed">阻断</span>' : `${toggle(`data-rule-toggle="${escape(rule.id)}"`, value.enabled !== false, `启用 ${rule.label}`)}<select data-rule-severity="${escape(rule.id)}" aria-label="${escape(rule.label)}的严重度" ${value.enabled === false ? "disabled" : ""}>${rule.severities.map((severity) => `<option value="${severity}" ${value.severity === severity ? "selected" : ""}>${({ error: "阻断", warning: "警告", info: "提示" })[severity] || escape(severity)}</option>`).join("")}</select>`}</div></article>`;
    }).join("");
    filterRules();
  }

  function filterRules() {
    const query = find("[data-rule-search]").value.trim().toLowerCase();
    const group = find("[data-rule-group]").value;
    let visible = 0;
    for (const row of all("[data-rule]")) {
      row.hidden = Boolean((group && row.dataset.group !== group) || (query && !row.dataset.search.includes(query)));
      if (!row.hidden) visible++;
    }
    find("[data-rule-empty]").hidden = visible > 0;
    find("[data-rule-count]").textContent = `${visible} 项规则`;
  }

  function selectTab(id, focus = false) {
    tab = id;
    for (const button of all("[data-tab]")) {
      button.setAttribute("aria-selected", String(button.dataset.tab === id));
      button.tabIndex = button.dataset.tab === id ? 0 : -1;
    }
    for (const panel of all("[data-panel]")) panel.hidden = panel.dataset.panel !== id;
    if (focus) find(`[data-tab="${id}"]`).focus();
  }

  function showErrors() {
    const errors = validateProjectDraft(draft);
    for (const slot of all("[data-error]")) slot.textContent = errors[slot.dataset.error] || "";
    for (const input of all("[data-error-key]")) input.setAttribute("aria-invalid", String(Boolean(errors[input.dataset.errorKey])));
    return errors;
  }

  function updateStatus(message = "", error = false) {
    find("[data-save-status]").textContent = message || (dirty() ? "有未保存的修改" : "所有设置已保存");
    find("[data-save-status]").classList.toggle("is-error", error);
    find("[data-save]").disabled = saving || (!dirty() && !draft.partial);
    find("[data-save]").textContent = saving ? "正在保存…" : "保存更改";
  }

  function requestClose() {
    if (saving) return;
    if (!dirty() && !draft.partial) return dialog.close();
    find("[data-discard-prompt]").hidden = false;
    find("[data-discard-note]").textContent = draft.partial ? "部分更改已经写入。关闭只会放弃尚未保存的修改。" : "修改尚未保存。你可以继续编辑、保存，或放弃修改。";
    find("[data-keep-editing]").focus();
  }

  async function submit() {
    if (saving) return;
    validationShown = true;
    if (Object.keys(showErrors()).length) {
      const invalid = find('[aria-invalid="true"]');
      selectTab(invalid.closest("[data-panel]").dataset.panel);
      invalid.focus();
      updateStatus("请检查标记的设置项", true);
      return;
    }
    saving = true;
    find("[data-discard-prompt]").hidden = true;
    find(".ps-editor").disabled = true;
    find("[data-close-settings]").disabled = true;
    find("[data-cancel-settings]").disabled = true;
    dialog.setAttribute("aria-busy", "true");
    updateStatus("正在保存，请稍候…");
    try {
      const project = await saveProjectDraft(draft, api);
      onSaved(project);
      draft.partial = false;
      initial = signature();
      dialog.close();
    } catch (error) {
      updateStatus(`${draft.partial ? "部分更改已保存；" : "保存失败；"}${error.message}。编辑内容已保留，请重试。`, true);
    } finally {
      saving = false;
      find(".ps-editor").disabled = false;
      find("[data-close-settings]").disabled = false;
      find("[data-cancel-settings]").disabled = false;
      dialog.removeAttribute("aria-busy");
      find("[data-save]").disabled = !dirty() && !draft.partial;
      find("[data-save]").textContent = "保存更改";
    }
  }

  dialog.addEventListener("cancel", (event) => { event.preventDefault(); requestClose(); });
  dialog.addEventListener("submit", (event) => { event.preventDefault(); submit(); });
  dialog.addEventListener("keydown", (event) => {
    if (event.target.matches("[data-tab]") && ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const index = tabs.findIndex((item) => item.id === tab);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1) + tabs.length) % tabs.length;
      selectTab(tabs[next].id, true);
    }
    if (event.key === "Enter" && event.target.matches("input") && event.target.type !== "checkbox") event.preventDefault();
  });
  dialog.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || saving) return;
    if (button.dataset.tab) selectTab(button.dataset.tab);
    if (button.matches("[data-close-settings], [data-cancel-settings]")) requestClose();
    if (button.matches("[data-keep-editing]")) { find("[data-discard-prompt]").hidden = true; find("[data-save]").focus(); }
    if (button.matches("[data-discard]")) dialog.close();
    if (button.dataset.addLibrary) {
      const key = `new-${crypto.randomUUID()}`;
      const kind = button.dataset.addLibrary;
      draft.libraries.push({ key, name: "", kind, role: "reference", priority: draft.libraries.filter((library) => library.kind === kind).length + 1, enabled: true });
      renderLibraries();
      find(`[data-library="${key}"] input`).focus();
      if (validationShown) showErrors();
      updateStatus();
    }
    if (button.dataset.move) {
      const current = draft.libraries.findIndex((library) => library.key === button.dataset.key);
      const peers = draft.libraries.map((library, index) => ({ library, index })).filter(({ library }) => library.kind === draft.libraries[current].kind);
      const peerIndex = peers.findIndex(({ index }) => index === current);
      const other = peers[peerIndex + (button.dataset.move === "up" ? -1 : 1)]?.index;
      if (other !== undefined) {
        [draft.libraries[current], draft.libraries[other]] = [draft.libraries[other], draft.libraries[current]];
        normalizeLibraryPriorities(draft.libraries, draft.libraries[other].kind);
        renderLibraries();
        find(`[data-library="${button.dataset.key}"] [data-move="${button.dataset.move}"]`)?.focus();
        updateStatus();
      }
    }
    if (button.dataset.remove) {
      draft.libraries = draft.libraries.filter((library) => library.key !== button.dataset.remove || library.id);
      renderLibraries();
      if (validationShown) showErrors();
      updateStatus();
    }
  });
  function edit(event) {
    const input = event.target;
    if (saving) return;
    if (input.matches("[data-rule-search], [data-rule-group]")) return filterRules();
    const before = signature();
    let changed = false;
    if (input.dataset.setting) {
      const [group, key] = input.dataset.setting.split(".");
      draft.settings[group][key] = input.value === "" ? "" : Number(input.value);
      changed = true;
    }
    if (input.dataset.libraryField) {
      const library = draft.libraries.find((item) => item.key === input.dataset.key);
      library[input.dataset.libraryField] = input.type === "checkbox" ? input.checked : input.type === "number" && input.value !== "" ? Number(input.value) : input.value;
      changed = true;
    }
    if (input.dataset.ruleToggle) {
      draft.settings.qa.rules[input.dataset.ruleToggle].enabled = input.checked;
      input.closest("[data-rule]").querySelector("select").disabled = !input.checked;
      changed = true;
    }
    if (input.dataset.ruleSeverity) { draft.settings.qa.rules[input.dataset.ruleSeverity].severity = input.value; changed = true; }
    if (input.type === "checkbox") input.closest(".ps-switch").querySelector(".ps-switch-text").textContent = input.checked ? "已启用" : "已停用";
    if (changed && signature() !== before) {
      find("[data-discard-prompt]").hidden = true;
      if (validationShown) showErrors();
      updateStatus();
    }
  }
  dialog.addEventListener("input", edit);
  dialog.addEventListener("change", edit);

  return {
    open(project, libraries, { initialTab = "libraries" } = {}) {
      draft = createProjectDraft(project, libraries);
      initial = signature();
      validationShown = false;
      const groups = [...new Set((project.qaRuleMetadata || []).map((rule) => rule.group))];
      dialog.innerHTML = `<form id="projectSettingsForm" class="ps-form" novalidate>
        <header class="ps-header"><div><span class="ps-eyebrow">项目工作区</span><h2 id="projectSettingsTitle">项目设置</h2><p>${escape(project.name)}<span>仅对当前项目生效</span></p></div><button class="ps-close" type="button" data-close-settings aria-label="关闭项目设置">×</button></header>
        <fieldset class="ps-editor"><legend class="ps-sr-only">项目设置编辑区</legend><nav class="ps-nav" role="tablist" aria-label="设置分类" aria-orientation="vertical">${tabs.map((item) => `<button type="button" role="tab" id="ps-tab-${item.id}" aria-controls="ps-panel-${item.id}" data-tab="${item.id}">${icon(item.icon)}<span><strong>${item.title}</strong><small>${item.subtitle}</small></span></button>`).join("")}<div class="ps-nav-note">调整会在保存后生效<br>切换分类不会丢失修改</div></nav>
        <div class="ps-content">
          <section role="tabpanel" id="ps-panel-libraries" aria-labelledby="ps-tab-libraries" data-panel="libraries" tabindex="0"><div class="ps-page-heading"><span class="ps-eyebrow">翻译资源</span><h3>术语库与 TM</h3><p>选择参与检索的资源，为项目建立统一的翻译参考。</p></div><div class="ps-info">主 TM 提供优先参考，工作 TM 用于当前项目的一致性。每个项目最多启用一个主 TM 和一个工作 TM。</div>${[["term_base", "术语库", "统一项目用词与专有名词", "添加术语库"], ["translation_memory", "翻译记忆", "管理主 TM、工作 TM 与参考 TM", "添加参考 TM"]].map(([kind, title, hint, action]) => `<section class="ps-library-section"><div class="ps-section-heading"><div><h4>${title}<span data-count="${kind}" class="ps-count"></span></h4><p>${hint}</p></div><button type="button" class="ps-add" data-add-library="${kind}"><span aria-hidden="true">＋</span>${action}</button></div><div data-library-list="${kind}"></div></section>`).join("")}<p class="ps-footnote">只有启用的库参与检索。术语库与 TM 分别排序；用上下箭头调整，同类资源会自动保持连续的 1、2、3…级。</p></section>
          ${tabs.filter((item) => ["matching", "batch"].includes(item.id)).map((item) => `<section role="tabpanel" id="ps-panel-${item.id}" aria-labelledby="ps-tab-${item.id}" data-panel="${item.id}" tabindex="0" hidden><div class="ps-page-heading"><span class="ps-eyebrow">${item.id === "matching" ? "参考策略" : "执行规模"}</span><h3>${item.title}</h3><p>${item.id === "matching" ? "分别控制编辑器候选、模型译例和连续双语上下文。" : "子批次管理任务进度，联译小组控制一次请求的内容量。"}</p></div>${[...new Set(fields.filter((field) => field.tab === item.id).map((field) => field.section))].map((section) => `<section class="ps-card"><h4>${section}</h4>${fields.filter((field) => field.section === section).map(fieldMarkup).join("")}</section>`).join("")}</section>`).join("")}
          <section role="tabpanel" id="ps-panel-qa" aria-labelledby="ps-tab-qa" data-panel="qa" tabindex="0" hidden><div class="ps-page-heading"><span class="ps-eyebrow">质量检查</span><h3>QA 规则</h3><p>按项目要求设置检查项；文件和标签结构规则始终启用。</p></div><div class="ps-qa-toolbar"><label class="ps-search"><span class="ps-sr-only">搜索 QA 规则</span><input type="search" data-rule-search placeholder="搜索规则名称或说明…"></label><label><span class="ps-sr-only">规则分类</span><select data-rule-group aria-label="规则分类"><option value="">全部分类</option>${groups.map((group) => `<option>${escape(group)}</option>`).join("")}</select></label><span data-rule-count></span></div><div class="ps-qa-legend"><span><i class="ps-dot-error"></i>阻断</span><span><i class="ps-dot-warning"></i>警告</span><span><i class="ps-dot-info"></i>提示</span></div><div class="ps-rule-list" data-rule-list></div><div class="ps-empty" data-rule-empty hidden>没有符合条件的规则，请调整搜索或分类。</div></section>
        </div></fieldset>
        <aside class="ps-discard" data-discard-prompt hidden role="alert"><p data-discard-note></p><div><button type="button" data-keep-editing>继续编辑</button><button type="button" data-discard>放弃未保存修改</button></div></aside>
        <footer class="ps-footer"><p data-save-status role="status" aria-live="polite"></p><div><button type="button" class="ps-cancel" data-cancel-settings>取消</button><button type="submit" class="ps-save" data-save>保存更改</button></div></footer></form>`;
      renderLibraries();
      renderRules();
      selectTab(tabs.some((item) => item.id === initialTab) ? initialTab : "libraries");
      updateStatus();
      dialog.showModal();
      find('[data-tab="libraries"]').focus();
    }
  };
}
