const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const readPath = (source, path) => path.split(".").reduce((carry, key) => carry?.[key], source);
const writePath = (target, path, value) => {
  const keys = path.split(".");
  const last = keys.pop();
  const parent = keys.reduce((carry, key) => (carry[key] = carry[key] || {}), target);
  parent[last] = value;
};

const providerTabs = [
  { id: "connection", title: "连接与鉴权", subtitle: "接口地址与密钥", icon: "link" },
  { id: "models", title: "模型分工", subtitle: "主模型与专用模型", icon: "layers" },
  { id: "embedding", title: "Embedding", subtitle: "语义向量检索", icon: "vector" },
  { id: "pricing", title: "成本门禁", subtitle: "评测成本预算", icon: "coins" }
];

const providerFields = {
  connection: [
    { name: "baseUrl", label: "Base URL", hint: "OpenAI 兼容接口地址，例如本地 Ollama 或云端网关。", placeholder: "http://localhost:11434/v1" },
    { name: "apiKey", label: "API Key", hint: "留空保持现有 Key；保存后使用 Windows 当前用户级 DPAPI 加密。", type: "password", placeholder: "留空保持不变", autocomplete: "off" }
  ],
  models: [
    { name: "model", label: "主模型", hint: "默认翻译与 QA 使用的主模型。", placeholder: "qwen3:14b" },
    { name: "fastModel", label: "快速模型", hint: "低风险短文本和轻量任务；留空则复用主模型。", placeholder: "留空则使用主模型" },
    { name: "qualityModel", label: "高质量模型", hint: "高风险、创译和升级重试；留空则复用主模型。", placeholder: "留空则使用主模型" },
    { name: "mtModel", label: "机器翻译底模", hint: "仅用于 MT + 后编辑路线；留空则使用快速模型或主模型。", placeholder: "留空则使用快速模型或主模型" }
  ],
  embedding: [
    { name: "embeddingModel", label: "Embedding 模型", hint: "留空禁用外部向量检索，回退本地 CJK 索引。", placeholder: "nomic-embed-text" },
    { name: "embeddingBaseUrl", label: "Embedding API 地址", hint: "可填 Base URL 或完整端点；留空复用主地址。", placeholder: "http://localhost:11434/v1" },
    { name: "embeddingApiKey", label: "Embedding API Key", hint: "留空复用主 Key；保存后同样加密持久化。", type: "password", placeholder: "留空复用主 Key", autocomplete: "off" }
  ],
  pricing: [
    { name: "inputPricePerMTok", label: "输入价格", hint: "美元 / 百万 token，用于评测成本门禁。", type: "number", min: "0", step: "any", placeholder: "例如 0.27", suffix: "USD / 1M tokens" },
    { name: "outputPricePerMTok", label: "输出价格", hint: "美元 / 百万 token，用于评测成本门禁。", type: "number", min: "0", step: "any", placeholder: "例如 1.10", suffix: "USD / 1M tokens" }
  ]
};

const parameterTabs = [
  { id: "quality", title: "质量与 QA", subtitle: "通过分、权重与扣分", icon: "check" },
  { id: "retrieval", title: "检索与上下文", subtitle: "译例、反例与邻段", icon: "search" },
  { id: "learning", title: "学习与评测", subtitle: "蒸馏、提议与门禁", icon: "spark" },
  { id: "orthography", title: "分享与标点", subtitle: "拆解上限与作品名括号", icon: "quote" }
];

function icon(name) {
  const paths = {
    link: '<path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.2 1.2"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20l1.2-1.2"/>',
    layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 12l9 5 9-5M3 16l9 5 9-5"/>',
    vector: '<circle cx="5" cy="12" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 12h5M14 10l3-3M14 14l3 3"/>',
    coins: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
    check: '<path d="M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/>',
    spark: '<path d="M12 3l1.7 5.1L19 10l-5.3 1.9L12 17l-1.7-5.1L5 10l5.3-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
    quote: '<path d="M7 7h4v4H9c0 2 1 3 3 3v3c-4 0-6-2-6-6V7zM15 7h4v4h-2c0 2 1 3 3 3v3c-4 0-6-2-6-6V7z"/>'
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.check}</svg>`;
}

function panelShell({ title, eyebrow, description, tabs, active, body, footer, notes = "" }) {
  return `<form class="sp-form" novalidate>
    <header class="sp-header"><div><span class="sp-eyebrow">${escape(eyebrow)}</span><h2 id="settingsPanelTitle">${escape(title)}</h2><p>${escape(description)}</p></div><button type="button" class="sp-close" data-close-panel aria-label="关闭">×</button></header>
    <div class="sp-body">
      <nav class="sp-nav" role="tablist" aria-label="设置分类">${tabs.map((tab) => `<button type="button" role="tab" aria-selected="${tab.id === active}" data-tab="${tab.id}">${icon(tab.icon)}<span><strong>${escape(tab.title)}</strong><small>${escape(tab.subtitle)}</small></span></button>`).join("")}</nav>
      <div class="sp-content">${body}</div>
    </div>
    ${notes}
    <footer class="sp-footer"><p data-status role="status" aria-live="polite"></p><div>${footer}</div></footer>
  </form>`;
}

function fieldMarkup(field, value, extra = "") {
  const attributes = [
    `name="${escape(field.name)}"`,
    field.type ? `type="${escape(field.type)}"` : 'type="text"',
    field.min !== undefined ? `min="${escape(field.min)}"` : "",
    field.step !== undefined ? `step="${escape(field.step)}"` : "",
    field.autocomplete ? `autocomplete="${escape(field.autocomplete)}"` : "",
    field.placeholder ? `placeholder="${escape(field.placeholder)}"` : "",
    extra
  ].filter(Boolean).join(" ");
  return `<label class="sp-field"><span><strong>${escape(field.label)}</strong><small>${escape(field.hint)}</small></span><div class="sp-input">${field.suffix ? `<div class="sp-input-with-suffix"><input ${attributes} value="${escape(value ?? "")}" /><em>${escape(field.suffix)}</em></div>` : `<input ${attributes} value="${escape(value ?? "")}" />`}</div></label>`;
}

export function createProviderSettingsPanel(dialog, { api, onSaved } = {}) {
  let active = "connection";
  let provider = null;
  let saving = false;
  const find = (selector) => dialog.querySelector(selector);

  function render(status = "") {
    const body = providerTabs.map((tab) => `<section class="sp-panel" data-panel="${tab.id}" ${tab.id === active ? "" : "hidden"}>
      <div class="sp-page-heading"><span class="sp-eyebrow">${escape(tab.subtitle)}</span><h3>${escape(tab.title)}</h3><p>${tab.id === "connection" ? "配置服务入口和鉴权；密钥保存后不会回显明文。" : tab.id === "models" ? "把不同风险等级的任务交给不同模型，留空会自动复用主模型。" : tab.id === "embedding" ? "配置语义向量检索；留空会回退本地 CJK 索引。" : "填写真实单价后，评测成本门禁才能计算成本和判断预算。"}</p></div>
      <div class="sp-card">${providerFields[tab.id].map((field) => {
        const value = field.name === "apiKey" || field.name === "embeddingApiKey" ? "" : readPath(provider, field.name);
        const placeholder = field.name === "apiKey" ? (provider.apiKeyConfigured ? "已配置 · 留空保持不变" : "未配置 · 如需鉴权请填写") : field.name === "embeddingApiKey" ? (provider.embeddingApiKeyConfigured ? "已配置 · 留空保持不变" : "未配置 · 留空复用主 Key") : field.placeholder;
        return fieldMarkup({ ...field, placeholder }, value);
      }).join("")}</div>
      ${tab.id === "connection" ? `<div class="sp-note"><strong>密钥安全</strong><p>API Key 使用 Windows 当前用户级 DPAPI 加密保存，不会以明文写入项目文件。</p></div>` : ""}
    </section>`).join("");
    dialog.innerHTML = panelShell({
      title: "模型服务设置",
      eyebrow: "OPENAI-COMPATIBLE",
      description: "连接模型服务、分配模型角色，并配置 Embedding 与成本门禁。",
      tabs: providerTabs,
      active,
      body,
      notes: `<div class="sp-notes" data-notes ${status ? "" : "hidden"}>${escape(status)}</div>`,
      footer: `<button type="button" class="sp-ghost" data-close-panel>取消</button><button type="submit" class="sp-primary" data-save ${saving ? "disabled" : ""}>${saving ? "保存中…" : "保存设置"}</button>`
    });
    find("[data-status]").textContent = provider?.apiKeyConfigured || provider?.embeddingApiKeyConfigured ? "已配置密钥会加密保存，留空不会覆盖。" : "尚未配置鉴权信息；本地无鉴权服务可留空。";
  }

  async function submit() {
    if (saving) return;
    saving = true;
    render();
    try {
      const form = new FormData(find(".sp-form"));
      const saved = await api("/api/provider", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
      provider = saved;
      onSaved?.(saved);
      dialog.close();
    } catch (error) {
      saving = false;
      render(error.message);
    }
  }

  dialog.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || saving) return;
    if (button.dataset.tab) {
      active = button.dataset.tab;
      render();
    }
    if (button.matches("[data-close-panel]")) dialog.close();
  });
  dialog.addEventListener("submit", (event) => { event.preventDefault(); submit(); });

  return {
    open(nextProvider) {
      if (dialog.open) return;
      provider = nextProvider;
      active = "connection";
      saving = false;
      render();
      dialog.showModal();
    }
  };
}

function parameterSections(group, fields) {
  const sections = new Map();
  for (const field of fields) {
    let section = "基础";
    if (group === "quality") {
      if (field.path.startsWith("quality.weight")) section = "Auto QA 权重";
      else if (field.path.startsWith("quality.penalty")) section = "问题扣分";
      else section = "通过与修订";
    } else if (group === "retrieval") section = "召回与上下文";
    else if (group === "learning") {
      if (field.path.includes("styleDistill")) section = "风格蒸馏";
      else if (field.path.includes("translatorProfile")) section = "译者画像";
      else if (field.path.includes("autoPropose")) section = "自动提议";
      else if (field.path.includes("Evaluation")) section = "评测门禁";
      else if (field.path.includes("distill")) section = "蒸馏取样";
      else if (field.path.includes("rule") || field.path.includes("conflict")) section = "规则治理";
    } else if (group === "share") section = "分享页";
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section).push(field);
  }
  return sections;
}

export function createParameterSettingsPanel(dialog, { api, onSaved } = {}) {
  let active = "quality";
  let payload = null;
  let saving = false;
  const find = (selector) => dialog.querySelector(selector);

  function render(notes = []) {
    const groups = new Map(payload.groups.map((group) => [group.group, group]));
    const renderFields = (fields) => fields.map((field) => {
      const override = payload.environmentOverrides?.[field.path];
      const value = readPath(payload.settings, field.path) ?? field.default;
      const extra = `data-path="${escape(field.path)}" ${override ? "disabled" : ""}`;
      return `<label class="sp-field${override ? " overridden" : ""}"><span><strong>${escape(field.label)}</strong><small>${escape(field.hint)}</small>${override ? `<em>由环境变量 ${escape(override.variable)} 接管</em>` : ""}</span><div class="sp-input"><input type="number" ${extra} value="${escape(String(value))}" min="${field.min}" max="${field.max}" step="${field.step}" /><small>${field.min} ~ ${field.max}</small></div></label>`;
    }).join("");
    const body = parameterTabs.map((tab) => {
      if (tab.id === "orthography") {
        const bracketRows = Object.entries(payload.locales).map(([locale, label]) => `<label class="sp-field"><span><strong>${escape(label)}</strong><small>${escape(locale)}</small></span><div class="sp-input"><select data-bracket="${escape(locale)}">${payload.titleBracketChoices.map((choice) => `<option value="${escape(choice)}"${payload.settings.orthography?.titleBrackets?.[locale] === choice ? " selected" : ""}>${escape(choice || "不检查")}</option>`).join("")}</select></div></label>`).join("");
        const shareFields = groups.get("share")?.fields || [];
        return `<section class="sp-panel" data-panel="${tab.id}" ${tab.id === active ? "" : "hidden"}><div class="sp-page-heading"><span class="sp-eyebrow">${escape(tab.subtitle)}</span><h3>${escape(tab.title)}</h3><p>控制分享页拆解规模，并配置作品名使用哪对括号。</p></div>${shareFields.length ? `<div class="sp-card"><h4>分享页</h4>${renderFields(shareFields)}</div>` : ""}<div class="sp-card"><h4>作品名括号约定</h4>${bracketRows}</div></section>`;
      }
      const group = groups.get(tab.id) || groups.get("share");
      const sections = parameterSections(tab.id, group?.fields || []);
      return `<section class="sp-panel" data-panel="${tab.id}" ${tab.id === active ? "" : "hidden"}><div class="sp-page-heading"><span class="sp-eyebrow">${escape(tab.subtitle)}</span><h3>${escape(tab.title)}</h3><p>${tab.id === "quality" ? "控制 AIQA 通过分、修订轮数、三维权重和扣分。" : tab.id === "retrieval" ? "控制翻译时注入多少参考译例、QA 反例和邻段上下文。" : "控制风格/画像蒸馏、自动提议和评测门禁。"}</p></div>${[...sections.entries()].map(([section, fields]) => `<div class="sp-card"><h4>${escape(section)}</h4>${renderFields(fields)}</div>`).join("")}</section>`;
    }).join("");
    dialog.innerHTML = panelShell({
      title: "参数设置",
      eyebrow: "WORKBENCH TUNING",
      description: "按分类调整质量、检索、学习和分享行为；改动保存后立即生效。",
      tabs: parameterTabs,
      active,
      body,
      notes: notes.length ? `<div class="sp-notes"><strong>已自动校正 ${notes.length} 项</strong>${notes.map((note) => `<div>${escape(note.label)}：${escape(note.note)}</div>`).join("")}</div>` : "",
      footer: `<button type="button" class="sp-ghost" data-reset>恢复出厂值</button><button type="button" class="sp-ghost" data-close-panel>取消</button><button type="submit" class="sp-primary" data-save ${saving ? "disabled" : ""}>${saving ? "保存中…" : "保存设置"}</button>`
    });
    find("[data-status]").textContent = "环境变量接管的项会置灰，保存时不会覆盖。";
  }

  function collect() {
    const settings = { orthography: { titleBrackets: {} } };
    for (const input of dialog.querySelectorAll("input[data-path]")) {
      if (input.disabled) continue;
      writePath(settings, input.dataset.path, Number(input.value));
    }
    for (const select of dialog.querySelectorAll("select[data-bracket]")) settings.orthography.titleBrackets[select.dataset.bracket] = select.value;
    return settings;
  }

  async function submit() {
    if (saving) return;
    saving = true;
    render();
    try {
      const result = await api("/api/settings", { method: "POST", body: JSON.stringify({ settings: collect() }) });
      payload = { ...payload, ...result };
      onSaved?.(result);
      if (result.notes?.length) {
        saving = false;
        render(result.notes);
      } else {
        dialog.close();
      }
    } catch (error) {
      saving = false;
      render([{ label: "保存失败", note: error.message }]);
    }
  }

  async function reset() {
    if (saving || !confirm("恢复出厂值会覆盖当前全部参数设置，确认继续？")) return;
    saving = true;
    render();
    try {
      const result = await api("/api/settings", { method: "POST", body: JSON.stringify({ reset: true }) });
      payload = { ...payload, ...result };
      saving = false;
      render(result.notes || []);
      onSaved?.(result);
    } catch (error) {
      saving = false;
      render([{ label: "恢复失败", note: error.message }]);
    }
  }

  dialog.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || saving) return;
    if (button.dataset.tab) {
      active = button.dataset.tab;
      render();
    }
    if (button.matches("[data-close-panel]")) dialog.close();
    if (button.matches("[data-reset]")) reset();
  });
  dialog.addEventListener("submit", (event) => { event.preventDefault(); submit(); });

  return {
    async open() {
      if (dialog.open) return;
      payload = await api("/api/settings");
      active = "quality";
      saving = false;
      render();
      dialog.showModal();
    }
  };
}
