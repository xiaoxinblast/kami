import { renderTranslationMarkup } from "./term-highlighter.js";
import { normalizePastedText, shouldRoutePasteToBatch } from "./paste-routing.js";
import { learningEvaluationResult } from "./learning-utils.js";
import { styleProfileDiff } from "./style-utils.js";
import { startWorkbenchSession } from "./session-lifecycle.js";
import { createProjectSettingsPanel } from "./project-settings.js";
import { createProjectWizard } from "./project-wizard.js";
import { createParameterSettingsPanel, createProviderSettingsPanel } from "./settings-panels.js";

startWorkbenchSession();

const state = {
  bootstrap: null,
  projects: [],
  activeProjectId: "",
  activeProject: null,
  serverVersion: "0.0.0",
  view: "workbench",
  workbenchLocale: "zh-CN",
  assetLocale: "zh-CN",
  styleLocale: "zh-CN",
  learningLocale: "zh-CN",
  autoQaLocale: "zh-CN",
  qaSource: "batch",
  qaSegments: [],
  qaFilter: "",
  qaCursor: -1,
  qaResult: null,
  qaFile: null,
  memoryLocale: "zh-CN",
  learningData: null,
  learningLoading: false,
  learningSelectedSkillId: "",
  conflictReport: null,
  referenceDocuments: [],
  referenceLibraries: [],
  referenceStatus: "",
  referenceSearch: "",
  referenceDetail: null,
  tasks: [],
  styleData: null,
  memories: [],
  memoryTotal: 0,
  // 术语库 / 记忆库按"库"管理：库列表 + 选中库后的条目视图。
  assetLibraries: [],
  memoryLibraries: [],
  assetLibraryId: "",
  memoryLibraryId: "",
  assetEntries: [],
  assetEntryTotal: 0,
  memoryEntryTotal: 0,
  importTermLibraryId: "",
  importTmLibraryId: "",
  memoryImportTargetId: "",
  // TM 库的第三层：当前打开的来源文件（""=停在文件列表，__none__=未标注来源）。
  memoryLibraryFile: "",
  memoryLibraryFiles: [],
  memoryImportFile: null,
  memoryImportPreview: null,
  styleGuideFile: null,
  lastResult: null,
  importFile: null,
  importFiles: [],
  assetPreflight: null,
  assetImportIntent: "auto",
  assetImportReturnView: "",
  assetImportPurpose: "term",
  assetImportAiCleaning: false,
  assetImportStyleEvidence: false,
  assetImportTaskId: "",
  assetImportWizard: false,
  assetImportStartedAt: 0,
  assetImportProgress: null,
  assetImportTicker: 0,
  memoryImportFiles: [],
  memoryStyleEvidence: true,
  importPreview: null,
  importCompleted: false,
  importCandidateTab: "terms",
  importVisibleCount: { terms: 150, styles: 150 },
  importBatchLearning: [],
  busy: false,
  activeSuggestion: null,
  translationMode: "single",
  batchFile: null,
  batchBase64: "",
  batchPreview: null,
  batchRunning: false,
  batchPaused: false,
  batchCancelling: false,
  logs: [],
  logLevel: "",
  logSearch: "",
  logErrorCount: 0,
  reviewImportBatchId: "",
  batchHasStoredOriginal: false,
  batchSegmentFilter: "",
  batchQaCursor: -1,
  batchClassification: null,
  batchStyleProfile: null,
  // 语境档案（整份文件的用途区间）与质量报告：翻译前/翻译后的两份整体结论。
  batchBrief: null,
  batchBriefPending: false,
  batchBriefDraft: null,
  batchReport: null,
  projectSettings: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function supportsBatchApi(version) {
  const [major, minor] = String(version || "0.0.0").split(".").map(Number);
  return major > 0 || minor >= 5;
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  } catch (error) {
    // fetch 直接抛错说明请求根本没到服务端（工作台在重启 / 已停止 / 连接被掐断），
    // 这时浏览器只会给一句 Failed to fetch，对用户没有任何指导意义。
    const detail = String(error?.message || "");
    const generic = /Failed to fetch|Load failed|NetworkError|network error/iu.test(detail);
    const message = generic
      ? "连不上工作台：可能正在重启或已停止，请刷新页面后重试"
      : `请求失败（${detail}）：请确认工作台仍在运行`;
    // 界面上只闪一句提示，同时把原始信息写进日志，事后能查。
    if (!String(path).startsWith("/api/logs")) recordClientLog("error", `请求未送达：${options.method || "GET"} ${path}`, detail);
    throw new Error(message);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.error || `请求失败：${response.status}`;
    if (!String(path).startsWith("/api/logs")) recordClientLog("error", `${options.method || "GET"} ${path} → HTTP ${response.status}`, message);
    throw new Error(message);
  }
  return payload;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function projectPayload() {
  return state.activeProjectId ? { projectId: state.activeProjectId } : {};
}

/**
 * 语体与领域不再让用户逐段配置：翻译路径统一按自动识别走，需要人工纠正时
 * 改语境档案里的区间用途（整份文件一次），而不是在每个请求上手填两个下拉框。
 */
function scopePayload() {
  return { contentType: "auto", domain: "auto" };
}

function renderProjectSelector() {
  const select = $("#projectSelect");
  if (!select) return;
  select.innerHTML = state.projects.length
    ? state.projects.map((project) => `<option value="${escapeHtml(project.id)}"${project.id === state.activeProjectId ? " selected" : ""}>${escapeHtml(project.name)}</option>`).join("")
    : '<option value="">暂无项目</option>';
  select.disabled = !state.projects.length;
  const hasProject = Boolean(state.projects.length);
  const settingsButton = $("#openProjectSettings");
  const deleteButton = $("#deleteProject");
  if (settingsButton) settingsButton.disabled = !hasProject;
  if (deleteButton) deleteButton.disabled = !hasProject;
}

async function loadProjects() {
  const payload = await api("/api/projects");
  state.projects = Array.isArray(payload.projects) ? payload.projects : [];
  if (!state.projects.length) {
    const created = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "默认项目", description: "日语到简体中文本地化项目" }) });
    state.projects = [created.project];
  }
  const saved = localStorage.getItem("kami-project-id");
  state.activeProjectId = state.projects.some((project) => project.id === saved) ? saved : state.projects[0].id;
  state.activeProject = state.projects.find((project) => project.id === state.activeProjectId) || state.projects[0];
  state.projectSettings = state.activeProject.settings || null;
  localStorage.setItem("kami-project-id", state.activeProjectId);
  renderProjectSelector();
}

async function selectProject(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project || project.id === state.activeProjectId) return;
  state.activeProjectId = project.id;
  state.activeProject = project;
  state.projectSettings = project.settings || null;
  localStorage.setItem("kami-project-id", project.id);
  renderProjectSelector();
  await loadAssets(state.assetLocale);
  await loadMemories(state.memoryLocale);
  toast(`已切换到项目：${project.name}`);
}

async function createProjectFromWizard({ name, description }) {
  const created = await api("/api/projects", { method: "POST", body: JSON.stringify({ name, description }) });
  state.projects = [...state.projects, created.project];
  state.activeProjectId = created.project.id;
  state.activeProject = created.project;
  state.projectSettings = created.project.settings || null;
  localStorage.setItem("kami-project-id", created.project.id);
  renderProjectSelector();
  await Promise.all([loadAssets(state.assetLocale), loadMemories(state.memoryLocale)]);
  return created.project;
}

async function importWizardSource(file) {
  const accepted = await setBatchFile(file);
  if (accepted === false) throw new Error("已取消列含义确认，请重新选择待译文件");
  if (!state.batchPreview) throw new Error("待译文件解析失败，请检查文件内容");
  return { filename: file.name };
}

async function importWizardTerms(files, { aiCleaning = false, styleEvidence = false } = {}) {
  // 向导的术语库步骤固定按"术语表"导入；等预检弹窗被处理完再推进下一步。
  const outcome = await setImportFiles(files, {
    intent: "terms",
    purpose: "term",
    aiCleaning,
    styleEvidence,
    returnView: "workbench",
    fromWizard: true
  });
  if (!outcome?.submitted) return { submitted: false };
  return {
    submitted: true,
    count: outcome.count,
    files: files.length,
    taskId: outcome.taskId,
    batchId: outcome.batchId || state.assetPreflight?.batchId || "",
    aiCleaning: Boolean(outcome.aiCleaning)
  };
}

async function previewWizardTm(file) {
  return api("/api/tm-import/preview", { method: "POST", body: JSON.stringify({ ...projectPayload(), filename: file.name, base64: await fileToBase64(file) }) });
}

async function commitWizardTm(preview, { styleEvidence = true } = {}) {
  const candidates = (preview.candidates || []).map((candidate) => ({ ...candidate, selected: true }));
  // 向导的这一步只负责提交：写入走后台任务，免得卡在"下一步"上几分钟。
  return api("/api/tm-import/commit", { method: "POST", body: JSON.stringify({ ...projectPayload(), batchId: preview.batchId, filename: preview.filename, candidates, styleEvidence, background: true }) });
}

async function importWizardStyleGuide(file) {
  return importStyleGuideFile(file, state.styleLocale);
}

function finishProjectWizard(summary = []) {
  const parts = summary.filter(Boolean);
  toast(parts.length ? `项目初始化完成：${parts.slice(0, 3).join("；")}` : "项目已创建，可稍后在项目设置中继续配置");
}

let projectWizard;
function getProjectWizard() {
  projectWizard ||= createProjectWizard($("#projectDialog"), {
    onCreateProject: createProjectFromWizard,
    onImportSource: importWizardSource,
    onImportTerms: importWizardTerms,
    onPreviewTm: previewWizardTm,
    onCommitTm: commitWizardTm,
    onImportStyleGuide: importWizardStyleGuide,
    onOpenQaSettings: () => openProjectSettings({ tab: "qa" }),
    onFinished: finishProjectWizard
  });
  return projectWizard;
}

function openDeleteProjectDialog() {
  if (!state.projects.length) return toast("当前没有可删除的项目");
  $("#deleteProjectList").innerHTML = state.projects.map((project) => `
    <label class="project-delete-row">
      <input type="checkbox" value="${escapeHtml(project.id)}" ${project.id === state.activeProjectId ? "checked" : ""} />
      <span><strong>${escapeHtml(project.name)}</strong><small>${escapeHtml(project.description || "未填写项目说明")}</small></span>
      ${project.id === state.activeProjectId ? '<em>当前项目</em>' : ""}
    </label>`).join("");
  $("#deleteProjectSelectAll").checked = false;
  $("#deleteProjectData").checked = false;
  updateDeleteSelection();
  updateDeleteConfirmLabel();
  $("#deleteProjectDialog").showModal();
}

function updateDeleteSelection() {
  const rows = $$("#deleteProjectList input[type=checkbox]");
  const selected = rows.filter((input) => input.checked);
  $("#deleteProjectCount").textContent = `已选 ${selected.length} 个`;
  $("#deleteProjectSelectAll").checked = rows.length > 0 && selected.length === rows.length;
  $("#deleteProjectConfirm").disabled = selected.length === 0;
}

function updateDeleteConfirmLabel() {
  const purge = Boolean($("#deleteProjectData")?.checked);
  $("#deleteProjectConfirm").textContent = purge ? "永久删除选中项目" : "删除选中项目";
}

async function deleteProjectFromDialog(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const submitButton = formElement.querySelector('button[type="submit"]');
  const projectIds = $$("#deleteProjectList input[type=checkbox]:checked").map((input) => input.value);
  const purge = Boolean($("#deleteProjectData")?.checked);
  if (!projectIds.length) return toast("请至少选择一个项目");
  if (purge && !confirm(`确认永久删除选中的 ${projectIds.length} 个项目及其全部后台数据？此操作无法撤销。`)) return;
  submitButton.disabled = true;
  submitButton.textContent = "正在删除…";
  try {
    const results = await Promise.allSettled(projectIds.map((projectId) => api(`/api/projects/${encodeURIComponent(projectId)}${purge ? "?purge=1" : ""}`, { method: "DELETE" })));
    const failed = results.filter((result) => result.status === "rejected");
    $("#deleteProjectDialog").close();
    $("#deleteProjectData").checked = false;
    await loadProjects();
    await loadAssets(state.assetLocale);
    await loadMemories(state.memoryLocale);
    if (failed.length) toast(`已删除 ${projectIds.length - failed.length} 个项目，${failed.length} 个失败：${failed[0].reason?.message || "未知错误"}`);
    else toast(purge ? `已永久删除 ${projectIds.length} 个项目及后台数据` : `已从工作台移除 ${projectIds.length} 个项目`);
  } catch (error) { toast(error.message); }
  finally {
    submitButton.disabled = false;
    updateDeleteConfirmLabel();
  }
}

let projectSettingsPanel;
async function openProjectSettings({ tab = "libraries" } = {}) {
  if (!state.activeProjectId) return toast("请先选择项目");
  const button = $("#openProjectSettings");
  button.disabled = true;
  try {
    const [project, libraryPayload] = await Promise.all([
      api(`/api/projects/${encodeURIComponent(state.activeProjectId)}`),
      api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/libraries`)
    ]);
    projectSettingsPanel ||= createProjectSettingsPanel($("#projectSettingsDialog"), {
      api,
      onSaved(project) {
        state.activeProject = project;
        state.projectSettings = project.settings;
        state.projects = state.projects.map((item) => item.id === project.id ? project : item);
        renderProjectSelector();
        toast("项目设置已保存");
        // 资源库是术语库 / 记忆库页的同一份数据：保存后两个页面的库列表与导入下拉都要跟着更新。
        Promise.all([loadAssetsSafeRefresh("term"), loadAssetsSafeRefresh("tm")]).catch(() => {});
      }
    });
    projectSettingsPanel.open(project, Array.isArray(libraryPayload.libraries) ? libraryPayload.libraries : [], { initialTab: tab });
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
}

let toastTimer;
let batchSaveChain = Promise.resolve();
function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 3000);
}

function setBusy(busy, label) {
  state.busy = busy;
  const button = $("#primaryAction");
  button.disabled = busy;
  if (busy && label) button.textContent = label;
  if (!busy) refreshActions();
}

function updateImportProgress(progress = {}) {
  const container = $("#importProgress");
  if (!container) return;
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  container.hidden = false;
  $("#importProgressText").textContent = progress.message || "正在识别与清洗";
  const batchMeta = Number(progress.total) > 0 ? ` · ${Number(progress.completed) || 0} / ${progress.total} 批` : "";
  const concurrencyMeta = progress.concurrency ? ` · ${progress.concurrency} 路并发` : "";
  $("#importProgressMeta").textContent = `${percent}%${batchMeta}${concurrencyMeta}`;
  $("#importProgressBar").style.width = `${percent}%`;
}

async function watchImportProgress(progressId, control) {
  while (!control.done) {
    try {
      const response = await fetch(`/api/term-import/progress/${encodeURIComponent(progressId)}`, { cache: "no-store" });
      if (response.ok) {
        const progress = await response.json();
        updateImportProgress(progress);
        if (progress.status === "completed" || progress.status === "failed") return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
}

function renderLocaleStrip(container, selected, onSelect) {
  container.innerHTML = Object.entries(state.bootstrap.locales).map(([locale, details]) => `
    <button class="locale-button ${selected === locale ? "active" : ""}" data-locale="${locale}">
      <img class="locale-flag" src="${escapeHtml(details.flagAsset)}" alt="" aria-hidden="true" />
      <span>${details.label}</span>
    </button>
  `).join("");
  container.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => onSelect(button.dataset.locale)));
}

function pageCopy(view) {
  if (view === "learning") return ["LEARNING CENTER", "学习中心", "将翻译轨迹沉淀为可评测、可批准、可回滚的翻译技能。"];
  return {
    workbench: ["TRANSLATION", "翻译", "使用日语→简体中文专属术语库，并自动识别语体。"],
    autoqa: ["TRANSLATION QA", "译文质检", "检查已有译文：按文件原生句段（或批次回放）跑硬规则与三层审查；只检查，不改译文。"],
    tasks: ["TASK CENTER", "任务中心", "查看、恢复、审校并导出日语→简体中文翻译任务。"],
    references: ["REFERENCE MATERIALS", "参考资料", "角色设定、剧本、故事梗概等；只在模型主动查询时按片段返回，不随每次翻译注入。"],
    import: ["BILINGUAL ASSET INGESTION", "双语资产导入", "先预检文件类型与资产去向，确认后再写入当前项目。"],
    assets: ["TERM ASSETS", "术语库", "查看日语→简体中文的物理隔离术语集合。"],
    memories: ["PROJECT TM", "记忆库 TM", "查看当前项目的主 TM、工作 TM 与参考 TM。"],
    styles: ["STYLE GUIDANCE", "风格指导", "查看并控制已沉淀的翻译风格规则。"],
    logs: ["RUNTIME LOG", "日志", "后台报错、任务进度与模型调用记录；报错不再只闪一下。"]
  }[view];
}

/**
 * 界面侧的报错也记进同一份日志：提示只显示 3 秒，日志里能回看。
 * 走的是 fire-and-forget，日志接口自己失败时不再递归上报。
 */
function recordClientLog(level, message, detail = "") {
  const text = String(message || "").trim();
  if (!text) return;
  if (level === "error") {
    // 界面上提示 3 秒就没了：角标留个痕迹，用户知道有错可查。
    bumpLogBadge(state.logErrorCount + 1);
    if (state.view === "logs") loadLogs().catch(() => {});
  }
  fetch("/api/logs/client", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ level, message: text.slice(0, 1_000), detail: String(detail || "").slice(0, 2_000), path: location.pathname })
  }).catch(() => {});
}

window.addEventListener("error", (event) => {
  recordClientLog("error", `未捕获异常：${event?.message || "未知错误"}`, `${event?.filename || ""}:${event?.lineno || 0}`);
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event?.reason;
  recordClientLog("error", `未处理的 Promise 拒绝：${reason?.message || String(reason || "未知原因")}`, reason?.stack || "");
});

function refreshActions() {
  if (state.busy) return;
  const primary = $("#primaryAction");
  const secondary = $("#secondaryAction");
  const tertiary = $("#tertiaryAction");
  const cancelBatch = $("#cancelBatchAction");
  [secondary, tertiary].forEach((button) => { button.hidden = true; button.disabled = false; });
  if (cancelBatch) { cancelBatch.hidden = true; cancelBatch.disabled = false; }
  primary.disabled = false;
  primary.title = "";
  if (state.view === "workbench") {
    if (state.translationMode === "single") {
      primary.textContent = "开始翻译";
      secondary.hidden = false;
      secondary.textContent = "清空";
      if (state.lastResult) {
        tertiary.hidden = false;
        tertiary.textContent = "复制译文";
      }
    } else {
      const segments = state.batchPreview?.segments || [];
      const hasPending = segments.some((segment) => segment.selected && segment.status !== "done");
      const hasCompleted = segments.some((segment) => segment.status === "done" && segment.translation);
      primary.textContent = state.batchRunning ? (state.batchPaused ? "暂停中…" : "暂停批次") : !state.batchPreview ? "解析并分段" : hasPending ? (segments.some((segment) => segment.status === "error") ? "继续 / 重试" : "开始批次翻译") : "批次已完成";
      primary.disabled = state.batchRunning ? state.batchPaused : (!state.batchPreview && !state.batchFile && !$("#batchPasteText")?.value.trim()) || (Boolean(state.batchPreview) && !hasPending);
      // 中断：正在服务端后台跑（或已交出去）时才出现，点了当前段跑完就停，进度保留。
      if (cancelBatch && state.batchPreview) {
        const running = state.batchRunning || ["queued", "running"].includes(state.batchPreview.runState || "");
        cancelBatch.hidden = !running;
        cancelBatch.disabled = !running;
        cancelBatch.textContent = state.batchCancelling ? "中断中…" : "中断批次";
      }
      if (state.batchFile || state.batchPreview || $("#batchPasteText")?.value.trim()) {
        secondary.hidden = false;
        secondary.textContent = "清空批次";
      }
      if (hasCompleted) {
        tertiary.hidden = false;
        tertiary.textContent = "导出译文";
      }
    }
  } else if (state.view === "import") {
    primary.textContent = state.assetPreflight ? "打开导入预检" : state.importPreview && !state.importCompleted ? "确认选中项入库" : state.importFile ? "重新预检" : "等待拖入双语资产";
    primary.disabled = state.importCompleted || (!state.assetPreflight && !state.importPreview && !state.importFile);
    if (state.importFile || state.importPreview) {
      secondary.hidden = false;
      secondary.textContent = "重新选择";
    }
  } else if (state.view === "assets") {
    primary.textContent = "新增单条";
  } else if (state.view === "memories") {
    primary.textContent = "刷新 TM";
  } else if (state.view === "tasks") {
    primary.textContent = "刷新任务";
  } else if (state.view === "styles") {
    primary.textContent = "刷新风格";
  } else if (state.view === "autoqa") {
    // 顶部按钮跟着"来源"走：批次/文件用各自的入口，粘贴文本才用输入框内容。
    const source = state.qaSource || "batch";
    primary.textContent = source === "batch" ? "查看质检结果" : "开始质检";
    primary.disabled = source === "batch"
      ? !$("#qaBatchSelect")?.value
      : source === "file"
        ? !state.qaFile
        : (!($("#autoQaSource")?.value.trim() && $("#autoQaTarget")?.value.trim()));
    if (source === "paste" && ($("#autoQaSource")?.value.trim() || $("#autoQaTarget")?.value.trim())) {
      secondary.hidden = false;
      secondary.textContent = "清空";
    }
  }
  if (state.view === "learning") {
    primary.textContent = state.learningLoading ? "正在读取学习轨迹……" : "根据近期轨迹生成候选技能";
    const payload = state.learningData?.data || state.learningData || {};
    const usableCount = state.learningData ? validLearningTrajectories(payload.trajectories || payload.evidence).length : 0;
    // 候选技能必须落到具体范围：全部视图下点按钮会先让你挑一个范围（有轨迹的），而不是禁用。
    const allScopes = learningAllScopes();
    const scopesWithTrajectories = allScopes && state.learningData ? learningScopesWithTrajectories().length : 0;
    primary.disabled = allScopes
      ? state.learningLoading || !state.learningData || scopesWithTrajectories === 0
      : state.learningLoading || !state.learningData || usableCount === 0;
    primary.title = allScopes
      ? (scopesWithTrajectories ? "先选一个有轨迹的范围，再生成该范围的候选技能" : "本项目还没有可用于学习的轨迹")
      : (!state.learningLoading && usableCount === 0 ? "当前日语→简体中文、语体与领域还没有带最终译文的完成或复核轨迹" : "");
  }
}

function setTranslationMode(mode) {
  if (mode === "batch" && !supportsBatchApi(state.serverVersion)) {
    toast("批次模块已安装，需重启服务后启用");
    return;
  }
  state.translationMode = mode === "batch" ? "batch" : "single";
  $$(".translation-mode").forEach((button) => button.classList.toggle("active", button.dataset.translationMode === state.translationMode));
  $("#singleWorkspace").hidden = state.translationMode !== "single";
  $("#batchWorkspace").hidden = state.translationMode !== "batch";
  // 批次模式下质量档在「分段与翻译策略」面板里，上面的那一行属于单句输入：同时出现
  // 会让同一个设置看着像两个开关。切模式时把值带过去，隐藏的那一个不会留下别的档位。
  const tierRow = $("#tierRow");
  if (tierRow) tierRow.hidden = state.translationMode === "batch";
  $("#batchQualityTier").value = $("#qualityTier").value;
  $("#viewDescription").textContent = state.translationMode === "batch"
    ? "上传长文或文件，自动分段、逐段审校并合并导出。"
    : "使用日语→简体中文专属术语库，并自动识别语体。";
  refreshActions();
}

function switchView(view) {
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  state.view = view;
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $$(".view").forEach((element) => element.classList.toggle("active", element.id === `view-${view}`));
  const [eyebrow, title, description] = pageCopy(view);
  $("#viewEyebrow").textContent = eyebrow;
  $("#viewTitle").textContent = title;
  $("#viewDescription").textContent = description;
  if (view === "assets") updateAssetLocale(state.assetLocale);
  if (view === "memories") updateMemoryLocale(state.memoryLocale);
  if (view === "assets") renderLibraryShell("term");
  if (view === "memories") { renderLibraryShell("tm"); renderLibraryFiles("tm"); }
  if (view === "references") loadReferences().catch((error) => toast(error.message));
  if (view === "tasks") loadTasks().catch((error) => toast(error.message));
  if (view === "styles") loadStyleGuidance(state.styleLocale).catch((error) => toast(error.message));
  if (view === "workbench") setTranslationMode(state.translationMode);
  if (view === "learning") loadLearning(state.learningLocale);
  if (view === "autoqa") { updateAutoQaLocale(state.autoQaLocale); setQaSource(state.qaSource || "batch"); }
  if (view === "logs") { loadLogs().catch((error) => toast(error.message)); startLogAutoRefresh(); } else stopLogAutoRefresh();
  refreshActions();
}

function setTranslationStatus(type, text) {
  const badge = $("#translationState");
  badge.className = `badge ${type}`;
  badge.textContent = text;
}

function updateWorkbenchLocale(locale) {
  const localeChanged = state.workbenchLocale !== locale;
  state.workbenchLocale = locale;
  renderLocaleStrip($("#workbenchLocales"), locale, updateWorkbenchLocale);
  const details = state.bootstrap.locales[locale];
  $("#targetKicker").textContent = `TARGET · ${locale.toUpperCase()}`;
  $("#targetTitle").textContent = `${details.label}译文`;
  state.lastResult = null;
  $("#targetOutput").textContent = "译文将在这里显示";
  $("#targetOutput").classList.add("empty");
  $("#targetOutput").contentEditable = "false";
  $("#toggleTargetEdit").hidden = true;
  $("#acceptTranslation").disabled = true;
  $("#sendToAutoQa").hidden = true;
  $("#targetLegend").hidden = true;
  $("#translationCandidates").hidden = true;
  $("#translationCandidates").innerHTML = "";
  $("#termMatches").textContent = "尚未匹配";
  $("#termMatches").className = "term-matches empty-list";
  $("#qaList").textContent = "翻译后显示相似译例、评分与修订结果";
  $("#qaList").className = "qa-list empty-list";
  setTranslationStatus("neutral", "等待翻译");
  if (localeChanged && state.batchPreview) {
    state.batchPreview.segments.forEach((segment) => {
      segment.translation = "";
      segment.result = null;
      segment.error = "";
      segment.status = "pending";
    });
    state.batchClassification = null;
    state.batchStyleProfile = null;
    renderBatchSegments();
  }
  refreshActions();
  previewClassificationAndMatches();
}

function renderMatches(matches) {
  $("#matchCount").textContent = `${matches.length} 条`;
  if (!matches.length) {
    $("#termMatches").className = "term-matches empty-list";
    $("#termMatches").textContent = "当前日语→简体中文术语库没有命中项";
    return;
  }
  $("#termMatches").className = "term-matches";
  $("#termMatches").innerHTML = matches.map(({ term, score, mode, matchPhrase }) => `
    <div class="term-chip ${mode === "exact" ? "" : "potential"}"><div><strong>${escapeHtml(term.source)} → ${escapeHtml(term.target)}</strong><small>${mode === "exact" ? "正式术语精确命中 · 结合句义判断" : mode === "smart" ? `智能近似：${escapeHtml(matchPhrase)} · 待判断` : `字符近似：${escapeHtml(matchPhrase)} · 待判断`}</small></div><span class="match-score">${Math.round(score * 100)}</span></div>
  `).join("");
}

function renderQa(result) {
  const errors = result.issues.filter((issue) => issue.severity === "error");
  $("#issueCount").textContent = result.aiQa?.fallbackReason ? "AIQA 未完成" : Number.isFinite(result.qaScore) ? `AIQA ${result.qaScore} 分 · ${result.aiQa?.iterations || 0} 次修订` : errors.length ? `${errors.length} 个阻断项` : result.issues.length ? `${result.issues.length} 条建议` : "硬校验通过";
  const reflection = result.reflection ? `<div class="reflection-box"><strong>模型反思</strong>\n${escapeHtml(result.reflection)}</div>` : "";
  const retrieval = result.aiQa?.references?.length ? `<div class="reflection-box"><strong>相似译例检索</strong>\n${result.aiQa.references.map((item) => {
    const tags = contentTagLabels(item.contentType || "general", item.contentTags);
    const origin = item.sourceFile ? `${item.sourceFile}${item.sourceRow ? ` 第 ${item.sourceRow} 行` : ""}` : (item.provenance || "历史资产");
    return `${Math.round(item.similarity * 100)}% · ${contentTypeLabel(item.contentType || "general")}${tags.length ? ` / ${tags.join(" / ")}` : ""} · ${origin}\n${item.source} → ${item.target}`;
  }).map(escapeHtml).join("\n\n")}</div>` : "";
  const qaCases = result.aiQa?.qaCases?.length ? `<div class="reflection-box"><strong>历史 AIQA 反例</strong>\n${result.aiQa.qaCases.map((item) => `${Math.round(item.similarity * 100)}% · ${item.rejectedTranslation} → ${item.correctedTranslation}`).map(escapeHtml).join("\n")}</div>` : "";
  const issues = result.issues.map((issue, index) => `<div class="qa-item ${issue.severity}"><div>${escapeHtml(issue.message)}</div><div class="qa-decision-actions"><button class="button ghost small single-qa-action" data-action="accept" data-issue-index="${index}">采纳并让 AI 修订</button><button class="button ghost small single-qa-action" data-action="partial" data-issue-index="${index}">部分采纳</button>${issue.severity !== "error" || issue.mqmSeverity === "minor" ? `<button class="button ghost small single-qa-action" data-action="reject" data-issue-index="${index}">拒绝意见</button>` : ""}</div></div>`).join("");
  const humanDecisions = result.aiQa?.humanDecisions?.length ? `<div class="reflection-box"><strong>人工 QA 决定</strong>\n${result.aiQa.humanDecisions.map((item) => `${item.actionLabel || item.action || item.decision || "已处理"} · ${item.issue?.message || item.issue || "QA 意见"}`).map(escapeHtml).join("\n")}</div>` : "";
  const receipt = result.reviewReceipt?.textZh ? `<div class="reflection-box review-receipt"><strong>审阅意见处理回执</strong>\n${escapeHtml(result.reviewReceipt.textZh)}</div>` : "";
  const routing = result.routing ? `<div class="reflection-box"><strong>本段用途与质量档</strong>\n${escapeHtml(`${contentTypeLabel(result.classification?.contentType || "general")} · ${result.qualityTierLabel || "标准"}档${result.qualityTierSource === "manual" ? "（手动指定）" : "（自动判定）"}${result.qualityUpgradeFrom ? ` · 已由${result.qualityUpgradeFrom === "fast" ? "快速" : "标准"}档自动升级` : ""}`)}\n${escapeHtml(result.tierReason || (result.routing.description || ""))}${result.tierStrength ? `\n${escapeHtml(result.tierStrength)}` : ""}</div>` : "";
  const referenceRefs = result.referenceUsage?.refs || [];
  const referenceBox = referenceRefs.length
    ? `<div class="reflection-box"><strong>本次查阅的资料</strong>\n${escapeHtml([...new Set(referenceRefs.map((ref) => [ref.documentName, ref.heading].filter(Boolean).join(" · ")).filter(Boolean))].join("；"))}</div>`
    : "";
  const qualityRoute = result.qualityRoute ? `<div class="reflection-box"><strong>质量判定</strong>\n${escapeHtml(`${result.qualityRoute.decision || "human_review"} · ${result.qualityRoute.reason || ""}`)}</div>` : "";
  const factSummary = result.factSchema?.facts?.length || result.factSchema?.limits?.length ? `<div class="reflection-box"><strong>事实与交付约束</strong>\n${escapeHtml(`${result.factSchema.facts?.length || 0} 个事实锚点 · ${result.factSchema.limits?.length || 0} 项交付限制`)}</div>` : "";
  $("#qaList").className = "qa-list";
  const fallback = result.aiQa?.fallbackReason ? `<div class="qa-item warning">AIQA 暂未完成：${escapeHtml(result.aiQa.fallbackReason)}</div>` : "";
  $("#qaList").innerHTML = `${routing}${qualityRoute}${factSummary}${referenceBox}${reflection}${retrieval}${qaCases}${humanDecisions}${receipt}${fallback}${issues || (!fallback ? '<div class="qa-item">硬规则与检索式 AIQA 均通过</div>' : '')}`;
  $$(".single-qa-action").forEach((button) => button.addEventListener("click", () => resolveSingleQaIssue(Number(button.dataset.issueIndex), button.dataset.action, button)));
}

const AUTO_QA_DIMENSIONS = [
  ["basic", "基本检查", "语言正确性专项（拼写/语法/标点，模型）+ 品牌名、格式与句内一致性（本地规则）"],
  ["fidelity", "语义忠实性", "漏译、增译、错译与语义偏差，着重检查项"],
  ["nuance", "Nuance 一致性", "敬语级别、语气词、正式度与句式节奏的细微差异"]
];

function updateAutoQaLocale(locale) {
  state.autoQaLocale = locale;
  const strip = $("#autoQaLocales");
  if (strip) renderLocaleStrip(strip, locale, updateAutoQaLocale);
  const details = state.bootstrap.locales[locale];
  $("#autoQaTargetKicker").textContent = `TARGET · ${locale.toUpperCase()}`;
  $("#autoQaTargetTitle").textContent = `${details.label}译文`;
  $("#autoQaState").textContent = "等待质检";
  $("#autoQaState").className = "badge neutral";
  $("#autoQaReport").hidden = true;
  refreshActions();
}

function clearAutoQa() {
  $("#autoQaSource").value = "";
  $("#autoQaTarget").value = "";
  $("#autoQaSourceCount").textContent = "0 字";
  $("#autoQaState").textContent = "等待质检";
  $("#autoQaState").className = "badge neutral";
  $("#autoQaReport").hidden = true;
  refreshActions();
}

/**
 * 把已完成的译文交接到 Auto QA。
 *
 * 翻译流程与质检流程此前是两个互不相通的入口：译完要复制原文、切页面、再粘贴
 * 译文，长批次基本没人愿意做。这里把原文/译文/语言/语体/领域一次带过去，
 * 语体与领域用**翻译时实际生效**的判定结果，而不是 Auto QA 页上的当前选择，
 * 否则质检会用另一套作用域去比对，判出来的 nuance 问题没有意义。
 */
async function handOffToAutoQa({ source, translation, locale, contentType, domain, label }) {
  const cleanSource = String(source || "").trim();
  const cleanTranslation = String(translation || "").trim();
  if (!cleanSource || !cleanTranslation) return toast("没有可质检的译文");

  $("#autoQaSource").value = cleanSource;
  $("#autoQaTarget").value = cleanTranslation;
  $("#autoQaSourceCount").textContent = `${[...cleanSource].length} 字`;

  if (locale && state.bootstrap?.locales?.[locale]) {
    state.autoQaLocale = locale;
    // 质检页现在按"来源"分区，不再有语言 chip（只有 zh-CN）；这里必须容错，
    // 否则 null 会抛错被外层 catch 吞掉，后面的 bindEvents() 全都不会执行。
    const autoQaStrip = $("#autoQaLocales");
    if (autoQaStrip) renderLocaleStrip(autoQaStrip, state.autoQaLocale, updateAutoQaLocale);
    $("#autoQaTargetKicker").textContent = `TARGET · ${locale.toUpperCase()}`;
    $("#autoQaTargetTitle").textContent = `${state.bootstrap.locales[locale]?.label || locale}译文`;
  }
  switchView("autoqa");
  toast(`${label} 已送入 Auto QA，开始逐句质检…`);
  await runAutoQa();
}

function sendCurrentTranslationToAutoQa() {
  const result = state.lastResult;
  if (!result?.translation) return toast("请先完成一次翻译");
  return handOffToAutoQa({
    source: $("#sourceText").value,
    translation: result.translation,
    locale: state.workbenchLocale,
    contentType: result.classification?.contentType,
    domain: result.domainResolution?.domain,
    label: "当前译文"
  });
}

/**
 * 批次交接按原始顺序拼接已完成分段，原文与译文用同样的换行拼法，
 * Auto QA 的逐句对齐才能把它们一一对上。未完成的分段直接跳过——
 * 让空译文进去只会制造整句漏译的假问题。
 */
function sendBatchToAutoQa() {
  const segments = (state.batchPreview?.segments || [])
    .filter((segment) => segment.status === "done" && String(segment.translation || "").trim())
    .sort((left, right) => (left.index || 0) - (right.index || 0));
  if (!segments.length) return toast("批次里还没有完成的译文");
  const skipped = (state.batchPreview?.segments || []).length - segments.length;
  return handOffToAutoQa({
    source: segments.map((segment) => segment.source).join("\n"),
    translation: segments.map((segment) => segment.translation).join("\n"),
    locale: state.workbenchLocale,
    contentType: state.batchClassification?.contentType,
    // 领域取服务端实际判定的结果；批次里各段作用域一致，取第一段即可。
    domain: segments.find((segment) => segment.result?.domainResolution?.domain)?.result.domainResolution.domain || $("#domain").value,
    label: skipped > 0 ? `批次 ${segments.length} 段（跳过未完成 ${skipped} 段）` : `批次全部 ${segments.length} 段`
  });
}


let providerSettingsPanel;
function getProviderSettingsPanel() {
  providerSettingsPanel ||= createProviderSettingsPanel($("#providerDialog"), {
    api,
    onSaved(provider) {
      state.bootstrap.provider = provider;
      $("#providerLabel").textContent = `${provider.model} · ${new URL(provider.baseUrl).hostname}`;
      toast("模型设置已更新");
    }
  });
  return providerSettingsPanel;
}

let parameterSettingsPanel;
function getParameterSettingsPanel() {
  parameterSettingsPanel ||= createParameterSettingsPanel($("#settingsDialog"), {
    api,
    onSaved(result) {
      toast(result.notes?.length ? `设置已保存，其中 ${result.notes.length} 项被自动校正` : "设置已保存并立即生效");
    }
  });
  return parameterSettingsPanel;
}

function openProviderSettings() {
  getProviderSettingsPanel().open(state.bootstrap.provider);
}

function openParameterSettings() {
  getParameterSettingsPanel().open().catch((error) => toast(error.message));
}

const QA_STATE_LABELS = { attention: "需要复核", suggest: "建议确认", pass: "通过", pending: "未完成" };

/** 段落的质检状态：分数 <90、AIQA 未完成、或有阻断级问题 → 需要复核；有意见 → 建议确认。 */
function qaSegmentState(segment) {
  const issues = segment.issues || [];
  if (segment.aiQaFallbackReason) return "attention";
  if (Number.isFinite(segment.qaScore) && segment.qaScore < 90) return "attention";
  if (issues.some((issue) => ["error", "critical"].includes(issue.severity))) return "attention";
  if (!segment.translation) return "pending";
  if (issues.length) return "suggest";
  return "pass";
}

function qaSeverityLabel(issue) {
  if (issue.severity === "critical") return "阻断";
  if (issue.severity === "error") return "阻断";
  if (issue.severity === "major") return "主要";
  return "轻微";
}

/** 统一段列表：筛选 chips + 跳到下一条待处理，批次/文件两条来源共用。 */
function renderQaSegments() {
  const segments = state.qaSegments || [];
  const container = $("#qaSegments");
  if (!container) return;
  const filters = $("#qaFilters");
  if (!segments.length) {
    container.innerHTML = "";
    if (filters) filters.innerHTML = "";
    return;
  }
  const counts = { "": segments.length, attention: 0, suggest: 0, pass: 0, pending: 0 };
  segments.forEach((segment) => { counts[qaSegmentState(segment)] += 1; });
  if (filters) {
    filters.innerHTML = [["", "全部"], ["attention", "需要复核"], ["suggest", "建议确认"], ["pass", "通过"], ["pending", "未完成"]]
      .map(([value, label]) => `<button class="qa-filter-chip${(state.qaFilter || "") === value ? " active" : ""}" type="button" data-qa-filter="${value}">${label} ${counts[value]}</button>`)
      .join("");
  }
  const filter = state.qaFilter || "";
  const visible = filter ? segments.filter((segment) => qaSegmentState(segment) === filter) : segments;
  container.innerHTML = visible.length ? visible.map((segment) => {
    const status = qaSegmentState(segment);
    const issues = segment.issues || [];
    const meta = [segment.entryKey || segment.entryId, segment.sourceRow ? `第 ${segment.sourceRow} 行` : "", segment.sheet].filter(Boolean).join(" · ");
    return `<article class="qa-segment ${status}" data-qa-index="${segment.index}">
      <div class="qa-segment-head"><span class="qa-segment-index">${segment.index}</span><span class="qa-segment-state ${status}">${QA_STATE_LABELS[status]}</span>${Number.isFinite(segment.qaScore) ? `<span class="qa-segment-score">${Math.round(segment.qaScore)} 分</span>` : ""}${meta ? `<span class="qa-segment-meta">${escapeHtml(meta)}</span>` : ""}</div>
      <div class="qa-segment-pair"><p><span>原文</span>${escapeHtml(segment.source || "")}</p><p><span>译文</span>${escapeHtml(segment.translation || "（无译文）")}</p></div>
      ${issues.length ? `<div class="qa-segment-issues">${issues.map((issue) => `<div class="qa-issue ${escapeHtml(issue.severity || "warning")}"><strong>${escapeHtml(qaSeverityLabel(issue))}${issue.category ? ` · ${escapeHtml(issue.category)}` : ""}</strong><span>${escapeHtml(issue.message || "")}</span>${issue.suggestion ? `<em>建议：${escapeHtml(issue.suggestion)}</em>` : ""}</div>`).join("")}</div>` : ""}
    </article>`;
  }).join("") : '<div class="empty-list">当前筛选下没有段落</div>';
}

/** 跳到下一条待处理（需要复核/建议确认）：在当前筛选结果里循环。 */
function jumpToNextQaSegment() {
  const filter = state.qaFilter || "";
  const list = filter ? (state.qaSegments || []).filter((segment) => qaSegmentState(segment) === filter) : (state.qaSegments || []).filter((segment) => ["attention", "suggest"].includes(qaSegmentState(segment)));
  if (!list.length) return toast("当前筛选下没有待处理段落");
  state.qaCursor = (Number(state.qaCursor) + 1) % list.length;
  const target = list[state.qaCursor];
  const row = document.querySelector(`.qa-segment[data-qa-index="${CSS.escape(String(target.index))}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("is-highlighted");
  setTimeout(() => row.classList.remove("is-highlighted"), 2_000);
}

/** 把批次/文件质检结果渲染成统一视图（同时把旧粘贴视图收起来）。 */
function applyQaResult(payload) {
  state.qaResult = payload;
  state.autoQaTaskId = payload.taskId || state.autoQaTaskId || "";
  const segments = (payload.segments || []).map((segment, index) => ({
    index: Number(segment.index) || index + 1,
    source: segment.source || "",
    translation: segment.translation || "",
    qaScore: Number.isFinite(Number(segment.qaScore)) ? Number(segment.qaScore) : null,
    issues: Array.isArray(segment.issues) ? segment.issues : [],
    aiQaFallbackReason: segment.aiQaFallbackReason || segment.fallbackReason || "",
    entryId: segment.entryId || "", entryKey: segment.entryKey || "",
    sourceRow: segment.sourceRow || null, sheet: segment.sheet || ""
  }));
  state.qaSegments = segments;
  state.qaFilter = "";
  state.qaCursor = -1;
  $("#autoQaReport").hidden = false;
  $("#qaAlignmentNote").textContent = payload.alignmentNote || "";
  $("#qaSegments").hidden = false;
  $("#qaFilters").hidden = false;
  const legacy = $("#autoQaIssues");
  if (legacy) { legacy.hidden = true; legacy.innerHTML = ""; }
  const scores = payload.scores || { overall: 0, dimensions: {} };
  const summary = payload.summary || {};
  $("#autoQaScores").innerHTML = [["overall", "综合分", "基本 20% · 忠实性 50% · Nuance 30%"], ...AUTO_QA_DIMENSIONS]
    .map(([key, label, caption]) => {
      const value = key === "overall" ? scores.overall : scores.dimensions?.[key];
      const stats = key === "overall" ? null : summary[key];
      const detail = key === "overall" ? caption : stats?.total ? `${stats.total} 条问题 · 阻断 ${stats.error || 0} · 主要 ${stats.major || 0} · 轻微 ${stats.minor || 0}` : "未发现问题";
      return `<div class="autoqa-score-card ${autoQaScoreTone(value)}"><strong>${Number.isFinite(Number(value)) ? Math.round(Number(value)) : "—"}</strong><span>${escapeHtml(label)}</span><small>${escapeHtml(detail || "")}</small></div>`;
    }).join("");
  renderQaSegments();
}

/** 质检来源切换：批次 / 文件 / 粘贴。 */
function setQaSource(source) {
  state.qaSource = source;
  $$("#qaSourceTabs .qa-source-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.qaSource === source));
  $$("[data-qa-panel]").forEach((panel) => { panel.hidden = panel.dataset.qaPanel !== source; });
  refreshActions();
  if (source === "batch") loadQaBatches().catch((error) => toast(error.message));
}

async function loadQaBatches() {
  const select = $("#qaBatchSelect");
  if (!select) return;
  const query = new URLSearchParams({ type: "batch", limit: "100" });
  if (state.activeProjectId) query.set("projectId", state.activeProjectId);
  const tasks = await api(`/api/tasks?${query}`);
  const batches = (Array.isArray(tasks) ? tasks : [])
    .filter((task) => task.type === "batch" && task.batchId && Number(task.completedSegments) > 0)
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  select.innerHTML = batches.length
    ? batches.map((task) => `<option value="${escapeHtml(task.batchId)}">${escapeHtml(task.filename)} · ${task.completedSegments}/${task.totalSegments}${task.qaPending ? ` · ${task.qaPending} 条待处理` : ""}</option>`).join("")
    : '<option value="">当前项目还没有可质检的批次</option>';
  select.disabled = !batches.length;
  $("#qaBatchLoad").disabled = !batches.length;
}

async function runQaFromBatch() {
  const batchId = $("#qaBatchSelect")?.value;
  if (!batchId) return toast("先选择一个翻译批次");
  setBusy(true, "正在回放批次质检结果…");
  try {
    applyQaResult(await api(`/api/qa/batch/${encodeURIComponent(batchId)}?projectId=${encodeURIComponent(state.activeProjectId || "")}`));
    toast("已回放这条批次的质检结果（未重新调用模型）");
  } catch (error) {
    toast(error.message);
  } finally { setBusy(false); }
}

async function runQaFromFile() {
  const file = state.qaFile;
  if (!file) return toast("先选择要质检的双语文件");
  setBusy(true, $("#qaDeepCheck").checked ? "正在按文件句段质检（含 AI 深度检查）…" : "正在按文件句段质检…");
  try {
    applyQaResult(await api("/api/qa/file", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      locale: state.autoQaLocale,
      filename: file.name,
      base64: await fileToBase64(file),
      ...scopePayload(),
      deepCheck: $("#qaDeepCheck").checked
    }) }));
    toast("质检完成（按文件原生句段，未做切句对齐）");
  } catch (error) {
    toast(error.message);
  } finally { setBusy(false); }
}

/** 下载质检报告：CSV，一行一条问题，方便丢给同事或存档。 */
function downloadQaReport() {
  const segments = state.qaSegments || [];
  if (!segments.length) return toast("还没有质检结果");
  const rows = [["段号", "状态", "分数", "原文", "译文", "级别", "分类", "问题", "建议"]];
  segments.forEach((segment) => {
    const status = QA_STATE_LABELS[qaSegmentState(segment)];
    const issues = segment.issues || [];
    if (!issues.length) rows.push([segment.index, status, segment.qaScore ?? "", segment.source, segment.translation, "", "", "", ""]);
    issues.forEach((issue) => rows.push([
      segment.index, status, segment.qaScore ?? "", segment.source, segment.translation,
      qaSeverityLabel(issue), issue.category || "", issue.message || "", issue.suggestion || ""
    ]));
  });
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const payload = { filename: `质检报告-${state.qaResult?.filename || "结果"}.csv`, mimeType: "text/csv;charset=utf-8", base64: btoa(unescape(encodeURIComponent(`\uFEFF${csv}`))) };
  saveExportedFile(payload).then((saved) => toast(saved.message)).catch((error) => toast(error.message));
}

async function runAutoQa() {
  const source = $("#autoQaSource").value.trim();
  const translation = $("#autoQaTarget").value.trim();
  if (!source || !translation) {
    toast("请同时填写日语原文与简体中文译文");
    return;
  }
  setBusy(true, "Auto QA 质检中…");
  $("#autoQaState").textContent = "质检中…";
  $("#autoQaState").className = "badge warning";
  try {
    const payload = await api("/api/auto-qa", {
      method: "POST",
      body: JSON.stringify({
        ...projectPayload(),
        source, translation,
        locale: state.autoQaLocale,
        ...scopePayload()
      })
    });
    renderAutoQaReport(payload);
    state.qaSegments = [];
    $("#qaSegments").hidden = true;
    $("#qaFilters").hidden = true;
    const legacyIssues = $("#autoQaIssues");
    if (legacyIssues) legacyIssues.hidden = false;
    toast(`质检完成：${payload.scores.overall} 分 · 已保存到任务中心`);
  } catch (error) {
    $("#autoQaState").textContent = "质检失败";
    $("#autoQaState").className = "badge error";
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

function autoQaScoreTone(score) {
  return score >= 90 ? "good" : score >= 70 ? "warn" : "bad";
}

function renderAutoQaReport(payload) {
  const { scores, summary, segments = [], alignmentIssues = [], alignmentNote, tagsStripped, segmentCounts, fallbackReason, references, qaCases, classification, domainResolution, styleProfile } = payload;
  const scoreCard = (score, label, caption, tone) => `
    <div class="autoqa-score-card ${tone}"><strong>${score}</strong><span>${escapeHtml(label)}</span><small>${escapeHtml(caption)}</small></div>`;
  $("#autoQaScores").innerHTML =
    scoreCard(scores.overall, "综合分", "基本 20% · 忠实性 50% · Nuance 30%", "overall")
    + AUTO_QA_DIMENSIONS.map(([dimension, label]) => {
      const value = scores.dimensions[dimension];
      const stats = summary[dimension] || {};
      const counts = stats.total
        ? `${stats.total} 条问题 · 阻断 ${stats.error} · 主要 ${stats.major} · 轻微 ${stats.minor}`
        : "未发现问题";
      return scoreCard(value, label, counts, autoQaScoreTone(value));
    }).join("");

  const evidenceLines = [];
  if (styleProfile?.name) evidenceLines.push(`风格规范：${styleProfile.name} v${styleProfile.version || 1}`);
  if (references?.length) evidenceLines.push(`已批准译例 ${references.length} 条`);
  if (qaCases?.length) evidenceLines.push(`历史 QA 反例 ${qaCases.length} 条`);
  if (classification?.contentType) {
    const label = state.bootstrap?.contentTypes?.[classification.contentType]?.label || classification.contentType;
    evidenceLines.push(`识别语体：${label}（${CLASSIFY_SOURCE_LABELS[classification.source] || classification.source || "识别"}）`);
    const tags = contentTagLabels(classification.contentType, classification.contentTags);
    if (tags.length) evidenceLines.push(`场景标签：${tags.join(" / ")}`);
  }
  if (domainResolution?.domain) {
    const label = DOMAIN_LABELS[domainResolution.domain] || domainResolution.domain;
    const note = domainResolution.relaxedRetrieval ? "，该领域无资产，检索已放宽到全部" : "";
    evidenceLines.push(`识别领域：${label}（${CLASSIFY_SOURCE_LABELS[domainResolution.source] || domainResolution.source}${note}）`);
  }
  const evidenceBox = evidenceLines.length
    ? `<div class="reflection-box"><strong>Nuance 对照证据</strong>\n${escapeHtml(evidenceLines.join("\n"))}</div>`
    : "";
  const notes = [];
  if (tagsStripped) notes.push("输入含 HTML 标签，已剥离后分析。");
  if (alignmentNote) notes.push(alignmentNote);
  const noteBox = notes.length ? `<div class="reflection-box"><strong>逐句对齐说明</strong>\n${escapeHtml(notes.join("\n"))}</div>` : "";
  const fallback = fallbackReason
    ? `<div class="qa-item error">部分句子模型层质检未完成：${escapeHtml(fallbackReason)}</div>`
    : "";
  const alignmentBlock = alignmentIssues.length
    ? `<section class="autoqa-dimension">
        <div class="autoqa-dimension-head"><div><span class="card-kicker">SENTENCE ALIGNMENT</span><h3>整句级问题</h3><small>按语义向量逐句对齐时发现的疑似漏译 / 增译</small></div><span class="asset-count">${alignmentIssues.length} 条</span></div>
        ${alignmentIssues.map((issue) => renderAutoQaIssue(issue, null)).join("")}
      </section>`
    : "";
  const openByDefault = segments.length <= 6;
  const segmentCards = segments.map((segment, index) => renderAutoQaSegment(segment, openByDefault || index < 2)).join("");
  $("#autoQaIssues").innerHTML = `
    ${evidenceBox}${noteBox}${fallback}${alignmentBlock}
    <section class="autoqa-dimension">
      <div class="autoqa-dimension-head"><div><span class="card-kicker">PER-SENTENCE CHECKS</span><h3>逐句检查</h3><small>原文 ${segmentCounts?.source ?? segments.length} 句 / 译文 ${segmentCounts?.translation ?? segments.length} 句，每一句按三个维度独立审查</small></div><span class="asset-count subtle">${segments.length} 组</span></div>
      ${segmentCards || `<div class="qa-item warning">未能配对任何句子，请检查输入内容。</div>`}
    </section>`;
  $("#autoQaReport").hidden = false;

  const overall = scores.overall;
  $("#autoQaState").textContent = fallbackReason ? "部分模型检查失败" : `${overall} 分`;
  $("#autoQaState").className = `badge ${overall >= 90 ? "success" : overall >= 70 ? "warning" : "error"}`;
}

function renderAutoQaSegment(segment, open) {
  const { index, sourceIndices, translationIndices, source, translation, issues, scores, fallbackReason: segmentFallback } = segment;
  const metrics = AUTO_QA_DIMENSIONS.map(([dimension, label]) =>
    `<span class="autoqa-segment-metric ${autoQaScoreTone(scores.dimensions[dimension])}"><i>${scores.dimensions[dimension]}</i>${label}</span>`).join("");
  const sourceLabel = sourceIndices.length > 1 ? `原文第 ${sourceIndices.join("、")} 句合并` : `原文第 ${sourceIndices[0] || index} 句`;
  const translationLabel = translationIndices.length > 1 ? `译文第 ${translationIndices.join("、")} 句合并` : `译文第 ${translationIndices[0] || index} 句`;
  const segmentFailure = segmentFallback ? `<div class="qa-item warning">本组模型检查失败：${escapeHtml(segmentFallback)}，仅展示本地基本检查。</div>` : "";
  const body = `<div class="autoqa-segment-body">
      <div class="autoqa-segment-pair">
        <div><span>${escapeHtml(sourceLabel)}</span><p>${escapeHtml(source)}</p></div>
        <div><span>${escapeHtml(translationLabel)}</span><p>${escapeHtml(translation)}</p></div>
      </div>
      ${segmentFailure}
      ${issues.length ? issues.map((issue) => renderAutoQaIssue(issue, index)).join("") : `<div class="qa-item">本句三层检查通过</div>`}
    </div>`;
  return `<details class="autoqa-segment"${open ? " open" : ""}>
    <summary>
      <span class="autoqa-segment-index">#${index}</span>
      <span class="autoqa-segment-score ${autoQaScoreTone(scores.overall)}">${scores.overall}</span>
      ${metrics}
      <span class="autoqa-segment-text">${escapeHtml(source.length > 42 ? `${source.slice(0, 42)}…` : source)}</span>
    </summary>
    ${body}
  </details>`;
}

function renderAutoQaIssue(issue, segmentIndex = null) {
  const canDeleteIssue = Boolean(state.autoQaTaskId) && window.isSecureContext && Boolean(globalThis.crypto?.subtle);
  const deleteButton = canDeleteIssue
    ? `<button class="button ghost small autoqa-issue-delete" type="button" data-qa-issue-delete="${encodeURIComponent(JSON.stringify({ issue, segmentIndex }))}">删除该意见</button>`
    : "";
  const severityLabel = issue.severity === "critical" || issue.severity === "error" ? "阻断"
    : issue.severity === "major" ? "主要" : "轻微";
  const spans = issue.sourceSpan || issue.targetSpan
    ? `<div class="autoqa-span-pair">${issue.sourceSpan ? `<span>原文「${escapeHtml(issue.sourceSpan)}」</span>` : ""}${issue.targetSpan ? `<span>译文「${escapeHtml(issue.targetSpan)}」</span>` : ""}</div>`
    : "";
  const suggestion = issue.suggestion ? `<small class="autoqa-suggestion">建议：${escapeHtml(issue.suggestion)}</small>` : "";
  const confidence = Number.isFinite(Number(issue.confidence))
    ? `<span class="autoqa-confidence">置信 ${Math.round(Number(issue.confidence) * 100)}%</span>`
    : "";
  return `<div class="autoqa-issue ${issue.severity}">
    ${deleteButton}
    <div class="autoqa-issue-head"><span class="autoqa-category">${escapeHtml(issue.category || "other")}</span><span class="autoqa-severity ${issue.severity}">${severityLabel}</span>${confidence}</div>
    <p>${escapeHtml(issue.message)}</p>${spans}${suggestion}
  </div>`;
}

function compactQaReferences(aiQa = {}) {
  return [...(aiQa.references || []), ...(aiQa.qaCases || []).map((item) => ({ ...item, kind: "qa_case" }))]
    .slice(0, 12)
    .map(({ embedding, ...item }) => item);
}

function qaResolutionBody({ source, translation, result, action, issueIndex, contentType, domain, batchId, review = {} }) {
  return {
    source, translation, action, issueIndex,
    issues: result.issues || [], qaScore: result.qaScore,
    locale: state.workbenchLocale, contentType, domain, batchId,
    trajectoryId: result.trajectoryId || result.trajectory_id || "",
    iterations: result.aiQa?.iterations || 0,
    references: compactQaReferences(result.aiQa),
    termDecisions: result.aiQa?.termDecisions || [],
    humanDecisions: result.aiQa?.humanDecisions || [],
    ...review
  };
}

async function resolveSingleQaIssue(issueIndex, action, button) {
  const result = state.lastResult;
  if (!result?.issues?.[issueIndex]) return;
  const issue = result.issues[issueIndex];
  const review = {};
  if (action === "accept" && !confirm("确认采纳这条 QA 意见，并让翻译模型按意见做最小修订？")) return;
  if (action === "partial") {
    const accepted = prompt("填写要采纳的部分（多项可用分号分隔）：", issue.suggestion || issue.message || "");
    if (accepted == null) return;
    const rejected = prompt("填写不采纳的部分及边界（必填）：", "其余表述保持不变");
    if (rejected == null) return;
    const instruction = prompt("给翻译模型的精确修订要求：", accepted);
    if (instruction == null) return;
    review.acceptedParts = accepted.split(/[；;]/).map((item) => item.trim()).filter(Boolean);
    review.rejectedParts = rejected.split(/[；;]/).map((item) => item.trim()).filter(Boolean);
    review.revisionInstruction = instruction.trim();
  }
  if (action === "reject") {
    const reason = prompt("请说明拒绝这条 QA 意见的原因（会写入处理回执）：", "当前译文在本语境中可接受");
    if (reason == null || !reason.trim()) return;
    review.reason = reason.trim();
  }
  button.disabled = true;
  button.textContent = ["accept", "partial", "revise"].includes(action) ? "AI 修订中…" : "记录中…";
  try {
    const resolved = await api("/api/qa/resolve", { method: "POST", body: JSON.stringify(qaResolutionBody({
      source: $("#sourceText").value.trim(), translation: result.translation, result, action, issueIndex,
      contentType: result.classification?.contentType || "general", domain: result.domainResolution?.domain || "auto", batchId: "single-review", review
    })) });
    state.lastResult = { ...result, ...resolved, translation: resolved.translation, issues: resolved.issues, qaScore: resolved.qaScore, aiQa: resolved.aiQa, reviewReceipt: resolved.reviewReceipt };
    renderTranslationOutput();
    renderQa(state.lastResult);
    setResultStatus(state.lastResult.issues, state.lastResult.aiQa);
    toast(["accept", "partial", "revise"].includes(action) ? `AI 已按决定修订并重新 QA：${resolved.qaScore} 分` : "已拒绝该条建议并生成处理回执");
  } catch (error) {
    button.disabled = false;
    button.textContent = action === "accept" ? "采纳并让 AI 修订" : action === "partial" ? "部分采纳" : "拒绝意见";
    toast(error.message);
  }
}

function setResultStatus(issues = [], aiQa = null) {
  if (aiQa?.fallbackReason) return setTranslationStatus("warning", "AIQA 未完成");
  if (Number.isFinite(aiQa?.score) && aiQa.score < 90) return setTranslationStatus("error", "AIQA 待复核");
  if (issues.some((issue) => issue.severity === "error")) setTranslationStatus("error", "需要处理");
  else if (issues.length) setTranslationStatus("warning", "建议确认");
  else setTranslationStatus("success", "QA 通过");
}

const CLASSIFY_SOURCE_LABELS = {
  manual: "人工指定", descriptor: "表格声明", "content-type": "语体决定",
  model: "模型识别", heuristic: "正文推断", fallback: "默认值"
};

const DOMAIN_LABELS = { game: "游戏", general: "通用", marketing: "市场营销", community: "社区运营" };

/**
 * 「自动识别」选项此前只能等翻译跑完、在结果区的小字里才知道判成了什么。
 * 语体与领域都直接决定取哪份风格规范和哪批记忆，判定结果必须当场可见。
 */
function resolutionSummary(classification, domainResolution) {
  const parts = [];
  if (classification?.contentType) {
    const label = state.bootstrap?.contentTypes?.[classification.contentType]?.label || classification.contentType;
    const tags = contentTagLabels(classification.contentType, classification.contentTags);
    parts.push(`语体 <strong>${escapeHtml(label)}</strong>${tags.length ? ` · ${escapeHtml(tags.join(" / "))}` : ""}（${escapeHtml(CLASSIFY_SOURCE_LABELS[classification.source] || classification.source || "识别")}）`);
  }
  if (domainResolution?.domain) {
    const label = DOMAIN_LABELS[domainResolution.domain] || domainResolution.domain;
    const note = domainResolution.relaxedRetrieval ? "，该领域无资产，检索已放宽到全部" : "";
    parts.push(`领域 <strong>${escapeHtml(label)}</strong>（${escapeHtml(CLASSIFY_SOURCE_LABELS[domainResolution.source] || domainResolution.source)}${escapeHtml(note)}）`);
  }
  return parts.join(" · ");
}

/**
 * 本次参考透明化：风格规范是项目级的（每项目一份），记忆仍按作用域排序，
 * 这里把"用的是哪一版规范、译例来自哪一档"说清楚。
 */
function scopeUsageText(scopeUsage) {
  if (!scopeUsage) return "";
  const parts = [];
  const profile = scopeUsage.styleProfile;
  if (profile) {
    parts.push(`项目规范${profile.name ? `「${profile.name}」` : ""} v${profile.version || 1}`);
  } else {
    parts.push("无启用中的项目规范");
  }
  const counts = scopeUsage.memoryScopes || {};
  const total = (counts.exact || 0) + (counts.partial || 0) + (counts.general || 0);
  if (total) {
    const detail = [
      counts.exact ? `同作用域 ${counts.exact}` : "",
      counts.partial ? `相邻作用域 ${counts.partial}` : "",
      counts.general ? `通用 ${counts.general}` : ""
    ].filter(Boolean).join(" / ");
    parts.push(`译例 ${total} 条（${detail}）`);
  }
  return `本次参考：${parts.join(" · ")}`;
}

function renderTranslationOutput() {
  const result = state.lastResult;
  if (!result) return;
  const rendered = renderTranslationMarkup(result.translation, result.matches, result.termSuggestions || []);
  $("#targetOutput").classList.remove("empty");
  $("#targetOutput").innerHTML = rendered.html;
  $("#targetLegend").hidden = rendered.officialCount + rendered.suggestionCount === 0;
  $("#officialLegend").hidden = rendered.officialCount === 0;
  $("#officialCount").textContent = `${rendered.officialCount} 处正式术语`;
  $("#suggestionLegend").hidden = rendered.suggestionCount === 0;
  $("#suggestionCount").textContent = `${rendered.suggestionCount} 处疑似术语`;
  $$(".term-suggestion").forEach((button) => button.addEventListener("click", () => openTermSuggestion(button.dataset.suggestionId)));
  const editable = $("#targetOutput").isContentEditable;
  if (editable) {
    $("#targetOutput").textContent = result.translation;
  }
  $("#toggleTargetEdit").hidden = false;
  $("#toggleTargetEdit").textContent = editable ? "完成编辑" : "编辑译文";
  $("#acceptTranslation").disabled = !result.translation;
  $("#sendToAutoQa").hidden = !result.translation;
  renderTranslationCandidates(result);
}

function renderTranslationCandidates(result) {
  const panel = $("#translationCandidates");
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  if (candidates.length < 2) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  panel.hidden = false;
  panel.innerHTML = `<div class="candidate-picker-head"><div><strong>模型候选</strong><small>${escapeHtml(result.routing?.label || "多候选路线")} · 推荐项已完成本轮 QA</small></div><span>${candidates.length} 版</span></div><div class="candidate-picker-list">${candidates.map((candidate, index) => {
    const selected = candidate.translation === result.translation;
    return `<button class="candidate-translation ${selected ? "selected" : ""}" data-translation-candidate="${index}" type="button"><span>${selected ? "当前采用" : `候选 ${index + 1}`}${candidate.recommended ? " · 系统推荐" : ""}</span><strong>${escapeHtml(candidate.translation)}</strong><small>${escapeHtml(candidate.reason || "点击采用并重新 QA")}</small></button>`;
  }).join("")}</div>`;
  $$('[data-translation-candidate]').forEach((button) => button.addEventListener("click", () => selectTranslationCandidate(Number(button.dataset.translationCandidate), button)));
}

async function selectTranslationCandidate(index, button) {
  const result = state.lastResult;
  const candidate = result?.candidates?.[index];
  if (!candidate || candidate.translation === result.translation) return;
  button.disabled = true;
  try {
    const qa = await api("/api/qa", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      source: $("#sourceText").value.trim(),
      translation: candidate.translation,
      locale: state.workbenchLocale,
      contentType: result.classification?.contentType || "general",
      domain: result.domainResolution?.domain || "auto",
      aiQa: true
    }) });
    state.lastResult = { ...result, ...qa, candidates: result.candidates, routing: result.routing, translation: qa.translation };
    renderTranslationOutput();
    renderMatches(state.lastResult.matches || result.matches || []);
    renderQa(state.lastResult);
    setResultStatus(state.lastResult.issues || [], state.lastResult.aiQa);
    toast(`已采用候选 ${index + 1} 并重新完成 QA`);
  } catch (error) {
    button.disabled = false;
    toast(`候选暂未采用：${error.message}`);
  }
}

function toggleTargetEdit() {
  const output = $("#targetOutput");
  const editable = output.isContentEditable;
  output.contentEditable = String(!editable);
  if (!editable) {
    output.textContent = state.lastResult.translation;
    $("#toggleTargetEdit").textContent = "完成编辑";
  } else {
    state.lastResult.translation = output.textContent.trim();
    renderTranslationOutput();
  }
}

async function acceptSingleTranslation() {
  if (!state.lastResult) return;
  const output = $("#targetOutput");
  const translation = output.isContentEditable ? output.textContent.trim() : state.lastResult.translation;
  if (!translation) return toast("没有可采纳的译文");
  if (output.isContentEditable) state.lastResult.translation = translation;
  setBusy(true, "采纳中…");
  try {
    const result = await api("/api/feedback/accept", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      source: $("#sourceText").value.trim(),
      translation,
      locale: state.workbenchLocale,
      contentType: state.lastResult.classification.contentType,
      domain: state.lastResult.domainResolution?.domain || "auto",
      styleProfileId: state.lastResult.styleProfile?.id || "",
      qaCaseId: state.lastResult.aiQa?.qaCases?.[0]?.id || "",
      termSuggestions: state.lastResult.termSuggestions || [],
      trajectoryId: state.lastResult.trajectoryId || state.lastResult.trajectory_id || ""
    }) });
    if (output.isContentEditable) toggleTargetEdit();
    toast(`${result.termCandidateWarning || `已采纳为正式译法${result.demoted ? `，${result.demoted} 条旧机器译文已降权` : ""}，并沉淀为风格证据${result.termCandidateBatch ? "；新术语已进入待审核候选" : ""}`}`);
  } catch (error) { toast(error.message); }
  finally { setBusy(false); }
}

function openTermSuggestion(id) {
  const suggestion = state.lastResult?.termSuggestions?.find((item) => item.id === id);
  if (!suggestion) return;
  state.activeSuggestion = suggestion;
  $("#suggestionSource").textContent = `${suggestion.matchedSource} ≈ ${suggestion.sourceTerm}`;
  $("#suggestionCurrent").textContent = suggestion.currentText;
  $("#suggestionReplacement").textContent = suggestion.replacement;
  $("#suggestionConfidence").textContent = `综合置信度 ${Math.round(Math.min(suggestion.matchScore, suggestion.confidence) * 100)}% · ${suggestion.reason}`;
  $("#termSuggestionDialog").showModal();
}

async function applyTermSuggestion() {
  const suggestion = state.activeSuggestion;
  if (!suggestion || !state.lastResult) return;
  state.lastResult.translation = state.lastResult.translation.split(suggestion.currentText).join(suggestion.replacement);
  state.lastResult.termSuggestions = (state.lastResult.termSuggestions || []).filter((item) => item.id !== suggestion.id);
  $("#termSuggestionDialog").close();
  state.activeSuggestion = null;
  try {
    const qa = await api("/api/qa", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      source: $("#sourceText").value,
      translation: state.lastResult.translation,
      locale: state.workbenchLocale,
      contentType: state.lastResult.classification.contentType,
      domain: state.lastResult.domainResolution?.domain || "auto",
      aiQa: true
    }) });
    state.lastResult.translation = qa.translation;
    state.lastResult.matches = qa.matches;
    state.lastResult.issues = qa.issues;
    state.lastResult.qaScore = qa.qaScore;
    state.lastResult.aiQa = qa.aiQa;
  } catch (error) { toast(`替换成功，但 QA 刷新失败：${error.message}`); }
  renderTranslationOutput();
  renderMatches(state.lastResult.matches);
  renderQa(state.lastResult);
  setResultStatus(state.lastResult.issues, state.lastResult.aiQa);
  toast(`已将“${suggestion.currentText}”替换为正式译法“${suggestion.replacement}”`);
}

let previewTimer;
function previewClassificationAndMatches() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    // 翻译与审校进行中不要用预检结果覆盖结果面板：预检响应可能比翻译晚回来，
    // 那样用户看到的就是"只有语体没有本次参考"的旧信息。
    if (state.busy) return;
    const text = $("#sourceText").value.trim();
    $("#sourceCount").textContent = `${[...text].length} 字`;
    if (!text || !state.bootstrap) return;
    try {
      const classification = await api("/api/classify", { method: "POST", body: JSON.stringify({ text, hint: "auto", domain: "auto" }) });
      const resolvedDomain = classification.domainResolution?.domain || "auto";
      const matched = await api("/api/match", { method: "POST", body: JSON.stringify({ ...projectPayload(), text, locale: state.workbenchLocale, contentType: classification.contentType, domain: resolvedDomain }) });
      $("#classificationPreview").innerHTML = `<span class="pulse-dot"></span><span>${resolutionSummary(classification, classification.domainResolution)} · 置信度 ${Math.round(classification.confidence * 100)}% · 命中 ${matched.matches.length} 条术语</span>`;
      renderMatches(matched.matches);
    } catch (error) {
      $("#classificationPreview").textContent = error.message;
    }
  }, 300);
}

async function translate() {
  const source = $("#sourceText").value.trim();
  if (!source) return toast("请先输入日语原文");
  setBusy(true, "翻译与审校中…");
  setTranslationStatus("warning", "处理中");
  try {
    const result = await api("/api/translate", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      source, locale: state.workbenchLocale, ...scopePayload(),
      qualityTier: $("#qualityTier").value,
      neighborContext: $("#neighborContext").value, useModelClassification: true
    }) });
    state.lastResult = result;
    renderTranslationOutput();
    // 透明化：除了语体/领域判定，还要说清这次到底吃到了哪一档作用域的规范与译例。
    const scopeNote = scopeUsageText(result.scopeUsage);
    $("#classificationPreview").innerHTML = `<span class="pulse-dot"></span><span>${resolutionSummary(result.classification, result.domainResolution)}${scopeNote ? ` · ${escapeHtml(scopeNote)}` : ""}</span>`;
    renderMatches(result.matches);
    renderQa(result);
    setResultStatus(result.issues, result.aiQa);
  } catch (error) {
    setTranslationStatus("error", "翻译失败");
    toast(error.message);
  } finally { setBusy(false); }
}

function clearTranslation() {
  $("#sourceText").value = "";
  $("#neighborContext").value = "";
  updateWorkbenchLocale(state.workbenchLocale);
}

async function loadPastedTextAsBatch(value) {
  if (!shouldRoutePasteToBatch(value)) return false;
  if (state.batchRunning) {
    toast("当前批次仍在翻译，请暂停或完成后再粘贴新内容");
    return false;
  }
  const pasted = normalizePastedText(value);
  state.batchFile = null;
  state.batchBase64 = "";
  state.batchPreview = null;
  state.batchClassification = null;
  state.batchStyleProfile = null;
  updateBatchSegmentationOptions("粘贴长文.txt");
  localStorage.removeItem("kami-batch-id");
  $("#batchFile").value = "";
  $("#batchPasteText").value = pasted;
  $("#batchFilePrompt").textContent = "已载入粘贴文本";
  $("#batchFileMeta").textContent = `${[...pasted].length} 字 · 正在自动分句`;
  $("#batchDropZone").classList.add("has-file");
  $("#batchSourceMeta").textContent = "正在解析";
  setTranslationMode("batch");
  renderBatchSegments();
  refreshActions();
  await prepareBatch();
  return true;
}

async function setBatchFile(file) {
  if (!file) return;
  if (!/\.(txt|md|docx|xlsx|csv|xliff|mqxliff)$/i.test(file.name)) return toast("请选择 TXT、Markdown、DOCX、XLSX、CSV、XLIFF 或 MQXLIFF 文件");
  if (file.size > UPLOAD_FILE_BYTES) return toast(`文件不能超过 ${UPLOAD_FILE_LABEL}`);
  state.batchFile = file;
  state.batchBase64 = "";
  state.batchPreview = null;
  state.batchClassification = null;
  state.batchStyleProfile = null;
  state.batchColumnMapping = null;
  updateBatchSegmentationOptions(file.name);
  $("#batchPasteText").value = "";
  $("#batchFilePrompt").textContent = file.name;
  $("#batchFileMeta").textContent = `${(file.size / 1024).toFixed(1)} KB · 正在智能识别`;
  $("#batchDropZone").classList.add("has-file");
  $("#batchSourceMeta").textContent = "AI 结构识别中";
  $("#spreadsheetAnalysis").hidden = true;
  renderBatchSegments();
  refreshActions();
  // 表格文件先让用户确认列含义：哪一列是日文原文、哪一列是已有译文/条目 ID、首行是不是表头。
  if (/\.(xlsx|csv)$/iu.test(file.name)) {
    const confirmed = await confirmBatchColumns(file);
    if (!confirmed) {
      resetBatchFileSelection();
      return false;
    }
  }
  await prepareBatch();
  return true;
}

const BATCH_COLUMN_ROLES = [
  { value: "source_text", label: "日文原文（要翻译）" },
  { value: "existing_translation", label: "已有译文（参考）" },
  { value: "translation_output", label: "写回译文的列" },
  { value: "entry_id", label: "条目 ID" },
  { value: "context", label: "上下文 / 说明" },
  { value: "constraint", label: "约束（字数、语言…）" },
  { value: "ignore", label: "忽略此列" }
];

/**
 * 待译表格上传后的"列含义"确认弹窗。
 *
 * 只对 .xlsx / .csv 弹：先让服务端给出每列的建议角色与样例，用户逐列调整、并决定首行是不是表头，
 * 确认后把映射交给 /api/batch/prepare。返回 true 表示用户确认（可以继续解析），false 表示取消。
 */
async function confirmBatchColumns(file) {
  const dialog = $("#batchColumnDialog");
  if (!dialog) return true;
  let structure = null;
  try {
    structure = await api("/api/batch/columns", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      filename: file.name,
      base64: await fileToBase64(file),
      locale: state.workbenchLocale,
      useAiStructure: true
    }) });
  } catch (error) {
    // 结构识别失败不该拦住上传：退回原来的全自动解析，并把原因告诉用户。
    toast(`列结构识别失败，将按自动识别导入：${error.message}`);
    return true;
  }
  state.batchColumns = structure;
  state.batchColumnMapping = null;

  const renderColumns = () => {
    const sheets = structure.sheets || [];
    $("#batchColumnSummary").textContent = `已识别 ${sheets.length} 个工作表、${sheets.reduce((sum, sheet) => sum + (sheet.columns?.length || 0), 0)} 列（${structure.structureSource === "model" ? "AI + 规则" : "本地规则"}）。逐列确认后再开始分段，只有「日文原文」列会被送去翻译。`;
    $("#batchColumnBody").innerHTML = sheets.map((sheet, sheetIndex) => `
      <section class="batch-column-sheet" data-sheet="${escapeHtml(sheet.sheet)}">
        <div class="batch-column-sheet-head">
          <div><strong>${escapeHtml(sheet.sheet)}</strong><small>${sheet.rowCount} 行 · ${escapeHtml(sheet.reason || "")}</small></div>
          <label class="batch-column-header-toggle"><input type="checkbox" data-sheet-header="${sheetIndex}" ${sheet.headerRow ? "checked" : ""} />首行是表头</label>
        </div>
        ${(sheet.columns || []).map((column) => `
          <div class="batch-column-row">
            <div class="batch-column-key"><b>${escapeHtml(column.letter)} 列</b>${escapeHtml(column.header || "无表头")}</div>
            <div class="batch-column-samples">${column.headerEmpty ? '<em class="batch-column-tag">表头为空 · 按下面内容识别</em>' : ""}${(column.samples?.length ? column.samples : ["（空）"]).map((sample) => `<em class="${sample === "（空）" ? "is-empty" : ""}">${escapeHtml(sample)}</em>`).join("")}<em class="is-empty">识别依据：${escapeHtml(column.reason || "")}</em></div>
            <select data-sheet-index="${sheetIndex}" data-column="${column.column}">${BATCH_COLUMN_ROLES.map((role) => `<option value="${role.value}"${column.role === role.value ? " selected" : ""}>${escapeHtml(role.label)}</option>`).join("")}</select>
          </div>`).join("")}
      </section>`).join("") || '<div class="empty-list">这个文件没有可识别的列</div>';
    updateBatchColumnState();
  };

  const collectMapping = () => ({
    sheets: (structure.sheets || []).map((sheet, sheetIndex) => ({
      sheet: sheet.sheet,
      headerRow: $(`[data-sheet-header="${sheetIndex}"]`)?.checked ? (sheet.headerRow || 1) : null,
      columns: $$(`select[data-sheet-index="${sheetIndex}"]`).map((select) => ({ column: Number(select.dataset.column), role: select.value }))
    }))
  });

  const updateBatchColumnState = () => {
    const mapping = collectMapping();
    const sourceCount = mapping.sheets.reduce((sum, sheet) => sum + sheet.columns.filter((column) => column.role === "source_text").length, 0);
    // 直接用当前选择（用户可能刚把某列改成写回列），标签从原始结构里取。
    const outputColumns = mapping.sheets.flatMap((sheet, sheetIndex) => sheet.columns
      .filter((column) => column.role === "translation_output")
      .map((column) => (structure.sheets[sheetIndex]?.columns || []).find((item) => item.column === column.column) || { letter: String(column.column) }));
    const outputCount = outputColumns.length;
    $("#batchColumnConfirm").disabled = sourceCount === 0;
    $("#batchColumnHint").classList.toggle("is-error", sourceCount === 0);
    $("#batchColumnHint").textContent = sourceCount
      ? `将翻译 ${sourceCount} 列日文原文；${outputCount ? `译文导出时写到「${outputColumns.map((column) => column.label || column.letter).join("」「")}」` : "没有指定写回列 → 导出时原位覆盖原文列"}；「已有译文」只作参考、「条目 ID」用于写回记忆库时的身份匹配。`
      : "至少要指定一列「日文原文」，否则没有可翻译的内容。";
    $$("#batchColumnBody select").forEach((select) => { select.dataset.role = select.value; });
  };

  renderColumns();
  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener("click", onClick);
      dialog.removeEventListener("change", onChange);
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onClick = (event) => {
      if (event.target.closest("#batchColumnConfirm")) return finish(collectMapping());
      if (event.target.closest("#batchColumnReset")) {
        state.batchColumns = structure;
        renderColumns();
      }
    };
    const onChange = (event) => {
      const target = event.target;
      if (target.matches("[data-sheet-header]")) {
        const index = Number(target.dataset.sheetHeader);
        structure.sheets[index].headerRow = target.checked ? (structure.sheets[index].headerRow || 1) : null;
        renderColumns();
        return;
      }
      updateBatchColumnState();
    };
    const onCancel = (event) => { event.preventDefault(); finish(null); };
    // × / 取消 走通用关闭按钮，关闭事件兜底成"未确认"。
    const onClose = () => finish(null);
    dialog.addEventListener("click", onClick);
    dialog.addEventListener("change", onChange);
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("close", onClose);
    dialog.showModal();
  });
  if (!result) return false;
  state.batchColumnMapping = result;
  return true;
}

/** 取消列确认时把上传状态清干净，避免界面停在"已选择文件"却没有解析结果。 */
function resetBatchFileSelection() {
  state.batchFile = null;
  state.batchBase64 = "";
  state.batchPreview = null;
  state.batchColumnMapping = null;
  $("#batchFile").value = "";
  $("#batchFilePrompt").textContent = "拖入或点击选择文件";
  $("#batchFileMeta").textContent = "拖入后自动识别；支持 TXT、Markdown、DOCX、XLSX、CSV、XLIFF、MQXLIFF，最大 20MB";
  $("#batchDropZone").classList.remove("has-file");
  $("#batchSourceMeta").textContent = "等待文件";
  renderBatchSegments();
  refreshActions();
}

async function resetBatch() {
  if (state.batchRunning) await pauseBatch();
  state.batchFile = null;
  state.batchBase64 = "";
  state.batchPreview = null;
  state.batchRunning = false;
  state.batchClassification = null;
  state.batchStyleProfile = null;
  updateBatchSegmentationOptions("粘贴长文.txt");
  localStorage.removeItem("kami-batch-id");
  $("#batchFile").value = "";
  $("#batchPasteText").value = "";
  $("#batchFilePrompt").textContent = "拖入或点击选择文件";
  $("#batchFileMeta").textContent = "拖入后自动识别；支持 TXT、Markdown、DOCX、XLSX、CSV、XLIFF、MQXLIFF，最大 20MB";
  $("#batchDropZone").classList.remove("has-file");
  $("#batchSourceMeta").textContent = "尚未载入";
  $("#spreadsheetAnalysis").hidden = true;
  renderBatchSegments();
  refreshActions();
}

function batchStatus(segment) {
  if (!segment.selected) return ["pending", "已跳过", "导出时保留原文"];
  if (segment.status === "running") return ["running", "翻译中", "术语匹配与 QA"];
  if (segment.status === "error") return ["error", "翻译失败", segment.error || "可继续重试"];
  if (segment.status === "done") {
    const issues = segment.result?.issues || [];
    if (segment.result?.aiQa?.fallbackReason) {
      const reason = String(segment.result.aiQa.fallbackReason).replace(/\s+/g, " ").slice(0, 90);
      return ["warning", "AIQA 未完成", reason || "需要重试或人工复核"];
    }
    if (Number.isFinite(segment.result?.qaScore) && segment.result.qaScore < 90) return ["warning", "需要复核", `AIQA ${segment.result.qaScore} 分`];
    const errors = issues.filter((issue) => issue.severity === "error").length;
    if (errors) return ["warning", "需要复核", `${errors} 个阻断项`];
    if (issues.length) return ["warning", "建议确认", `${issues.length} 条建议`];
    return ["success", "QA 通过", `${Number.isFinite(segment.result?.qaScore) ? `${segment.result.qaScore} 分 · ` : ""}${segment.result?.matches?.length || 0} 条术语`];
  }
  return ["pending", "待翻译", "等待队列"];
}

function renderSpreadsheetAnalysis(analysis) {
  const element = $("#spreadsheetAnalysis");
  if (!analysis?.sheets?.length) {
    element.hidden = true;
    return;
  }
  const roleLabels = { source_text: "正文", context: "补充信息", constraint: "约束", existing_translation: "已有译文", ignore: "忽略" };
  const sourceLabel = analysis.usedModel ? "AI 已识别" : "规则降级识别";
  element.hidden = false;
  element.innerHTML = `<div class="analysis-head"><strong>Excel 结构识别</strong><span>${sourceLabel}${analysis.fallbackReason ? ` · ${escapeHtml(analysis.fallbackReason)}` : ""}</span></div>${analysis.sheets.map((sheet) => `
    <div class="analysis-sheet"><strong>${escapeHtml(sheet.sheet)} · ${sheet.headerRow ? `表头第 ${sheet.headerRow} 行` : "无表头自动推断"} · ${Math.round((sheet.confidence || 0) * 100)}%</strong><div class="analysis-columns">${sheet.columns.map((column) => `<span class="analysis-column ${column.role}" title="${escapeHtml(column.reason)}">${escapeHtml(column.letter)} · ${escapeHtml(column.label)} → ${roleLabels[column.role] || column.role}</span>`).join("")}</div></div>
  `).join("")}`;
}

function renderBatchTarget(segment) {
  const running = segment.status === "running";
  const rendered = segment.result && segment.translation
    ? renderTranslationMarkup(segment.translation, segment.result.matches || [], [])
    : { html: escapeHtml(segment.translation || ""), officialCount: 0 };
  const placeholder = running ? "正在翻译…" : "译文将在这里显示";
  return `<div class="batch-segment-target${running ? " disabled" : ""}" data-id="${escapeHtml(segment.id)}" data-placeholder="${placeholder}" role="textbox" aria-label="第 ${segment.index} 段译文" aria-multiline="true" contenteditable="${running ? "false" : "true"}">${rendered.html}</div>${rendered.officialCount ? `<div class="batch-term-legend"><i></i>${rendered.officialCount} 处正式术语</div>` : ""}`;
}

function batchIssueHtml(issue, index, segmentId) {
  const severity = issue.mqmSeverity || issue.severity || "warning";
  const label = severity === "critical" ? "严重" : severity === "major" || severity === "error" ? "主要" : "次要";
  const spans = [issue.sourceSpan ? `原文：${issue.sourceSpan}` : "", issue.targetSpan ? `译文：${issue.targetSpan}` : ""].filter(Boolean).join(" · ");
  const reject = issue.severity !== "error" || issue.mqmSeverity === "minor" ? `<button class="button ghost small batch-qa-action" data-action="reject" data-id="${escapeHtml(segmentId)}" data-issue-index="${index}">拒绝意见</button>` : "";
  return `<div class="batch-qa-issue ${escapeHtml(severity)}"><strong>${label} · ${escapeHtml(issue.category || issue.type || "QA")}</strong><p>${escapeHtml(issue.message || "未说明问题")}</p>${issue.suggestion ? `<p class="suggestion">建议：${escapeHtml(issue.suggestion)}</p>` : ""}${spans ? `<small>${escapeHtml(spans)}</small>` : ""}<div class="qa-decision-actions"><button class="button ghost small batch-qa-action" data-action="accept" data-id="${escapeHtml(segmentId)}" data-issue-index="${index}">采纳并让 AI 修订</button><button class="button ghost small batch-qa-action" data-action="partial" data-id="${escapeHtml(segmentId)}" data-issue-index="${index}">部分采纳</button>${reject}</div></div>`;
}

function renderBatchDetails(segment) {
  const result = segment.result;
  if (segment.status !== "done" || !result) return "";
  const aiQa = result.aiQa || {};
  const matches = result.matches || [];
  const issues = result.issues || [];
  const references = aiQa.references || [];
  const qaCases = aiQa.qaCases || [];
  const termDecisions = aiQa.termDecisions || [];
  const humanDecisions = aiQa.humanDecisions || [];
  const summary = [
    Number.isFinite(result.qaScore) ? `AIQA ${result.qaScore} 分` : "规则 QA",
    `${matches.length} 条术语`,
    `${references.length} 条译例`,
    `${aiQa.iterations || 0} 次修订`,
    issues.length ? `${issues.length} 条建议` : "无问题"
  ];
  const scopeNote = scopeUsageText(result.scopeUsage);
  if (scopeNote) summary.push(scopeNote);
  const summaryText = summary.join(" · ");
  const termsHtml = matches.length ? matches.map((match) => `<div class="batch-detail-item"><strong>${escapeHtml(match.term?.source)} → ${escapeHtml(match.term?.target)}</strong><small>${match.mode === "exact" ? "正式/别名命中" : `疑似命中：${escapeHtml(match.matchPhrase || "")}`} · ${Math.round((match.score || 0) * 100)}%</small></div>`).join("") : '<div class="batch-detail-empty">本段没有命中术语</div>';
  const issuesHtml = issues.length ? issues.map((issue, index) => batchIssueHtml(issue, index, segment.id)).join("") : `<div class="batch-detail-empty">${aiQa.fallbackReason ? "硬规则通过；AIQA 尚待重试" : "硬规则与 AIQA 均未发现问题"}</div>`;
  const referencesHtml = references.length ? references.map((item) => {
    const type = contentTypeLabel(item.contentType || "general");
    const tags = contentTagLabels(item.contentType || "general", item.contentTags);
    const origin = item.sourceFile
      ? `${item.sourceFile}${item.sourceRow ? ` · 第 ${item.sourceRow} 行` : ""}`
      : ({ "human-accept": "工作台人工采纳", "table-import": "术语表导入", "aiqa-passed": "AIQA 通过", "aiqa-corrected": "AIQA 修订" }[item.provenance] || item.provenance || "历史资产");
    return `<div class="batch-memory-item"><div><strong>${Math.round((item.similarity || 0) * 100)}% · ${escapeHtml(item.qualityStatus === "human_approved" ? "人工批准" : "机器验证")}</strong><small>${escapeHtml([type, ...tags, origin].filter(Boolean).join(" · "))}</small><p>${escapeHtml(item.source)}</p><p class="target">${escapeHtml(item.target)}</p></div></div>`;
  }).join("") : '<div class="batch-detail-empty">没有达到相关度门槛的同类译例</div>';
  const qaCasesHtml = qaCases.length ? `<section><h5>历史 AIQA 反例</h5>${qaCases.map((item) => `<div class="batch-memory-item"><div><p>${escapeHtml(item.rejectedTranslation || "")}</p><p class="target">修订：${escapeHtml(item.correctedTranslation || "")}</p></div></div>`).join("")}</section>` : "";
  const decisionsHtml = termDecisions.length ? `<section><h5>AI 术语裁决</h5>${termDecisions.map((item) => `<div class="batch-detail-item"><strong>${item.decision === "apply" ? "已采用" : "不强制替换"} · ${escapeHtml(item.matchedSource)} → ${escapeHtml(item.officialTarget)}</strong><small>${escapeHtml(item.reason)}</small></div>`).join("")}</section>` : "";
  const humanDecisionsHtml = humanDecisions.length ? `<section><h5>人工 QA 决定</h5>${humanDecisions.map((item) => `<div class="batch-detail-item"><strong>${escapeHtml(item.actionLabel || item.action || item.decision || "已处理")}</strong><small>${escapeHtml(item.issue?.message || item.issue || item.reason || "QA 意见")}</small></div>`).join("")}</section>` : "";
  const receiptHtml = result.reviewReceipt?.textZh ? `<section><h5>处理回执</h5><div class="reflection-box review-receipt">${escapeHtml(result.reviewReceipt.textZh)}</div></section>` : "";
  const fallback = aiQa.fallbackReason ? `<div class="batch-qa-fallback"><strong>AIQA 未完成</strong><span>${escapeHtml(aiQa.fallbackReason)}</span><button type="button" class="button ghost small retry-segment-qa" data-id="${escapeHtml(segment.id)}">仅重跑本段 QA</button></div>` : "";
  return `<details class="batch-segment-details${aiQa.fallbackReason ? " has-warning" : ""}">
    <summary>${escapeHtml(summaryText)}<span>查看术语、译例与 QA 意见</span></summary>
    ${fallback}
    <div class="batch-detail-grid">
      <section><h5>术语命中</h5>${termsHtml}</section>
      <section><h5>QA 意见</h5>${issuesHtml}</section>
      <section><h5>相似译例检索</h5>${referencesHtml}</section>
      ${qaCasesHtml}
      ${decisionsHtml}
      ${humanDecisionsHtml}
      ${receiptHtml}
    </div>
  </details>`;
}

/**
 * 分段属于哪一类 QA 状态：需要复核（分数低 / AIQA 未完成 / 有阻断项）、
 * 建议确认（有 warning 建议）、通过、待翻译、已跳过。
 * 翻译界面的筛选与"跳到下一条待处理"用它，口径与任务中心的待处理计数一致。
 */
function batchSegmentGroup(segment) {
  if (!segment.selected) return "skipped";
  if (segment.status === "error") return "attention";
  if (segment.status !== "done") return "pending";
  const result = segment.result || {};
  const issues = result.issues || [];
  if (result.aiQa?.fallbackReason) return "attention";
  if (Number.isFinite(result.qaScore) && result.qaScore < 90) return "attention";
  if (issues.some((issue) => ["error", "critical"].includes(issue.severity))) return "attention";
  if (segment.accepted) return "pass";
  if (issues.length) return "suggest";
  return "pass";
}

const BATCH_QA_CHIPS = [["", "全部"], ["attention", "需要复核"], ["suggest", "建议确认"], ["pending", "待翻译"], ["pass", "通过"], ["skipped", "已跳过"]];

/** 任务中心「N 条待处理」：打开这条批次并直接跳到第一条待处理分段。 */
async function jumpToTaskQa(batchId, button) {
  const task = findBatchTask(batchId);
  if (!task) return toast("找不到这条批次任务");
  if (button) button.disabled = true;
  try {
    await openTask(batchId);
    if (state.batchPreview?.batchId !== batchId) return;
    state.batchQaCursor = -1;
    jumpToNextBatchIssue();
  } finally {
    if (button) button.disabled = false;
  }
}

/** 跳到下一条待处理分段（需要复核 / 建议确认），在当前筛选结果里循环，滚动并高亮。 */
function jumpToNextBatchIssue() {
  const segments = state.batchPreview?.segments || [];
  const filter = state.batchSegmentFilter || "";
  const pool = segments.filter((segment) => (filter
    ? batchSegmentGroup(segment) === filter
    : ["attention", "suggest"].includes(batchSegmentGroup(segment))));
  if (!pool.length) return toast("没有待处理的分段");
  state.batchQaCursor = (Number(state.batchQaCursor) + 1) % pool.length;
  const target = pool[state.batchQaCursor];
  // 当前筛选可能把它隐藏了：先切到"全部"，保证目标可见。
  if (filter && pool.length === 1) {
    state.batchSegmentFilter = "";
    renderBatchSegments();
  }
  const row = document.querySelector(`.batch-segment[data-segment-id="${CSS.escape(String(target.id))}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("is-highlighted");
  setTimeout(() => row.classList.remove("is-highlighted"), 2_500);
}

/**
 * 跳过说明：XLIFF 里被跳过的句段（锁定 / 已有译文）不参与翻译，但要讲清楚，
 * 否则用户会以为"段数不对/漏翻了"——导出时这些句段会原样保留。
 */
function batchSkipSummary(structure) {
  const xliff = structure?.xliff || {};
  const locked = Number(xliff.skippedLocked) || 0;
  const existing = Number(xliff.skippedExisting) || 0;
  const skipped = locked + existing;
  if (!skipped) return "";
  const reasons = [locked ? `锁定 ${locked}` : "", existing ? `已有译文 ${existing}` : ""].filter(Boolean).join("、");
  return ` · 跳过 ${skipped}（${reasons}）`;
}

/** 分段队列左上角那句"N 字 · M 段 / M 段 · 历史任务"统一带上跳过说明。 */
function batchSourceMetaText({ segments, characters, suffix }) {
  const count = Number(segments) || 0;
  const prefix = characters ? `${characters} 字 · ` : "";
  return `${prefix}${count} 段${batchSkipSummary(state.batchPreview?.structure)}${suffix ? ` · ${suffix}` : ""}`;
}

function renderBatchSegments() {
  const container = $("#batchSegments");
  const segments = state.batchPreview?.segments || [];
  if (!segments.length) {
    container.innerHTML = '<div class="empty-list batch-empty">粘贴文本或拖入文件后，会自动识别正文并生成分句队列。</div>';
    $("#batchProgressText").textContent = "等待解析";
    $("#batchProgressMeta").textContent = "0 / 0";
    $("#batchProgressBar").style.width = "0%";
    $("#batchQaFilter").hidden = true;
    return;
  }
  const selected = segments.filter((segment) => segment.selected);
  const completed = selected.filter((segment) => segment.status === "done").length;
  const failed = selected.filter((segment) => segment.status === "error").length;
  const percent = selected.length ? Math.round((completed / selected.length) * 100) : 0;
  const styleSuffix = state.batchStyleProfile?.name ? ` · ${state.batchStyleProfile.name}` : "";
  $("#batchProgressText").textContent = `${state.batchRunning ? (state.batchPaused ? "将在当前段后暂停" : "批次翻译中") : completed === selected.length ? "批次已完成" : failed ? "部分分段待重试" : "分段已就绪"}${styleSuffix}`;
  $("#batchProgressMeta").textContent = `${completed} / ${selected.length}${failed ? ` · ${failed} 失败` : ""}`;
  $("#batchProgressBar").style.width = `${percent}%`;
  // 筛选 chips + 跳转：几十上百段时不用靠肉眼滚（口径与任务中心"待处理"一致）。
  const counts = { "": segments.length, attention: 0, suggest: 0, pending: 0, pass: 0, skipped: 0 };
  segments.forEach((segment) => { counts[batchSegmentGroup(segment)] += 1; });
  const filter = state.batchSegmentFilter || "";
  $("#batchQaFilter").hidden = false;
  $("#batchQaChips").innerHTML = BATCH_QA_CHIPS
    .filter(([value]) => value === "" || counts[value] > 0)
    .map(([value, label]) => `<button class="qa-filter-chip${filter === value ? " active" : ""}" type="button" data-batch-filter="${value}">${label} ${counts[value]}</button>`)
    .join("");
  const visibleSegments = filter ? segments.filter((segment) => batchSegmentGroup(segment) === filter) : segments;
  container.innerHTML = visibleSegments.map((segment) => {
    const [className, label, meta] = batchStatus(segment);
    const acceptEnabled = segment.status === "done" && segment.translation && !segment.accepted;
    return `<div class="batch-segment ${segment.status === "running" ? "is-running" : ""} ${segment.status === "error" ? "has-error" : ""}" data-segment-id="${segment.id}">
      <div class="batch-segment-index"><input class="batch-segment-check" data-id="${segment.id}" type="checkbox" ${segment.selected ? "checked" : ""} ${state.batchRunning ? "disabled" : ""} aria-label="选择第 ${segment.index} 段" /><span class="row-ref">${segment.index}</span></div>
      <div class="batch-segment-source"><div class="segment-source-text">${escapeHtml(segment.source)}</div>${segment.context?.metadata?.length || segment.context?.referenceTranslations?.length ? `<div class="segment-context">${(segment.context.metadata || []).map((item) => `<span class="${item.role === "constraint" ? "constraint" : ""}" title="${escapeHtml(item.value)}">${escapeHtml(item.label)}：${escapeHtml(item.value)}</span>`).join("")}${(segment.context.referenceTranslations || []).map((item) => `<span class="reference" title="${escapeHtml(item.value)}">参考 · ${escapeHtml(item.label)}：${escapeHtml(item.value)}</span>`).join("")}</div>` : ""}</div>
      <div class="batch-target-cell">${renderBatchTarget(segment)}</div>
      <div class="segment-status ${className}"><strong>${segment.accepted ? "已采纳" : label}</strong><small>${escapeHtml(meta)}</small>${segmentTierChips(segment)}${acceptEnabled ? `<button class="button ghost small accept-segment" data-id="${segment.id}">采纳</button>` : ""}</div>
      ${renderBatchDetails(segment)}
    </div>`;
  }).join("") || '<div class="empty-list batch-empty">当前筛选下没有分段。</div>';
  $("#acceptAllSegments").hidden = !segments.some((segment) => segment.status === "done" && segment.translation && !segment.accepted);
  $$("#batchQaChips .qa-filter-chip").forEach((chip) => chip.addEventListener("click", () => {
    state.batchSegmentFilter = chip.dataset.batchFilter || "";
    state.batchQaCursor = -1;
    renderBatchSegments();
  }));
  $("#batchToAutoQa").hidden = !segments.some((segment) => segment.status === "done" && String(segment.translation || "").trim());
  $$(".batch-segment-check").forEach((checkbox) => checkbox.addEventListener("change", () => {
    const segment = segments.find((item) => item.id === checkbox.dataset.id);
    if (segment) segment.selected = checkbox.checked;
    renderBatchSegments();
    refreshActions();
    saveBatchProgress();
  }));
  $$(".batch-segment-target[contenteditable='true']").forEach((target) => {
    target.addEventListener("input", () => {
      const segment = segments.find((item) => item.id === target.dataset.id);
      if (!segment) return;
      segment.translation = target.innerText.replace(/\n+$/u, "").trim();
      segment.accepted = false;
    });
    target.addEventListener("blur", () => {
      const segment = segments.find((item) => item.id === target.dataset.id);
      if (!segment) return;
      segment.translation = target.innerText.replace(/\n+$/u, "").trim();
      if (segment.translation) {
        segment.status = "done";
        segment.result = segment.result || { issues: [], matches: [] };
        segment.result.translation = segment.translation;
      }
      segment.accepted = false;
      renderBatchSegments();
      refreshActions();
      saveBatchProgress();
    });
  });
  $$(".accept-segment").forEach((button) => button.addEventListener("click", () => acceptSegment(button.dataset.id)));
  $$(".retry-segment-qa").forEach((button) => button.addEventListener("click", () => retrySegmentQa(button.dataset.id)));
  $$(".batch-qa-action").forEach((button) => button.addEventListener("click", () => resolveBatchQaIssue(button.dataset.id, Number(button.dataset.issueIndex), button.dataset.action, button)));
}

async function resolveBatchQaIssue(segmentId, issueIndex, action, button) {
  const segment = state.batchPreview?.segments.find((item) => item.id === segmentId);
  if (!segment?.result?.issues?.[issueIndex]) return;
  const issue = segment.result.issues[issueIndex];
  const review = {};
  if (action === "accept" && !confirm("确认采纳这条 QA 意见，并让翻译模型按意见修订本段？")) return;
  if (action === "partial") {
    const accepted = prompt("填写要采纳的部分（多项可用分号分隔）：", issue.suggestion || issue.message || "");
    if (accepted == null) return;
    const rejected = prompt("填写不采纳的部分及边界（必填）：", "其余表述保持不变");
    if (rejected == null) return;
    const instruction = prompt("给翻译模型的精确修订要求：", accepted);
    if (instruction == null) return;
    review.acceptedParts = accepted.split(/[；;]/).map((item) => item.trim()).filter(Boolean);
    review.rejectedParts = rejected.split(/[；;]/).map((item) => item.trim()).filter(Boolean);
    review.revisionInstruction = instruction.trim();
  }
  if (action === "reject") {
    const reason = prompt("请说明拒绝这条 QA 意见的原因（会写入处理回执）：", "当前译文在本语境中可接受");
    if (reason == null || !reason.trim()) return;
    review.reason = reason.trim();
  }
  button.disabled = true;
  button.textContent = ["accept", "partial", "revise"].includes(action) ? "AI 修订中…" : "记录中…";
  try {
    const resolved = await api("/api/qa/resolve", { method: "POST", body: JSON.stringify(qaResolutionBody({
      source: segment.source, translation: segment.translation, result: segment.result, action, issueIndex,
      contentType: segment.result?.segmentPurpose || state.batchClassification?.contentType || "general", domain: "auto",
      batchId: state.batchPreview.batchId || "batch-review", review
    })) });
    segment.translation = resolved.translation || segment.translation;
    segment.result = { ...segment.result, ...resolved, translation: segment.translation, issues: resolved.issues, qaScore: resolved.qaScore, aiQa: resolved.aiQa, reviewReceipt: resolved.reviewReceipt };
    segment.status = "done";
    segment.accepted = false;
    await saveBatchProgress();
    renderBatchSegments();
    toast(["accept", "partial", "revise"].includes(action) ? `第 ${segment.index} 段已由 AI 修订并重新 QA：${resolved.qaScore} 分` : `第 ${segment.index} 段已记录拒绝意见`);
  } catch (error) {
    button.disabled = false;
    button.textContent = action === "accept" ? "采纳并让 AI 修订" : action === "partial" ? "部分采纳" : "拒绝意见";
    toast(error.message);
  }
}

async function retrySegmentQa(segmentId) {
  const segment = state.batchPreview?.segments.find((item) => item.id === segmentId);
  if (!segment?.translation) return;
  const button = document.querySelector(`.retry-segment-qa[data-id="${CSS.escape(segmentId)}"]`);
  if (button) { button.disabled = true; button.textContent = "AIQA 重试中…"; }
  try {
    const qa = await api("/api/qa", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      source: segment.source,
      translation: segment.translation,
      locale: state.workbenchLocale,
      contentType: segment.result?.segmentPurpose || state.batchClassification?.contentType || "general",
      domain: "auto",
      batchId: state.batchPreview.batchId || "manual-recheck",
      aiQa: true
    }) });
    segment.translation = qa.translation || segment.translation;
    segment.result = {
      ...(segment.result || {}),
      translation: segment.translation,
      matches: qa.matches || segment.result?.matches || [],
      issues: qa.issues || [],
      qaScore: qa.qaScore,
      aiQa: qa.aiQa,
      styleProfile: qa.styleProfile || segment.result?.styleProfile || null
    };
    segment.status = "done";
    segment.accepted = false;
    await saveBatchProgress();
    renderBatchSegments();
    toast(qa.aiQa?.fallbackReason ? `AIQA 仍未完成：${qa.aiQa.fallbackReason}` : `本段 AIQA 已完成：${qa.qaScore} 分`);
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = "仅重跑本段 QA"; }
    toast(`AIQA 重试失败：${error.message}`);
  }
}

async function prepareBatch() {
  const pasted = $("#batchPasteText").value.trim();
  if (!state.batchFile && !pasted) return toast("请先上传文件或粘贴长文");
  setBusy(true, state.batchFile?.name.toLowerCase().endsWith(".xlsx") ? "AI 识别表格结构中…" : "解析与分段中…");
  try {
    state.batchBase64 = state.batchFile ? await fileToBase64(state.batchFile) : "";
    const prepared = await api("/api/batch/prepare", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      filename: state.batchFile?.name || "粘贴长文.txt",
      base64: state.batchBase64 || undefined,
      text: state.batchFile ? undefined : pasted,
      segmentationMode: $("#batchSegmentationMode").value,
      locale: state.workbenchLocale,
      useAiStructure: true,
      columnMapping: state.batchColumnMapping || undefined
    }) });
    prepared.segments.forEach((segment) => Object.assign(segment, { selected: true, status: "pending", translation: "", result: null, error: "", accepted: false }));
    state.batchPreview = prepared;
    state.batchClassification = null;
    state.batchStyleProfile = null;
    state.batchBrief = null;
    state.batchBriefDraft = null;
    state.batchBriefPending = Boolean(prepared.contextBriefPending);
    state.batchReport = null;
    localStorage.setItem("kami-batch-id", prepared.batchId || "");
    await saveBatchProgress();
    $("#batchSourceMeta").textContent = batchSourceMetaText({
      segments: prepared.statistics.segments,
      characters: prepared.statistics.characters
    });
    renderSpreadsheetAnalysis(prepared.spreadsheetAnalysis);
    if (!state.batchFile) {
      $("#batchFilePrompt").textContent = "已载入粘贴长文";
      $("#batchFileMeta").textContent = `${prepared.statistics.characters} 字 · ${prepared.format.toUpperCase()}`;
      $("#batchDropZone").classList.add("has-file");
    } else $("#batchFileMeta").textContent = `${(state.batchFile.size / 1024).toFixed(1)} KB · ${prepared.spreadsheetAnalysis?.usedModel ? "AI 已识别正文与补充信息" : prepared.format === "xlsx" ? "已按规则识别表格" : "已完成分段"}`;
    renderBatchSegments();
    renderBatchBrief();
    renderBatchReport();
    if (prepared.contextBriefPending) loadBatchBrief(prepared.batchId);
    toast(prepared.format === "xlsx" ? `已识别 ${prepared.statistics.segments} 个翻译单元，补充信息不会作为正文翻译` : `已自动拆分为 ${prepared.statistics.segments} 段，可取消不需要翻译的段落`);
  } catch (error) { toast(error.message); }
  finally { setBusy(false); }
}

function structuredContextGroups(segments) {
  const maxEntries = Math.max(2, Number(state.projectSettings?.batch?.groupMaxEntries) || 10);
  const maxChars = Math.max(300, Number(state.projectSettings?.batch?.groupMaxChars) || 1500);
  const groups = [];
  let current = [];
  let chars = 0;
  let boundary = "";
  for (const segment of segments) {
    const length = [...String(segment.source || "")].length;
    const nextBoundary = `${segment.locator?.type || ""}\u0000${segment.locator?.sheet || segment.context?.sheet || ""}`;
    if (current.length && (current.length >= maxEntries || chars + length > maxChars || (boundary && nextBoundary !== boundary))) {
      groups.push(current);
      current = [];
      chars = 0;
      boundary = "";
    }
    current.push(segment);
    chars += length;
    boundary ||= nextBoundary;
  }
  if (current.length) groups.push(current);
  const byId = new Map();
  groups.forEach((group, index) => group.forEach((segment) => byId.set(segment.id, { index, group })));
  return byId;
}

function mergeServerBatchRun(run) {
  if (!state.batchPreview || state.batchPreview.batchId !== run.batchId) return;
  const current = new Map(state.batchPreview.segments.map((segment) => [segment.id, segment]));
  state.batchPreview.subBatches = run.subBatches || [];
  state.batchPreview.runState = run.runState || "ready";
  state.batchPreview.runnerOptions = run.runnerOptions || null;
  state.batchPreview.segments = (run.segments || []).map((segment, index) => ({
    ...(current.get(segment.id) || {}),
    ...segment,
    index: index + 1
  }));
  state.batchClassification = { contentType: run.contentType || "general", source: "server-runner" };
  if (run.contextBrief !== undefined) {
    state.batchBrief = run.contextBrief;
    if (run.contextBrief) state.batchBriefPending = false;
  }
  if (run.qualityReport !== undefined) state.batchReport = run.qualityReport;
  renderBatchSegments();
  renderBatchBrief();
  renderBatchReport();
  refreshActions();
}

async function pollServerBatch(batchId) {
  while (state.batchRunning && state.batchPreview?.batchId === batchId) {
    const run = await api(`/api/batch/run/${encodeURIComponent(batchId)}?projectId=${encodeURIComponent(state.activeProjectId)}`);
    mergeServerBatchRun(run);
    if (["completed", "needs_attention", "paused"].includes(run.runState)) {
      state.batchRunning = false;
      state.batchPaused = false;
      state.batchCancelling = false;
      refreshActions();
      renderBatchSegments();
      await loadBatchBrief(batchId);
      await loadBatchReport(batchId);
      if (run.runState === "completed") toast("后台批次翻译完成，可以导出原格式文件");
      else if (run.runState === "paused" && run.runnerOptions?.cancelled) toast("批次已中断，已完成的段落保留，可随时继续");
      else if (run.runState === "paused") toast("后台批次已暂停，进度已保存");
      else toast("后台批次存在失败，可点击继续 / 重试");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_200));
  }
}

/** 质量档：批次级设置，逐段由服务端判定实际档位。 */
function batchQualityTier() {
  return $("#batchQualityTier")?.value || "auto";
}

/**
 * 质量档只有一个设置，两种模式各在自己版面里显示它：单句在上方的质量档行，
 * 批次在「分段与翻译策略」面板里（上面的行在批次模式下隐藏，避免同一个设置
 * 在两处同时可选、看着像两个开关）。改任意一处都同步到另一处。
 */
function syncQualityTier(value, source) {
  for (const select of [$("#qualityTier"), $("#batchQualityTier")]) {
    if (select && select !== source) select.value = value;
  }
}

function briefPurposeLabel(purpose) {
  return state.bootstrap?.contentTypes?.[purpose]?.label || purpose || "通用";
}

function segmentTierChips(segment) {
  const purpose = segment.result?.segmentPurpose;
  const tier = segment.result?.qualityTier;
  if (!purpose && !tier) return "";
  const tierLabel = { fast: "快速", standard: "标准", strict: "严苛" }[tier] || "";
  const upgraded = segment.result?.qualityUpgradeFrom ? `<span class="segment-chip upgraded" title="由${{ fast: "快速", standard: "标准" }[segment.result.qualityUpgradeFrom] || segment.result.qualityUpgradeFrom}档自动升级">↑${tierLabel}</span>` : (tierLabel ? `<span class="segment-chip">${tierLabel}</span>` : "");
  return `<span class="segment-chips">${purpose ? `<span class="segment-chip purpose" title="${escapeHtml(segment.result?.tierReason || "")}">${escapeHtml(briefPurposeLabel(purpose))}</span>` : ""}${upgraded}</span>`;
}

/**
 * 语境档案：翻译前通读整份文件得到的用途区间。默认只读，编辑态可以改区间用途、
 * 删除某条注意点——因为它是全流程的输入，用户必须能纠正系统的判断。
 */
function renderBatchBrief() {
  const panel = $("#batchBriefPanel");
  if (!panel) return;
  const brief = state.batchBrief;
  const pending = state.batchBriefPending;
  if (!brief && !pending) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const draft = state.batchBriefDraft;
  const summary = $("#batchBriefSummary");
  if (pending) {
    summary.textContent = "正在通读全文做语境分析……完成后每段用途会自动继承，翻译开始前必须完成";
  } else if (brief?.status === "ready") {
    const coverage = brief.coverage || {};
    summary.textContent = `${briefPurposeLabel(brief.documentType?.purpose)} · ${(brief.sections || []).length} 个用途区间 · 覆盖 ${coverage.covered || 0} / ${coverage.total || 0} 条${brief.documentType?.summary ? ` · ${brief.documentType.summary}` : ""}`;
  } else {
    summary.textContent = "语境分析失败：翻译会按通用口径继续，可重新分析或手动补用途";
  }
  const editing = Boolean(draft);
  $("#batchBriefActions").hidden = !editing;
  $("#batchBriefEditToggle").textContent = editing ? "编辑中" : "编辑用途";
  const sections = editing ? draft.sections : (brief?.sections || []);
  $("#batchBriefSections").innerHTML = sections.length
    ? sections.map((section, index) => `<div class="batch-brief-row">
        <span class="batch-brief-range">第 ${section.from}–${section.to} 条</span>
        ${editing
          ? `<select data-brief-section-purpose="${index}">${Object.entries(state.bootstrap?.contentTypes || {}).map(([value, details]) => `<option value="${value}"${value === section.purpose ? " selected" : ""}>${escapeHtml(details.label)}</option>`).join("")}</select><input data-brief-section-note="${index}" value="${escapeHtml(section.note || "")}" placeholder="这段的处理要点（可留空）" />`
          : `<span class="batch-brief-purpose">${escapeHtml(briefPurposeLabel(section.purpose))}</span><span class="batch-brief-note-text">${escapeHtml(section.note || "")}</span>`}
      </div>`).join("")
    : '<div class="empty-list batch-empty">还没有用途区间。</div>';
  const notes = editing ? draft.notes : (brief?.notes || []);
  $("#batchBriefNotes").innerHTML = notes.length
    ? `<div class="batch-brief-note-head">格式与一致性注意点</div>${notes.map((note, index) => `<div class="batch-brief-note"><span>${escapeHtml(note.text)}</span>${editing ? `<button class="button ghost small" type="button" data-brief-note-remove="${index}">删除</button>` : ""}</div>`).join("")}`
    : "";
  const crossRefs = brief?.crossRefs || [];
  if (!editing && crossRefs.length) {
    $("#batchBriefNotes").innerHTML += `<div class="batch-brief-note-head">跨条目必须一致</div>${crossRefs.map((ref) => `<div class="batch-brief-note"><span>${escapeHtml(ref.note)}</span><em>${escapeHtml((ref.ids || []).join("、"))}</em></div>`).join("")}`;
  }
}

async function loadBatchBrief(batchId = state.batchPreview?.batchId) {
  if (!batchId) return;
  try {
    const payload = await api(`/api/batch/run/${encodeURIComponent(batchId)}/context-brief`);
    state.batchBrief = payload.brief || null;
    state.batchBriefPending = Boolean(payload.pending);
  } catch {
    state.batchBrief = null;
    state.batchBriefPending = false;
  }
  renderBatchBrief();
  return state.batchBrief;
}

async function rerunBatchBrief() {
  const batchId = state.batchPreview?.batchId;
  if (!batchId) return;
  state.batchBriefPending = true;
  renderBatchBrief();
  try {
    await api(`/api/batch/run/${encodeURIComponent(batchId)}/context-brief`, { method: "POST", body: JSON.stringify(projectPayload()) });
    toast("已重新开始语境分析，完成后可在任务中心查看");
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const brief = await loadBatchBrief(batchId);
      if (brief) break;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  } catch (error) {
    state.batchBriefPending = false;
    renderBatchBrief();
    toast(`语境分析失败：${error.message}`);
  }
}

/** 等语境分析出结果（最多约 10 分钟）：先触发一次分析，再轮询状态。 */
async function waitForBatchBrief(batchId) {
  state.batchBriefPending = true;
  renderBatchBrief();
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (attempt === 0) {
      try {
        await api(`/api/batch/run/${encodeURIComponent(batchId)}/context-brief`, { method: "POST", body: JSON.stringify(projectPayload()) });
      } catch { /* 已经在跑时服务端会复用同一次任务 */ }
    }
    const brief = await loadBatchBrief(batchId);
    if (brief) {
      state.batchBriefPending = false;
      renderBatchBrief();
      return brief.status === "ready";
    }
    if (!state.batchBriefPending) return false;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  state.batchBriefPending = false;
  renderBatchBrief();
  return false;
}

function toggleBatchBriefEdit() {
  if (state.batchBriefDraft) {
    state.batchBriefDraft = null;
  } else if (state.batchBrief) {
    state.batchBriefDraft = {
      sections: (state.batchBrief.sections || []).map((section) => ({ ...section })),
      notes: (state.batchBrief.notes || []).map((note) => ({ ...note }))
    };
  }
  renderBatchBrief();
}

async function saveBatchBriefEdit() {
  const batchId = state.batchPreview?.batchId;
  if (!batchId || !state.batchBriefDraft) return;
  for (const select of $$("#batchBriefSections select[data-brief-section-purpose]")) {
    const section = state.batchBriefDraft.sections[Number(select.dataset.briefSectionPurpose)];
    if (section) section.purpose = select.value;
  }
  for (const input of $$("#batchBriefSections input[data-brief-section-note]")) {
    const section = state.batchBriefDraft.sections[Number(input.dataset.briefSectionNote)];
    if (section) section.note = input.value.trim();
  }
  try {
    const payload = await api(`/api/batch/run/${encodeURIComponent(batchId)}/context-brief`, {
      method: "PATCH",
      body: JSON.stringify({ ...projectPayload(), sections: state.batchBriefDraft.sections, notes: state.batchBriefDraft.notes })
    });
    state.batchBriefDraft = null;
    await loadBatchBrief(batchId);
    toast(`语境档案已更新：${payload.summary?.sections || 0} 个用途区间`);
  } catch (error) {
    toast(`保存失败：${error.message}`);
  }
}

/** 质量报告与跨条目待核对清单。 */
function renderBatchReport() {
  const panel = $("#batchReportPanel");
  if (!panel) return;
  const payload = state.batchReport;
  if (!payload?.report) {
    panel.hidden = true;
    return;
  }
  const report = payload.report;
  panel.hidden = false;
  $("#batchReportSummary").textContent = `${report.totals?.translated || 0} / ${report.totals?.selected || 0} 段已翻译 · 质检覆盖 ${report.coverage?.percent ?? 0}% · 平均 ${report.scores?.average ?? "—"} 分`;
  const metrics = [
    ["档位分布", `快速 ${report.tiers?.fast || 0} · 标准 ${report.tiers?.standard || 0} · 严苛 ${report.tiers?.strict || 0}${report.upgrades ? ` · 升级 ${report.upgrades}` : ""}`],
    // 未采用不一定是错：术语要结合句义判断（「パス→帕斯」落在「プレミアムパス」里就该让位），
    // 所以这里既报采用率也报未采用条数，供人工判断而不是直接判错。
    ["术语采用率", report.terms?.adoptionRate === null
      ? "无命中"
      : `${report.terms?.adoptionRate ?? 0}%（${report.terms?.applied || 0} / ${report.terms?.expectedUses || 0}）${(report.terms?.expectedUses || 0) - (report.terms?.applied || 0) ? `，${(report.terms?.expectedUses || 0) - (report.terms?.applied || 0)} 条按语境判断未采用` : ""}`],
    ["保护标记", `${report.protectedTokens?.preserved || 0} / ${report.protectedTokens?.total || 0}`],
    ["事实锚点问题", `${report.facts?.issueCount || 0} 处 / ${report.facts?.segments || 0} 段`],
    ["待人工复核", `${report.humanReview?.suggested || 0} 段${(report.humanReview?.reasons || []).length ? `（${report.humanReview.reasons.map((item) => `${item.reason} × ${item.count}`).join("；")}）` : ""}`],
    ["跨条目待核对", `${report.consistency?.findings || 0} 条`]
  ];
  $("#batchReportMetrics").innerHTML = metrics.map(([label, value]) => `<div class="batch-report-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
  const findings = payload.findings || [];
  $("#batchReportFindings").innerHTML = findings.length
    ? `<div class="batch-brief-note-head">待核对清单</div>${findings.map((finding) => `<div class="batch-brief-note"><span><strong>${escapeHtml(FINDING_TYPE_LABELS[finding.type] || finding.type)}</strong> · ${escapeHtml(finding.detail)}${finding.suggestion ? `<em>建议：${escapeHtml(finding.suggestion)}</em>` : ""}</span><em>${escapeHtml((finding.ids || []).join("、"))}</em></div>`).join("")}`
    : '<div class="empty-list batch-empty">没有发现跨条目不一致。</div>';
}

const FINDING_TYPE_LABELS = {
  duplicate_source: "同原文不同译文",
  term_usage_gap: "术语译法未统一",
  term_drift: "术语漂移",
  name_drift: "专名漂移",
  voice_drift: "角色口吻漂移",
  style_conflict: "与风格规范冲突",
  format_risk: "格式风险"
};

async function loadBatchReport(batchId = state.batchPreview?.batchId) {
  if (!batchId) return;
  try {
    state.batchReport = await api(`/api/batch/run/${encodeURIComponent(batchId)}/consistency-check`);
  } catch {
    state.batchReport = null;
  }
  renderBatchReport();
}

async function runConsistencyCheckNow() {
  const batchId = state.batchPreview?.batchId;
  if (!batchId) return;
  toast("已开始跨条目一致性核对，完成后本页自动刷新");
  try {
    await api(`/api/batch/run/${encodeURIComponent(batchId)}/consistency-check`, { method: "POST", body: JSON.stringify(projectPayload()) });
    const before = state.batchReport?.report?.generatedAt || "";
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const payload = await api(`/api/batch/run/${encodeURIComponent(batchId)}/consistency-check`);
      if (payload?.report && payload.report.generatedAt !== before) {
        state.batchReport = payload;
        renderBatchReport();
        toast(`一致性核对完成：${(payload.findings || []).length} 条待核对`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    toast("一致性核对还没完成，可稍后在任务中心查看");
  } catch (error) {
    toast(`一致性核对失败：${error.message}`);
  }
}

async function pauseBatch() {
  if (!state.batchPreview?.batchId || state.batchPaused) return;
  state.batchPaused = true;
  refreshActions();
  await api(`/api/batch/run/${encodeURIComponent(state.batchPreview.batchId)}/pause`, {
    method: "POST",
    body: JSON.stringify(projectPayload())
  });
}

/**
 * 中断批次：当前段跑完就停，已完成的段落全部保留，之后可以「继续 / 重试」接着翻。
 * 与暂停的区别只是"是用户主动中断"，任务中心据此显示已中断。
 */
async function cancelBatchRun() {
  const batchId = state.batchPreview?.batchId;
  if (!batchId || state.batchCancelling) return;
  if (!confirm("中断这个批次？已完成的段落会保留，之后可以继续翻译。")) return;
  state.batchCancelling = true;
  refreshActions();
  try {
    const result = await api(`/api/batch/run/${encodeURIComponent(batchId)}/cancel`, { method: "POST", body: JSON.stringify(projectPayload()) });
    toast(result.cancelling ? "已请求中断：当前段落跑完就停" : "批次已中断，已完成段落保留");
    if (!result.cancelling) {
      state.batchRunning = false;
      state.batchPaused = false;
      state.batchCancelling = false;
      refreshActions();
    }
  } catch (error) {
    state.batchCancelling = false;
    refreshActions();
    toast(error.message);
  }
}

async function runBatch() {
  if (!state.batchPreview?.batchId || state.batchRunning) return;
  const hasPending = state.batchPreview.segments.some((segment) => segment.selected && segment.status !== "done");
  if (!hasPending) return toast("没有待翻译的分段");
  // 语境分析是翻译的前置条件：服务端会返回 409，这里等在原地，避免用"猜出来的用途"翻整批。
  if (state.batchBriefPending || !state.batchBrief || state.batchBrief.status !== "ready") {
    const ready = await waitForBatchBrief(state.batchPreview.batchId);
    if (!ready) return toast("语境分析还没完成，请稍后重试或手动重新分析");
  }
  state.batchRunning = true;
  state.batchPaused = false;
  refreshActions();
  renderBatchSegments();
  try {
    await saveBatchProgress();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await api(`/api/batch/run/${encodeURIComponent(state.batchPreview.batchId)}/start`, {
          method: "POST",
          body: JSON.stringify({ ...projectPayload(), qualityTier: batchQualityTier() })
        });
        break;
      } catch (error) {
        // 服务端发现语境档案还没就绪：等它跑完再自动继续，而不是把 409 甩给用户。
        if (attempt === 0 && /语境分析/.test(error.message)) {
          toast("服务端还在做语境分析，完成后自动开始翻译");
          const ready = await waitForBatchBrief(state.batchPreview.batchId);
          if (!ready) throw error;
          continue;
        }
        throw error;
      }
    }
    toast("批次已交给服务端后台执行，关闭页面也会继续");
    await pollServerBatch(state.batchPreview.batchId);
  } catch (error) {
    state.batchRunning = false;
    state.batchPaused = false;
    refreshActions();
    renderBatchSegments();
    toast(`后台批次启动失败：${error.message}`);
  }
}

async function runBatchInBrowserLegacy() {
  if (!state.batchPreview || state.batchRunning) return;
  const segments = state.batchPreview.segments;
  const queue = segments.filter((segment) => segment.selected && segment.status !== "done");
  if (!queue.length) return toast("没有待翻译的分段");
  state.batchRunning = true;
  state.batchPaused = false;
  refreshActions();
  renderBatchSegments();
  const structuredGroupMode = state.batchPreview.segmentationMode === "group";
  const groupById = structuredGroupMode ? structuredContextGroups(queue) : new Map();
  if (!state.batchClassification) {
    const documentText = segments.filter((segment) => segment.selected).map((segment) => segment.source).join("\n").slice(0, 8_000);
    try {
      state.batchClassification = await api("/api/classify", { method: "POST", body: JSON.stringify({
        text: documentText,
        hint: "auto",
        useModel: true
      }) });
      const contentType = state.batchClassification.contentType;
      state.batchStyleProfile = {
        id: `batch-${contentType}`,
        name: state.bootstrap.contentTypes[contentType].label,
        source: "batch-content-type",
        instruction: state.bootstrap.contentTypes[contentType].register
      };
      renderBatchSegments();
    } catch (error) {
      state.batchRunning = false;
      refreshActions();
      renderBatchSegments();
      return toast(`批次语体识别失败：${error.message}`);
    }
  }
  for (const segment of queue) {
    if (state.batchPaused) break;
    segment.status = "running";
    segment.error = "";
    renderBatchSegments();
    const position = segments.indexOf(segment);
    const groupContext = groupById.get(segment.id);
    const context = {
      ...(segment.context || {}),
      previous: segment.context?.previous || segments[position - 1]?.source || "",
      next: segment.context?.next || segments[position + 1]?.source || "",
      document: state.batchPreview.filename,
      segmentIndex: position + 1,
      segmentCount: segments.length
    };
    try {
      // 本批已定稿译文作为风格锚点：后续各行严格仿照同一句式与用词。
      const anchorCount = Math.max(0, Number(state.projectSettings?.tm?.contextAnchorCount ?? 5));
      const contextKey = `${segment.locator?.type || ""}\u0000${segment.locator?.sheet || segment.context?.sheet || ""}`;
      const batchReferences = segments.slice(0, position)
        .filter((item) => item.translation && `${item.locator?.type || ""}\u0000${item.locator?.sheet || item.context?.sheet || ""}` === contextKey)
        .slice(-anchorCount)
        .map((item) => ({ source: item.source, target: item.translation }));
      const result = await api("/api/translate", { method: "POST", body: JSON.stringify({
        ...projectPayload(),
        source: segment.source,
        locale: state.workbenchLocale,
        contentType: segment.result?.segmentPurpose || state.batchClassification.contentType,
        domain: "auto",
        neighborContext: context,
        styleProfile: state.batchStyleProfile,
        batchId: state.batchPreview.batchId || state.batchPreview.filename,
        segmentId: segment.id,
        entryId: segment.locator?.unitId || segment.locator?.entryId || segment.context?.entryId || "",
        sourceFile: state.batchPreview.filename || "",
        sourceRow: segment.locator?.row || segment.context?.row || null,
        previousSource: context.previous || "",
        nextSource: context.next || "",
        batchReferences,
        batchGroupEntries: groupContext?.group.map((item) => ({ id: item.id, source: item.source, context: item.context })) || [],
        qualityTier: batchQualityTier(),
        useModelClassification: false
      }) });
      if (result.styleProfile?.source === "style-library") state.batchStyleProfile = result.styleProfile;
      segment.translation = result.translation;
      segment.result = result;
      segment.status = "done";
      segment.accepted = false;
    } catch (error) {
      segment.status = "error";
      segment.error = error.message;
    }
    renderBatchSegments();
    saveBatchProgress();
  }
  state.batchRunning = false;
  const paused = state.batchPaused;
  state.batchPaused = false;
  renderBatchSegments();
  refreshActions();
  await saveBatchProgress();
  if (!paused && segments.some((segment) => segment.status === "done")) {
    try {
      const review = await api("/api/evolution/review", { method: "POST", body: JSON.stringify({
        ...projectPayload(),
        locale: state.workbenchLocale,
        contentType: state.batchClassification?.contentType || "general",
        domain: "auto",
        batchId: state.batchPreview.batchId || ""
      }) });
      const parts = [];
      if (review.distilled) parts.push(`已生成风格规范草稿 v${review.distilled.version}`);
      else if (review.distillPending) parts.push(`风格证据 ${styleDistillProgress(review.distillPending)}`);
      if (review.profile) parts.push(`已生成译者画像草稿 v${review.profile.version}`);
      else if (review.profilePending) parts.push(`画像证据 ${review.profilePending.acceptedCount}/${review.profilePending.threshold}`);
      if (review.review?.trend?.length) parts.push(`复盘发现 ${review.review.trend.length} 类问题趋势`);
      toast(parts.length ? `任务后复盘完成：${parts.join("；")}` : "任务后复盘完成，暂无新的风格发现");
    } catch {}
  }
  const failed = segments.filter((segment) => segment.selected && segment.status === "error").length;
  if (paused) toast("批次已暂停，当前进度已保留");
  else if (failed) toast(`批次运行结束，${failed} 段失败，可点击“继续 / 重试”`);
  else toast("批次翻译完成，可以导出原格式文件");
}

function taskStatusLabel(status) {
  return { ready: "待启动", in_progress: "进行中", paused: "已暂停", review: "QA 待处理", needs_attention: "存在失败", completed: "已完成" }[status] || "待处理";
}

function formatTaskTime(value) {
  if (!value) return "时间未知";
  try { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
  catch { return String(value); }
}

async function loadTasks() {
  const query = new URLSearchParams();
  if ($("#taskType")?.value) query.set("type", $("#taskType").value);
  if ($("#taskLocale")?.value) query.set("locale", $("#taskLocale").value);
  if ($("#taskStatus")?.value) query.set("status", $("#taskStatus").value);
  if ($("#taskSearch")?.value.trim()) query.set("search", $("#taskSearch").value.trim());
  if (state.activeProjectId) query.set("projectId", state.activeProjectId);
  state.tasks = await api(`/api/tasks?${query}`);
  renderTasks();
}

function renderTasks() {
  const tasks = state.tasks || [];
  $("#taskCount").textContent = `${tasks.length} 个任务`;
  const completed = tasks.filter((item) => item.status === "completed").length;
  const review = tasks.filter((item) => item.status === "review" || item.status === "needs_attention").length;
  const pending = tasks.filter((item) => item.status === "in_progress").length;
  const unitCount = tasks.reduce((sum, item) => sum + (item.totalSegments || 0), 0);
  $("#taskSummary").innerHTML = `<span>进行中 ${pending}</span><span>待处理 QA ${review}</span><span>已完成 ${completed}</span><span>共 ${tasks.length} 个任务 · ${unitCount} 个翻译单元</span>`;
  $("#taskList").innerHTML = tasks.length ? tasks.map((task) => {
    if (task.type === "autoqa") return renderQaTaskRow(task);
    if (task.type === "background") return renderBackgroundTaskRow(task);
    return renderBatchTaskRow(task);
  }).join("") : '<div class="empty-list task-empty">没有符合当前筛选条件的历史任务</div>';
  $$(".task-row [data-action]").forEach((button) => button.addEventListener("click", () => {
    const id = button.closest(".task-row").dataset.taskId;
    const action = button.dataset.action;
    if (action === "open-task") openTask(id);
    else if (action === "export-task") exportTaskRow(id, button);
    else if (action === "open-qa-task") openQaTask(id);
    else if (action === "delete-qa-task") deleteQaTaskRow(id, button);
    else if (action === "download-export") downloadBackgroundExport(id, button);
    else if (action === "open-import-review") openImportReview(id, button);
    else if (action === "open-batch") openTask(button.dataset.batchId || "");
    else if (action === "continue-import") continueImportTask(id, button);
    else if (action === "pause-task") pauseBatchTask(id, button);
    else if (action === "continue-task") continueBatchTask(id, button);
    else if (action === "import-review") importReviewTask(id, button);
    else if (action === "jump-qa") jumpToTaskQa(id, button);
    else if (action === "delete-task") deleteTaskRow(id, button);
    else if (action === "cancel-task") cancelBatchTask(id, button);
    else if (action === "cancel-background") cancelBackgroundTaskRow(id, button);
    else if (action === "delete-background") deleteBackgroundTaskRow(id, button);
  }));
}

const BACKGROUND_TASK_LABELS = { term_import: "术语导入", asset_import: "双语资产导入", batch_translation: "后台批次翻译", context_analysis: "语境分析", consistency_check: "一致性核对", embedding_rebuild: "Embedding 重建", batch_export: "批次导出" };

/** 导入类任务的中断/失败都能用同一个批次续跑（已写入的重复项会自动跳过）。 */
function resumableImportTask(task) {
  if (!["term_import", "asset_import"].includes(task.taskType)) return false;
  if (!["failed", "needs_attention"].includes(task.status)) return false;
  return Boolean(task.payload?.batchId || task.payload?.resumable);
}

function renderBackgroundTaskRow(task) {
  const locale = state.bootstrap.locales[task.locale];
  const progress = task.progress || {};
  const percent = Number.isFinite(Number(progress.percent)) ? Math.max(0, Math.min(100, Number(progress.percent))) : (task.status === "completed" ? 100 : 0);
  // 中断与服务重启打断都用 progress.phase 区分，状态本身仍是库里允许的取值。
  const stoppedPhase = ["cancelled", "interrupted"].includes(progress.phase);
  const statusLabel = stoppedPhase ? "已中断" : task.status === "in_progress" ? "进行中" : task.status === "review" ? "等待审核" : ["needs_attention", "failed"].includes(task.status) ? "失败" : "已完成";
  const statusClass = task.status === "in_progress" || task.status === "review" ? "warning" : task.status === "needs_attention" ? "error" : "success";
  const message = progress.message || "";
  const download = task.taskType === "batch_export" && task.status === "completed" && task.payload?.downloadUrl;
  const summary = task.payload?.summary;
  const canResumeImport = task.taskType === "term_import" && task.status === "review" && task.payload?.batchId;
  const canContinueImport = resumableImportTask(task);
  // 语境分析与一致性核对都属于某条批次：任务行要能一键跳回批次页看结果。
  const canOpenBatch = ["context_analysis", "consistency_check"].includes(task.taskType) && Boolean(task.payload?.batchId);
  const canCancel = task.status === "in_progress";
  // 导入类任务会把审校稿接回学习轨迹：接回多少条、多少条因歧义/找不到原文没接上，
  // 用户要能在任务行直接看到，不用去翻任务 payload。
  const trajectoryText = summary && summary.trajectoriesLinked != null
    ? ` · 接回轨迹 ${summary.trajectoriesLinked} 条${(Number(summary.trajectoryAmbiguous) || Number(summary.trajectoryUnmatched))
      ? `（歧义 ${summary.trajectoryAmbiguous ?? 0} / 未匹配 ${summary.trajectoryUnmatched ?? 0}）`
      : ""}${Number(summary.trajectoryAlreadyAccepted) ? ` · 此前已采纳跳过 ${Number(summary.trajectoryAlreadyAccepted)} 条` : ""}`
    : "";
  const payloadText = summary
    ? `术语 ${summary.terms ?? 0} · 译例 ${summary.memories ?? 0} · 风格草稿 ${summary.styleProfiles ?? 0} · 跳过 ${summary.skipped ?? 0}${summary.skippedByReason ? `（${Object.entries(summary.skippedByReason).map(([reason, count]) => `${reason} ${count}`).join("；")}）` : ""}${trajectoryText}`
    : task.payload?.error ? `错误：${task.payload.error}` : "";
  return `<article class="task-row" data-task-id="${escapeHtml(task.id)}">
    <div class="task-main"><div class="task-title"><strong>${escapeHtml(task.title)}</strong><span class="task-status ${escapeHtml(statusClass)}">${escapeHtml(statusLabel)}</span><span class="task-type-chip">${escapeHtml(BACKGROUND_TASK_LABELS[task.taskType] || "后台")}</span></div><small title="${escapeHtml(message || payloadText || "")}">${locale ? `${escapeHtml(locale.label)} · ` : ""}${escapeHtml(message || payloadText || contentTypeLabel(task.contentType))} · ${formatTaskTime(task.updatedAt)}</small></div>
    <div class="task-progress"><div><i style="width:${percent}%"></i></div><span>${task.totalSegments ? `${task.completedSegments} / ${task.totalSegments}` : `${percent}%`}</span></div>
    <div class="task-qa"><strong title="${escapeHtml(payloadText || "")}">${payloadText || (canResumeImport ? `${task.payload.candidateCount || 0} 条候选` : "—")}</strong><small>${task.status === "in_progress" ? "后台执行中" : canResumeImport ? "识别完成，等待人工确认" : formatTaskTime(task.updatedAt)}</small></div>
    <div class="task-actions">${canCancel ? '<button class="button ghost small" data-action="cancel-background">中断</button>' : ""}${canOpenBatch ? `<button class="button secondary small" data-action="open-batch" data-batch-id="${escapeHtml(task.payload.batchId)}">查看批次</button>` : ""}${canResumeImport ? `<button class="button secondary small" data-action="open-import-review">继续审核</button>` : ""}${canContinueImport ? `<button class="button secondary small" data-action="continue-import">继续导入</button>` : ""}${download ? `<button class="button secondary small" data-action="download-export">下载 Excel</button>` : ""}<button class="button ghost small" data-action="delete-background">删除</button></div>
  </article>`;
}

/** 删除一条翻译批次：在跑的可以先中断再删（服务端会清理关联任务、原文件存档与导出文件）。 */
async function deleteTaskRow(batchId, button) {
  const task = findBatchTask(batchId);
  if (!task) return toast("找不到这条批次任务");
  const running = ["queued", "running"].includes(task.runState);
  const choice = await confirmTaskDelete({
    title: `删除「${task.filename}」`,
    summary: running
      ? "这条批次正在后台翻译。你想怎么处理？"
      : `删除后这条批次的段落与进度都会消失（已采纳进记忆库的译文不受影响）。共 ${task.totalSegments} 段。`,
    running,
    stopHint: "先中断翻译（当前段跑完就停），再删除批次记录",
    recordHint: running ? "翻译会继续跑完，但任务中心不再显示这条批次" : "删除批次记录"
  });
  if (!choice) return;
  button.disabled = true;
  button.textContent = "删除中…";
  try {
    const result = await api(`/api/tasks/${encodeURIComponent(batchId)}?stop=${choice === "stop" ? "1" : "0"}`, { method: "DELETE", body: JSON.stringify(projectPayload()) });
    if (localStorage.getItem("kami-batch-id") === batchId) {
      localStorage.removeItem("kami-batch-id");
      if (state.batchPreview?.batchId === batchId) resetBatchFileSelection?.();
    }
    toast(result.stopped ? "已停止并删除该批次" : "已删除该批次");
    await loadTasks();
  } catch (error) {
    button.disabled = false;
    button.textContent = "删除";
    toast(error.message);
  }
}

/** 任务中心里的批次操作：暂停 / 继续 / 中断，都走已有的批次接口。 */
function findBatchTask(id) {
  return (state.tasks || []).find((item) => item.type === "batch" && item.batchId === id) || null;
}

async function runBatchTaskAction(button, { busyText, endpoint, body, doneText }) {
  const original = button?.textContent || "";
  if (button) { button.disabled = true; button.textContent = busyText; }
  try {
    const result = await api(endpoint, { method: "POST", body: JSON.stringify(body) });
    toast(doneText(result));
    await loadTasks();
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = original; }
    toast(error.message);
  }
}

async function pauseBatchTask(id, button) {
  const task = findBatchTask(id);
  if (!task) return toast("找不到这条批次任务");
  await runBatchTaskAction(button, {
    busyText: "暂停中…",
    endpoint: `/api/batch/run/${encodeURIComponent(id)}/pause`,
    body: { projectId: task.projectId || state.activeProjectId || "" },
    doneText: () => "已请求暂停：当前段落结束就停，进度已保存"
  });
}

async function continueBatchTask(id, button) {
  const task = findBatchTask(id);
  if (!task) return toast("找不到这条批次任务");
  await runBatchTaskAction(button, {
    busyText: "续跑中…",
    endpoint: `/api/batch/run/${encodeURIComponent(id)}/start`,
    body: {
      projectId: task.projectId || state.activeProjectId || "",
      route: task.runnerOptions?.route || "auto",
      reflect: task.runnerOptions?.reflect !== false
    },
    doneText: (result) => result?.alreadyRunning ? "这个批次已经在后台跑着了" : "已继续：只翻还没完成的段落"
  });
}

async function cancelBatchTask(id, button) {
  const task = findBatchTask(id);
  if (!task) return toast("找不到这条批次任务");
  if (!confirm(`中断「${task.filename}」？已完成的段落会保留，之后可以继续翻译。`)) return;
  await runBatchTaskAction(button, {
    busyText: "中断中…",
    endpoint: `/api/batch/run/${encodeURIComponent(id)}/cancel`,
    body: { projectId: task.projectId || state.activeProjectId || "" },
    doneText: (result) => result?.cancelling ? "已请求中断：当前段落跑完就停" : "批次已中断，已完成段落保留"
  });
}

/**
 * 审校回填：把在 memoQ 里改完的同一批文件导回来。
 * 命中的段落直接覆盖译文并标记人工采纳，同时写入主 TM 并接回学习轨迹；
 * 未匹配和有歧义的条目会在弹窗里逐条列出来，不静默丢弃。
 */
function importReviewTask(batchId, button) {
  const task = findBatchTask(batchId);
  if (!task) return toast("找不到这条批次任务");
  state.reviewImportBatchId = batchId;
  const input = $("#reviewImportFile");
  input.value = "";
  input.click();
  void button;
}

function renderReviewImportDetails(report) {
  const sections = [];
  if (report.details?.unmatched?.length) {
    // 本批解析时跳过的句段（锁定 / 已有译文）不在可回填范围内：把数字写在标题里，
    // 用户才看得懂为什么这些原文"不在批次里"。
    const skipped = report.skippedUnits || {};
    const skipParts = [Number(skipped.locked) ? `锁定 ${Number(skipped.locked)}` : "", Number(skipped.existing) ? `已有译文 ${Number(skipped.existing)}` : ""].filter(Boolean);
    const skipHint = skipParts.length ? `（本批解析时已跳过：${skipParts.join(" / ")}，它们不在可回填范围）` : "";
    sections.push(`<div><strong>未匹配 ${report.unmatched} 条</strong><small>这些原文不在这个批次里，或属于被跳过的段落${escapeHtml(skipHint)}</small>${report.details.unmatched.map((item) => `<p>${escapeHtml(String(item.source).slice(0, 60))} <em>${escapeHtml(item.reason)}</em></p>`).join("")}</div>`);
  }
  if (report.details?.ambiguous?.length) {
    sections.push(`<div><strong>有歧义 ${report.ambiguous} 条</strong><small>同一条原文在批次里出现多次，缺少条目 ID 时不敢乱认（没有写入）</small>${report.details.ambiguous.map((item) => `<p>${escapeHtml(String(item.source).slice(0, 60))} <em>${escapeHtml(item.reason)}</em></p>`).join("")}</div>`);
  }
  if (report.failures?.length) {
    sections.push(`<div><strong>失败 ${report.failures.length} 条</strong>${report.failures.map((item) => `<p>${escapeHtml(String(item.source).slice(0, 60))} <em>${escapeHtml(item.reason)}</em></p>`).join("")}</div>`);
  }
  return sections.length ? sections.join("") : '<div class="manual-guide-empty"><strong>全部条目都按条目 ID 精确匹配</strong><p>没有未匹配或歧义条目。</p></div>';
}

async function submitReviewImport(file) {
  const batchId = state.reviewImportBatchId;
  if (!file || !batchId) return;
  const dialog = $("#reviewImportDialog");
  $("#reviewImportSummary").textContent = `正在回填「${file.name}」……`;
  $("#reviewImportDetails").innerHTML = "";
  if (!dialog.open) dialog.showModal();
  try {
    const report = await api(`/api/batch/run/${encodeURIComponent(batchId)}/import-review`, { method: "POST", body: JSON.stringify({
      ...projectPayload(), filename: file.name, base64: await fileToBase64(file)
    }) });
    // 已采纳过的轨迹不算"新接回"：把这三个数字分开写，否则"接回 0 条"看起来像失败。
    const linkedParts = [`接回学习轨迹 ${report.trajectoriesLinked} 条`];
    if (Number(report.trajectoriesUpdated)) linkedParts.push(`更新已采纳轨迹 ${Number(report.trajectoriesUpdated)} 条`);
    const acceptedSkipped = Number(report.trajectoryAcceptedUnchanged) || Number(report.trajectoryAlreadyAccepted);
    if (acceptedSkipped) linkedParts.push(`此前已采纳、内容相同跳过 ${acceptedSkipped} 条`);
    $("#reviewImportSummary").textContent = `已回填 ${report.matched} / ${report.total} 条（其中 ${report.changed} 条译文有改动）· 写入主 TM ${report.memoriesWritten} 条 · ${linkedParts.join(" · ")}`;
    $("#reviewImportDetails").innerHTML = renderReviewImportDetails(report);
    toast(`审校回填完成：匹配 ${report.matched} 条，写入主 TM ${report.memoriesWritten} 条`);
    await loadTasks();
  } catch (error) {
    $("#reviewImportSummary").textContent = `回填失败：${error.message}`;
    toast(error.message);
  }
}

/** 导入类任务（术语 / 双语资产 / TM）的中断：跑批循环在下一处分块边界停下。 */
async function cancelBackgroundTaskRow(id, button) {
  const original = button?.textContent || "中断";
  if (button) { button.disabled = true; button.textContent = "中断中…"; }
  try {
    const result = await api(`/api/background-tasks/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify(projectPayload()) });
    toast(result.cancelling ? "已请求中断：正在跑的循环会在下一处分块停下" : result.stopped ? "任务已标记中断" : "任务已经不在运行");
    await loadTasks();
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = original; }
    toast(error.message);
  }
}

/**
 * 任务中心的「继续导入」：复用同一个批次续跑。已写入的条目会被当作重复跳过，
 * 所以中断或服务重启之后都能补齐剩余候选。
 */
async function continueImportTask(id, button) {
  const task = (state.tasks || []).find((item) => item.id === id);
  const batchId = task?.payload?.batchId;
  if (!batchId) return toast("这条任务没有可续传的批次，需重新上传文件");
  const original = button?.textContent || "继续导入";
  if (button) { button.disabled = true; button.textContent = "续传中…"; }
  try {
    const result = await api("/api/assets-import/resume", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      batchId,
      purpose: task.payload?.purpose || "term",
      aiCleaning: task.payload?.aiCleaning === true,
      styleEvidence: task.payload?.styleEvidence === true
    }) });
    toast(`已续传 ${result.accepted || 0} 条候选，进度见任务中心`);
    await loadTasks();
    watchAssetImportTask(result.taskId, { returnView: "" }).catch(() => {});
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = original; }
    toast(error.message);
  }
}

async function openImportReview(id, button) {
  const task = (state.tasks || []).find((item) => item.id === id);
  const batchId = task?.payload?.batchId;
  if (!batchId) return toast("这条旧任务没有关联审核批次，无法恢复");
  const original = button?.textContent || "继续审核";
  if (button) { button.disabled = true; button.textContent = "恢复中…"; }
  try {
    const result = await api(`/api/term-import/review/${encodeURIComponent(batchId)}`);
    result.candidates.forEach((candidate) => { candidate.selected = candidate.decision === "ready" && !candidate.existing; });
    state.importFile = null;
    state.importPreview = { ...result, backgroundTaskId: id };
    state.importCompleted = result.status === "completed";
    state.importCandidateTab = "terms";
    state.importVisibleCount = { terms: 150, styles: 150 };
    state.importBatchLearning = [];
    $("#termFile").value = "";
    $("#filePrompt").textContent = result.filename || task.title;
    $("#fileMeta").textContent = `${result.candidates.length} 条候选 · 已从审核队列恢复`;
    $("#dropZone").classList.add("has-file");
    updateImportProgress({ phase: "pending-commit", message: "识别完成，等待确认入库", percent: 100, completed: 1, total: 1 });
    $("#mappingNote").textContent = `已恢复昨晚保存的审核批次，共 ${result.candidates.length} 条候选；尚未写入正式术语库。页面按每批 150 条显示，避免大批量数据再次卡住。`;
    $("#importBatchLearningPanel").hidden = true;
    $("#importBatchLearningList").innerHTML = '<div class="empty-list">提交译例后显示本批风格学习结果</div>';
    switchView("import");
    renderImportCandidates();
    toast(`已恢复 ${result.candidates.length} 条候选，请继续审核`);
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = original; }
    toast(error.message);
  }
}

function downloadBackgroundExport(id, button) {
  window.location.href = `/api/export-tasks/${encodeURIComponent(id)}/download`;
}

/**
 * 删除任务：进行中的任务要先问清楚是"停止并删除"还是"只删记录"，
 * 否则删了列表项后台还在跑，用户以为任务已经没了。
 */
async function confirmTaskDelete({ title, summary, running, stopHint, recordHint }) {
  const options = [];
  if (running) options.push({ id: "stop", label: "停止并删除", hint: stopHint || "先中断任务，等它真正停下再删除记录" });
  options.push({ id: "record", label: running ? "仅删除记录" : "删除", hint: recordHint || (running ? "后台会继续跑完，但列表里不再显示" : "删除这条记录，已完成的结果一并清掉") });
  return openChoiceDialog({ kicker: "DELETE TASK", title, summary, options });
}

async function deleteBackgroundTaskRow(id, button) {
  const task = (state.tasks || []).find((item) => item.id === id);
  const running = task?.status === "in_progress";
  const choice = await confirmTaskDelete({
    title: `删除「${task?.title || "后台任务"}」`,
    summary: running
      ? "这条任务还在后台运行。你想怎么处理？"
      : "确认删除这条任务记录？（导入类任务已写入的数据不会被删除）",
    running: Boolean(running),
    stopHint: "先请求中断（跑批循环在下一处分块停下），再删除记录",
    recordHint: running ? "后台会继续跑完，但列表里不再显示" : "只删记录"
  });
  if (!choice) return;
  if (choice === "stop") {
    await api(`/api/background-tasks/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify(projectPayload()) }).catch(() => {});
    // 给跑批循环一点时间在分块边界停下，避免刚删完又被进度写回来。
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  button.disabled = true;
  button.textContent = "删除中…";
  try {
    await api(`/api/background-tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadTasks();
    toast("已删除后台任务");
  } catch (error) {
    button.disabled = false;
    button.textContent = "删除";
    toast(error.message);
  }
}

function renderReferenceLibraries() {
  const select = $("#referenceLibrary");
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">全部资料库</option>' + (state.referenceLibraries || [])
    .filter((library) => library.kind === "reference")
    .map((library) => `<option value="${escapeHtml(library.id)}">${escapeHtml(library.name)}${library.enabled === false ? "（已停用）" : ""}</option>`)
    .join("");
  select.value = current || select.value;
}

async function loadReferences() {
  const projectId = state.activeProjectId || "";
  const query = new URLSearchParams({
    projectId,
    libraryId: state.referenceLibraryId || "",
    status: state.referenceStatus || "",
    search: state.referenceSearch || "",
    limit: "100"
  });
  const payload = await api(`/api/references?${query}`);
  state.referenceDocuments = payload.items || [];
  state.referenceLibraries = payload.libraries || [];
  $("#referenceCount").textContent = `已显示 ${state.referenceDocuments.length} / 共 ${payload.total || 0} 条`;
  renderReferenceLibraries();
  renderReferenceList();
}

function renderReferenceList() {
  const container = $("#referenceList");
  const items = state.referenceDocuments || [];
  if (!items.length) {
    container.innerHTML = '<div class="empty-list">当前项目还没有参考资料。上传角色设定、剧本或故事梗概后，模型才能在翻译时按需查询。</div>';
    return;
  }
  container.innerHTML = items.map((item) => {
    const statusLabel = { indexing: "索引中", ready: "可用", failed: "失败", disabled: "已停用" }[item.status] || item.status;
    const scope = [item.contentType ? `语体 ${escapeHtml(contentTypeLabel(item.contentType))}` : "", item.domain ? `领域 ${escapeHtml(item.domain)}` : ""].filter(Boolean).join(" · ") || "全项目通用";
    return `<article class="reference-row" data-reference-id="${escapeHtml(item.id)}">
      <div class="reference-main"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.sourceFile || "")} ${item.sourceFormat ? `· ${escapeHtml(item.sourceFormat)}` : ""} · ${scope}</small>
        ${item.error ? `<small class="reference-error">${escapeHtml(item.error)}</small>` : ""}</div>
      <div class="reference-metrics"><span class="badge ${item.status === "ready" ? "success" : item.status === "failed" ? "error" : "warning"}">${escapeHtml(statusLabel)}</span><small>${item.characters} 字 · ${item.chunkCount} 片段</small></div>
      <div class="task-actions">
        <button class="button secondary small" data-reference-action="detail" data-id="${escapeHtml(item.id)}">查看片段</button>
        <button class="button ghost small" data-reference-action="reindex" data-id="${escapeHtml(item.id)}">重新索引</button>
        <button class="button ghost small" data-reference-action="toggle" data-id="${escapeHtml(item.id)}" data-status="${item.status === "disabled" ? "ready" : "disabled"}">${item.status === "disabled" ? "启用" : "停用"}</button>
        <button class="button ghost small" data-reference-action="delete" data-id="${escapeHtml(item.id)}">删除</button>
      </div>
    </article>`;
  }).join("");
}

async function referenceFileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function uploadReferenceFiles(files) {
  const projectId = state.activeProjectId || "";
  if (!projectId) return toast("请先选择项目");
  const list = [...files];
  if (!list.length) return;
  $("#referenceUploadNote").textContent = `正在上传 ${list.length} 个文件……`;
  let accepted = 0;
  for (const file of list) {
    try {
      const base64 = await referenceFileToBase64(file);
      await api("/api/references", {
        method: "POST",
        body: JSON.stringify({ projectId, filename: file.name, name: file.name.replace(/\.[^.]+$/u, ""), base64 })
      });
      accepted += 1;
    } catch (error) {
      toast(`${file.name}：${error.message}`);
    }
  }
  $("#referenceUploadNote").textContent = accepted
    ? `已提交 ${accepted} 个文件，正在后台解析与向量化；完成后本页会自动刷新。`
    : "没有文件被接受，请检查格式与大小（单个不超过 20MB）。";
  await loadReferences();
  window.setTimeout(() => loadReferences().catch(() => {}), 4000);
}

async function openReferenceDetail(id) {
  const payload = await api(`/api/references/${encodeURIComponent(id)}/chunks?limit=50`);
  state.referenceDetail = payload;
  const panel = $("#referenceDetailPanel");
  panel.hidden = false;
  $("#referenceDetailTitle").textContent = payload.document?.name || "资料详情";
  const report = payload.document?.ingestReport || {};
  $("#referenceDetailMeta").textContent = [
    `${payload.document?.sourceFile || ""}${payload.document?.sourceFormat ? `（${payload.document.sourceFormat}）` : ""}`,
    `共 ${payload.total} 个片段`,
    report.visionPages ? `其中 ${report.visionPages} 页由模型识图` : "",
    report.riskChunks ? `${report.riskChunks} 个片段被判定含注入特征，默认不参与检索` : ""
  ].filter(Boolean).join(" · ");
  $("#referenceDetailActions").innerHTML = `<button class="button ghost small" data-reference-action="reindex" data-id="${escapeHtml(id)}">重新索引</button>`;
  $("#referenceChunks").innerHTML = (payload.items || []).map((chunk) => `<article class="reference-chunk ${chunk.risk ? "risk" : ""}">
    <div class="reference-chunk-head"><strong>${escapeHtml(chunk.heading || `片段 ${chunk.ordinal + 1}`)}</strong>
      <small>${chunk.page ? `位置 ${escapeHtml(chunk.page)} · ` : ""}${chunk.origin === "vision" ? "模型识图" : "原文抽取"} · ${chunk.characters} 字${chunk.id ? ` · ${escapeHtml(chunk.id)}` : ""}</small>
      ${chunk.risk ? `<span class="badge warning">疑似注入${chunk.allowed ? "（已放行）" : ""}</span><button class="button ghost small" data-reference-action="allow" data-id="${escapeHtml(chunk.id)}" data-allowed="${chunk.allowed ? "false" : "true"}">${chunk.allowed ? "取消放行" : "放行"}</button>` : ""}</div>
    <p>${escapeHtml(chunk.text)}</p>
  </article>`).join("") || '<div class="empty-list">这份资料还没有片段。</div>';
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function referenceAction(action, id, button) {
  try {
    if (action === "detail") return await openReferenceDetail(id);
    if (action === "reindex") {
      button.disabled = true;
      button.textContent = "重建中…";
      await api(`/api/references/${encodeURIComponent(id)}/reindex`, { method: "POST" });
      toast("已重新生成向量索引");
    } else if (action === "toggle") {
      await api(`/api/references/${encodeURIComponent(id)}/status`, { method: "POST", body: JSON.stringify({ status: button.dataset.status }) });
      toast(button.dataset.status === "disabled" ? "已停用，不再参与检索" : "已启用");
    } else if (action === "allow") {
      await api(`/api/reference-chunks/${encodeURIComponent(id)}/allow`, { method: "POST", body: JSON.stringify({ allowed: button.dataset.allowed === "true" }) });
      toast(button.dataset.allowed === "true" ? "已放行该片段" : "已取消放行");
    } else if (action === "delete") {
      if (!confirm("确认删除这份参考资料？它的全部片段会一并删除，模型将再也查不到。")) return;
      await api(`/api/references/${encodeURIComponent(id)}`, { method: "DELETE" });
      toast("已删除参考资料");
      $("#referenceDetailPanel").hidden = true;
    }
    await loadReferences();
  } catch (error) {
    toast(error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

function renderBatchTaskRow(task) {
  const locale = state.bootstrap.locales[task.locale];
  const progress = task.totalSegments ? Math.round(task.completedSegments / task.totalSegments * 100) : 0;
  // 中断过的批次：run_state 只能是库里允许的取值，所以中断用 runnerOptions.cancelled 标记，
  // 这里据此显示"已中断"并给出「继续翻译」。
  const cancelled = task.runnerOptions?.cancelled === true;
  const runningState = ["queued", "running"].includes(task.runState);
  const hasPending = Number(task.completedSegments) < Number(task.totalSegments);
  const canResume = hasPending && !runningState;
  const canImportReview = Number(task.completedSegments) > 0;
  return `<article class="task-row" data-task-id="${escapeHtml(task.batchId)}">
    <div class="task-main"><div class="task-title"><strong>${escapeHtml(task.filename)}</strong><span class="task-status ${escapeHtml(task.status)}">${cancelled ? "已中断" : taskStatusLabel(task.status)}</span><span class="task-type-chip">批次</span></div><small>${escapeHtml(locale?.label || task.locale)} · ${escapeHtml(contentTypeLabel(task.contentType))} · ${escapeHtml(task.domain)} · ${formatTaskTime(task.updatedAt)}</small></div>
    <div class="task-progress"><div><i style="width:${progress}%"></i></div><span>${task.completedSegments} / ${task.totalSegments}</span></div>
    <div class="task-qa">${task.qaPending
      ? `<button class="qa-jump" type="button" data-action="jump-qa" title="打开这条批次并跳到第一条待处理"><strong>${task.qaPending} 条待处理</strong><small>点击定位 →</small></button>`
      : "<strong>QA 已清</strong>"}${task.failedSegments ? `<small>${task.failedSegments} 段失败</small>` : `<small>${task.format || "text"}</small>`}</div>
    <div class="task-actions">${runningState ? '<button class="button secondary small" data-action="pause-task">暂停</button>' : ""}${canResume ? '<button class="button secondary small" data-action="continue-task">继续翻译</button>' : ""}${runningState ? '<button class="button ghost small" data-action="cancel-task">中断</button>' : ""}${canImportReview ? '<button class="button ghost small" data-action="import-review">导入审校结果</button>' : ""}<button class="button ghost small" data-action="open-task">打开任务</button><button class="button secondary small" data-action="export-task">导出</button><button class="button ghost small" data-action="delete-task">删除</button></div>
  </article>`;
}

function renderQaTaskRow(task) {
  const locale = state.bootstrap.locales[task.locale];
  const scoreTone = task.overallScore == null ? "neutral" : task.overallScore >= 90 ? "success" : task.overallScore >= 70 ? "warning" : "error";
  return `<article class="task-row" data-task-id="${escapeHtml(task.id)}">
    <div class="task-main"><div class="task-title"><strong>${escapeHtml(task.title)}</strong><span class="badge ${scoreTone}">${task.overallScore == null ? "未评分" : `${task.overallScore} 分`}</span><span class="task-type-chip">Auto QA</span></div><small>${escapeHtml(locale?.label || task.locale)} · ${escapeHtml(contentTypeLabel(task.contentType))} · ${escapeHtml(task.domain)} · ${formatTaskTime(task.updatedAt)}</small></div>
    <div class="task-progress"><div><i style="width:100%"></i></div><span>${task.totalSegments} 句原文</span></div>
    <div class="task-qa"><strong>${task.qaPending ? `${task.qaPending} 个问题` : "未发现问题"}</strong><small>${escapeHtml(task.status === "review" ? "需要复核" : "已通过")}</small></div>
    <div class="task-actions"><button class="button secondary small" data-action="open-qa-task">查看报告</button><button class="button ghost small" data-action="delete-qa-task">删除</button></div>
  </article>`;
}

/** 与 server 的 issueFingerprint 保持一致：字段顺序、空白折叠、截断长度都不能变。 */
async function autoQaIssueFingerprint(issue, segmentIndex) {
  const clean = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();
  const parts = [
    segmentIndex == null ? "" : String(segmentIndex),
    clean(issue.dimension),
    clean(issue.severity),
    clean(issue.category || issue.type),
    clean(issue.message),
    clean(issue.sourceSpan),
    clean(issue.targetSpan || issue.span)
  ];
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\u0000")));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

async function deleteAutoQaIssue(button) {
  if (!state.autoQaTaskId) return toast("请先打开一条已保存的质检报告");
  if (!confirm("删除这条 AI 意见？评分会按剩余意见重算，删除记录会留档。")) return;
  const payload = JSON.parse(decodeURIComponent(button.dataset.qaIssueDelete));
  button.disabled = true;
  try {
    const fingerprint = await autoQaIssueFingerprint(payload.issue, payload.segmentIndex);
    const result = await api(`/api/qa-tasks/${encodeURIComponent(state.autoQaTaskId)}/issues/delete`, {
      method: "POST",
      body: JSON.stringify({ fingerprint })
    });
    toast(`已删除该意见，综合分重算为 ${result.scores?.overall ?? "—"}`);
    await openQaTask(state.autoQaTaskId);
  } catch (error) {
    button.disabled = false;
    toast(error.message);
  }
}

async function openQaTask(id) {
  try {
    const payload = await api(`/api/qa-tasks/${encodeURIComponent(id)}`);
    const { task, report } = payload;
      state.autoQaTaskId = id;
    // 新版质检（文件/批次来源）的报告是新结构：直接回放到统一段列表，不重新调模型。
    if (report?.sourceKind) {
      switchView("autoqa");
      applyQaResult(report);
      toast("已回放这次质检报告（未重新调用模型）");
      return;
    }
    $("#autoQaSource").value = task.sourceText || "";
    $("#autoQaTarget").value = task.translationText || "";
    $("#autoQaSourceCount").textContent = `${[...(task.sourceText || "")].length} 字`;
    state.autoQaLocale = task.locale;
    const strip = $("#autoQaLocales");
    if (strip) renderLocaleStrip(strip, state.autoQaLocale, updateAutoQaLocale);
    $("#autoQaTargetKicker").textContent = `TARGET · ${task.locale.toUpperCase()}`;
    $("#autoQaTargetTitle").textContent = `${state.bootstrap.locales[task.locale]?.label || task.locale}译文`;
    switchView("autoqa");
    renderAutoQaReport(report);
    toast("已回放质检报告（未重新调用模型）");
  } catch (error) { toast(error.message); }
}

async function deleteQaTaskRow(id, button) {
  if (!confirm("确认删除这条质检任务？删除后无法恢复。")) return;
  button.disabled = true;
  button.textContent = "删除中…";
  try {
    await api(`/api/qa-tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadTasks();
    toast("已删除质检任务");
  } catch (error) {
    button.disabled = false;
    button.textContent = "删除";
    toast(error.message);
  }
}

/**
 * 任务中心导出：和翻译界面的导出是同一个选择——写回原文件 / 仅译文 / 任务 Excel。
 * 写回原文件靠"导入时随批次存档的原文件"，所以这里也不用再让用户选文件。
 */
async function exportTaskRow(batchId, button) {
  button.disabled = true;
  button.textContent = "读取中…";
  try {
    const run = await api(`/api/batch/run/${encodeURIComponent(batchId)}?projectId=${encodeURIComponent(state.activeProjectId || "")}`);
    const hasOriginal = Boolean(run.runnerOptions?.originalFile);
    const choice = await openChoiceDialog({ kicker: "EXPORT OPTIONS",
      title: "导出方式",
      summary: `${run.filename} · ${run.format?.toUpperCase?.() || ""}${hasOriginal ? " · 原文件已随批次存档" : " · 没有原文件存档"}${batchWriteBackLabelFor(run)}`,
      options: [
        ...(hasOriginal
          ? [{ id: "in-place", label: "写回原文件", hint: "译文写回原文件里它该在的位置（MQXLIFF 写 target、表格写译文列）" }]
          : [{ id: "pick-source", label: "选择原文件并写回", hint: "这个批次没有原文件存档（改动前导入的）；选中同一个原文件后译文写回原位，并自动存档，下次不用再选" }]),
        { id: "translation-only", label: "仅导出译文", hint: "只给译文（每段一行），不带原文与排版" },
        { id: "task-xlsx", label: "任务 Excel（后台生成）", hint: "序号 / 原文 / 译文 / 状态 / AIQA 分数 / QA 意见 / 人工决定；生成后在这里下载" }
      ]
    });
    button.disabled = false;
    button.textContent = "导出";
    if (!choice) return;
    if (choice === "task-xlsx") {
      const payload = await api(`/api/tasks/${encodeURIComponent(batchId)}/export`, { method: "POST", body: JSON.stringify(projectPayload()) });
      toast(payload.message || "导出已进入任务中心后台处理");
      setTimeout(() => loadTasks().catch(() => {}), 600);
      return;
    }
    // 老批次没存档时让用户选一次原文件，之后服务端会把它存档起来（下次自动）。
    if (choice === "pick-source" && !(await pickBatchSourceFile())) {
      button.textContent = "导出";
      return;
    }
    button.disabled = true;
    button.textContent = choice === "in-place" ? "写回中…" : "生成中…";
    // 与翻译界面同一道门禁：有阻断项先列出来，让用户决定是否强行导出。
    const gateSegments = (run.segments || []).map(({ id, source, selected, translation }) => ({ id, source, selected, translation }));
    const gate = await api("/api/batch/export/preflight", { method: "POST", signal: AbortSignal.timeout(EXPORT_PREFLIGHT_TIMEOUT_MS), body: JSON.stringify({
      ...projectPayload(), locale: run.locale, contentType: run.contentType || "general", domain: run.domain || "general", segments: gateSegments
    }) }).catch(() => null);
    if (gate && !gate.ok) {
      const proceed = await openExportDialog({
        title: `导出被 QA 门禁挡住（${gate.blocking.length} 项）`,
        summary: "这些是规则层的硬问题（占位符、术语、数字、未翻译等）。修好再导出最稳，也可以强制导出。",
        items: gate.blocking.slice(0, 20),
        forceLabel: "仍然导出（跳过门禁）"
      });
      if (!proceed) { button.disabled = false; button.textContent = "导出"; return; }
    } else if (gate?.warnings?.length) {
      const proceed = await openExportDialog({
        title: `导出前有 ${gate.warnings.length} 条提醒`,
        summary: "只是提醒，不影响导出。可以看一眼再决定。",
        items: gate.warnings.slice(0, 20),
        forceLabel: "继续导出"
      });
      if (!proceed) { button.disabled = false; button.textContent = "导出"; return; }
    }
    const exported = await api("/api/batch/export", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      batchId,
      filename: run.filename,
      locale: run.locale,
      format: run.format,
      mode: choice,
      base64: state.batchBase64 || undefined,
      structure: run.structure,
      segments: run.segments
    }) });
    const saved = await saveExportedFile(exported);
    // 与翻译界面同一套反馈：弹窗写清文件名、方式与保存位置。
    await openExportDialog({
      title: "导出完成",
      summary: `${exported.filename}（${choice === "in-place" ? "写回原文件" : "仅译文"}）。${saved.message || ""}`,
      items: []
    });
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "导出";
  }
}

/** 任务中心那条批次记录的写回列提示（结构里存着列角色）。 */
function batchWriteBackLabelFor(run) {
  const sheets = run?.structure?.spreadsheetAnalysis?.sheets || run?.spreadsheetAnalysis?.sheets || [];
  for (const sheet of sheets) {
    const output = (sheet.columns || []).find((column) => column.role === "translation_output");
    if (output) return ` · 写回列：${output.label || `${output.letter} 列`}`;
  }
  return "";
}

function applyStoredBatchRun(run) {
  state.batchBase64 = "";
  state.batchFile = null;
  // 导入时上传的原文件由服务端随批次存档；有它就不需要用户再选一次。
  state.batchHasStoredOriginal = Boolean(run.runnerOptions?.originalFile);
  state.batchPreview = {
    batchId: run.batchId, filename: run.filename, format: run.format,
    segmentationMode: run.segmentationMode, structure: run.structure, subBatches: run.subBatches || [], runState: run.runState || "ready",
    runnerOptions: run.runnerOptions || null,
    segments: run.segments.map((segment, index) => ({
      id: segment.id, index: index + 1, source: segment.source, translation: segment.translation || "",
      status: segment.status || "pending", selected: segment.selected !== false, accepted: Boolean(segment.accepted),
      locator: segment.locator || undefined, context: segment.context || undefined, result: segment.result || null, error: segment.error || ""
    }))
  };
  state.batchClassification = { contentType: run.contentType || "general", source: "restored" };
  state.batchStyleProfile = null;
  state.batchBrief = run.contextBrief || null;
  state.batchBriefDraft = null;
  state.batchBriefPending = false;
  state.batchReport = run.qualityReport || null;
  updateBatchSegmentationOptions(run.filename || "");
  state.workbenchLocale = run.locale || state.workbenchLocale;
  localStorage.setItem("kami-batch-id", run.batchId);
  renderLocaleStrip($("#workbenchLocales"), state.workbenchLocale, updateWorkbenchLocale);
  $("#batchSourceMeta").textContent = batchSourceMetaText({ segments: run.segments.length, suffix: "历史任务" });
  $("#batchFilePrompt").textContent = run.filename || "已恢复历史任务";
  $("#batchFileMeta").textContent = "任务内容已从后台恢复，可继续 QA、编辑或导出 Excel";
  $("#batchDropZone").classList.add("has-file");
  switchView("workbench");
  setTranslationMode("batch");
  // 打开历史任务时清掉上一次的 QA 筛选，免得看起来"段落少了"。
  state.batchSegmentFilter = "";
  state.batchQaCursor = -1;
  renderBatchSegments();
  renderBatchBrief();
  renderBatchReport();
  refreshActions();
}

async function openTask(batchId) {
  try {
    const run = await api(`/api/batch/run/${encodeURIComponent(batchId)}?projectId=${encodeURIComponent(state.activeProjectId)}`);
    applyStoredBatchRun(run);
    toast(`已打开任务：${run.filename}`);
    if (["queued", "running"].includes(run.runState)) {
      state.batchRunning = true;
      refreshActions();
      pollServerBatch(run.batchId).catch((error) => toast(error.message));
    }
  } catch (error) { toast(error.message); }
}

function invalidateBatchTranslations(message) {
  if (!state.batchPreview || state.batchRunning) return;
  const hadTranslations = state.batchPreview.segments.some((segment) => segment.status === "done");
  state.batchPreview.segments.forEach((segment) => {
    segment.translation = "";
    segment.result = null;
    segment.error = "";
    segment.status = "pending";
  });
  state.batchClassification = null;
  state.batchStyleProfile = null;
  renderBatchSegments();
  refreshActions();
  if (hadTranslations) toast(message);
}

/**
 * 通用"选一个"弹窗：导出方式（写回原文件 / 仅译文 / 任务 Excel）、删除确认都用它。
 * 返回所选 option id，取消关闭返回空字符串。
 */
function openChoiceDialog({ kicker = "CHOOSE", title, summary, options }) {
  const dialog = $("#exportOptionsDialog");
  $("#exportOptionsKicker").textContent = kicker;
  $("#exportOptionsTitle").textContent = title;
  $("#exportOptionsSummary").textContent = summary;
  $("#exportOptionsBody").innerHTML = options
    .map((option) => `<button class="export-option" type="button" data-export-option="${escapeHtml(option.id)}"><strong>${escapeHtml(option.label)}</strong><small>${escapeHtml(option.hint || "")}</small></button>`)
    .join("");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener("click", onClick);
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onClick = (event) => {
      const option = event.target.closest("[data-export-option]");
      if (option) return finish(option.dataset.exportOption);
      if (event.target.closest("[data-close='exportOptionsDialog']")) finish("");
    };
    const onClose = () => finish("");
    dialog.addEventListener("click", onClick);
    dialog.addEventListener("close", onClose);
    if (!dialog.open) dialog.showModal();
  });
}

/** 让用户补选原文件（历史任务没保存原文件时，写回需要它）。 */
function pickBatchSourceFile() {
  return new Promise((resolve) => {
    const input = $("#batchSourceFile");
    input.value = "";
    const onChange = async (event) => {
      input.removeEventListener("change", onChange);
      const file = event.target.files?.[0];
      if (!file) return resolve(false);
      state.batchFile = file;
      state.batchBase64 = await fileToBase64(file);
      $("#batchFilePrompt").textContent = file.name;
      resolve(true);
    };
    input.addEventListener("change", onChange);
    input.click();
  });
}

/** 当前表格的写回列（没有写回列就是原位覆盖原文）。 */
function batchWriteBackLabel() {
  const sheets = state.batchPreview?.spreadsheetAnalysis?.sheets || [];
  for (const sheet of sheets) {
    const output = (sheet.columns || []).find((column) => column.role === "translation_output");
    if (output) return `${sheet.sheet} · ${output.label || `${output.letter} 列`}（译文列）`;
  }
  const hasTable = ["xlsx", "csv"].includes(state.batchPreview?.format);
  return hasTable ? "没有指定译文列 → 原位覆盖日文原文列" : "";
}

async function exportBatch() {
  if (!state.batchPreview) return;
  const exportSegments = state.batchPreview.segments.map(({ id, source, selected, translation }) => ({ id, source, selected, translation }));
  const format = state.batchPreview.format;
  const needsSource = ["docx", "xlsx", "csv", "xliff", "mqxliff"].includes(format);
  // 原文件可能还在内存里，也可能已经由服务端随批次存档：两种都能直接写回。
  const hasSource = Boolean(state.batchBase64) || state.batchHasStoredOriginal;
  const writeBack = batchWriteBackLabel();
  let mode = "in-place";
  let exportFormat = format;
  // 先确认导出方式：写回原文件 / 仅译文 / 任务 Excel。缺原文件时不再静默换格式。
  if (needsSource && !hasSource) {
    const choice = await openChoiceDialog({ kicker: "EXPORT OPTIONS",
      title: "没有原文件，无法写回",
      summary: `${format.toUpperCase()} 的译文要写回原文件才能保留原有结构与译文位置，但历史任务没有保存原始文件。选一种方式继续：`,
      options: [
        { id: "pick-source", label: "选择原文件并写回", hint: "重新选中同名原文件后，译文写回它原本的位置（MQXLIFF 写 target、表格写译文列）" },
        { id: "translation-only", label: "仅导出译文", hint: "只给译文（每段一行），不带原文与排版" },
        { id: "task-xlsx", label: "导出任务 Excel（含 QA 信息）", hint: "序号 / 原文 / 译文 / 状态 / AIQA 分数 / QA 意见 / 人工决定" }
      ]
    });
    if (!choice) return;
    if (choice === "pick-source") {
      if (!(await pickBatchSourceFile())) return;
    } else if (choice === "translation-only") {
      mode = "translation-only";
    } else {
      exportFormat = "task-xlsx";
    }
  } else {
    const choice = await openChoiceDialog({ kicker: "EXPORT OPTIONS",
      title: "导出方式",
      summary: `原文件：${state.batchFile?.name || (state.batchHasStoredOriginal ? `${state.batchPreview.filename}（已随批次存档）` : state.batchPreview.filename)}${writeBack ? ` · ${writeBack}` : ""}`,
      options: [
        { id: "in-place", label: "写回原文件", hint: needsSource ? "译文写回原文件里它该在的位置（表格写译文列，XLIFF 写 target）" : "在原文件结构里替换对应段落，保留其它内容" },
        { id: "translation-only", label: "仅导出译文", hint: "只给译文（每段一行）；DOCX 会生成一份只有译文的新文档" }
      ]
    });
    if (!choice) return;
    mode = choice;
  }
  setBusy(true, "正在检查导出条件…");
  try {
    let gate = null;
    let gateError = "";
    try {
      gate = await api("/api/batch/export/preflight", {
        method: "POST",
        signal: AbortSignal.timeout(EXPORT_PREFLIGHT_TIMEOUT_MS),
        body: JSON.stringify({
          ...projectPayload(), locale: state.workbenchLocale, contentType: state.batchClassification?.contentType || "general", domain: "auto", segments: exportSegments
        })
      });
    } catch (error) {
      gateError = error.message;
    }
    // 门禁结果以前只弹 3 秒 toast，用户会觉得"点了没反应"：改成弹窗逐条列出来，并给"仍要导出"的出口。
    if (gateError) {
      const proceed = await openExportDialog({
        title: "导出前检查没能完成",
        summary: `${gateError}。可以跳过检查直接导出，也可以稍后重试。`,
        items: [],
        forceLabel: "跳过检查，直接导出"
      });
      if (!proceed) return;
    } else if (gate && !gate.ok) {
      const proceed = await openExportDialog({
        title: `导出被 QA 门禁挡住（${gate.blocking.length} 项）`,
        summary: "这些是规则层的硬问题（占位符、术语、数字、未翻译等）。修好再导出最稳，也可以强制导出。",
        items: gate.blocking.slice(0, 20),
        forceLabel: "仍然导出（跳过门禁）"
      });
      if (!proceed) return;
    } else if (gate?.warnings?.length) {
      const proceed = await openExportDialog({
        title: `导出前有 ${gate.warnings.length} 条提醒`,
        summary: "只是提醒，不影响导出。可以看一眼再决定。",
        items: gate.warnings.slice(0, 20),
        forceLabel: "继续导出"
      });
      if (!proceed) return;
    }

    setBusy(true, "正在生成导出文件…");
    const payload = await api("/api/batch/export", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      filename: state.batchPreview.filename,
      locale: state.workbenchLocale,
      format: exportFormat,
      mode,
      batchId: state.batchPreview.batchId || "",
      structure: state.batchPreview.structure,
      base64: state.batchBase64 || undefined,
      segments: exportSegments
    }) });
    const saved = await saveExportedFile(payload);
    await openExportDialog({
      title: "导出完成",
      summary: `${payload.filename}（${mode === "translation-only" ? "仅译文" : "写回原文件"}${exportFormat === "task-xlsx" ? " · 任务 Excel" : ""}）。${saved.message}`,
      items: []
    });
  } catch (error) {
    await openExportDialog({ title: "导出失败", summary: error.message, items: [] });
  } finally { setBusy(false); }
}

const EXPORT_PREFLIGHT_TIMEOUT_MS = 90_000;

/**
 * 导出相关的弹窗：门禁阻断 / 提醒 / 完成 / 失败都在这里给出落点。
 * 带 forceLabel 时返回 true 表示用户选择"仍然导出"，否则 false。
 */
function openExportDialog({ title, summary, items = [], forceLabel = "" }) {
  const dialog = $("#exportDialog");
  $("#exportDialogTitle").textContent = title;
  $("#exportDialogSummary").textContent = summary;
  $("#exportDialogDetails").innerHTML = items.length
    ? items.map((item) => `<div><strong>第 ${Number(item.segmentIndex) || "?"} 段</strong><p>${escapeHtml(item.message || "")}${item.suggestion ? `<em>${escapeHtml(item.suggestion)}</em>` : ""}</p></div>`).join("")
    : "";
  const jump = $("#exportDialogJump");
  jump.hidden = !items.length;
  const force = $("#exportDialogForce");
  force.hidden = !forceLabel;
  if (forceLabel) force.textContent = forceLabel;
  const firstSegmentId = items.find((item) => item.segmentId)?.segmentId || "";
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener("click", onClick);
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onClick = (event) => {
      if (event.target.closest("#exportDialogForce")) return finish(true);
      if (event.target.closest("#exportDialogJump")) { jumpToBatchSegment(firstSegmentId); finish(false); return; }
      if (event.target.closest("[data-close='exportDialog']")) finish(false);
    };
    const onClose = () => finish(false);
    dialog.addEventListener("click", onClick);
    dialog.addEventListener("close", onClose);
    if (!dialog.open) dialog.showModal();
  });
}

/** 跳到批次翻译页并高亮某一段，配合导出弹窗的"去看第一条"。 */
function jumpToBatchSegment(segmentId) {
  switchView("workbench");
  setTranslationMode("batch");
  const row = segmentId ? document.querySelector(`.batch-segment[data-segment-id="${CSS.escape(String(segmentId))}"]`) : null;
  if (!row) return toast("已回到批次翻译页，请按段号查看");
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("is-highlighted");
  setTimeout(() => row.classList.remove("is-highlighted"), 2_500);
}

/**
 * 保存导出文件：优先用系统的"另存为"让用户挑位置（Chromium 系支持），
 * 不支持时回退成普通下载——并明确告诉用户文件去了哪里，避免"点了没反应"的错觉。
 */
async function saveExportedFile(payload) {
  const binary = atob(payload.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const extension = String(payload.filename || "").split(".").pop() || "bin";
  if (typeof window.showSaveFilePicker === "function") {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: payload.filename,
        types: [{ description: "导出文件", accept: { [payload.mimeType || "application/octet-stream"]: [`.${extension}`] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      return { message: `已保存到你选择的位置：${handle.name || payload.filename}` };
    } catch (error) {
      if (String(error?.name) === "AbortError") throw new Error("已取消保存");
      // 其它原因（浏览器策略、权限）回退成下载，不让导出彻底失败。
    }
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: payload.mimeType || "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = payload.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return { message: "浏览器不会弹保存位置时必须自行设置：默认已存到「下载」目录" };
}

function batchFeedbacks() {
  return state.batchPreview?.segments.filter((segment) => segment.status === "done" && segment.translation && !segment.accepted) || [];
}

async function acceptSegment(segmentId) {
  const segment = state.batchPreview?.segments.find((item) => item.id === segmentId);
  if (!segment || !segment.translation) return;
  try {
    const result = await api("/api/feedback/accept", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      source: segment.source,
      translation: segment.translation,
      locale: state.workbenchLocale,
      contentType: state.batchClassification?.contentType || "general",
      domain: "auto",
      styleProfileId: state.batchStyleProfile?.id || "",
      qaCaseId: segment.result?.aiQa?.qaCases?.[0]?.id || "",
      termSuggestions: segment.result?.termSuggestions || [],
      batchId: state.batchPreview.batchId || "",
      sourceFile: state.batchPreview.filename || "",
      // 条目身份：采纳进主 TM 时带上，后续同一条目的译例才能按 ID 命中。
      entryId: segment.locator?.unitId || segment.locator?.entryId || "",
      entryKey: segment.entryKey || segment.locator?.entryKey || "",
      trajectoryId: segment.result?.trajectoryId || segment.result?.trajectory_id || ""
    }) });
    segment.accepted = true;
    saveBatchProgress();
    renderBatchSegments();
    refreshActions();
    toast(`已采纳：${segment.source.slice(0, 20)}…${result.demoted ? `（${result.demoted} 条旧译降权）` : ""}`);
  } catch (error) { toast(error.message); }
}

async function acceptAllSegments() {
  const pending = batchFeedbacks();
  if (!pending.length) return;
  if (!confirm(`确认采纳全部 ${pending.length} 段译文？采纳后将写入翻译记忆与风格证据。`)) return;
  setBusy(true, `采纳中（0 / ${pending.length}）…`);
  let done = 0;
  for (const segment of pending) {
    try {
      await api("/api/feedback/accept", { method: "POST", body: JSON.stringify({
        ...projectPayload(),
        source: segment.source,
        translation: segment.translation,
        locale: state.workbenchLocale,
        contentType: state.batchClassification?.contentType || "general",
        domain: "auto",
        styleProfileId: state.batchStyleProfile?.id || "",
        qaCaseId: segment.result?.aiQa?.qaCases?.[0]?.id || "",
        termSuggestions: segment.result?.termSuggestions || [],
        batchId: state.batchPreview.batchId || "",
        sourceFile: state.batchPreview.filename || "",
        entryId: segment.locator?.unitId || segment.locator?.entryId || "",
        entryKey: segment.entryKey || segment.locator?.entryKey || "",
        trajectoryId: segment.result?.trajectoryId || segment.result?.trajectory_id || ""
      }) });
      segment.accepted = true;
      done += 1;
      setBusy(true, `采纳中（${done} / ${pending.length}）…`);
      saveBatchProgress();
    } catch (error) {
      toast(`第 ${segment.index} 段采纳失败：${error.message}`);
    }
  }
  setBusy(false);
  renderBatchSegments();
  toast(`已采纳 ${done} / ${pending.length} 段译文`);
}

async function saveBatchProgress() {
  if (!state.batchPreview?.batchId) return;
  const preview = state.batchPreview;
  localStorage.setItem("kami-batch-id", preview.batchId);
  const payload = {
      ...projectPayload(),
      batchId: preview.batchId,
      filename: preview.filename,
      locale: state.workbenchLocale,
      contentType: state.batchClassification?.contentType || "general",
      domain: "auto",
      format: preview.format,
      segmentationMode: preview.segmentationMode,
      structure: preview.structure,
      segments: preview.segments.map(({ id, source, translation, status, selected, accepted, locator, context, result }) => ({ id, source, translation, status, selected, accepted, locator, context, result: compactBatchResult(result) }))
  };
  batchSaveChain = batchSaveChain.catch(() => undefined).then(() => api("/api/batch/run", { method: "POST", body: JSON.stringify(payload) }));
  try { await batchSaveChain; }
  catch (error) { console.warn("批次进度保存失败：", error.message); }
}

function compactBatchResult(result) {
  if (!result) return null;
  const compactText = (value, limit = 800) => String(value || "").slice(0, limit);
  return {
    translation: compactText(result.translation, 10_000),
    qaScore: Number.isFinite(result.qaScore) ? result.qaScore : null,
    matches: (result.matches || []).slice(0, 20).map((match) => ({ mode: match.mode, matchPhrase: compactText(match.matchPhrase, 120), score: match.score, term: { source: compactText(match.term?.source, 120), target: compactText(match.term?.target, 120), enforcement: match.term?.enforcement, forbidden: match.term?.forbidden || [] } })),
    issues: (result.issues || []).slice(0, 30),
    aiQa: result.aiQa ? {
      score: Number.isFinite(result.aiQa.score) ? result.aiQa.score : null,
      status: result.aiQa.status,
      iterations: result.aiQa.iterations || 0,
      used: Boolean(result.aiQa.used),
      fallbackReason: compactText(result.aiQa.fallbackReason, 500),
      termDecisions: (result.aiQa.termDecisions || []).slice(0, 12),
      humanDecisions: (result.aiQa.humanDecisions || []).slice(0, 30),
      referenceCount: (result.aiQa.references || []).length,
      qaCaseCount: (result.aiQa.qaCases || []).length
    } : null,
    styleProfile: result.styleProfile ? { id: result.styleProfile.id, name: result.styleProfile.name, version: result.styleProfile.version } : null
  };
}

async function restoreBatchProgress() {
  const batchId = localStorage.getItem("kami-batch-id");
  if (!batchId) return;
  try {
    const run = await api(`/api/batch/run/${encodeURIComponent(batchId)}?projectId=${encodeURIComponent(state.activeProjectId)}`);
    if (!run?.segments?.length) return;
    state.batchPreview = {
      batchId: run.batchId,
      filename: run.filename,
      format: run.format,
      segmentationMode: run.segmentationMode,
      structure: run.structure,
      segments: run.segments.map((segment, index) => ({
        id: segment.id,
        index: index + 1,
        source: segment.source,
        translation: segment.translation || "",
        status: segment.status || "pending",
        selected: segment.selected !== false,
        accepted: Boolean(segment.accepted),
        locator: segment.locator || undefined,
        context: segment.context || undefined,
        result: segment.result || null,
        error: ""
      }))
    };
    state.batchClassification = { contentType: run.contentType || "general", source: "restored" };
    state.batchStyleProfile = null;
    state.batchBrief = run.contextBrief || null;
    state.batchBriefDraft = null;
    state.batchBriefPending = false;
    state.batchReport = run.qualityReport || null;
    state.batchHasStoredOriginal = Boolean(run.runnerOptions?.originalFile);
    state.workbenchLocale = run.locale || state.workbenchLocale;
    setTranslationMode("batch");
    renderLocaleStrip($("#workbenchLocales"), state.workbenchLocale, updateWorkbenchLocale);
    const details = state.bootstrap.locales[state.workbenchLocale];
    $("#targetKicker").textContent = `TARGET · ${state.workbenchLocale.toUpperCase()}`;
    $("#targetTitle").textContent = `${details.label}译文`;
    $("#batchSourceMeta").textContent = batchSourceMetaText({ segments: run.segments.length, suffix: "已恢复保存的进度" });
    if (run.format === "text" || run.format === "markdown") {
      $("#batchFilePrompt").textContent = "已恢复粘贴长文进度";
      $("#batchFileMeta").textContent = `${run.segments.length} 段 · 刷新后自动恢复`;
      $("#batchDropZone").classList.add("has-file");
    } else {
      $("#batchFilePrompt").textContent = run.filename;
      $("#batchFileMeta").textContent = "进度已恢复 · 导出前请重新选择同名原文件";
      $("#batchDropZone").classList.add("has-file");
    }
    renderBatchSegments();
    renderBatchBrief();
    renderBatchReport();
    refreshActions();
    if (["queued", "running"].includes(run.runState)) {
      state.batchRunning = true;
      pollServerBatch(run.batchId).catch((error) => toast(error.message));
    }
    toast("已恢复上次未完成的批次进度");
  } catch {
    localStorage.removeItem("kami-batch-id");
  }
}

async function updateAssetLocale(locale) {
  state.assetLocale = locale;
  renderLocaleStrip($("#assetLocales"), locale, updateAssetLocale);
  const details = state.bootstrap.locales[locale];
  $("#assetListTitle").textContent = `${details.label}术语库`;
  $("#targetTermLabel").textContent = `${details.label}正式译法`;
  await loadAssets(locale);
}

async function loadStyleProfiles(locale) {
  try {
    const [drafts, active, pending] = await Promise.all([
      api(`/api/style-profiles?locale=${encodeURIComponent(locale)}&status=draft&projectId=${encodeURIComponent(state.activeProjectId)}`),
      api(`/api/style-profiles?locale=${encodeURIComponent(locale)}&status=active&projectId=${encodeURIComponent(state.activeProjectId)}`),
      api(`/api/qa-cases/pending?locale=${encodeURIComponent(locale)}&projectId=${encodeURIComponent(state.activeProjectId)}`)
    ]);
    renderStyleProfiles(drafts, active, pending);
  } catch (error) {
    $("#styleProfileList").innerHTML = `<div class="empty-list">风格规范加载失败：${escapeHtml(error.message)}</div>`;
  }
}

/** 蒸馏跳过原因决定进度怎么读：阈值看总量，增长窗口看增量，待审草稿没有进度可言。 */
function styleDistillProgress(pending = {}) {
  if (pending.skipped === "pending_draft") return "待审核草稿";
  if (pending.skipped === "growth_window") return `新增 ${pending.sinceLastDistill ?? 0}/${pending.growthWindow}`;
  if (Number.isFinite(Number(pending.evidenceCount)) && Number.isFinite(Number(pending.threshold))) {
    return `${pending.evidenceCount}/${pending.threshold}`;
  }
  return String(pending.reason || "暂不蒸馏");
}

function contentTypeLabel(value) {
  return state.bootstrap?.contentTypes?.[value]?.label || value;
}

function contentTagLabels(contentType, tags = []) {
  const dictionary = state.bootstrap?.contentTags?.[contentType] || {};
  return (Array.isArray(tags) ? tags : []).map((tag) => dictionary[tag] || tag).filter(Boolean);
}

/**
 * 草稿卡片上的评测状态。译者画像不在配对评测覆盖范围内，单独标注，
 * 免得看起来像"漏评"。
 */
function styleEvaluationState(item) {
  if (item.kind !== "style") return { tone: "neutral", label: "译者画像暂不参与配对评测，按人工判断启用" };
  const evaluation = item.evaluation;
  if (!evaluation || !evaluation.evaluatedAt) return { tone: "warn", label: "尚未评测：直接启用属于凭感觉改风格，建议先跑一次配对评测" };
  const sample = `${evaluation.sampleCount ?? 0} 组留出对照`;
  if (evaluation.promotable === true) return { tone: "pass", label: `评测通过 · ${sample} · ${evaluation.conclusion || "达到晋升门槛"}` };
  return { tone: "fail", label: `评测未通过 · ${sample} · ${evaluation.conclusion || "未达晋升门槛"}` };
}

async function pollStyleEvaluation(jobId) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    let job;
    try { job = await api(`/api/style-profiles/evaluation-jobs/${encodeURIComponent(jobId)}`); }
    catch { return null; }
    if (["completed", "failed", "interrupted"].includes(job.status)) return job;
    $("#styleProfileCount").textContent = `评测中 ${job.progress.completed}/${job.progress.requested}`;
  }
  return null;
}

function renderStyleProfiles(drafts, active, pending) {
  const activeById = new Map([...(active.styleProfiles || []), ...(active.userProfiles || [])].map((item) => [item.id, item]));
  const profileCards = [];
  for (const item of drafts.styleProfiles || []) {
    const previous = item.parentId ? activeById.get(item.parentId) : null;
    profileCards.push({ ...item, kind: "style", kindLabel: `风格规范 · ${contentTypeLabel(item.contentType)} / ${item.domain}`, previous });
  }
  for (const item of drafts.userProfiles || []) {
    const previous = item.parentId ? activeById.get(item.parentId) : null;
    profileCards.push({ ...item, kind: "user", kindLabel: "译者画像 · 全局", previous });
  }
  profileCards.sort((a, b) => b.version - a.version);
  $("#styleProfileCount").textContent = `${profileCards.length} 待审核`;

  const profileHtml = profileCards.map((item) => `
    <div class="style-profile-card" data-profile-id="${escapeHtml(item.id)}">
      <div class="style-profile-head"><strong>v${item.version} · ${escapeHtml(item.name)}</strong><span>${escapeHtml(item.kindLabel)} · ${item.evidenceCount} 条证据${item.status === "draft" ? " · 草稿" : ""}</span></div>
      <div class="style-profile-instruction">${escapeHtml(item.instruction)}</div>
      <div class="style-profile-diff" hidden><div><strong>当前生效版本</strong><p>${escapeHtml(item.previous?.instruction || "无（首个版本）")}</p></div><div><strong>本草稿</strong><p>${escapeHtml(item.instruction)}</p></div></div>
      <div class="style-profile-evaluation ${escapeHtml(styleEvaluationState(item).tone)}">${escapeHtml(styleEvaluationState(item).label)}</div>
      <div class="style-profile-actions">
        <button class="button ghost small" data-action="diff">对比新旧</button>
        ${item.kind === "style" ? '<button class="button ghost small" data-action="evaluate">评测</button>' : ""}
        <button class="button ghost small" data-action="activate">激活</button>
        <button class="button ghost small" data-action="reject">拒绝</button>
      </div>
    </div>
  `).join("");
  const pendingHtml = pending.length ? `<div class="qa-case-pending"><strong>AIQA 待复核案例（${pending.length}）</strong>${pending.map((item) => `
    <div class="qa-case-row" data-case-id="${escapeHtml(item.id)}">
      <div><small>${Math.round(item.scoreBefore)} → ${Math.round(item.scoreAfter)} · ${escapeHtml(item.source.slice(0, 40))}</small><p><s>${escapeHtml((item.rejectedTranslation || "").slice(0, 60))}</s> → <strong>${escapeHtml((item.correctedTranslation || "").slice(0, 60))}</strong></p></div>
      <div class="qa-case-actions"><button class="button ghost small" data-action="approve-case">采纳为反例</button><button class="button ghost small" data-action="dispose-case">作废</button></div>
    </div>
  `).join("")}</div>` : "";
  $("#styleProfileList").innerHTML = profileHtml || '<div class="empty-list">当前语言没有待审核的风格草稿</div>' + pendingHtml;

  $$(".style-profile-card [data-action]").forEach((button) => button.addEventListener("click", async () => {
    const card = button.closest(".style-profile-card");
    const id = card.dataset.profileId;
    if (button.dataset.action === "diff") {
      card.querySelector(".style-profile-diff").hidden = !card.querySelector(".style-profile-diff").hidden;
      return;
    }
    if (button.dataset.action === "evaluate") {
      button.disabled = true;
      try {
        const job = await api(`/api/style-profiles/${encodeURIComponent(id)}/evaluate`, { method: "POST", body: JSON.stringify({ project: state.activeProjectId || "default" }) });
        toast(`风格评测已进入后台：${job.progress.requested} 组留出对照，只有风格规范一个变量`);
        const finished = await pollStyleEvaluation(job.jobId);
        if (finished?.status === "completed") toast(finished.result?.report?.conclusion || "风格评测完成");
        else if (finished) toast(`风格评测未完成：${finished.error || finished.status}`);
      } catch (error) { toast(error.message); }
      finally {
        button.disabled = false;
        await loadStyleProfiles(state.assetLocale);
      }
      return;
    }
    try {
      await api(`/api/style-profiles/${encodeURIComponent(id)}/${button.dataset.action}`, { method: "POST", body: JSON.stringify(projectPayload()) });
      toast(button.dataset.action === "activate" ? "已激活，开始参与翻译" : "已拒绝该草稿");
      await loadStyleProfiles(state.assetLocale);
    } catch (error) {
      // 评测结论反对时后端返回 409；越过闸门必须是一次明确的人工决定，并会被记录。
      if (button.dataset.action === "activate" && /评测结论不支持启用/.test(error.message) && confirm(`${error.message}

仍要启用吗？本次越过评测闸门会记录在该风格规范上。`)) {
        try {
          await api(`/api/style-profiles/${encodeURIComponent(id)}/activate`, { method: "POST", body: JSON.stringify({ ...projectPayload(), force: true }) });
          toast("已忽略评测结论并启用，该决定已记录");
          await loadStyleProfiles(state.assetLocale);
          return;
        } catch (forceError) { toast(forceError.message); return; }
      }
      toast(error.message);
    }
  }));
  $$(".qa-case-row [data-action]").forEach((button) => button.addEventListener("click", async () => {
    const id = button.closest(".qa-case-row").dataset.caseId;
    try {
      await api(`/api/qa-cases/${encodeURIComponent(id)}/${button.dataset.action === "approve-case" ? "approve" : "dispose"}`, { method: "POST" });
      toast(button.dataset.action === "approve-case" ? "已采纳为反例，将参与后续 QA 指导" : "已作废该案例");
      await loadStyleProfiles(state.assetLocale);
    } catch (error) { toast(error.message); }
  }));
}

async function updateStyleLocale(locale) {
  state.styleLocale = locale;
  renderLocaleStrip($("#styleLocales"), locale, updateStyleLocale);
  const details = state.bootstrap.locales[locale];
  $("#styleGuidanceTitle").textContent = `${details.label}翻译风格指导`;
  await loadStyleGuidance(locale);
}

async function importStyleGuideFile(file, locale = state.styleLocale) {
  if (!file) throw new Error("请先选择风格指南文件");
  if (!/\.(txt|md|docx)$/iu.test(file.name)) throw new Error("风格指南仅支持 .txt、.md、.docx");
  if (file.size > 5 * 1024 * 1024) throw new Error("风格指南不能超过 5MB");
  const result = await api("/api/style-guides/import", { method: "POST", body: JSON.stringify({
    ...projectPayload(),
    locale,
    filename: file.name,
    base64: await fileToBase64(file)
  }) });
  await loadStyleGuidance(locale);
  return result;
}

/** 上传控件既要看出"能点"，也要看出"选中了哪个文件"。 */
function renderStyleGuidePicker() {
  const file = state.styleGuideFile;
  $("#styleGuideFileName").textContent = file
    ? `${file.name} · ${formatBytes(file.size)}`
    : "支持 TXT / Markdown / DOCX，最大 5MB";
  $("#styleGuideFile").closest(".library-file-button")?.classList.toggle("has-file", Boolean(file));
}

async function importStyleGuide() {
  const file = state.styleGuideFile;
  if (!file) return;
  const button = $("#styleGuideImportButton");
  const note = $("#styleGuideImportNote");
  button.disabled = true;
  note.className = "library-import-note";
  note.textContent = "正在读取并启用风格指南……";
  try {
    const result = await importStyleGuideFile(file);
    state.styleGuideFile = null;
    $("#styleGuideFile").value = "";
    renderStyleGuidePicker();
    note.classList.add("is-ok");
    note.textContent = `已启用：${result.filename} · ${result.characters} 字 · 作为当前项目的风格规则立即生效`;
    toast("风格指南已导入并启用，优先于自动蒸馏的规则");
  } catch (error) {
    button.disabled = false;
    note.classList.add("is-error");
    note.textContent = error.message;
    toast(error.message);
  }
}

function splitStyleRules(instruction) {
  // 历史接口：只返回真正的规则行（小节标题不算规则、也不按「；」拆条）。
  return parseStyleDocument(instruction).filter((block) => block.type === "rule").map((block) => block.text);
}

/**
 * 风格规范（无论人工导入还是自动蒸馏）都是**带小节的文档**：
 *   【用词】/「# 标题」/「一、」这类是章节标题，`・`/`-`/`1.` 开头的才是规则条目。
 * 旧实现按换行 + 「；」硬切，于是把标题也算成规则、还把一条规则拆成两条（12 行显示成 14 条）。
 *
 * 这里统一解析成块：heading（章节）/ rule（规则，去掉项目符号前缀）/ divider（分隔线）。
 * 同一段文字给两种界面用：人工指南按文档渲染，蒸馏规范按小节分组列规则。
 */
function parseStyleDocument(text) {
  const blocks = [];
  for (const raw of String(text || "").split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[=\-*_]{3,}$/u.test(line)) { blocks.push({ type: "divider", text: "" }); continue; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/u);
    if (heading) {
      blocks.push({ type: "heading", level: Math.min(4, heading[1].length), text: heading[2].trim() });
      continue;
    }
    const bracketHeading = line.match(/^【(.+)】$/u);
    if (bracketHeading) { blocks.push({ type: "heading", level: 2, text: bracketHeading[1].trim() }); continue; }
    const numberedHeading = line.match(/^[一二三四五六七八九十]+、\s*(.+?)[。.]?$/u);
    if (numberedHeading && line.length <= 24) { blocks.push({ type: "heading", level: 2, text: numberedHeading[1].trim() }); continue; }
    const rule = line
      .replace(/^[・·•*\-]\s*/u, "")
      .replace(/^\d+[.)、]\s*/u, "")
      .trim();
    if (rule) blocks.push({ type: "rule", text: rule });
  }
  return blocks;
}

/** 人工指南的"查看正文"：按文档结构渲染，一行都不丢。 */
function renderStyleGuideDocument(text) {
  const blocks = parseStyleDocument(text);
  if (!blocks.length) return '<p class="guide-doc-empty">正文为空</p>';
  return blocks.map((block) => {
    if (block.type === "divider") return '<hr class="guide-doc-divider" />';
    if (block.type === "heading") return `<p class="guide-doc-heading lv${block.level || 2}">${escapeHtml(block.text)}</p>`;
    return `<p>${escapeHtml(block.text)}</p>`;
  }).join("");
}

/** 人工指南卡片里的"查看正文"：全文渲染（不截断），并给一个复制入口。 */
function renderManualGuideDocument(instruction) {
  const text = String(instruction || "");
  const characters = [...text].length;
  return `<details class="style-examples manual-guide-details"><summary>查看正文（全文 ${characters} 字，按文档结构展开）</summary>
    <div class="guide-doc">${renderStyleGuideDocument(text)}</div>
    <div class="guide-doc-footer"><button class="button ghost small" type="button" data-action="copy-guide">复制全文</button><small>正文按导入时的原文保存，没有被改写</small></div>
  </details>`;
}

function formatStyleTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/**
 * 人工风格指南状态模块：一眼看清"有没有人工指南、是哪一份、现在是否启用"。
 *
 * 人工导入的指南由 /api/style-guides/import 命名成"风格指南 · <文件名>"，
 * 用它跟从译文里蒸馏出来的译者画像区分（两者都存在 user_profiles 里）。
 */
/**
 * 立即重新蒸馏：不用等下一次批次/导入结束。逐个作用域按同一套门禁判定，
 * 够条件（证据 ≥ 阈值、距上次蒸馏的新增 ≥ 增长窗口、且没有待审草稿）才会调模型。
 */
async function distillStyleNow(button) {
  if (!button || button.disabled) return;
  button.disabled = true;
  button.textContent = "蒸馏中…";
  try {
    const result = await api("/api/style-profiles/distill", {
      method: "POST",
      body: JSON.stringify({ ...projectPayload(), locale: state.styleLocale })
    });
    // 项目级蒸馏一次只出一份：成功就说版本与规则数，跳过就把门禁原因原样说明。
    if (result.distilled) {
      toast(`已重新蒸馏项目规范 v${result.profile.version}（${result.profile.rules} 条规则，证据 ${result.evidenceCount} 条）`);
    } else {
      toast(result.reason ? `暂未蒸馏：${result.reason}` : "当前还没有风格证据可蒸馏");
    }
    await loadStyleGuidance(state.styleLocale);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "立即重新蒸馏";
  }
}

function renderManualGuide(profiles) {
  const container = $("#manualGuideStatus");
  if (!container) return;
  const guides = (profiles.userProfiles || []).filter((item) => String(item.name || "").startsWith("风格指南 · "));
  const current = guides.find((item) => item.status === "active")
    || [...guides].sort((left, right) => (Number(right.version) || 0) - (Number(left.version) || 0))[0]
    || null;
  if (!current) {
    container.innerHTML = '<div class="manual-guide-empty"><strong>还没有人工风格指南</strong><p>用上面的入口导入 TXT / Markdown / DOCX；导入后立即启用，并优先于自动蒸馏出的规则。</p></div>';
    return;
  }
  const status = String(current.status || "draft");
  const statusLabel = status === "active" ? "已启用" : status === "draft" ? "待批准" : "已停用";
  const statusNote = status === "active"
    ? "正在作为最高优先级风格规则参与翻译"
    : status === "draft" ? "尚未启用，当前翻译不会使用它" : "已停用，历史版本仍保留";
  const history = guides.filter((item) => item.id !== current.id).length;
  const action = status === "active"
    ? '<button class="button ghost small" data-action="disable">停用（保留历史）</button>'
    : `<button class="button secondary small" data-action="activate">${status === "draft" ? "批准并启用" : "重新启用"}</button>`;
  container.innerHTML = `<article class="manual-guide-card ${escapeHtml(status)}" data-profile-id="${escapeHtml(current.id)}">
    <div class="manual-guide-head"><div><strong>${escapeHtml(String(current.name || "").replace(/^风格指南 · /u, ""))}</strong><small>${escapeHtml(statusNote)} · v${Number(current.version) || 1} · 正文 ${[...String(current.instruction || "")].length} 字 · 最近更新 ${escapeHtml(formatStyleTime(current.updatedAt))}${history ? ` · 另有 ${history} 个历史版本` : ""}</small></div><span class="style-state ${escapeHtml(status)}">${statusLabel}</span></div>
    <div class="manual-guide-actions">${renderManualGuideDocument(current.instruction)}${action}</div>
  </article>`;
}

async function loadStyleGuidance(locale = state.styleLocale) {
  const [profiles, pending] = await Promise.all([
    api(`/api/style-profiles?locale=${encodeURIComponent(locale)}&projectId=${encodeURIComponent(state.activeProjectId)}`),
    api(`/api/qa-cases/pending?locale=${encodeURIComponent(locale)}&projectId=${encodeURIComponent(state.activeProjectId)}`)
  ]);
  state.styleData = { profiles, pending };
  renderStyleGuidance();
}

/** 来源文件清单的展示文本：最多列两个文件，其余写"等 N 个文件"。 */
function formatEvidenceFiles(files = []) {
  const list = learningArray(files).filter((item) => item?.name);
  if (!list.length) return "";
  const shown = list.slice(0, 2).map((item) => `${item.name}（${Number(item.count) || 0} 条）`).join("、");
  return list.length > 2 ? `${shown} 等 ${list.length} 个文件` : shown;
}

function renderStyleGuidance() {
  const profiles = state.styleData?.profiles || { styleProfiles: [], userProfiles: [], evidencePools: [] };
  const pending = state.styleData?.pending || [];
  const learningRuns = learningRunsFromPayload(profiles);
  const statusFilter = $("#styleStatus")?.value || "";
  // 人工导入的指南是"整篇文档"，它有自己的模块（上面那块，含全文与启用开关）。
  // 这里只列从语料蒸馏 / 复盘出来的规则——它们才是真正一条一条的规则。
  const items = (profiles.styleProfiles || [])
    .map((item) => ({ ...item, kind: "style", scopeLabel: `${contentTypeLabel(item.contentType)} · ${item.domain}` }))
    .filter((item) => !statusFilter || item.status === statusFilter);
  const activeCount = [...(profiles.userProfiles || []), ...(profiles.styleProfiles || [])].filter((item) => item.status === "active").length;
  $("#styleGuidanceCount").textContent = `${activeCount} 条启用 · ${items.length} 条显示`;
  renderManualGuide(profiles);
  $("#styleLearningCount").textContent = `${learningRuns.length} 个批次范围`;
  $("#styleLearningRuns").innerHTML = learningRuns.length ? renderLearningCards(learningRuns) : '<div class="empty-list compact">还没有可展示的批次学习记录；导入完整双语句段后会在这里说明 AI 具体学到了什么。</div>';
  // 渲染完要挂事件：这一块的卡片里有"重跑模型浓缩"这类按记录操作的按钮。
  bindStyleLearningLinks($("#styleLearningRuns"));
  const pools = profiles.evidencePools || [];
  // 风格资产是项目级的：只有一个池子。语体分布折起来，需要判断"证据里有没有对白/公告"
  // 时再展开（蒸馏会按语体分层取样）。
  const poolTotal = pools.reduce((sum, pool) => sum + (Number(pool.evidenceCount) || 0), 0);
  const poolThreshold = Number(pools[0]?.threshold) || 8;
  const poolPercent = Math.min(100, Math.round((poolTotal / Math.max(1, poolThreshold)) * 100));
  const scopeBreakdown = (profiles.evidenceByScope || pools[0]?.byContentType || []);
  const scopeDetail = scopeBreakdown.length
    ? scopeBreakdown.map((bucket) => `<div class="style-pool"><div><strong>${escapeHtml(contentTypeLabel(bucket.contentType))}</strong><small>该语体的证据条数（蒸馏按语体分层取样，保证每类都有代表）</small></div><div class="style-pool-progress"><i style="width:${Math.min(100, Math.round(((Number(bucket.count) || 0) / Math.max(1, poolTotal)) * 100))}%"></i></div><span>${bucket.count} 条</span></div>`).join("")
    : '<div class="empty-list compact">还没有证据。</div>';
  const poolDetail = pools.map((pool) => {
    const percent = Math.min(100, Math.round((pool.evidenceCount / Math.max(1, pool.threshold)) * 100));
    const sources = pool.sources || {};
    const sampledNote = Number(pool.sampled) && Number(pool.sampled) < Number(pool.evidenceCount)
      ? `<small>分析取样：${pool.sampled} 条（改写 / 负例按取样统计）</small>`
      : "";
    // 池子也要说清"证据来自哪些文件"：蒸馏出来的规则才能回溯到具体交付物。
    const poolFiles = formatEvidenceFiles(pool.files);
    const filesNote = poolFiles ? `<small class="style-pool-files">来源文件：${escapeHtml(poolFiles)}</small>` : "";
    return `<div class="style-pool is-project"><div><strong>项目规范证据池</strong><small>直接证据：表格导入 ${sources.tableImport || 0} · 人工采纳 ${sources.humanAccept || 0}${sources.other ? ` · 历史/其他 ${sources.other}` : ""}${sources.revised ? ` · 含改写 ${sources.revised}` : ""}${sources.negative ? ` · 反例 ${sources.negative}` : ""}</small><small>辅助复盘：AIQA 记录 ${sources.qaReview || 0}（不计入 ${pool.threshold} 条直接证据）</small>${filesNote}${sampledNote}</div><div class="style-pool-progress"><i style="width:${percent}%"></i></div><span>${pool.evidenceCount} / ${pool.threshold}</span></div>`;
  }).join("");
  $("#styleEvidencePools").innerHTML = pools.length
    ? `<div class="style-pool-heading"><div><strong>正在积累的项目证据池</strong><small>累计达到 ${poolThreshold} 条才会蒸馏；蒸馏时按语体分层取样，规则会写明适用场景</small></div><button class="button secondary small" type="button" id="styleDistillNow">立即重新蒸馏</button></div>
      <div class="style-pool is-total"><div><strong>全部证据（项目级）</strong><small>翻译时只用这一份项目规范，不再按语体×领域各取一份</small></div><div class="style-pool-progress"><i style="width:${poolPercent}%"></i></div><span>${poolTotal} / ${poolThreshold}</span></div>
      ${poolDetail}
      <details class="advanced-scope"><summary>按语体查看证据分布（${scopeBreakdown.length} 类）</summary>${scopeDetail}</details>`
    : '<div class="empty-list compact">还没有完整双语句段进入风格证据池；导入短术语不会产生风格。</div>';
  // 池子每次重画，按钮要重新挂：不用等下一次批次跑完就能手动触发蒸馏。
  $("#styleDistillNow")?.addEventListener("click", (event) => distillStyleNow(event.currentTarget));
  $("#styleGuidanceList").innerHTML = items.length ? items.map((item) => {
    // 蒸馏结果同样是带小节的文档：小节标题单独显示，规则在小节内编号，
    // 标题既不算规则、也不会因为「；」被拆成两条。
    // 待批准草案与当前生效版本逐字相同的规则占多数：折叠起来只展开变化的部分，
    // 否则两张卡片并排看就是"同一批规则抄了两遍"。
    const diff = styleProfileDiff(item, item.status === "active" ? null : (profiles.styleProfiles || []).find((other) => other.id !== item.id && other.status === "active" && (other.contentType || "general") === (item.contentType || "general") && (other.domain || "general") === (item.domain || "general")));
    const reusedTexts = new Set(diff?.reusedTexts || []);
    const updatedTexts = new Set(diff?.updatedTexts || []);
    const sections = [];
    for (const block of parseStyleDocument(item.instruction)) {
      if (block.type === "divider") continue;
      if (block.type === "heading") { sections.push({ title: block.text, rules: [] }); continue; }
      if (!sections.length) sections.push({ title: "", rules: [] });
      sections.at(-1).rules.push(block.text);
    }
    const ruleCount = sections.reduce((sum, section) => sum + section.rules.length, 0);
    const reusedCount = sections.reduce((sum, section) => sum + section.rules.filter((rule) => reusedTexts.has(rule)).length, 0);
    const sectionCount = sections.filter((section) => section.title).length;
    const examples = (item.examples || []).slice(0, 4);
    const sourceBatchId = item.sourceBatchId || item.source_batch_id || "";
    const learningSummary = item.learningSummary || item.learning_summary || "";
    // 这一版规则的取样来自哪些文件：蒸馏结果必须能回溯到具体交付物。
    const evidenceFiles = formatEvidenceFiles(item.evidenceFiles || item.evidence_files);
    const missingFiles = Number(item.evidenceFilesMissing ?? item.evidence_files_missing) || 0;
    const evidenceFilesNote = evidenceFiles
      ? `<small class="style-evidence-files">来源文件：${escapeHtml(evidenceFiles)}</small>`
      : (missingFiles ? `<small class="style-evidence-files">来源文件：原证据已不在库中（本版取样 ${missingFiles} 条）</small>` : "");
    const diffChips = diff
      ? `<p class="style-rule-diff">对比 v${diff.baselineVersion}：新增 ${diff.added} · 改写 ${diff.updated} · 逐字沿用 ${diff.reused} · 已退休 ${diff.retired}</p>`
      : "";
    const ruleRow = (rule, index, { reused = false } = {}) => `<div class="style-rule-row${reused ? " reused" : ""}"><span>${String(index + 1).padStart(2, "0")}</span><p>${escapeHtml(rule)}${updatedTexts.has(rule) ? '<em class="style-rule-tag">本版改写</em>' : ""}</p></div>`;
    return `<article class="style-guidance-card ${escapeHtml(item.status)}" data-profile-id="${escapeHtml(item.id)}">
      <div class="style-guidance-head"><div><strong>${escapeHtml(item.name)}</strong><small>适用范围：${escapeHtml(state.bootstrap.locales[state.styleLocale].label)} × ${escapeHtml(item.scopeLabel)} · v${item.version}</small><small>生成方式：${escapeHtml(item.name.startsWith("风格指南 · ") ? "人工上传，正文未被改写" : item.name.includes("复盘修订") ? "AIQA 复盘结合已沉淀语料" : "同类双语语料自动精炼")} · ${item.evidenceCount} 条证据${sourceBatchId ? ` · 来源批次 ${escapeHtml(String(sourceBatchId).slice(0, 8))}` : ""}</small>${evidenceFilesNote}</div><span class="style-state ${escapeHtml(item.status)}">${item.status === "active" ? "已启用" : item.status === "draft" ? "待批准" : "已停用"}</span></div>
      ${learningSummary ? `<p class="style-learning-summary">本批浓缩：${escapeHtml(learningSummary)}</p>` : ""}
      <p class="style-rule-count">${sectionCount ? `${sectionCount} 个小节 · ` : ""}共 ${ruleCount} 条规则${reusedCount ? `（其中 ${reusedCount} 条与 v${diff.baselineVersion} 逐字相同，已折叠）` : ""}</p>
      ${diffChips}
      <div class="style-rule-list">${ruleCount ? sections.map((section) => {
        const changed = section.rules.filter((rule) => !reusedTexts.has(rule));
        const reused = section.rules.filter((rule) => reusedTexts.has(rule));
        return `<div class="style-rule-section-group">${section.title ? `<p class="style-rule-section">${escapeHtml(section.title)}</p>` : ""}${changed.map((rule, index) => ruleRow(rule, index)).join("")}${reused.length ? `<details class="style-rule-reused"><summary>沿用 v${diff.baselineVersion} 的 ${reused.length} 条（逐字相同）</summary>${reused.map((rule, index) => ruleRow(rule, index, { reused: true })).join("")}</details>` : ""}</div>`;
      }).join("") : '<div class="batch-detail-empty">该版本没有可展示的规则条目</div>'}</div>
      ${examples.length ? `<details class="style-examples"><summary>查看 ${examples.length} 个正反例</summary>${examples.map((example) => `<div><strong>${example.type === "negative" ? "反例" : "正例"}</strong><p>${escapeHtml(example.source || "")}</p><p>${escapeHtml(example.target || "")}</p><small>${escapeHtml(example.reason || "")}</small></div>`).join("")}</details>` : ""}
      <div class="style-guidance-actions"><button class="button ${item.status === "active" ? "ghost" : "secondary"} small" data-action="${item.status === "active" ? "disable" : "activate"}">${item.status === "active" ? "停用（保留历史）" : "批准并启用"}</button></div>
    </article>`;
  }).join("") : '<div class="empty-list">当前筛选条件下没有自动蒸馏的规则条目；人工导入的风格指南在上面的「人工风格指南」模块里单独展示（它是一整篇文档，不按条计）。</div>';
  $("#styleQaCount").textContent = `${pending.length} 条`;
  $("#styleQaList").innerHTML = pending.length ? pending.map((item) => `<div class="qa-case-row" data-case-id="${escapeHtml(item.id)}"><div><small>${Math.round(item.scoreBefore)} → ${Math.round(item.scoreAfter)} · ${escapeHtml(item.source.slice(0, 55))}</small><p><s>${escapeHtml((item.rejectedTranslation || "").slice(0, 90))}</s> → <strong>${escapeHtml((item.correctedTranslation || "").slice(0, 90))}</strong></p></div><div class="qa-case-actions"><button class="button secondary small" data-action="approve-case">采纳为反例</button><button class="button ghost small" data-action="dispose-case">作废</button></div></div>`).join("") : '<div class="empty-list">当前没有待审核案例</div>';

  $$(".style-guidance-card [data-action], #manualGuideStatus [data-action]").forEach((button) => button.addEventListener("click", async () => {
    const id = button.closest("[data-profile-id]").dataset.profileId;
    const action = button.dataset.action;
    if (action === "copy-guide") {
      // 指南可能几千字：复制走剪贴板，内容直接从当前数据里取，不依赖 DOM 截断。
      const guide = (state.styleData?.profiles?.userProfiles || []).find((item) => item.id === id);
      try {
        await navigator.clipboard.writeText(String(guide?.instruction || ""));
        toast("已复制人工风格指南全文");
      } catch (error) { toast(`复制失败：${error.message}`); }
      return;
    }
    button.disabled = true;
    try {
      await api(`/api/style-profiles/${encodeURIComponent(id)}/${action === "activate" ? "activate" : "reject"}`, { method: "POST", body: JSON.stringify(projectPayload()) });
      toast(action === "activate" ? "风格已启用，后续翻译将注入该规则" : "风格已关闭，历史版本仍保留但不参与翻译");
      await loadStyleGuidance(state.styleLocale);
    } catch (error) { button.disabled = false; toast(error.message); }
  }));
  $$("#styleQaList .qa-case-row [data-action]").forEach((button) => button.addEventListener("click", async () => {
    const id = button.closest(".qa-case-row").dataset.caseId;
    try {
      await api(`/api/qa-cases/${encodeURIComponent(id)}/${button.dataset.action === "approve-case" ? "approve" : "dispose"}`, { method: "POST" });
      toast(button.dataset.action === "approve-case" ? "已采纳为 AIQA 反例" : "已作废该案例");
      await loadStyleGuidance(state.styleLocale);
    } catch (error) { toast(error.message); }
  }));
}

const LOG_LEVEL_LABELS = { debug: "调试", info: "信息", warn: "警告", error: "错误" };
const LOG_AUTO_REFRESH_MS = 3_000;
let logAutoRefreshTimer = null;

function logTimeLabel(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function renderLogs() {
  const entries = state.logs || [];
  $("#logCount").textContent = `${entries.length} 条`;
  const errors = entries.filter((entry) => entry.level === "error").length;
  bumpLogBadge(errors);
  $("#logHint").textContent = errors
    ? `当前筛选下有 ${errors} 条错误。记录等级决定服务端记多少：调到「调试」会记下更多细节，调到「仅错误」只留报错。`
    : "记录等级决定服务端记多少：调到「调试」会记下更多细节，调到「仅错误」只留报错。";
  $("#logList").innerHTML = entries.length ? entries.map((entry) => `
    <div class="log-row ${escapeHtml(entry.level)}">
      <span class="log-time">${escapeHtml(logTimeLabel(entry.ts))}${entry.previous ? '<em class="log-previous">上次运行</em>' : ""}</span>
      <span class="log-level ${escapeHtml(entry.level)}">${escapeHtml(LOG_LEVEL_LABELS[entry.level] || entry.level)}</span>
      <div class="log-body"><p class="log-message">${escapeHtml(entry.message)}</p>${entry.detail ? `<p class="log-detail">${escapeHtml(entry.detail)}</p>` : ""}</div>
    </div>`).join("") : '<div class="empty-list">当前筛选下没有日志</div>';
  $$("#logLevels .log-level-chip").forEach((chip) => chip.classList.toggle("active", chip.dataset.level === (state.logLevel || "")));
}

/** 侧边栏角标：有几条错误可查。正在看日志页时不打扰。 */
function bumpLogBadge(count) {
  state.logErrorCount = Math.max(0, Number(count) || 0);
  const badge = $("#logNavBadge");
  if (!badge) return;
  badge.hidden = state.logErrorCount === 0 || state.view === "logs";
  badge.textContent = String(state.logErrorCount);
}

async function loadLogs() {
  if (!state.bootstrap) return;
  const params = new URLSearchParams({ limit: "300" });
  if (state.logLevel) params.set("level", state.logLevel);
  if (state.logSearch) params.set("search", state.logSearch);
  const payload = await api(`/api/logs?${params}`);
  state.logs = payload.entries || [];
  const level = payload.settings?.level;
  if (level && $("#logVerbosity")) $("#logVerbosity").value = level;
  renderLogs();
}

function startLogAutoRefresh() {
  stopLogAutoRefresh();
  if (!$("#logAutoRefresh")?.checked) return;
  logAutoRefreshTimer = setInterval(() => {
    if (state.view !== "logs") return;
    loadLogs().catch(() => {});
  }, LOG_AUTO_REFRESH_MS);
}

function stopLogAutoRefresh() {
  if (logAutoRefreshTimer) clearInterval(logAutoRefreshTimer);
  logAutoRefreshTimer = null;
}

async function loadAssets(locale) {
  state.assetLocale = locale;
  await loadProjectLibraries();
  renderLibraryTable("term");
  if (state.assetLibraryId) await loadLibraryEntries("term", { append: false });
  else renderAssetLibrarySummary();
}

function updateBatchSegmentationOptions(filename = "") {
  const structured = /\.(xlsx|csv|xliff|mqxliff)$/iu.test(String(filename));
  const select = $("#batchSegmentationMode");
  if (!select) return;
  for (const option of select.options) option.hidden = structured ? !["unit", "group"].includes(option.value) : ["unit", "group"].includes(option.value);
  if (structured && !["unit", "group"].includes(select.value)) select.value = "unit";
  if (!structured && !["sentence", "paragraph"].includes(select.value)) select.value = "sentence";
  const label = select.closest("label")?.querySelector("span");
  if (label) label.textContent = structured ? "结构化文件翻译方式" : "翻译单元";
}

async function updateMemoryLocale(locale) {
  state.memoryLocale = locale;
  renderLocaleStrip($("#memoryLocales"), locale, updateMemoryLocale);
  await loadMemories(locale);
}

const MEMORY_PAGE_SIZE = 500;
let memorySearchTimer;
let termSearchTimer;

/**
 * 记忆库按页读取：标题写"已显示 N / 共 M 条"，搜索也交给服务端。
 * 之前接口固定 limit=500 且前端只在前 500 条里过滤，用户会以为库里只有 500 条。
 */
async function loadMemories(locale, { append = false } = {}) {
  state.memoryLocale = locale;
  await loadProjectLibraries();
  renderLibraryTable("tm");
  if (state.memoryLibraryId) await loadLibraryEntries("tm", { append: false });
  else renderMemoryLibrarySummary();
  return undefined;
}

function renderMemoryCount() {
  renderEntryCount("tm");
}

/**
 * 文件清单 + 逐文件状态。用户最需要的是"它确实在动"：每个文件一行，
 * 状态从 待预检 → 识别中 → 已识别 N 条 / 失败，而不是一句静止的"正在预检"。
 */
function renderImportFileList(container, files, states) {
  if (!container) return;
  const totalBytes = files.reduce((sum, file) => sum + (file?.size || 0), 0);
  const done = files.filter((file) => states.get(file.name)?.status === "done" || states.get(file.name)?.status === "failed").length;
  const failed = files.filter((file) => states.get(file.name)?.status === "failed").length;
  container.hidden = !files.length;
  if (!files.length) { container.innerHTML = ""; return; }
  container.innerHTML = `<div class="import-file-head"><strong>${files.length} 个文件 · ${formatBytes(totalBytes)}</strong><span>已预检 ${done} / ${files.length}${failed ? ` · 失败 ${failed}` : ""}</span></div>
    <ul>${files.map((file) => {
      const state = states.get(file.name) || { status: "pending" };
      const label = state.status === "done" ? `已识别 ${state.entries || 0} 条`
        : state.status === "running" ? "识别中…"
          : state.status === "failed" ? `失败：${state.error || "解析失败"}`
            : "待预检";
      return `<li class="${state.status}"><span class="import-file-name">${escapeHtml(file.name)}</span><small>${escapeHtml(formatBytes(file.size))}</small><em>${escapeHtml(label)}</em></li>`;
    }).join("")}</ul>`;
}

function elapsedText(startedAt) {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`;
}

/**
 * 双语资产预检。去向与清洗开关在**上传前**就已经定了：整批一个类型，
 * 需要混合处理时分两次导入，避免"同一个文件既当术语又当 TM"。
 * 预检逐文件进行，进度与每个文件的结果都直接显示在拖入区下方。
 */
async function setImportFiles(files = [], {
  intent = "auto",
  returnView = "",
  purpose = "",
  aiCleaning = null,
  styleEvidence = null,
  fromWizard = false
} = {}) {
  const selected = Array.from(files).filter(Boolean);
  if (!selected.length) return;
  const supported = /\.(xlsx|csv|xliff|mqxliff)$/iu;
  const invalid = selected.find((file) => !supported.test(file.name));
  if (invalid) return toast(`${invalid.name} 不是支持的双语资产格式`);
  // 与记忆库、批次入口统一：单文件 20MB，一次最多 200 个文件；不再限制单次总量
  //（预检是逐文件请求，请求体积不随文件数量增长）。
  const oversize = selected.find((file) => file.size > MEMORY_IMPORT_FILE_BYTES);
  if (oversize) return toast(`${oversize.name} 超过单文件 ${UPLOAD_FILE_LABEL} 上限（${formatBytes(oversize.size)}）`);
  if (selected.length > IMPORT_MAX_FILES) return toast(`一次最多选择 ${IMPORT_MAX_FILES} 个文件，当前 ${selected.length} 个`);
  const resolvedPurpose = purpose || (intent === "terms" ? "term" : readImportPurpose());
  state.importFiles = selected;
  state.importFile = selected[0];
  state.assetPreflight = null;
  state.assetImportIntent = intent;
  state.assetImportReturnView = returnView;
  state.assetImportPurpose = resolvedPurpose;
  // 默认值只在切换类型时由 syncImportPurposeControls 给（人工 TM 默认勾、术语表默认不勾）；
  // 这里一律以界面上的当前勾选为准，否则用户刚取消的勾选会被"默认值"又勾回去。
  state.assetImportAiCleaning = resolvedPurpose === "term" ? (aiCleaning ?? readImportAiCleaning()) : false;
  state.assetImportStyleEvidence = styleEvidence ?? readImportStyleEvidence();
  state.assetImportTaskId = "";
  state.assetImportWizard = fromWizard;
  assetPreflightOutcome = null;
  $("#filePrompt").textContent = selected.length === 1 ? selected[0].name : `已选择 ${selected.length} 个文件`;
  $("#dropZone").classList.add("has-file");
  const fileStates = new Map(selected.map((file) => [file.name, { status: "pending", entries: 0, error: "" }]));
  renderImportFileList($("#importFileList"), selected, fileStates);
  const startedAt = Date.now();
  const progress = (message, percent) => {
    $("#fileMeta").textContent = `${message} · 已用时 ${elapsedText(startedAt)}（本地解析，不调用模型）`;
    updateImportProgress({ message, percent });
  };
  try {
    // 一个文件一个请求：进度是真实的 N/M，而且某个文件坏了不会把整批带崩。
    const merged = { batchId: "", files: [], candidates: [], duplicates: { existing: 0, conflict: 0 }, statistics: { files: 0, entries: 0, anomalies: 0 } };
    const failures = [];
    for (const [index, file] of selected.entries()) {
      fileStates.get(file.name).status = "running";
      renderImportFileList($("#importFileList"), selected, fileStates);
      progress(`正在预检 ${index + 1} / ${selected.length}：${file.name}`, Math.round((index / selected.length) * 100));
      try {
        const result = await api("/api/assets-import/preview", { method: "POST", body: JSON.stringify({
          ...projectPayload(),
          // 类型决定要不要在预检里比对库内术语：选"人工 TM"时服务端不做这项开销。
          purpose: state.assetImportPurpose,
          files: [{ filename: file.name, base64: await fileToBase64(file) }]
        }) });
        if (!merged.batchId) merged.batchId = result.batchId;
        merged.files.push(...(result.files || []));
        merged.candidates.push(...(result.candidates || []));
        merged.duplicates.existing += result.duplicates?.existing || 0;
        merged.duplicates.conflict += result.duplicates?.conflict || 0;
        merged.statistics.files += result.files?.length || 0;
        merged.statistics.entries += result.statistics?.entries || 0;
        merged.statistics.anomalies += result.statistics?.anomalies || 0;
        fileStates.get(file.name).status = "done";
        fileStates.get(file.name).entries = result.statistics?.entries || 0;
      } catch (error) {
        failures.push({ filename: file.name, error: error.message });
        merged.files.push({ filename: file.name, type: "invalid", entries: 0, anomalies: [error.message], defaultPurpose: "term" });
        merged.statistics.files += 1;
        merged.statistics.anomalies += 1;
        fileStates.get(file.name).status = "failed";
        fileStates.get(file.name).error = error.message;
      }
      renderImportFileList($("#importFileList"), selected, fileStates);
    }
    progress(`预检完成：${selected.length - failures.length} / ${selected.length} 个文件，共 ${merged.statistics.entries} 条双语条目`, 100);
    state.assetPreflight = { ...merged, failures };
    renderAssetPreflight();
    resetAssetImportProgress();
    $("#assetPreflightDialog").showModal();
    if (fromWizard) {
      // 向导必须等用户处理完预检弹窗再推进，否则会在弹窗后面偷偷跳过这一步。
      return await new Promise((resolve) => { assetPreflightDeferred = { resolve }; });
    }
    return { submitted: false };
  } catch (error) {
    $("#importFileList").hidden = false;
    $("#fileMeta").textContent = `预检中断：${error.message}`;
    updateImportProgress({ message: `预检中断：${error.message}`, percent: 100 });
    toast(error.message);
    return { submitted: false };
  }
}

function readImportPurpose() {
  const checked = $$('input[name="importPurpose"]').find((input) => input.checked);
  return checked?.value === "tm" ? "tm" : "term";
}

function readImportAiCleaning() {
  return Boolean($("#importAiCleaning")?.checked);
}

function readImportStyleEvidence() {
  return Boolean($("#importStyleEvidence")?.checked);
}

/**
 * 类型选择联动：AI 清洗只对术语表有意义（人工 TM 本来就已人工确认），
 * 风格证据则默认跟着类型走（人工 TM 默认写、术语表默认不写）。
 */
function syncImportPurposeControls({ resetDefaults = false } = {}) {
  const purpose = readImportPurpose();
  state.assetImportPurpose = purpose;
  const aiRow = $("#importAiCleaningRow");
  if (aiRow) aiRow.hidden = purpose !== "term";
  if (resetDefaults) {
    if ($("#importAiCleaning")) $("#importAiCleaning").checked = false;
    if ($("#importStyleEvidence")) $("#importStyleEvidence").checked = purpose === "tm";
  }
}

/** 预检弹窗的收尾：向导要等它关掉才知道这一步到底提交了什么。 */
let assetPreflightDeferred = null;
let assetPreflightOutcome = null;

function resolveAssetPreflight() {
  const deferred = assetPreflightDeferred;
  assetPreflightDeferred = null;
  if (deferred) deferred.resolve(assetPreflightOutcome || { submitted: false });
}

function closeAssetPreflightDialog() {
  const dialog = $("#assetPreflightDialog");
  if (dialog?.open) dialog.close();
  resolveAssetPreflight();
}

function resetAssetImportProgress() {
  const container = $("#assetImportProgress");
  if (!container) return;
  container.hidden = true;
  $("#assetImportProgressBar").style.width = "0%";
}

function updateAssetImportProgress(progress = {}) {
  const container = $("#assetImportProgress");
  if (!container) return;
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  container.hidden = false;
  const elapsed = state.assetImportStartedAt ? ` · 已用时 ${((Date.now() - state.assetImportStartedAt) / 1000).toFixed(1)} 秒` : "";
  $("#assetImportProgressText").textContent = `${progress.message || "正在导入"}${progress.status === "completed" || progress.status === "failed" ? "" : elapsed}`;
  $("#assetImportProgressMeta").textContent = `${percent}%`;
  $("#assetImportProgressBar").style.width = `${percent}%`;
  container.classList.toggle("is-failed", progress.status === "failed");
}

/** 提交与执行期间让"已用时"持续走动：静止的界面让人以为卡死了。 */
function startAssetImportTicker() {
  stopAssetImportTicker();
  state.assetImportTicker = window.setInterval(() => {
    if (!state.assetImportProgress) return;
    updateAssetImportProgress(state.assetImportProgress);
  }, 500);
}

function stopAssetImportTicker() {
  if (state.assetImportTicker) window.clearInterval(state.assetImportTicker);
  state.assetImportTicker = 0;
}

function rememberAssetImportProgress(progress) {
  state.assetImportProgress = { ...(state.assetImportProgress || {}), ...progress };
  updateAssetImportProgress(state.assetImportProgress);
}

function renderAssetPreflight() {
  const preview = state.assetPreflight;
  if (!preview) return;
  const aiRow = $("#assetPreflightAiRow");
  if (aiRow) aiRow.hidden = state.assetImportPurpose !== "term";
  if ($("#assetPreflightAiCleaning")) $("#assetPreflightAiCleaning").checked = state.assetImportAiCleaning;
  if ($("#assetPreflightStyleEvidence")) $("#assetPreflightStyleEvidence").checked = state.assetImportStyleEvidence;
  const purposeLabel = state.assetImportPurpose === "tm" ? "写入人工主 TM" : state.assetImportAiCleaning ? "AI 清洗后分库写入" : "按表直接导入（本地规则分流）";
  $("#assetPreflightBody").innerHTML = (preview.files || []).map((file) => {
    const duplicates = file.duplicates || {};
    const duplicateBadges = [
      duplicates.existing ? `<span class="badge neutral">库内已存在 ${Number(duplicates.existing)}</span>` : "",
      duplicates.conflict ? `<span class="badge warning">与库内译法冲突 ${Number(duplicates.conflict)}</span>` : ""
    ].filter(Boolean).join("");
    return `<tr><td>${escapeHtml(file.filename)}</td><td>${escapeHtml(file.type || "未知")}</td><td>${Number(file.entries) || 0}</td><td>${escapeHtml(purposeLabel)}</td><td><small>${escapeHtml((file.anomalies || []).join("；") || "未发现异常")}${state.assetImportStyleEvidence ? " · 写入风格证据" : ""}</small>${duplicateBadges ? `<div class="preflight-duplicate-flags">${duplicateBadges}</div>` : ""}</td></tr>`;
  }).join("") || '<tr><td colspan="5" class="table-empty">没有可预检的文件</td></tr>';
  const cleaningText = state.assetImportPurpose === "tm"
    ? "不调用模型"
    : state.assetImportAiCleaning ? "AI 清洗（较慢）" : "不调用模型，按本地规则分流";
  const duplicates = preview.duplicates || {};
  // 预检就讲清楚库里已经有什么：同对照会跳过，冲突不覆盖，两者都要用户先知道。
  const duplicateText = duplicates.existing || duplicates.conflict
    ? ` 其中库内已存在相同对照 ${duplicates.existing || 0} 条（入库时跳过）、与库内译法冲突 ${duplicates.conflict || 0} 条（不会覆盖库内条目，要改用术语库页面手动改）。`
    : "";
  $("#assetPreflightSummary").textContent = `已识别 ${preview.files?.length || 0} 个文件、${preview.statistics?.entries || 0} 条双语条目。去向：${purposeLabel}；${cleaningText}。${duplicateText}确认后进入后台导入。`;
  const termLibrary = libraryById("term", state.importTermLibraryId);
  const tmLibrary = libraryById("tm", state.importTmLibraryId);
  const targetParts = state.assetImportPurpose === "tm"
    ? [`人工 TM → ${tmLibrary?.name || "主 TM"}`]
    : [`术语 → ${termLibrary?.name || "默认术语库"}`, `句段 → ${tmLibrary?.name || "主 TM"}`];
  $("#assetPreflightTarget").textContent = `目标库：${targetParts.join(" · ")}（在「项目设置 → 资源库」里调整）`;
}

async function confirmAssetPreflight() {
  const preview = state.assetPreflight;
  if (!preview) return;
  const candidates = (preview.candidates || []).map((candidate) => ({ ...candidate, selected: candidate.selected !== false }));
  if (!candidates.length) return toast("没有可入库的双语条目");
  const purpose = state.assetImportPurpose;
  // 弹窗里的勾选是最终生效值（预检弹窗可能来自术语库/记忆库页面，那里没有前置选择器）。
  const aiCleaning = purpose === "term" && Boolean($("#assetPreflightAiCleaning")?.checked);
  const styleEvidence = Boolean($("#assetPreflightStyleEvidence")?.checked);
  state.assetImportAiCleaning = aiCleaning;
  state.assetImportStyleEvidence = styleEvidence;
  try {
    // 点下确认就立刻切成进度视图：这次请求只创建后台任务，但用户不该盯着灰按钮猜。
    state.assetImportStartedAt = Date.now();
    state.assetImportProgress = { phase: "submitting", message: "正在创建后台导入任务…", percent: 0 };
    updateAssetImportProgress(state.assetImportProgress);
    startAssetImportTicker();
    $("#assetPreflightConfirm").disabled = true;
    $("#assetPreflightConfirm").textContent = "提交中…";
    $("#assetPreflightSummary").textContent = `正在创建后台导入任务：${candidates.length} 条条目、${state.importFiles?.length || 0} 个文件。任务一旦创建，关掉这个窗口也会继续跑完。`;
    const result = await api("/api/assets-import/commit", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      batchId: preview.batchId,
      filename: state.importFile?.name || "双语资产导入",
      candidates,
      purpose,
      aiCleaning,
      styleEvidence,
      termLibraryId: state.importTermLibraryId || "",
      tmLibraryId: state.importTmLibraryId || ""
    }) });
    const returnView = state.assetImportReturnView;
    const accepted = Number(result.accepted) || candidates.length;
    state.assetImportTaskId = result.taskId || result.backgroundTaskId || "";
    assetPreflightOutcome = {
      submitted: true,
      taskId: state.assetImportTaskId,
      batchId: result.batchId || preview.batchId,
      count: accepted,
      files: state.importFiles?.length || 0,
      aiCleaning,
      purpose
    };
    $("#assetPreflightConfirm").hidden = true;
    $("#assetPreflightClose").hidden = false;
    rememberAssetImportProgress({ status: "running", message: aiCleaning ? "任务已创建：先写审核队列，再做 AI 清洗" : "任务已创建：先写审核队列，再按表导入", percent: 1 });
    toast(`已开始后台导入 ${accepted} 条；可以关掉这个窗口继续下一步`);
    if (returnView) {
      $("#assetPreflightTableWrap").hidden = true;
      $("#assetPreflightSummary").textContent = `已提交后台导入：${state.importFiles?.length || 0} 个文件、${accepted} 条双语条目。${aiCleaning ? "先做 AI 清洗再入库。" : "按本地规则分流写入。"}可以关掉这个窗口，向导会继续下一步，进度与结果在任务中心可查。`;
    }
    watchAssetImportTask(state.assetImportTaskId, { returnView }).catch(() => {});
  } catch (error) {
    stopAssetImportTicker();
    rememberAssetImportProgress({ status: "failed", message: `创建后台任务失败：${error.message}`, percent: 0 });
    $("#assetPreflightConfirm").disabled = false;
    $("#assetPreflightConfirm").textContent = "确认并继续";
    toast(error.message);
  }
}

/**
 * 后台导入的进度与收尾。页面被关掉也没关系：任务在服务端继续跑，
 * 任务中心会保留进度与跳过明细。
 */
async function watchAssetImportTask(taskId, { returnView = "" } = {}) {
  if (!taskId) return;
  let finished = false;
  while (!finished) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    let task = null;
    try {
      task = await api(`/api/background-tasks/${encodeURIComponent(taskId)}`);
    } catch { finished = true; break; }
    if (!task) { finished = true; break; }
    rememberAssetImportProgress({ status: task.status, ...(task.progress || {}) });
    if (task.status === "completed" || task.status === "failed" || task.status === "needs_attention") {
      finished = true;
      stopAssetImportTicker();
      const summary = task.payload?.summary;
      if (task.status === "completed") {
        const skipped = Number(summary?.skipped) || 0;
        const text = `导入完成：术语 ${summary?.terms || 0} 条、主 TM ${summary?.memories || 0} 条${skipped ? `、跳过 ${skipped} 条（${Object.entries(summary?.skippedByReason || {}).map(([reason, count]) => `${reason} ${count}`).join("；")}）` : ""}。`;
        $("#mappingNote").textContent = text;
        toast(text);
        await Promise.all([loadAssets(state.assetLocale), loadMemories(state.memoryLocale)]);
      } else {
        $("#mappingNote").textContent = `后台导入未完成：${task.progress?.message || task.payload?.error || "未知原因"}。可在任务中心点「继续导入」补齐。`;
        toast("后台导入未完成，可在任务中心继续导入");
      }
      if (returnView) switchView(returnView);
    }
  }
}

/** 已选的人工 TM 文件列表 + 逐文件预检状态。 */
function renderMemoryImportFiles(states = new Map()) {
  const container = $("#memoryImportFiles");
  const files = state.memoryImportFiles.length ? state.memoryImportFiles : [state.memoryImportFile].filter(Boolean);
  if (!container) return;
  const button = $("#memoryImportButton");
  if (button) button.textContent = files.length > 1 ? `预检 ${files.length} 个文件` : "预检 TM";
  renderImportFileList(container, files, states);
}

function formatBytes(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const UPLOAD_FILE_BYTES = 20 * 1024 * 1024;
const UPLOAD_FILE_LABEL = String(Math.round(UPLOAD_FILE_BYTES / (1024 * 1024))) + "MB";
/** 兼容旧名字：预检与上传共用同一个单文件上限。 */
const MEMORY_IMPORT_FILE_BYTES = UPLOAD_FILE_BYTES;
/** 一次最多选多少个文件：预检是逐文件的，这里只是防止误拖几百个文件把界面卡住。 */
const IMPORT_MAX_FILES = 200;

function validateMemoryImportFiles(files) {
  const tooBig = files.find((file) => file.size > MEMORY_IMPORT_FILE_BYTES);
  if (tooBig) return `${tooBig.name} 超过单文件 ${UPLOAD_FILE_LABEL} 上限（${formatBytes(tooBig.size)}）`;
  if (files.length > IMPORT_MAX_FILES) return `一次最多选择 ${IMPORT_MAX_FILES} 个文件，当前 ${files.length} 个`;
  return "";
}

/** 记忆库页行内「导入」：目标库固定为这一行，打开弹窗再选文件（预检 → 确认写库）。 */
function openMemoryImportDialog(libraryId) {
  const library = libraryById("tm", libraryId);
  state.memoryImportTargetId = String(libraryId || "");
  state.memoryImportFiles = [];
  state.memoryImportFile = null;
  state.memoryImportPreview = null;
  const picker = $("#memoryFile");
  if (picker) picker.value = "";
  $("#memoryImportTarget").textContent = library
    ? `目标库：${library.name}（${libraryRoleLabel("tm", library)} · 优先级 ${Number(library.priority) || 1}）`
    : "目标库：主 TM";
  $("#memoryImportButton").disabled = true;
  $("#memoryImportButton").textContent = "预检 TM";
  renderMemoryImportFiles();
  $("#memoryImportNote").textContent = `选择文件后会自动本地预检（不调用模型）；确认后写入「${library?.name || "主 TM"}」，并自动接回当前项目中可唯一定位的原翻译轨迹。`;
  $("#memoryImportPreview").hidden = true;
  $("#memoryImportProgress").hidden = true;
  $("#memoryImportDialog").showModal();
}

async function previewMemoryImport() {
  const files = state.memoryImportFiles.length ? state.memoryImportFiles : [state.memoryImportFile].filter(Boolean);
  if (!files.length) return;
  const invalid = files.find((file) => !/\.(xlsx|csv|xliff|mqxliff)$/iu.test(file.name));
  if (invalid) return toast(`${invalid.name}：人工 TM 只支持 .xlsx、.csv、.xliff、.mqxliff`);
  const sizeError = validateMemoryImportFiles(files);
  if (sizeError) {
    $("#memoryImportNote").textContent = sizeError;
    renderMemoryImportFiles(new Map(files.map((file) => [file.name, { status: "failed", entries: 0, error: sizeError }])));
    return toast(sizeError);
  }
  try {
    $("#memoryImportButton").disabled = true;
    const startedAt = Date.now();
    const fileStates = new Map(files.map((file) => [file.name, { status: "pending", entries: 0, error: "" }]));
    renderMemoryImportFiles(fileStates);
    const candidates = [];
    const failures = [];
    let batchId = "";
    for (const [index, file] of files.entries()) {
      fileStates.get(file.name).status = "running";
      renderMemoryImportFiles(fileStates);
      $("#memoryImportNote").textContent = `正在本地预检 ${index + 1} / ${files.length}：${file.name} · 已用时 ${elapsedText(startedAt)}（解析表格 / XLIFF，不调用模型）`;
      try {
        const result = await api("/api/tm-import/preview", { method: "POST", body: JSON.stringify({
          ...projectPayload(),
          filename: file.name,
          files: [{ filename: file.name, base64: await fileToBase64(file) }]
        }) });
        if (!batchId) batchId = result.batchId;
        const found = (result.candidates || []).map((candidate) => ({ ...candidate, selected: candidate.selected !== false }));
        candidates.push(...found);
        fileStates.get(file.name).status = "done";
        fileStates.get(file.name).entries = found.length;
      } catch (error) {
        failures.push({ filename: file.name, error: error.message });
        fileStates.get(file.name).status = "failed";
        fileStates.get(file.name).error = error.message;
      }
      renderMemoryImportFiles(fileStates);
    }
    const preview = {
      batchId,
      filename: files.length === 1 ? files[0].name : `${files[0].name} 等 ${files.length} 个文件`,
      candidates
    };
    state.memoryImportPreview = preview;
    const evidenceText = state.memoryStyleEvidence ? "确认后同时写入主 TM 与风格学习证据。" : "确认后只写入主 TM，不进入风格证据池。";
    const failureText = failures.length ? `；${failures.length} 个文件解析失败：${failures.map((item) => `${item.filename}（${item.error}）`).join("、")}` : "";
    $("#memoryImportNote").textContent = `本地预检识别 ${preview.candidates.length} 条双语 TM（来自 ${files.length - failures.length} / ${files.length} 个文件，用时 ${elapsedText(startedAt)}）；尚未调用模型，也尚未写入数据库${failureText}。${evidenceText}`;
    $("#memoryImportPreview").hidden = false;
    // 条目 ID 列优先显示 memoQ 的 x-mmq-context（稳定身份），没有才退回表内序号。
    $("#memoryImportPreviewBody").innerHTML = preview.candidates.slice(0, 500).map((candidate, index) => `<tr><td><input type="checkbox" data-memory-index="${index}" ${candidate.selected ? "checked" : ""} /></td><td>${escapeHtml(candidate.entryKey || candidate.entryId || "")}</td><td>${escapeHtml(candidate.source)}</td><td>${escapeHtml(candidate.target)}</td><td>${escapeHtml([candidate.sourceFile, candidate.sourceRow ? `第 ${candidate.sourceRow} 行` : ""].filter(Boolean).join(" · "))}</td></tr>`).join("") || '<tr><td colspan="5" class="table-empty">没有可写入的双语条目</td></tr>';
    $("#memoryImportConfirm").disabled = !preview.candidates.length;
  } catch (error) {
    $("#memoryImportNote").textContent = `预检失败：${error.message}`;
    toast(error.message);
  } finally {
    $("#memoryImportButton").disabled = false;
  }
}

async function commitMemoryImport() {
  const preview = state.memoryImportPreview;
  if (!preview) return;
  const checked = new Set($$("#memoryImportPreviewBody [data-memory-index]").filter((input) => input.checked).map((input) => Number(input.dataset.memoryIndex)));
  const candidates = preview.candidates.map((candidate, index) => ({ ...candidate, selected: checked.has(index) }));
  if (!candidates.some((candidate) => candidate.selected)) return toast("请至少选择一条 TM");
  try {
    $("#memoryImportConfirm").disabled = true;
    // 写入改为后台任务：几千条要跑几分钟，界面得有进度、也要允许关页面。
    const started = await api("/api/tm-import/commit", { method: "POST", body: JSON.stringify({ ...projectPayload(), batchId: preview.batchId, filename: preview.filename, candidates, styleEvidence: state.memoryStyleEvidence, tmLibraryId: state.memoryImportTargetId || "", background: true }) });
    const taskId = started.taskId || started.backgroundTaskId;
    $("#memoryImportProgress").hidden = false;
    $("#memoryImportProgressText").textContent = `已提交后台写入 ${started.accepted ?? candidates.length} 条…`;
    const startedAt = Date.now();
    let task = null;
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      task = await api(`/api/background-tasks/${encodeURIComponent(taskId)}`).catch(() => null);
      if (!task) break;
      const percent = Math.max(0, Math.min(100, Number(task.progress?.percent) || 0));
      const done = task.status === "completed" || task.status === "failed";
      $("#memoryImportProgressText").textContent = `${task.progress?.message || "正在写入"}${done ? "" : ` · 已用时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`}`;
      $("#memoryImportProgressMeta").textContent = `${percent}%`;
      $("#memoryImportProgressBar").style.width = `${percent}%`;
      $("#memoryImportNote").textContent = "写入在后台执行：可以关掉这个页面，进度与结果都能在任务中心查到。";
      if (done) break;
    }
    const summary = task?.payload?.summary;
    const skippedText = Number(summary?.skipped) ? `；跳过 ${summary.skipped} 条` : "";
    const evidenceText = state.memoryStyleEvidence ? "，并已写入风格学习证据池" : "";
    if (task?.status === "completed") {
      const targetName = libraryById("tm", state.memoryImportTargetId)?.name || "目标 TM";
      $("#memoryImportNote").textContent = `TM 已写入「${targetName}」：${summary?.memories ?? 0} 条${evidenceText}；接回原翻译轨迹 ${summary?.trajectoriesLinked || 0} 条${skippedText}。`;
      toast("人工 TM 导入完成");
    } else {
      $("#memoryImportNote").textContent = `后台写入未完成：${task?.progress?.message || "请到任务中心查看"}。可在任务中心点「继续导入」补齐。`;
      toast("后台写入未完成，可在任务中心继续");
    }
    $("#memoryImportPreview").hidden = true;
    state.memoryImportPreview = null;
    await loadAssetsSafeRefresh("tm");
  } catch (error) {
    $("#memoryImportNote").textContent = error.message;
    toast(error.message);
  } finally {
    $("#memoryImportConfirm").disabled = false;
  }
}

function renderMemories() {
  // 搜索已在服务端完成：这里直接渲染服务端返回的这一页，不能再按输入框二次过滤，
  // 否则会把服务端匹配到的条目又筛掉（大小写、全半角等口径不一致）。
  renderLibraryEntries("tm");
}

/** 术语库 / 记忆库共用的库列表与条目视图。kind: "term" | "tm" */
const ENTRY_PAGE_SIZE = 500;

function projectLibraryList(kind) {
  return kind === "term" ? state.assetLibraries : state.memoryLibraries;
}

function libraryById(kind, id) {
  return projectLibraryList(kind).find((library) => library.id === String(id)) || null;
}

function libraryKindLabel(kind) {
  return kind === "term" ? "术语库" : "TM";
}

function libraryRoleLabel(kind, library) {
  if (kind === "term") return "术语库";
  if (library?.role === "master") return "主 TM";
  if (library?.role === "working") return "工作 TM";
  return "参考 TM";
}

function activeLibraryId(kind) {
  return kind === "term" ? state.assetLibraryId : state.memoryLibraryId;
}

function activeEntries(kind) {
  return kind === "term" ? state.assetEntries : state.memories;
}

function entrySearchValue(kind) {
  return ($(kind === "term" ? "#assetSearch" : "#memorySearch")?.value || "").trim();
}

/**
 * 库列表与导入下拉的唯一数据源：项目设置里的资源库 + 实时条目数。
 * 项目设置保存、库开关、删库之后都要重新调用它，保证两处永远一致。
 */
async function loadProjectLibraries() {
  if (!state.activeProjectId) return [];
  const payload = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/libraries?withStats=1`);
  const libraries = Array.isArray(payload.libraries) ? payload.libraries : [];
  state.assetLibraries = libraries.filter((library) => library.kind === "term_base");
  state.memoryLibraries = libraries.filter((library) => library.kind === "translation_memory");
  renderImportTargetOptions();
  return libraries;
}

/** 双语资产导入页的目标库下拉：只列启用中的库作为可选项，默认取主 TM / 首选术语库。 */
function renderImportTargetOptions() {
  const optionsOf = (libraries) => libraries
    .map((library) => `<option value="${escapeHtml(library.id)}" ${library.enabled ? "" : "disabled"}>${escapeHtml(library.name)}${library.enabled ? "" : "（未启用）"}</option>`)
    .join("");
  const termSelect = $("#importTermLibrary");
  if (termSelect) {
    termSelect.innerHTML = optionsOf(state.assetLibraries);
    const usable = state.assetLibraries.find((library) => library.id === state.importTermLibraryId && library.enabled)
      || state.assetLibraries.find((library) => library.enabled)
      || state.assetLibraries[0];
    state.importTermLibraryId = usable?.id || "";
    termSelect.value = state.importTermLibraryId;
  }
  const tmSelect = $("#importTmLibrary");
  if (tmSelect) {
    tmSelect.innerHTML = optionsOf(state.memoryLibraries);
    const usable = state.memoryLibraries.find((library) => library.id === state.importTmLibraryId && library.enabled)
      || state.memoryLibraries.find((library) => library.role === "master" && library.enabled)
      || state.memoryLibraries.find((library) => library.enabled)
      || state.memoryLibraries[0];
    state.importTmLibraryId = usable?.id || "";
    tmSelect.value = state.importTmLibraryId;
  }
}

function formatLibraryTime(value) {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return String(value);
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
}

function libraryRowMarkup(kind, library) {
  const entries = Number(library.entryCount) || 0;
  const roleLabel = libraryRoleLabel(kind, library);
  const roleClass = kind === "term" ? "term" : (library.role || "reference");
  const id = escapeHtml(library.id);
  // 工作 TM / 主 TM 是按翻译文件往里写的：把"几个文件"直接写在库行上，
  // 不然用户只看到一个总数，不知道里面其实是好几批。
  const fileBadge = kind === "tm" && Number(library.fileCount) > 0
    ? `<span class="library-badge files">${Number(library.fileCount)} 个文件</span>`
    : "";
  return `<tr class="library-row${library.enabled ? "" : " is-disabled"}" data-library-kind="${kind}" data-library-id="${id}">
    <td><label class="library-toggle"><input type="checkbox" data-library-toggle="1" data-kind="${kind}" data-id="${id}" ${library.enabled ? "checked" : ""} aria-label="启用/停用 ${escapeHtml(library.name)}" /><span aria-hidden="true"></span></label></td>
    <td><span class="library-badge ${roleClass}">${escapeHtml(roleLabel)}</span></td>
    <td><strong>${escapeHtml(library.name || "未命名资源库")}</strong>${fileBadge}<small>${escapeHtml(library.latestFile ? `最近：${library.latestFile}` : library.description || "")}</small></td>
    <td>日 → 简中</td>
    <td class="library-count">${entries}</td>
    <td>${Number(library.priority) || 1}</td>
    <td>${escapeHtml(formatLibraryTime(library.lastEntryAt))}</td>
    <td class="library-actions">
      <button class="button secondary small" type="button" data-library-action="open" data-kind="${kind}" data-id="${id}">打开</button>
      <button class="button ghost small" type="button" data-library-action="import" data-kind="${kind}" data-id="${id}" ${library.enabled ? "" : "disabled"} title="${library.enabled ? "导入到这个库" : "未启用的库不能作为导入目标"}">导入</button>
      <button class="button ghost small" type="button" data-library-action="export" data-kind="${kind}" data-id="${id}">导出</button>
      <button class="button ghost small" type="button" data-library-action="settings" data-kind="${kind}" data-id="${id}">设置</button>
      <button class="button ghost small danger" type="button" data-library-action="delete" data-kind="${kind}" data-id="${id}">删除</button>
    </td></tr>`;
}

function renderLibraryTable(kind) {
  const body = $(kind === "term" ? "#assetLibraryBody" : "#memoryLibraryBody");
  if (!body) return;
  const libraries = projectLibraryList(kind);
  const total = libraries.reduce((sum, library) => sum + (Number(library.entryCount) || 0), 0);
  const mergeRow = `<tr class="library-row is-merge" data-library-kind="${kind}" data-library-id="">
    <td><span class="library-merge-dot" title="合并视图不改变任何库的启用状态"></span></td>
    <td><span class="library-badge merge">合并</span></td>
    <td><strong>全部库（合并视图）</strong><small>把当前语言的 ${libraries.length} 个${libraryKindLabel(kind)}合并查看</small></td>
    <td>日 → 简中</td>
    <td class="library-count">${total}</td>
    <td>—</td><td>—</td>
    <td class="library-actions">
      <button class="button secondary small" type="button" data-library-action="open" data-kind="${kind}" data-id="">打开</button>
      <button class="button ghost small" type="button" data-library-action="export" data-kind="${kind}" data-id="">导出</button>
    </td></tr>`;
  const rows = libraries.map((library) => libraryRowMarkup(kind, library)).join("");
  body.innerHTML = `${mergeRow}${rows}` || mergeRow;
  // 打开了具体库时表头写的是"已显示 N / 共 M 条"，不要被库列表的总数覆盖。
  if (!activeLibraryId(kind)) {
    if (kind === "term") renderAssetLibrarySummary();
    else renderMemoryLibrarySummary();
  }
}

function renderAssetLibrarySummary() {
  const total = state.assetLibraries.reduce((sum, library) => sum + (Number(library.entryCount) || 0), 0);
  $("#assetRevision").textContent = `${total} 条`;
  $("#assetList").innerHTML = "";
}

function renderMemoryLibrarySummary() {
  const total = state.memoryLibraries.reduce((sum, library) => sum + (Number(library.entryCount) || 0), 0);
  $("#memoryCount").textContent = `${total} 条`;
  const more = $("#memoryMoreBar");
  if (more) more.hidden = true;
  $("#memoryList").innerHTML = "";
}

/** 两级切换：库列表 ↔ 条目视图，面包屑显示当前库。 */
function renderLibraryShell(kind) {
  const libraryId = activeLibraryId(kind);
  const fileId = kind === "tm" ? state.memoryLibraryFile : "";
  const listView = $(kind === "term" ? "#assetLibraryView" : "#memoryLibraryView");
  const filesView = kind === "tm" ? $("#memoryFilesView") : null;
  const entryView = $(kind === "term" ? "#assetEntryView" : "#memoryEntryView");
  const breadcrumb = $(kind === "term" ? "#assetBreadcrumb" : "#memoryBreadcrumb");
  const backButton = $(kind === "term" ? "#assetBreadcrumbBack" : "#memoryBreadcrumbBack");
  const nameNode = $(kind === "term" ? "#assetBreadcrumbName" : "#memoryBreadcrumbName");
  const metaNode = $(kind === "term" ? "#assetBreadcrumbMeta" : "#memoryBreadcrumbMeta");
  const fileNode = kind === "tm" ? $("#memoryBreadcrumbFile") : null;
  const library = libraryId ? libraryById(kind, libraryId) : null;
  // 库里还没有按文件分组的条目时不停在空的文件层，直接进条目（不然是个死胡同）。
  const hasFiles = (state.memoryLibraryFiles || []).length > 0;
  const showFiles = kind === "tm" && Boolean(libraryId) && !fileId && hasFiles;
  if (listView) listView.hidden = Boolean(libraryId);
  if (filesView) filesView.hidden = !showFiles;
  if (entryView) entryView.hidden = !(libraryId && !showFiles);
  if (breadcrumb) breadcrumb.hidden = !libraryId;
  if (backButton) backButton.textContent = fileId ? "← 返回文件列表" : "← 返回库列表";
  if (library) {
    if (nameNode) nameNode.textContent = library.name || "未命名资源库";
    if (metaNode) metaNode.textContent = `${libraryRoleLabel(kind, library)} · ${Number(library.entryCount) || 0} 条 · 日 → 简中 · 优先级 ${Number(library.priority) || 1}`;
  }
  if (fileNode) {
    fileNode.hidden = !fileId;
    fileNode.textContent = fileId ? `当前文件：${fileId === "__none__" ? "未标注来源" : fileId}` : "";
  }
}

/** 库 → 文件 → 条目 的中间层：工作 TM / 主 TM 按翻译文件分开显示。 */
async function loadLibraryFiles(kind, libraryId) {
  const locale = kind === "term" ? state.assetLocale : state.memoryLocale;
  const params = new URLSearchParams({ locale, projectId: state.activeProjectId || "", libraryId });
  const payload = await api(`/api/library-files?${params}`);
  const files = Array.isArray(payload.files) ? payload.files : [];
  if (kind === "tm") state.memoryLibraryFiles = files;
  return files;
}

function renderLibraryFiles(kind) {
  if (kind !== "tm") return;
  const body = $("#memoryFileBody");
  if (!body) return;
  const files = state.memoryLibraryFiles || [];
  // 文件分组只是浏览/导出/清理的维度，会不会影响翻译匹配要看库的角色：
  // 工作 TM 的机器草稿按文件隔离；主 TM / 参考 TM 的匹配永远是整个库（跨文件）。
  const library = libraryById("tm", state.memoryLibraryId);
  const note = $("#memoryFilesNote");
  if (note) {
    note.textContent = library?.role === "working"
      ? "工作 TM 按翻译文件分开：每个文件一批机器译文，只在同一个文件内参与一致性参考；这里的「打开」只看该文件的条目。"
      : "文件分组只用于浏览、导出与清理。翻译匹配取的是整个库（跨全部文件），人工确认译文不受文件限制。";
  }
  body.innerHTML = files.length ? files.map((file) => {
    const key = escapeHtml(file.sourceFile || "__none__");
    const label = file.sourceFile || "未标注来源";
    const batch = file.batchId ? `${file.batchCount > 1 ? `${file.batchCount} 个批次 · ` : ""}${String(file.batchId).slice(0, 8)}` : "—";
    return `<tr class="library-row" data-file-key="${key}">
      <td><strong>${escapeHtml(label)}</strong>${file.sourceFile ? "" : "<small>单句翻译等没有文件名的条目</small>"}</td>
      <td class="library-count">${Number(file.entryCount) || 0}</td>
      <td>${escapeHtml(batch)}</td>
      <td>${escapeHtml(formatLibraryTime(file.lastEntryAt))}</td>
      <td class="library-actions">
        <button class="button secondary small" type="button" data-file-action="open" data-key="${key}">打开</button>
        <button class="button ghost small" type="button" data-file-action="export" data-key="${key}">导出</button>
        <button class="button ghost small danger" type="button" data-file-action="delete" data-key="${key}">删除该文件草稿</button>
      </td></tr>`;
  }).join("") : '<tr><td colspan="5" class="table-empty">这个库里还没有按文件分组的条目</td></tr>';
  // 文件数据是异步到的：渲染完要重算一次外壳（有没有文件决定停在文件层还是直接进条目），
  // 否则中途的重绘会按"空文件表"把文件层隐藏掉。
  renderLibraryShell(kind);
}

async function openLibraryFile(kind, fileKey) {
  if (kind !== "tm") return;
  state.memoryLibraryFile = String(fileKey || "");
  renderLibraryShell(kind);
  const search = $("#memorySearch");
  if (search) search.value = "";
  await loadLibraryEntries("tm", { append: false });
}

async function closeLibraryFile(kind) {
  if (kind !== "tm") return;
  state.memoryLibraryFile = "";
  renderLibraryShell(kind);
  // 先用已有数据把文件列表画出来（切换要立刻生效），刷新在后台做。
  renderLibraryFiles(kind);
  loadLibraryFiles(kind, state.memoryLibraryId)
    .then(() => renderLibraryFiles(kind))
    .catch(() => {});
}

/** 删掉某个文件在这个库里产生的条目（工作 TM 的按批次清理）。 */
async function deleteLibraryFile(kind, fileKey) {
  const file = (state.memoryLibraryFiles || []).find((item) => (item.sourceFile || "__none__") === fileKey);
  const label = file?.sourceFile || "未标注来源";
  const count = Number(file?.entryCount) || 0;
  const choice = await openChoiceDialog({
    kicker: "DELETE FILE ENTRIES",
    title: `删除「${label}」的条目`,
    summary: `这会删除该文件在这个库里的 ${count} 条条目（例如工作 TM 里这个文件产生的机器译文）。其它文件的条目不受影响。`,
    options: [
      { id: "delete", label: `删除这 ${count} 条`, hint: "只删这个文件在这个库里的条目，别的文件不动" },
      { id: "cancel", label: "取消", hint: "什么都不做" }
    ]
  });
  if (choice !== "delete") return;
  const locale = state.memoryLocale;
  await api(`/api/library-entries?locale=${encodeURIComponent(locale)}&kind=${kind}&projectId=${encodeURIComponent(state.activeProjectId)}&libraryId=${encodeURIComponent(state.memoryLibraryId)}&sourceFile=${encodeURIComponent(fileKey)}`, { method: "DELETE" });
  toast(`已删除「${label}」的 ${count} 条条目`);
  await loadAssetsSafeRefresh("tm");
  await closeLibraryFile("tm");
}

async function loadLibraryEntries(kind, { append = false } = {}) {
  const libraryId = activeLibraryId(kind);
  const locale = kind === "term" ? state.assetLocale : state.memoryLocale;
  const params = new URLSearchParams({ locale, kind, limit: String(ENTRY_PAGE_SIZE), search: entrySearchValue(kind) });
  if (state.activeProjectId) params.set("projectId", state.activeProjectId);
  if (libraryId) params.set("libraryId", libraryId);
  // TM 库停在文件列表时不取条目；打开某个文件后只取这个文件的行。
  if (kind === "tm" && state.memoryLibraryFile) params.set("sourceFile", state.memoryLibraryFile);
  if (append) params.set("offset", String(activeEntries(kind).length));
  const payload = await api(`/api/library-entries?${params}`);
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (kind === "term") {
    state.assetEntries = append ? [...state.assetEntries, ...items] : items;
    state.assetEntryTotal = Number(payload.total) || 0;
  } else {
    state.memories = append ? [...state.memories, ...items] : items;
    state.memoryEntryTotal = Number(payload.total) || 0;
  }
  renderLibraryEntries(kind);
  renderEntryCount(kind);
}

function renderEntryCount(kind) {
  if (kind === "term") {
    const loaded = state.assetEntries.length;
    const total = Math.max(state.assetEntryTotal, loaded);
    $("#assetRevision").textContent = loaded < total ? `已显示 ${loaded} / 共 ${total} 条` : `${total} 条`;
    const more = $("#assetMoreBar");
    if (more) {
      more.hidden = loaded >= total;
      if (loaded < total) $("#assetMoreMeta").textContent = `还有 ${total - loaded} 条未显示`;
    }
    return;
  }
  const loaded = state.memories.length;
  const total = Math.max(state.memoryEntryTotal, loaded);
  $("#memoryCount").textContent = loaded < total ? `已显示 ${loaded} / 共 ${total} 条` : `${total} 条`;
  const more = $("#memoryMoreBar");
  if (more) {
    more.hidden = loaded >= total;
    if (loaded < total) $("#memoryMoreMeta").textContent = `还有 ${total - loaded} 条未显示`;
  }
}

function entriesEmptyText(kind) {
  return entrySearchValue(kind) ? "当前筛选没有条目" : `这个${libraryKindLabel(kind)}里还没有条目`;
}

function renderLibraryEntries(kind) {
  const items = activeEntries(kind);
  if (kind === "term") {
    $("#assetList").innerHTML = items.length ? items.map((term) => `
      <div class="asset-row" data-entry-id="${escapeHtml(term.id)}"><div class="asset-row-main"><strong>${escapeHtml(term.source)}</strong><span class="arrow">→</span><strong>${escapeHtml(term.target)}</strong><div class="asset-meta"><span>${escapeHtml(libraryById("term", term.libraryId)?.name || "正式术语")}</span>${(term.contentTypes || []).map((type) => `<span>${escapeHtml(state.bootstrap.contentTypes[type]?.label || type)}</span>`).join("")}${term.provenance ? `<span>${escapeHtml(term.provenance)}</span>` : ""}</div>${String(term.note || "").trim() ? `<p class="asset-note" title="${escapeHtml(term.note)}"><em>注释</em>${escapeHtml(term.note)}</p>` : ""}</div><div class="asset-row-actions"><button class="button ghost small" type="button" data-term-action="edit" data-id="${escapeHtml(term.id)}">编辑</button><button class="button ghost small danger" type="button" data-term-action="delete" data-id="${escapeHtml(term.id)}">删除</button></div></div>
    `).join("") : `<div class="empty-list asset-empty">${entriesEmptyText("term")}</div>`;
    return;
  }
  $("#memoryList").innerHTML = items.length ? items.map((item) => `
    <div class="asset-row" data-entry-id="${escapeHtml(item.id)}"><div class="asset-row-main"><strong>${escapeHtml(item.source)}</strong><span class="arrow">→</span><strong>${escapeHtml(item.target)}</strong><div class="asset-meta"><span>${escapeHtml(libraryById("tm", item.libraryId)?.name || (item.qualityStatus === "human_approved" ? "人工确认" : item.qualityStatus === "machine_verified" ? "机器译文" : "候选"))}</span><span>${item.qualityStatus === "human_approved" ? "人工确认" : item.qualityStatus === "machine_verified" ? "机器译文" : "候选"}</span>${item.entryKey ? `<span>${escapeHtml(item.entryKey)}</span>` : ""}${item.sourceFile ? `<span>${escapeHtml(item.sourceFile)}</span>` : ""}${item.batchId ? `<span>批次 ${escapeHtml(String(item.batchId).slice(0, 8))}</span>` : ""}${item.sourceRow ? `<span>第 ${item.sourceRow} 行</span>` : ""}</div></div><div class="asset-row-actions"><button class="button ghost small" type="button" data-memory-action="edit" data-id="${escapeHtml(item.id)}">编辑</button><button class="button ghost small danger" type="button" data-memory-action="delete" data-id="${escapeHtml(item.id)}">删除</button></div></div>
  `).join("") : `<div class="empty-list">${entriesEmptyText("tm")}</div>`;
}

async function openLibrary(kind, libraryId) {
  if (kind === "term") state.assetLibraryId = String(libraryId || "");
  else state.memoryLibraryId = String(libraryId || "");
  // 打开 TM 库先看"来源文件"这一层（工作 TM 的语义就是按文件分开的）；
  // 术语库没有文件语义，直接进条目。
  if (kind === "tm") {
    state.memoryLibraryFile = "";
    state.memoryLibraryFiles = [];
    if (state.memoryLibraryId) {
      try {
        await loadLibraryFiles("tm", state.memoryLibraryId);
      } catch (error) {
        toast(error.message);
      }
    }
    renderLibraryFiles("tm");
  }
  renderLibraryShell(kind);
  const search = $(kind === "term" ? "#assetSearch" : "#memorySearch");
  if (search) search.value = "";
  const showFiles = kind === "tm" && Boolean(state.memoryLibraryId) && (state.memoryLibraryFiles || []).length > 0;
  if (!showFiles) await loadLibraryEntries(kind, { append: false });
}

async function closeLibrary(kind) {
  if (kind === "term") {
    state.assetLibraryId = "";
    state.assetEntries = [];
    state.assetEntryTotal = 0;
  } else {
    state.memoryLibraryId = "";
    state.memoryLibraryFile = "";
    state.memoryLibraryFiles = [];
    state.memories = [];
    state.memoryEntryTotal = 0;
  }
  renderLibraryShell(kind);
  await loadAssetsSafeRefresh(kind);
}

/** 刷新库列表（含实时条目数）；库内条目视图打开时一并刷新。 */
async function loadAssetsSafeRefresh(kind) {
  await loadProjectLibraries();
  renderLibraryTable(kind);
  if (activeLibraryId(kind)) await loadLibraryEntries(kind, { append: false });
  else if (kind === "term") renderAssetLibrarySummary();
  else renderMemoryLibrarySummary();
}

async function toggleLibraryEnabled(kind, libraryId, enabled) {
  const library = libraryById(kind, libraryId);
  if (!library) return;
  await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/libraries/${encodeURIComponent(libraryId)}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled })
  });
  toast(enabled ? `已启用「${library.name}」，它会参与翻译检索` : `已停用「${library.name}」，它不再参与翻译检索`);
  await loadAssetsSafeRefresh(kind);
}

async function deleteLibrary(kind, libraryId) {
  const library = libraryById(kind, libraryId);
  if (!library) return;
  const count = Number(library.entryCount) || 0;
  const choice = await openChoiceDialog({
    kicker: "DELETE LIBRARY",
    title: `删除「${library.name}」`,
    summary: `这个库里现在有 ${count} 条条目。库设置会被删除，你要怎么处理库内条目？`,
    options: [
      { id: "keep", label: "仅删除库", hint: `${count} 条条目保留在数据库里，但不再归属任何库、也不再参与检索` },
      { id: "purge", label: `连条目一起删除（${count} 条）`, hint: "永久删除库内全部条目，无法恢复" }
    ]
  });
  if (!choice) return;
  try {
    if (choice === "purge" && count > 0) {
      const locale = kind === "term" ? state.assetLocale : state.memoryLocale;
      await api(`/api/library-entries?locale=${encodeURIComponent(locale)}&kind=${kind}&projectId=${encodeURIComponent(state.activeProjectId)}&libraryId=${encodeURIComponent(libraryId)}`, { method: "DELETE" });
    }
    await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/libraries/${encodeURIComponent(libraryId)}`, { method: "DELETE" });
    if (activeLibraryId(kind) === libraryId) {
      if (kind === "term") state.assetLibraryId = "";
      else state.memoryLibraryId = "";
      renderLibraryShell(kind);
    }
    toast(choice === "purge" ? `已删除「${library.name}」与库内 ${count} 条条目` : `已删除「${library.name}」，库内条目保留但不再归属`);
    await loadAssetsSafeRefresh(kind);
  } catch (error) { toast(error.message); }
}

/** 行内导入：术语走双语资产导入预检，TM 走人工 TM 预检弹窗，目标库就是这一行。 */
function importIntoLibrary(kind, libraryId) {
  const library = libraryById(kind, libraryId);
  if (!library) return;
  if (library.enabled !== true) return toast(`「${library.name}」未启用，不能作为导入目标`);
  if (kind === "term") {
    state.importTermLibraryId = library.id;
    if ($("#importTermLibrary")) $("#importTermLibrary").value = library.id;
    $("#termLibraryFile").click();
    return;
  }
  openMemoryImportDialog(library.id);
}

async function exportLibrary(kind, libraryId, button, sourceFile = "") {
  const library = libraryId ? libraryById(kind, libraryId) : null;
  const fileLabel = sourceFile ? ` · ${sourceFile === "__none__" ? "未标注来源" : sourceFile}` : "";
  const label = `${library ? library.name : `全部${libraryKindLabel(kind)}`}${fileLabel}`;
  if (button) {
    button.disabled = true;
    button.textContent = "提交中…";
  }
  try {
    await api("/api/library-export", {
      method: "POST",
      body: JSON.stringify({
        ...projectPayload(),
        locale: kind === "term" ? state.assetLocale : state.memoryLocale,
        kind,
        libraryId: libraryId || "",
        sourceFile: sourceFile || ""
      })
    });
    toast(`「${label}」导出已进入任务中心，跑完在那里下载 Excel`);
  } catch (error) { toast(error.message); }
  finally {
    if (button) {
      button.disabled = false;
      button.textContent = "导出";
    }
  }
}

function openTermEditDialog(entry) {
  const form = $("#assetForm");
  if (!form || !entry) return;
  form.reset();
  form.source.value = entry.source || "";
  form.target.value = entry.target || "";
  form.aliases.value = (entry.aliases || []).join(", ");
  form.forbidden.value = (entry.forbidden || []).join(", ");
  form.contentType.value = (entry.contentTypes || [])[0] || "general";
  form.note.value = entry.note || "";
  $("#assetDialogId").value = entry.id;
  $("#assetDialogTitle").textContent = "编辑术语";
  $("#assetDialogSubmit").textContent = "保存修改";
  const library = entry.libraryId ? libraryById("term", entry.libraryId) : null;
  $("#assetDialogTarget").textContent = `所属库：${library?.name || "未归属"} · 修改不会改变库归属`;
  $("#assetDialog").showModal();
}

function resetTermDialog() {
  const form = $("#assetForm");
  if (!form) return;
  form.reset();
  $("#assetDialogId").value = "";
  $("#assetDialogTitle").textContent = "新增单条术语";
  $("#assetDialogSubmit").textContent = "保存到当前语言库";
  const library = state.assetLibraryId ? libraryById("term", state.assetLibraryId) : null;
  $("#assetDialogTarget").textContent = library
    ? `将保存到：${library.name}`
    : "将保存到：项目里优先级最高的启用术语库（想指定库请先在术语库页打开那个库）";
}

async function deleteTermEntry(entry) {
  if (!entry) return;
  if (!confirm(`确认删除术语「${entry.source} → ${entry.target}」？删除后翻译不再参考它。`)) return;
  await api(`/api/assets/${encodeURIComponent(entry.id)}?locale=${encodeURIComponent(state.assetLocale)}&projectId=${encodeURIComponent(state.activeProjectId || "")}`, { method: "DELETE" });
  toast("已删除术语");
  await loadAssetsSafeRefresh("term");
}

function openMemoryEntryDialog(entry) {
  const form = $("#memoryEntryForm");
  if (!form || !entry) return;
  form.reset();
  form.source.value = entry.source || "";
  form.target.value = entry.target || "";
  form.entryKey.value = entry.entryKey || "";
  $("#memoryEntryId").value = entry.id;
  const library = entry.libraryId ? libraryById("tm", entry.libraryId) : null;
  $("#memoryEntryMeta").textContent = [
    `所属库：${library?.name || "未归属"}`,
    entry.qualityStatus === "human_approved" ? "人工确认" : entry.qualityStatus === "machine_verified" ? "机器译文" : "候选",
    entry.sourceFile ? `来源 ${entry.sourceFile}${entry.sourceRow ? ` 第 ${entry.sourceRow} 行` : ""}` : "",
    "修改不会改变库归属"
  ].filter(Boolean).join(" · ");
  $("#memoryEntryDialog").showModal();
}

async function deleteMemoryEntry(entry) {
  if (!entry) return;
  if (!confirm(`确认删除这条 TM 条目？\n${entry.source}\n→ ${entry.target}`)) return;
  await api(`/api/memories/${encodeURIComponent(entry.id)}?locale=${encodeURIComponent(state.memoryLocale)}`, { method: "DELETE" });
  toast("已删除 TM 条目");
  await loadAssetsSafeRefresh("tm");
}

async function setImportFile(file) {
  if (!file) return;
  if (!/\.(xlsx|csv)$/i.test(file.name)) return toast("请选择 .xlsx 或 .csv 表格");
  if (file.size > UPLOAD_FILE_BYTES) return toast(`表格不能超过 ${UPLOAD_FILE_LABEL}`);
  state.importFile = file;
  state.importPreview = null;
  state.importCompleted = false;
  state.importCandidateTab = "terms";
  state.importVisibleCount = { terms: 150, styles: 150 };
  state.importBatchLearning = [];
  $("#filePrompt").textContent = file.name;
  $("#fileMeta").textContent = `${(file.size / 1024).toFixed(1)} KB · AI 正在识别表格结构`;
  $("#dropZone").classList.add("has-file");
  $("#mappingNote").textContent = "正在自动识别日语列、简体中文列和无表头数据结构……";
  $("#importSummary").innerHTML = "<span>AI 结构识别中</span>";
  updateImportProgress({ message: "正在上传并解析表格", percent: 2 });
  $("#termImportSummary").innerHTML = "<span>等待术语识别</span>";
  $("#styleImportSummary").innerHTML = "<span>等待译例识别</span>";
  $("#termImportCandidates").innerHTML = '<tr><td colspan="6" class="table-empty">清洗后将在此处审核术语候选</td></tr>';
  $("#styleImportCandidates").innerHTML = '<tr><td colspan="6" class="table-empty">清洗后将在此处审核完整译例</td></tr>';
  $("#importBatchLearningPanel").hidden = true;
  $("#importBatchLearningList").innerHTML = '<div class="empty-list">提交译例后显示本批风格学习结果</div>';
  setImportCandidateTab("terms");
  refreshActions();
  await cleanTable();
}

function resetImport() {
  state.importFile = null;
  state.importFiles = [];
  state.assetPreflight = null;
  state.assetImportIntent = "auto";
  state.assetImportReturnView = "";
  state.assetImportTaskId = "";
  state.assetImportWizard = false;
  assetPreflightOutcome = null;
  state.importPreview = null;
  state.importCompleted = false;
  state.importCandidateTab = "terms";
  state.importVisibleCount = { terms: 150, styles: 150 };
  state.importBatchLearning = [];
  $("#termFile").value = "";
  $("#filePrompt").textContent = "拖入或点击选择双语资产文件";
  $("#fileMeta").textContent = "支持多选 .xlsx / .csv / .xliff / .mqxliff，单个文件不超过 20MB；先本地预检，再确认导入";
  $("#dropZone").classList.remove("has-file");
  renderImportFileList($("#importFileList"), [], new Map());
  $("#mappingNote").textContent = "拖入表格后会自动识别结构并生成审核队列。";
  $("#importSummary").innerHTML = "<span>尚未清洗</span>";
  $("#importProgress").hidden = true;
  $("#importProgressBar").style.width = "0%";
  $("#termImportSummary").innerHTML = "<span>0 条术语</span>";
  $("#styleImportSummary").innerHTML = "<span>0 条译例</span>";
  $("#termImportCandidates").innerHTML = '<tr><td colspan="6" class="table-empty">还没有术语候选</td></tr>';
  $("#styleImportCandidates").innerHTML = '<tr><td colspan="6" class="table-empty">还没有完整译例</td></tr>';
  $("#importBatchLearningPanel").hidden = true;
  $("#importBatchLearningList").innerHTML = '<div class="empty-list">提交译例后显示本批风格学习结果</div>';
  if ($("#assetPreflightDialog")?.open) $("#assetPreflightDialog").close();
  setImportCandidateTab("terms");
  refreshActions();
}

async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function decisionLabel(candidate) {
  if (candidate.existing) return ["已存在", "existing"];
  if (candidate.conflict) return ["译法冲突", "review"];
  if (candidate.decision === "ready") return ["可入库", "ready"];
  if (candidate.decision === "review") return ["需复核", "review"];
  return ["已排除", "excluded"];
}

function selectedCandidates() {
  return state.importPreview?.candidates.filter((candidate) => candidate.selected) || [];
}

function importCandidateKind(candidate) {
  const nested = Boolean(candidate?.nested || candidate?.parentCandidateKey || candidate?.parent_candidate_key);
  return candidate?.assetType === "memory" && !nested ? "styles" : "terms";
}

function indexedImportCandidates(kind) {
  return (state.importPreview?.candidates || [])
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => importCandidateKind(candidate) === kind);
}

function setImportCandidateTab(tab) {
  const next = tab === "styles" ? "styles" : "terms";
  state.importCandidateTab = next;
  $$('[data-import-candidate-tab]').forEach((button) => {
    const active = button.dataset.importCandidateTab === next;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  const termsPane = $("#importTermsPane");
  const stylesPane = $("#importStylesPane");
  if (termsPane) {
    termsPane.hidden = next !== "terms";
    termsPane.classList.toggle("active", next === "terms");
  }
  if (stylesPane) {
    stylesPane.hidden = next !== "styles";
    stylesPane.classList.toggle("active", next === "styles");
  }
}

function updateCandidateSelectAll(id, entries) {
  const checkbox = $(id);
  if (!checkbox) return;
  const selectable = entries.map(({ candidate }) => candidate).filter((candidate) => !candidate.existing && candidate.decision !== "excluded");
  checkbox.checked = selectable.length > 0 && selectable.every((candidate) => candidate.selected);
  checkbox.indeterminate = selectable.some((candidate) => candidate.selected) && !selectable.every((candidate) => candidate.selected);
}

function updateImportSummary() {
  if (!state.importPreview) return;
  const candidates = state.importPreview.candidates;
  const ai = state.importPreview.ai;
  const terms = indexedImportCandidates("terms");
  const styles = indexedImportCandidates("styles");
  const selected = selectedCandidates();
  $("#importSummary").innerHTML = `
    <span>总候选 <strong>${candidates.length}</strong></span><span>术语 <strong>${terms.length}</strong></span><span>完整译例 <strong>${styles.length}</strong></span><span>已选 <strong>${selected.length}</strong></span><span>${ai?.used ? `AI 已逐条归类 ${ai.reviewed} 条` : ai?.requested ? "AI 不可用 · 已用本地规则" : "本地规则归类"}</span>
  `;
  const nestedCount = terms.filter(({ candidate }) => candidate.nested || candidate.parentCandidateKey || candidate.parent_candidate_key).length;
  const termSelected = terms.filter(({ candidate }) => candidate.selected).length;
  const styleSelected = styles.filter(({ candidate }) => candidate.selected).length;
  const styleScopes = new Set(styles.map(({ candidate }) => `${candidate.locale}\u0000${candidate.contentType || "general"}\u0000${candidate.domain || "general"}`));
  $("#termImportSummary").innerHTML = `<span>术语 <strong>${terms.length}</strong></span><span>句内提取 <strong>${nestedCount}</strong></span><span>已选 <strong>${termSelected}</strong></span><span>需复核 <strong>${terms.filter(({ candidate }) => candidate.decision === "review").length}</strong></span>`;
  $("#styleImportSummary").innerHTML = `<span>完整译例 <strong>${styles.length}</strong></span><span>风格范围 <strong>${styleScopes.size}</strong></span><span>已选 <strong>${styleSelected}</strong></span><span>需复核 <strong>${styles.filter(({ candidate }) => candidate.decision === "review").length}</strong></span>`;
  updateCandidateSelectAll("#selectAllTermCandidates", terms);
  updateCandidateSelectAll("#selectAllStyleCandidates", styles);
}

function renderImportCandidateRows(entries, kind) {
  if (!entries.length) return `<tr><td colspan="6" class="table-empty">${kind === "terms" ? "没有识别到独立或句内术语候选" : "没有识别到可用的完整双语译例"}</td></tr>`;
  const visibleCount = Math.max(150, Number(state.importVisibleCount?.[kind]) || 150);
  const visibleEntries = entries.slice(0, visibleCount);
  const rows = visibleEntries.map(({ candidate, index }) => {
    const [label, className] = decisionLabel(candidate);
    const disabled = candidate.existing || candidate.decision === "excluded" || state.importCompleted;
    const locale = state.bootstrap.locales[candidate.locale] || { shortLabel: candidate.locale, label: candidate.locale };
    const rowLabel = candidate.rowNumber ? `第 ${candidate.rowNumber} 行` : "来源行未知";
    const nested = Boolean(candidate.nested || candidate.parentCandidateKey || candidate.parent_candidate_key);
    const evidenceMeta = nested && Number(candidate.occurrences) > 1 ? ` · ${candidate.occurrences} 条父句证据` : "";
    const meta = kind === "terms"
      ? `${nested ? "句内参考候选" : "正式术语"} · ${candidate.domain || "general"}${evidenceMeta} · ${rowLabel}`
      : `${contentTypeLabel(candidate.contentType || "general")} · ${candidate.domain || "general"} · ${rowLabel}`;
    const sourceEditor = kind === "terms"
      ? `<input class="table-input candidate-source" data-index="${index}" value="${escapeHtml(candidate.source)}" ${disabled ? "disabled" : ""} />`
      : `<textarea class="table-input table-textarea candidate-source" data-index="${index}" rows="2" ${disabled ? "disabled" : ""}>${escapeHtml(candidate.source)}</textarea>`;
    const targetEditor = kind === "terms"
      ? `<input class="table-input candidate-target" data-index="${index}" value="${escapeHtml(candidate.target)}" ${disabled ? "disabled" : ""} />`
      : `<textarea class="table-input table-textarea candidate-target" data-index="${index}" rows="2" ${disabled ? "disabled" : ""}>${escapeHtml(candidate.target)}</textarea>`;
    return `<tr class="candidate-${className}">
      <td class="check-cell"><input class="candidate-check" data-index="${index}" type="checkbox" ${candidate.selected ? "checked" : ""} ${disabled ? "disabled" : ""} /></td>
      <td><span class="locale-tag">${escapeHtml(locale.shortLabel)} · ${escapeHtml(locale.label)}</span><small class="row-ref">${escapeHtml(meta)}</small></td>
      <td>${sourceEditor}</td>
      <td>${targetEditor}</td>
      <td><span class="decision-badge ${className}">${label}</span><small class="score">${Math.round((Number(candidate.score) || 0) * 100)} 分</small></td>
      <td class="reason-cell">${escapeHtml((candidate.reasons || []).join("；") || "短语长度与语言特征通过")}</td>
    </tr>`;
  }).join("");
  if (visibleEntries.length >= entries.length) return rows;
  return `${rows}<tr><td colspan="6" class="table-empty"><button class="button secondary small" data-import-load-more="${kind}">再显示 ${Math.min(150, entries.length - visibleEntries.length)} 条</button><small class="row-ref">已显示 ${visibleEntries.length} / ${entries.length}</small></td></tr>`;
}

function renderImportCandidates() {
  const terms = indexedImportCandidates("terms");
  const styles = indexedImportCandidates("styles");
  $("#termImportCandidates").innerHTML = renderImportCandidateRows(terms, "terms");
  $("#styleImportCandidates").innerHTML = renderImportCandidateRows(styles, "styles");
  $$(".candidate-check").forEach((checkbox) => checkbox.addEventListener("change", () => { state.importPreview.candidates[Number(checkbox.dataset.index)].selected = checkbox.checked; updateImportSummary(); }));
  $$(".candidate-source").forEach((input) => input.addEventListener("change", () => { state.importPreview.candidates[Number(input.dataset.index)].source = input.value.trim(); }));
  $$(".candidate-target").forEach((input) => input.addEventListener("change", () => { state.importPreview.candidates[Number(input.dataset.index)].target = input.value.trim(); }));
  $$('[data-import-load-more]').forEach((button) => button.addEventListener("click", () => {
    const kind = button.dataset.importLoadMore;
    state.importVisibleCount[kind] = (Number(state.importVisibleCount[kind]) || 150) + 150;
    renderImportCandidates();
  }));
  if (!indexedImportCandidates(state.importCandidateTab).length && (terms.length || styles.length)) setImportCandidateTab(terms.length ? "terms" : "styles");
  else setImportCandidateTab(state.importCandidateTab);
  updateImportSummary();
}

function normalizeLearningRules(value, instruction = "") {
  const raw = Array.isArray(value) ? value : value ? [value] : splitStyleRules(instruction);
  return raw.map((rule) => {
    if (typeof rule === "string") return { category: "风格规则", text: rule };
    return {
      category: String(rule?.category || rule?.dimension || rule?.type || "风格规则"),
      text: String(rule?.guidance || rule?.instruction || rule?.rule || rule?.observation || rule?.text || "").trim(),
      confidence: Number(rule?.confidence)
    };
  }).filter((rule) => rule.text).slice(0, 12);
}

function normalizeStyleLearningRun(item = {}) {
  const profile = item.profile || item.styleProfile || {};
  const locale = item.locale || item.targetLocale || item.target_locale || profile.locale || profile.targetLocale || profile.target_locale || "";
  const contentType = item.contentType || item.content_type || profile.contentType || profile.content_type || "general";
  const domain = item.domain || profile.domain || "general";
  const instruction = String(item.instruction || item.instructions || profile.instruction || profile.instructions || "").trim();
  const evidenceCount = Number(item.evidenceCount ?? item.evidence_count ?? item.batchEvidenceCount ?? item.batch_evidence_count ?? profile.evidenceCount ?? profile.evidence_count) || 0;
  const profileId = item.profileId || item.profile_id || item.promotedProfileId || item.promoted_profile_id || profile.id || "";
  const profileStatus = item.profileStatus || item.profile_status || profile.status || (profileId ? "draft" : "");
  return {
    ...item,
    locale,
    contentType,
    domain,
    evidenceCount,
    summary: String(item.summary || item.learningSummary || item.learning_summary || item.reason || instruction || "已完成本批风格观察，等待更多同类证据。"),
    rules: normalizeLearningRules(item.rules || item.learnedRules || item.learned_rules, instruction),
    examples: (Array.isArray(item.examples) ? item.examples : Array.isArray(profile.examples) ? profile.examples : []).slice(0, 4),
    confidence: Number(item.confidence ?? item.learningConfidence ?? item.learning_confidence),
    caveat: String(item.caveat || item.limitation || item.warning || ""),
    status: String(item.status || item.learningStatus || item.learning_status || (profileId ? "promoted" : "observed")),
    batchId: String(item.batchId || item.batch_id || ""),
    filename: String(item.filename || item.sourceFile || item.source_file || ""),
    profileId: String(profileId),
    profileName: String(item.profileName || item.profile_name || profile.name || ""),
    profileStatus: String(profileStatus),
    profileVersion: Number(item.profileVersion ?? item.profile_version ?? profile.version) || null
  };
}

function learningRunsFromPayload(payload = {}, { includeProfileFallback = false } = {}) {
  const direct = payload.batchLearning || payload.learningRuns || payload.recentLearningRuns || payload.styleLearningRuns || payload.styleLearning || [];
  if (Array.isArray(direct) && direct.length) return direct.map(normalizeStyleLearningRun);
  if (!includeProfileFallback) return [];
  const profiles = Array.isArray(payload.styleProfiles) ? payload.styleProfiles.map((profile) => normalizeStyleLearningRun({ ...profile, profile, status: profile.status || "promoted" })) : [];
  const pending = Array.isArray(payload.styleFallbacks) ? payload.styleFallbacks.map((item) => normalizeStyleLearningRun({ ...item, status: "collecting", summary: item.reason })) : [];
  return [...profiles, ...pending];
}

function learningStatus(run) {
  const status = String(run.profileStatus || run.status || "").toLowerCase();
  if (status === "active") return ["已启用", "active"];
  if (["draft", "promoted", "ready"].includes(status) || run.profileId) return ["已形成待批准规范", "draft"];
  if (["failed", "error"].includes(status)) return ["学习失败", "error"];
  if (["dismissed", "rejected", "inactive"].includes(status)) return ["已关闭", "inactive"];
  return ["已学习 · 继续积累", "observed"];
}

function renderLearningCards(runs, { showJump = false } = {}) {
  return runs.map((run) => {
    const [statusLabel, statusClass] = learningStatus(run);
    const locale = state.bootstrap.locales[run.locale] || { shortLabel: run.locale || "--", label: run.locale || "未知语言" };
    const rules = run.rules || [];
    const examples = run.examples || [];
    const confidence = Number.isFinite(run.confidence) ? `${Math.round((run.confidence <= 1 ? run.confidence * 100 : run.confidence))}% 置信` : "";
    const profileMeta = run.profileId
      ? `${run.profileName || "风格规范"}${run.profileVersion ? ` v${run.profileVersion}` : ""} · ${run.profileStatus === "active" ? "已启用" : "待批准"}`
      : "尚未形成正式规范";
    const sourceMeta = [run.filename, run.batchId ? `批次 ${run.batchId.slice(0, 8)}` : "", `${run.evidenceCount} 条本批证据`, confidence].filter(Boolean).join(" · ");
    return `<article class="batch-learning-card ${escapeHtml(statusClass)}">
      <div class="batch-learning-head"><div><span class="locale-tag">${escapeHtml(locale.shortLabel)} · ${escapeHtml(locale.label)}</span><strong>${escapeHtml(contentTypeLabel(run.contentType))} · ${escapeHtml(run.domain)}</strong><small>${escapeHtml(sourceMeta || `${run.evidenceCount} 条本批证据`)}</small></div><span class="style-state ${escapeHtml(statusClass)}">${statusLabel}</span></div>
      <p class="batch-learning-summary">${escapeHtml(run.summary)}</p>
      ${rules.length ? `<div class="batch-learning-rules">${rules.map((rule) => `<div><span>${escapeHtml(rule.category)}</span><p>${escapeHtml(rule.text)}</p>${Number.isFinite(rule.confidence) ? `<small>${Math.round((rule.confidence <= 1 ? rule.confidence * 100 : rule.confidence))}%</small>` : ""}</div>`).join("")}</div>` : '<div class="batch-detail-empty">模型没有返回可拆分的规则条目，已保留学习摘要。</div>'}
      ${examples.length ? `<details class="style-examples"><summary>查看 ${examples.length} 个本批代表例句</summary>${examples.map((example) => `<div><strong>${example.type === "negative" ? "反例" : "正例"}</strong><p>${escapeHtml(example.source || "")}</p><p>${escapeHtml(example.target || "")}</p><small>${escapeHtml(example.reason || "")}</small></div>`).join("")}</details>` : ""}
      ${run.caveat ? `<p class="batch-learning-caveat">${escapeHtml(run.caveat)}</p>` : ""}
      <div class="batch-learning-foot"><small>${escapeHtml(profileMeta)}</small><div class="batch-learning-actions">${modelCondenseFailed(run) && run.id ? `<button class="button secondary small" type="button" data-rerun-condense="${escapeHtml(run.id)}">重跑模型浓缩</button>` : ""}${showJump && run.locale ? `<button class="button ghost small style-learning-link" type="button" data-style-learning-locale="${escapeHtml(run.locale)}">查看风格指导</button>` : ""}</div></div>
    </article>`;
  }).join("");
}

function bindStyleLearningLinks(container) {
  container?.querySelectorAll(".style-learning-link").forEach((button) => button.addEventListener("click", () => {
    const locale = button.dataset.styleLearningLocale;
    if (state.bootstrap.locales[locale]) state.styleLocale = locale;
    renderLocaleStrip($("#styleLocales"), state.styleLocale, updateStyleLocale);
    switchView("styles");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }));
  container?.querySelectorAll("[data-rerun-condense]").forEach((button) => button.addEventListener("click", () => rerunBatchCondense(button)));
}

/** 这一批是不是"模型浓缩没成功、只留了本地统计"（据此决定要不要给重跑入口）。 */
function modelCondenseFailed(run) {
  const caveat = String(run?.caveat || "");
  return caveat.includes("模型浓缩失败") || caveat.includes("模型浓缩暂不可用");
}

/** 重跑本批浓缩：模型通了就换成模型产出，仍然失败就把新的失败原因写在卡片上。 */
async function rerunBatchCondense(button) {
  const id = button.dataset.rerunCondense;
  if (!id || button.disabled) return;
  button.disabled = true;
  button.textContent = "重跑中…";
  try {
    const result = await api(`/api/style-learning-runs/${encodeURIComponent(id)}/refresh`, { method: "POST", body: JSON.stringify(projectPayload()) });
    toast(result.failed ? `模型浓缩仍然失败：${result.learning?.caveat || "未知原因"}` : "已用模型重新浓缩这一批，记录已更新");
    await loadStyleGuidance(state.styleLocale);
  } catch (error) {
    toast(error.message);
    button.disabled = false;
    button.textContent = "重跑模型浓缩";
  }
}

function renderImportBatchLearning() {
  const panel = $("#importBatchLearningPanel");
  const list = $("#importBatchLearningList");
  const runs = state.importBatchLearning || [];
  panel.hidden = !runs.length;
  $("#importBatchLearningCount").textContent = `${runs.length} 个范围`;
  list.innerHTML = runs.length ? renderLearningCards(runs, { showJump: true }) : '<div class="empty-list">本批没有完整译例，因此没有产生风格学习记录。</div>';
  bindStyleLearningLinks(list);
}

function learningArray(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function learningId(item = {}) {
  return String(item.id || item.skillId || item.skill_id || item.versionId || item.version_id || "");
}

function learningScopeMatches(item = {}) {
  const locale = item.locale || item.targetLocale || item.target_locale || item.scope?.locale;
  const contentType = item.contentType || item.content_type || item.scope?.contentType || item.scope?.content_type;
  const domain = item.domain || item.scope?.domain;
  const project = item.project || item.scope?.project;
  // 学习资产是"语言 × 语体 × 领域 × 项目"四层隔离，接口已经按当前项目取过数据了：
  // 只有历史遗留的 default 作用域和当前项目都算"当前范围"。早先这里只认 default，
  // 真实项目的轨迹/技能会被整批过滤掉，界面永远显示 0。
  const activeProject = state.activeProjectId || "default";
  return (!locale || locale === state.learningLocale)
    && (!contentType || learningScopeSelected("contentType") === "all" || contentType === $("#learningContentType").value)
    && (!domain || learningScopeSelected("domain") === "all" || domain === $("#learningDomain").value)
    && (!project || project === "default" || project === activeProject);
}

/** 当前下拉选的是"全部"（整维度放开）还是某个具体语体 / 领域。 */
function learningScopeSelected(dimension) {
  return dimension === "domain" ? $("#learningDomain").value : $("#learningContentType").value;
}

/** 任一维度选了"全部"：界面按"跨范围浏览"处理（列全部、逐条标范围、不显示指路提示）。 */
function learningAllScopes() {
  return learningScopeSelected("contentType") === "all" || learningScopeSelected("domain") === "all";
}

/** 范围标签：全部视图下每条资产要能看出自己属于哪个语体 × 领域。 */
function learningScopeTag(item = {}) {
  if (!learningAllScopes()) return "";
  const contentType = item.contentType || item.content_type || item.scope?.contentType || item.scope?.content_type || "general";
  const domain = item.domain || item.scope?.domain || "general";
  return `<span class="learning-scope-tag">${escapeHtml(contentTypeLabel(contentType))} × ${escapeHtml(learningDomainLabel(domain))}</span>`;
}

/** 候选与生效版本配对：全部视图下要用"该候选自己范围"的生效版本做评测基线。 */
function learningChampionFor(skill, champions = []) {
  const list = learningArray(champions);
  if (!skill) return list[0] || null;
  const contentType = String(skill.contentType || skill.content_type || skill.scope?.contentType || "general");
  const domain = String(skill.domain || skill.scope?.domain || "general");
  return list.find((item) => (String(item.contentType || item.content_type || "general") === contentType)
    && (String(item.domain || item.scope?.domain || "general") === domain)) || list[0] || null;
}

function validLearningTrajectories(items = []) {
  return learningArray(items).filter((item) => learningScopeMatches(item)
    && ["completed", "review"].includes(String(item.status || "").toLowerCase())
    && String(item.finalTranslation || item.final_translation || "").trim());
}

function learningPayload() {
  const payload = state.learningData?.data || state.learningData || {};
  const allSkills = learningArray(payload.skills);
  const champions = learningArray(payload.champions || payload.champion || payload.activeSkill || payload.active_skill)
    .concat(allSkills.filter((skill) => ["active", "champion"].includes(String(skill.status || skill.lifecycle || "").toLowerCase())));
  const explicitCandidates = learningArray(payload.candidates || payload.challengers || payload.candidateSkills || payload.candidate_skills);
  const candidates = explicitCandidates.concat(explicitCandidates.length ? [] : allSkills.filter((skill) => ["draft", "challenger", "candidate", "ready", "evaluated", "evaluating"].includes(String(skill.status || skill.lifecycle || "").toLowerCase())));
  const unique = (items) => [...new Map(items.map((item) => [learningId(item) || JSON.stringify(item), item])).values()];
  // 一个范围一份生效版本：具体范围取那一份，全部视图把范围内的都列出来（逐张标范围）。
  const scopedChampions = unique(champions).filter(learningScopeMatches);
  return {
    payload,
    champion: scopedChampions[0] || null,
    champions: scopedChampions,
    candidates: unique(candidates).filter(learningScopeMatches),
    evaluations: learningArray(payload.evaluations || payload.skillEvaluations || payload.skill_evaluations),
    evidence: learningArray(payload.evidence || payload.trajectories || payload.recentTrajectories || payload.recent_trajectories)
  };
}

function learningStatusMeta(item = {}) {
  const status = String(item.status || item.lifecycle || item.state || "candidate").toLowerCase();
  if (["active", "champion"].includes(status)) return ["生效中", "active"];
  if (["ready", "passed", "evaluated"].includes(status)) return ["评测通过", "ready"];
  if (["evaluating", "running"].includes(status)) return ["评测中", "running"];
  if (["rejected", "dismissed"].includes(status)) return ["已拒绝", "rejected"];
  if (["failed", "blocked"].includes(status)) return ["未通过", "failed"];
  if (["reject", "insufficient"].includes(status)) return [status === "insufficient" ? "证据不足" : "评测未通过", "failed"];
  if (status === "needs_review") return ["证据不足", "insufficient"];
  if (status === "unstable") return ["结果不稳定", "insufficient"];
  if (status === "stale") return ["评测基线已过期", "stale"];
  if (status === "promote") return ["评测通过", "ready"];
  return ["待评测", "candidate"];
}

function learningSkillTitle(skill = {}) {
  const contentType = skill.contentType || skill.content_type || skill.scope?.contentType || skill.scope?.content_type || $("#learningContentType").value;
  const domain = skill.domain || skill.scope?.domain || $("#learningDomain").value;
  return skill.name || skill.title || `${contentTypeLabel(contentType)} · ${domain}`;
}

function learningVersion(skill = {}) {
  const version = skill.version ?? skill.revision ?? skill.skillVersion ?? skill.skill_version;
  return version === undefined || version === null || version === "" ? "未标记版本" : `v${version}`;
}

function learningEvaluationFor(skill, evaluations) {
  const id = learningId(skill);
  return skill.evaluation || evaluations.find((item) => String(item.skillId || item.skill_id || item.candidateId || item.candidate_id || item.challengerSkillId || item.challenger_skill_id || item.challengerId || item.challenger_id || "") === id) || null;
}

function learningRules(skill = {}) {
  const strategy = skill.strategy || {};
  const output = [];
  const instruction = strategy.prompting?.additionalInstruction || strategy.instruction;
  if (instruction) output.push(`增量执行指导：${instruction}`);
  const additionalRules = learningArray(strategy.prompting?.additionalRules || strategy.additionalRules);
  output.push(...additionalRules.map((item) => `增量规则：${String(item)}`));
  if (Number.isFinite(Number(strategy.retrieval?.translationMemory?.limit))) output.push(`相似译例召回上限：${Number(strategy.retrieval.translationMemory.limit)} 条`);
  if (Number.isFinite(Number(strategy.retrieval?.qaCases?.limit))) output.push(`历史 QA 反例召回上限：${Number(strategy.retrieval.qaCases.limit)} 条`);
  if (Number.isFinite(Number(strategy.qa?.minimumScore))) output.push(`AIQA 通过分数：${Number(strategy.qa.minimumScore)} 分`);
  if (Number.isFinite(Number(strategy.qa?.maximumRevisionAttempts))) output.push(`AIQA 自动修订上限：${Number(strategy.qa.maximumRevisionAttempts)} 次`);
  if (output.length) return output.slice(0, 8);
  const raw = skill.changes || skill.rules || skill.instructions || skill.steps || [];
  if (Array.isArray(raw)) return raw.map((item) => typeof item === "string" ? item : item.text || item.rule || item.instruction || item.summary).filter(Boolean).slice(0, 8);
  if (typeof raw === "string") return raw.split(/\r?\n/u).map((item) => item.replace(/^[-*\d.\s]+/u, "").trim()).filter(Boolean).slice(0, 8);
  const changedPaths = learningArray(skill.metadata?.changedPaths || skill.metadata?.changed_paths);
  if (changedPaths.length) return changedPaths.map((item) => String(item)).slice(0, 8);
  return [];
}

function renderLearningChampion(champions, scopeCounts) {
  const container = $("#learningChampion");
  const list = learningArray(champions);
  if (!list.length) {
    $("#learningChampionStatus").textContent = "尚无生效版本";
    container.innerHTML = '<div class="empty-list learning-empty"><div><strong>这个范围还没有生产技能</strong><span>先根据已积累轨迹生成候选，完成评测并批准后，它才会成为这个范围的生效版本。</span></div></div>';
    return;
  }
  // 全部视图会带上每个范围各一份生效版本，其中多数是还没用过、0 条轨迹的默认策略：
  // 默认只摆出真有轨迹的范围，其余收进折叠，避免一屏全是空壳。
  if (!learningAllScopes()) {
    $("#learningChampionStatus").textContent = `${learningVersion(list[0])} · 已启用`;
    container.innerHTML = list.map((champion) => renderLearningChampionCard(champion)).join("");
    return;
  }
  const scopeKeyOf = (item) => `${item.contentType || item.content_type || item.scope?.contentType || "general"}\u0000${item.domain || item.scope?.domain || "general"}`;
  const withTrajectories = new Set(learningArray(scopeCounts).map(scopeKeyOf));
  const active = list.filter((champion) => withTrajectories.has(scopeKeyOf(champion)));
  const idle = list.filter((champion) => !withTrajectories.has(scopeKeyOf(champion)));
  $("#learningChampionStatus").textContent = idle.length
    ? `${active.length} 个范围有轨迹 · 共 ${list.length} 个`
    : `${list.length} 个范围已启用`;
  container.innerHTML = `${active.map((champion) => renderLearningChampionCard(champion)).join("")}${idle.length
    ? `<details class="learning-champion-rest"${active.length ? "" : " open"}><summary>其它 ${idle.length} 个范围还没有轨迹（默认折叠）</summary>${idle.map((champion) => renderLearningChampionCard(champion)).join("")}</details>`
    : ""}`;
}

function renderLearningChampionCard(champion) {
  const rules = learningRules(champion);
  const [statusLabel, statusClass] = learningStatusMeta({ ...champion, status: "active" });
  const evidenceCount = Number(champion.evidenceCount ?? champion.evidence_count ?? champion.trajectoryCount ?? champion.trajectory_count)
    || learningArray(champion.evidenceIds || champion.evidence_ids).length;
  const canRollback = Boolean(champion.parentId || champion.parent_id || Number(champion.version) > 1);
  const autoPropose = champion.metadata?.autoPropose || champion.metadata?.auto_propose;
  const autoProposeNote = autoPropose
    ? (autoPropose.lastError
      ? `<span class="learning-auto-note error">自动候选生成上次失败：${escapeHtml(autoPropose.lastError)}（新的人工终稿到达后会重试）</span>`
      : `<span class="learning-auto-note">自动候选生成已启用 · ${escapeHtml(String(autoPropose.lastAcceptedCount ?? ""))} 条人工终稿时触发${autoPropose.lastProposedAt ? ` · 上次生成候选 ${escapeHtml(formatLearningDate(autoPropose.lastProposedAt))}${autoPropose.lastSource === "manual" ? "（手动）" : ""}` : ""}</span>`)
    : "";
  return `<article class="learning-skill-card champion">
    <div class="learning-skill-head"><div><span class="learning-skill-version">${escapeHtml(learningVersion(champion))}</span><h3>${escapeHtml(learningSkillTitle(champion))}</h3>${learningScopeTag(champion)}<small>${evidenceCount} 条轨迹支撑${champion.activatedAt || champion.activated_at ? ` · ${escapeHtml(formatLearningDate(champion.activatedAt || champion.activated_at))} 启用` : ""}</small></div><span class="learning-status ${statusClass}">${statusLabel}</span></div>
    <p class="learning-skill-summary">${escapeHtml(champion.summary || champion.description || champion.instruction || "当前稳定生产版本。所有新候选都将以此版本作为评测基线。")}</p>
    ${autoProposeNote}
    ${rules.length ? `<div class="learning-rule-grid">${rules.map((rule, index) => `<div><span>${String(index + 1).padStart(2, "0")}</span><p>${escapeHtml(rule)}</p></div>`).join("")}</div>` : ""}
    <div class="learning-card-footer"><small>回滚会恢复上一已验证版本，并保留本版本审计记录。</small><div class="learning-actions"><button class="button ghost small" type="button" data-learning-action="rollback" data-skill-id="${escapeHtml(learningId(champion))}" ${canRollback ? "" : "disabled"}>${canRollback ? "回滚上一版本" : "无可回滚版本"}</button></div></div>
  </article>`;
}

function formatLearningDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function evaluationPassed(evaluation, skill = {}) {
  const result = learningEvaluationResult(evaluation);
  if (typeof result.promotable === "boolean") return result.promotable;
  if (typeof evaluation?.passed === "boolean") return evaluation.passed;
  const gate = String(evaluation?.decision || result.status || evaluation?.gateStatus || evaluation?.gate_status || skill.status || "").toLowerCase();
  return ["passed", "ready", "evaluated", "promote", "approved"].includes(gate);
}

function renderLearningCandidates(candidates, evaluations, champions, validTrajectoryCount) {
  const list = $("#learningCandidateList");
  $("#learningCandidateCount").textContent = `${candidates.length} 个候选`;
  if (!candidates.length) {
    list.innerHTML = validTrajectoryCount
      ? '<div class="empty-list learning-empty"><div><strong>当前没有候选技能</strong><span>可使用顶部主操作从当前范围的有效轨迹中提炼隔离候选，或等人工批准终稿达到阈值后由系统自动提议；生成不会直接改变生产翻译。</span></div></div>'
      : '<div class="empty-list learning-empty"><div><strong>当前范围还没有可学习的完成轨迹</strong><span>请先完成翻译并通过 QA 或进入复核；有最终译文后，系统才会开放候选技能生成。</span></div></div>';
    return;
  }
  if (!candidates.some((item) => learningId(item) === state.learningSelectedSkillId)) state.learningSelectedSkillId = learningId(candidates[0]);
  list.innerHTML = candidates.map((skill) => {
    const id = learningId(skill);
    // 全部视图下候选来自不同范围：基线必须取它自己范围的生效版本，不能用别的范围的。
    const champion = learningChampionFor(skill, champions);
    const evaluation = learningEvaluationFor(skill, evaluations);
    const evaluationResult = learningEvaluationResult(evaluation);
    const currentChampionId = learningId(champion);
    const evaluationChampionId = String(evaluation?.championSkillId || evaluation?.champion_skill_id || evaluationResult.championId || evaluationResult.champion_id || "");
    const candidateParentId = String(skill.parentId || skill.parent_id || "");
    const baselineCurrent = !currentChampionId
      || ((!evaluationChampionId || evaluationChampionId === currentChampionId) && (!candidateParentId || candidateParentId === currentChampionId));
    const resolvedStatus = !baselineCurrent ? "stale" : evaluationPassed(evaluation, skill) ? "ready" : (evaluationResult.status || evaluation?.decision || evaluation?.status || skill.status);
    const [statusLabel, statusClass] = learningStatusMeta({ ...skill, status: resolvedStatus });
    const selected = id === state.learningSelectedSkillId;
    const reason = skill.changeReason || skill.change_reason || skill.reason || skill.rationale || skill.summary || "由近期高频修订与成功翻译轨迹提出。";
    const sanitizationWarnings = skill.metadata?.sanitization?.warnings || skill.metadata?.sanitization_warnings || [];
    const sanitizationNote = sanitizationWarnings.length
      ? `<div class="learning-auto-note" title="模型补丁中超出白名单、越界或疑似注入的内容已被净化，不影响候选生成。">模型补丁已净化 ${sanitizationWarnings.length} 处：${escapeHtml(String(sanitizationWarnings[0].reason || sanitizationWarnings[0] || ""))}${sanitizationWarnings.length > 1 ? " 等" : ""}</div>`
      : "";
    const rules = learningRules(skill);
    const evidenceCount = Number(skill.evidenceCount ?? skill.evidence_count ?? skill.trajectoryCount ?? skill.trajectory_count) || learningArray(skill.evidence || skill.evidenceIds || skill.evidence_ids).length;
    const canActivate = Boolean(evaluation && baselineCurrent && evaluationPassed(evaluation, skill));
    // 候选刚生成时还没有任何评测：evaluation 为 null，这里不能直接读它的字段
    // （曾经因此抛 "Cannot read properties of null (reading 'decision')"，整个学习中心变成读取失败）。
    const reviewStatus = String(evaluationResult.status || evaluation?.decision || "").toLowerCase();
    const insufficient = evaluation && ["insufficient", "needs_review"].includes(reviewStatus);
    const unstable = evaluation && reviewStatus === "unstable";
    const footerText = !baselineCurrent
      ? "该候选基于旧的生效版本生成，不能再晋升；请拒绝它，并从当前生效版本重新生成候选。"
      : !evaluation
        ? "尚未与当前生效版本进行隔离评测。"
        : canActivate
          ? "已在当前生效版本基线上通过完整门槛，可由人工批准启用。"
          : unstable
            ? (evaluationResult.conclusion || "重复评测结论互相矛盾，系统已暂停形成优劣结论。")
          : insufficient
            ? (evaluationResult.conclusion || "评测证据不足或执行未完成，当前没有形成优劣结论。")
            : "评测门槛未通过，不能进入生产。";
    return `<article class="learning-skill-card candidate ${selected ? "selected" : ""}" data-learning-select="${escapeHtml(id)}" tabindex="0">
      <div class="learning-skill-head"><div><span class="learning-skill-version">${escapeHtml(learningVersion(skill))}</span><h3>${escapeHtml(learningSkillTitle(skill))}</h3>${learningScopeTag(skill)}<small>${evidenceCount} 条来源证据${skill.createdAt || skill.created_at ? ` · ${escapeHtml(formatLearningDate(skill.createdAt || skill.created_at))}` : ""}</small></div><span class="learning-status ${statusClass}">${statusLabel}</span></div>
      <div class="learning-change-reason"><span>为什么提出这次变更</span><p>${escapeHtml(reason)}</p></div>
      ${sanitizationNote}
      ${rules.length ? `<details class="learning-change-details"><summary>查看 ${rules.length} 项候选执行配置</summary>${rules.map((rule) => `<p>${escapeHtml(rule)}</p>`).join("")}</details>` : ""}
      <div class="learning-card-footer"><small>${escapeHtml(footerText)}</small><div class="learning-actions"><button class="button secondary small" type="button" data-learning-action="evaluate" data-skill-id="${escapeHtml(id)}" ${baselineCurrent ? "" : "disabled"}>${evaluation ? "重新评测" : "运行评测"}</button><button class="button primary small" type="button" data-learning-action="activate" data-skill-id="${escapeHtml(id)}" ${canActivate ? "" : "disabled"}>批准启用</button><button class="button ghost small danger" type="button" data-learning-action="reject" data-skill-id="${escapeHtml(id)}">拒绝</button></div></div>
    </article>`;
  }).join("");
}

const learningMetricLabels = {
  qaScore: ["AIQA 平均分", "分", true], qa_score: ["AIQA 平均分", "分", true],
  termAccuracy: ["术语正确率", "%", true], term_accuracy: ["术语正确率", "%", true], mandatoryTermAccuracy: ["强制术语正确率", "%", true],
  acceptanceRate: ["相对人工终稿的近似通过率", "%", true], acceptance_rate: ["相对人工终稿的近似通过率", "%", true], humanAcceptanceRate: ["相对人工终稿的近似通过率", "%", true],
  editDistance: ["相对人工终稿的编辑距离", "%", false], edit_distance: ["相对人工终稿的编辑距离", "%", false], humanEditDistance: ["相对人工终稿的编辑距离", "%", false],
  hardErrorRate: ["硬错误率", "%", false], hard_error_rate: ["硬错误率", "%", false], hardErrorCount: ["硬错误数", "", false], hardErrorFreeRate: ["无硬错误率", "%", true],
  averageCost: ["平均模型成本", "", false], averageLatencyMs: ["平均延迟", "ms", false]
};

function learningNumber(value) {
  return value === null || value === undefined || value === "" ? Number.NaN : Number(value);
}

function learningMetricDefinition(key, fallbackLabel = "", fallbackUnit = "", fallbackHigher = true) {
  const definition = learningMetricLabels[key];
  return definition || [fallbackLabel || key, fallbackUnit, fallbackHigher];
}

function normalizeLearningMetrics(evaluation = {}) {
  const result = learningEvaluationResult(evaluation);
  if (Array.isArray(result.metrics)) return result.metrics.map((metric, index) => {
    const key = metric.key || metric.name || `metric-${index}`;
    const [label, unit, higher] = learningMetricDefinition(key, metric.label || `指标 ${index + 1}`, metric.unit || "", metric.higherIsBetter ?? metric.higher_is_better ?? true);
    return {
      key, label, unit: metric.unit || unit, higher: metric.higherIsBetter ?? metric.higher_is_better ?? higher,
      champion: learningNumber(metric.champion ?? metric.baseline ?? metric.control),
      candidate: learningNumber(metric.candidate ?? metric.challenger ?? metric.value),
      delta: learningNumber(metric.delta)
    };
  });
  const baseline = result.championMetrics || result.champion_metrics || result.champion || result.baseline || result.baselineMetrics || result.baseline_metrics || {};
  const candidate = result.challengerMetrics || result.challenger_metrics || result.candidate || result.challenger || result.candidateMetrics || result.candidate_metrics || {};
  const metricObject = result.metrics && typeof result.metrics === "object" ? result.metrics : {};
  const preferredKeys = ["mandatoryTermAccuracy", "hardErrorCount", "hardErrorFreeRate", "qaScore", "humanEditDistance", "humanAcceptanceRate"];
  const keys = [...new Set([...preferredKeys.filter((key) => key in baseline || key in candidate), ...Object.keys(metricObject)])];
  if (baseline.cost || candidate.cost) keys.push("averageCost");
  if (baseline.latencyMs || candidate.latencyMs) keys.push("averageLatencyMs");
  return keys.map((key) => {
    const item = metricObject[key];
    const definition = learningMetricLabels[key] || [key, item?.unit || "", item?.higherIsBetter ?? item?.higher_is_better ?? true];
    const baselineValue = key === "averageCost" ? baseline.cost?.average : key === "averageLatencyMs" ? baseline.latencyMs?.average : baseline[key];
    const candidateValue = key === "averageCost" ? candidate.cost?.average : key === "averageLatencyMs" ? candidate.latencyMs?.average : candidate[key];
    return {
      key, label: item?.label || definition[0], unit: item?.unit || definition[1], higher: item?.higherIsBetter ?? item?.higher_is_better ?? definition[2],
      champion: learningNumber(item?.champion ?? item?.baseline ?? baselineValue), candidate: learningNumber(item?.candidate ?? item?.challenger ?? item?.value ?? candidateValue), delta: learningNumber(item?.delta ?? result.deltas?.[key] ?? result.metricDeltas?.[key] ?? result.metric_deltas?.[key])
    };
  }).filter((metric) => Number.isFinite(metric.champion) || Number.isFinite(metric.candidate));
}

function learningMetricDisplay(value, unit) {
  if (!Number.isFinite(value)) return "—";
  const normalized = unit === "%" && Math.abs(value) <= 1 ? value * 100 : value;
  return `${normalized.toFixed(Math.abs(normalized) >= 100 ? 0 : 1)}${unit}`;
}

function renderLearningEvaluation(candidate, evaluation, champion) {
  const matrix = $("#learningEvaluationMatrix");
  if (!candidate || !evaluation) {
    matrix.innerHTML = '<div class="empty-list learning-empty"><div><strong>还没有可对比的评测</strong><span>在候选卡片底部运行评测，结果会在这里与当前生效版本逐项比较。</span></div></div>';
    return;
  }
  const metrics = normalizeLearningMetrics(evaluation);
  const result = learningEvaluationResult(evaluation);
  const passed = evaluationPassed(evaluation, candidate);
  const evaluationStatus = String(result.status || evaluation.decision || "").toLowerCase();
  const insufficient = ["insufficient", "needs_review"].includes(evaluationStatus);
  const unstable = evaluationStatus === "unstable";
  const currentChampionId = learningId(champion);
  const evaluatedChampionId = String(evaluation.championSkillId || evaluation.champion_skill_id || result.championId || result.champion_id || "");
  const stale = Boolean(currentChampionId && evaluatedChampionId && currentChampionId !== evaluatedChampionId);
  const comparisonLabel = stale ? "旧生效版本基线评测" : unstable ? "结果不稳定 · 暂不形成优劣结论" : insufficient ? "证据不足 · 暂不形成优劣结论" : "已完成生效版本 / 候选版本对比";
  const gateClass = stale ? "stale" : unstable || insufficient ? "insufficient" : passed ? "passed" : "failed";
  const gateLabel = stale ? "基线已过期" : unstable ? "多轮结论互相矛盾" : insufficient ? "评测未完整完成" : passed ? "通过晋升门槛" : "未通过晋升门槛";
  const evaluationBasis = result.evaluationBasis || "编辑距离与近似通过率均由候选译文相对人工批准终稿自动计算，不代表新增人工投票或主观打分。";
  const conclusion = result.reportZh || (typeof evaluation.report === "string" ? evaluation.report : "") || result.conclusion || result.summary || result.reason || (passed ? "候选通过全部晋升门槛。" : "候选尚未通过全部晋升门槛。将在批准前保持隔离。 ");
  matrix.innerHTML = `<div class="learning-evaluation-title"><div><span>${escapeHtml(comparisonLabel)}</span><strong>${escapeHtml(learningSkillTitle(candidate))} ${escapeHtml(learningVersion(candidate))}</strong></div><span class="learning-gate ${gateClass}">${gateLabel}</span></div>
    <p class="learning-evaluation-basis">${escapeHtml(evaluationBasis)}</p>
    ${metrics.length ? `<div class="learning-metric-table"><div class="learning-metric-row heading"><span>指标</span><span>当前生效版本</span><span>候选版本</span><span>变化</span></div>${metrics.map((metric) => {
      const rawDelta = Number.isFinite(metric.delta) ? metric.delta : metric.candidate - metric.champion;
      const improved = metric.higher ? rawDelta >= 0 : rawDelta <= 0;
      return `<div class="learning-metric-row"><strong>${escapeHtml(metric.label)}</strong><span>${learningMetricDisplay(metric.champion, metric.unit)}</span><span>${learningMetricDisplay(metric.candidate, metric.unit)}</span><span class="metric-delta ${improved ? "positive" : "negative"}">${rawDelta > 0 ? "+" : ""}${learningMetricDisplay(rawDelta, metric.unit)}</span></div>`;
    }).join("")}</div>` : '<div class="empty-list learning-empty">评测已完成，但服务端没有返回可展示的指标。</div>'}
    <p class="learning-evaluation-conclusion">${escapeHtml(conclusion)}</p>`;
}

function renderLearningEvidence(evidence, candidates) {
  const nested = candidates.flatMap((skill) => learningArray(skill.evidence || skill.references).map((item) => ({ ...item, skillId: learningId(skill) })));
  const allRows = validLearningTrajectories(evidence.length ? evidence : nested);
  const rows = allRows.slice(0, 30);
  const selectedCandidate = candidates.find((item) => learningId(item) === state.learningSelectedSkillId);
  const selectedEvidenceIds = new Set(learningArray(selectedCandidate?.evidenceIds || selectedCandidate?.evidence_ids).map(String));
  $("#learningEvidenceCount").textContent = allRows.length > rows.length ? `${allRows.length} 条证据 · 显示 ${rows.length}` : `${allRows.length} 条证据`;
  $("#learningEvidenceList").innerHTML = rows.length ? rows.map((item) => {
    const accepted = item.humanDecision?.accepted === true || item.human_decision?.accepted === true;
    const typeLabel = accepted ? "人工采纳轨迹" : item.status === "review" ? "待复核轨迹" : "完成轨迹";
    const referenceRefs = item.referenceUsage?.refs || [];
    const referenceLine = referenceRefs.length
      ? `<small class="learning-reference-line">本次查阅资料 ${referenceRefs.length} 段：${escapeHtml([...new Set(referenceRefs.map((ref) => [ref.documentName, ref.heading].filter(Boolean).join(" · ")).filter(Boolean))].slice(0, 3).join("；"))}${referenceRefs.length > 3 ? "…" : ""}</small>`
      : "";
    const attribution = item.attribution || {};
    const title = item.title || item.reason || item.changeReason || item.change_reason || item.summary
      || ({ improved: "发现正向改进信号", needs_learning: "发现需要继续学习的修订信号", observed: "已记录轨迹，尚不能可靠归因" }[attribution.outcome])
      || "已记录完成轨迹，尚未形成可靠归因";
    const attributionText = String(attribution.reportZh || attribution.report || "").slice(0, 800);
    const source = item.source || item.sourceText || item.source_text || "";
    const target = item.correctedTranslation || item.corrected_translation || item.finalTranslation || item.final_translation || item.translation || item.target || "";
    const ref = item.taskId || item.task_id || item.trajectoryId || item.trajectory_id || item.id || "";
    const linked = selectedEvidenceIds.has(String(item.id || ref));
    const sourceFile = String(item.sourceFile || item.assetRefs?.sourceFile || "");
    // 全部视图下每条轨迹要能看出自己属于哪个语体 × 领域，条目本身就是证据。
    return `<article class="learning-evidence-item ${linked ? "linked" : ""}"><div class="learning-evidence-meta"><span>${escapeHtml(typeLabel)}</span>${learningScopeTag(item)}<small>${escapeHtml(ref ? `#${String(ref).slice(0, 12)}` : "可追溯来源")}${linked ? " · 本候选来源" : ""}${item.createdAt || item.created_at ? ` · ${escapeHtml(formatLearningDate(item.createdAt || item.created_at))}` : ""}</small>${sourceFile ? `<small class="learning-evidence-file" title="${escapeHtml(sourceFile)}">来源：${escapeHtml(sourceFile)}</small>` : ""}</div><div><strong>${escapeHtml(title)}</strong>${attributionText ? `<p class="learning-evidence-reason">${escapeHtml(attributionText)}</p>` : ""}${source ? `<p>${escapeHtml(source)}</p>` : ""}${target ? `<p class="learning-evidence-target">→ ${escapeHtml(target)}</p>` : ""}</div></article>`;
  }).join("") : '<div class="empty-list learning-empty"><div><strong>当前范围还没有学习证据</strong><span>完成翻译、AIQA 修订或人工采纳后，证据会连同轨迹编号出现在这里。</span></div></div>';
}

const CONFLICT_ACTION_LABELS = {
  "retire-style-rule": { badge: "建议退休弱势规则", tone: "actionable" },
  review: { badge: "需人工判断", tone: "manual" }
};

function renderLearningConflicts(report) {
  const conflicts = Array.isArray(report?.conflicts) ? report.conflicts : [];
  const count = $("#learningConflictCount");
  const list = $("#learningConflictList");
  // 「还没扫过」和「扫过了没冲突」是两回事，混起来会让人以为已经检查过。
  if (!report?.scannedAt) {
    count.textContent = "尚未扫描";
    list.innerHTML = `<div class="empty-list learning-empty"><div><strong>${escapeHtml(report?.reason || "尚未扫描")}</strong><span>扫描会比对风格规范、技能附加规则与译者画像三方，只有模型确认无法同时遵守的才算冲突。</span></div></div>`;
    return;
  }
  count.textContent = conflicts.length
    ? `${conflicts.length} 处冲突 · 比对 ${report.scannedRules || 0} 条规则`
    : `无冲突 · 比对 ${report.scannedRules || 0} 条规则`;
  if (!conflicts.length) {
    const detail = report.reason || `已比对 ${report.scannedRules || 0} 条规则、${report.candidates || 0} 对同方面组合。`;
    list.innerHTML = `<div class="empty-list learning-empty"><div><strong>${escapeHtml(report.reason ? "本次没有得出冲突结论" : "三方规则没有互相矛盾")}</strong><span>${escapeHtml(detail)}</span></div></div>`;
    return;
  }
  list.innerHTML = conflicts.map((conflict, index) => {
    const meta = CONFLICT_ACTION_LABELS[conflict.action] || CONFLICT_ACTION_LABELS.review;
    const side = (rule, winning) => `<div class="learning-conflict-side ${winning ? "winning" : ""}"><span>${escapeHtml(rule.originLabel || "")}${winning ? " · 证据更强" : ""}</span><p>${escapeHtml(rule.rule || "")}</p><small>${rule.evidenceCount ? `${rule.evidenceCount} 条证据` : "无证据计数"}</small></div>`;
    const winnerRule = conflict.winner?.rule || "";
    const isWinner = (rule) => Boolean(winnerRule) && rule.rule === winnerRule;
    const canRetire = conflict.action === "retire-style-rule" && conflict.ruleId;
    return `<article class="learning-conflict-item ${meta.tone}">
      <div class="learning-conflict-head"><span class="learning-conflict-badge ${meta.tone}">${escapeHtml(meta.badge)}</span><small>${escapeHtml((conflict.aspects || []).join("、") || "同一方面")}</small></div>
      ${conflict.situation ? `<p class="learning-conflict-situation">${escapeHtml(conflict.situation)}</p>` : ""}
      <div class="learning-conflict-sides">${side(conflict.left, isWinner(conflict.left))}${side(conflict.right, isWinner(conflict.right))}</div>
      <p class="learning-conflict-reason">${escapeHtml(conflict.reason || "")}</p>
      ${conflict.recommendation ? `<p class="learning-conflict-reason subtle">模型建议：${escapeHtml(conflict.recommendation)}</p>` : ""}
      ${canRetire ? `<div class="learning-conflict-foot"><button class="button ghost small" type="button" data-conflict-retire="${escapeHtml(conflict.ruleId)}" data-conflict-index="${index}">退休这条风格规则</button><small>只改风格规范，技能与画像不受影响</small></div>` : ""}
    </article>`;
  }).join("");
  $$("[data-conflict-retire]").forEach((button) => button.addEventListener("click", () => retireConflictRule(button)));
}

async function loadConflictReport() {
  const scope = learningActionBody();
  const params = new URLSearchParams({ locale: scope.locale, contentType: scope.contentType, domain: scope.domain, project: scope.project });
  try {
    state.conflictReport = await api(`/api/learning/conflict-scan?${params}`);
  } catch {
    // 冲突报告是诊断信息，读不到不该把整个学习中心拖成错误态。
    state.conflictReport = null;
  }
  renderLearningConflicts(state.conflictReport);
}

async function runConflictScan(button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "扫描中……";
  try {
    state.conflictReport = await api("/api/learning/conflict-scan", { method: "POST", body: JSON.stringify(learningActionBody()) });
    renderLearningConflicts(state.conflictReport);
    const found = state.conflictReport.conflicts?.length || 0;
    toast(found ? `发现 ${found} 处规则冲突` : state.conflictReport.reason || "三方规则没有互相矛盾");
  } catch (error) {
    toast(`扫描失败：${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function retireConflictRule(button) {
  const conflict = (state.conflictReport?.conflicts || [])[Number(button.dataset.conflictIndex)];
  if (!confirm("确认退休这条风格规则？它会立刻退出翻译提示词，记录保留在规范里可供复核。")) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "处理中……";
  try {
    const result = await api("/api/learning/conflict-scan/apply", {
      method: "POST",
      body: JSON.stringify({ ...learningActionBody(), ruleId: button.dataset.conflictRetire, reason: conflict?.reason || "" })
    });
    state.conflictReport = result.report;
    renderLearningConflicts(state.conflictReport);
    toast(`已退休该规则，当前生效 ${result.activeRules} 条`);
  } catch (error) {
    toast(`退休失败：${error.message}`);
    button.disabled = false;
    button.textContent = original;
  }
}

const GATE_STATUS_LABELS = {
  pass: "上次门禁通过",
  block: "上次门禁阻断",
  insufficient: "证据不足",
  not_run: "尚未运行"
};

function qualityPercent(value) {
  return value === null || value === undefined ? "—" : `${(Number(value) * 100).toFixed(1)}%`;
}

async function loadQualityGate() {
  const params = new URLSearchParams(learningActionBody());
  try {
    const [assets, gate] = await Promise.all([
      api(`/api/quality/assets?${params}`),
      api(`/api/quality/gate?${params}`)
    ]);
    state.qualityAssets = assets;
    state.qualityGate = gate;
    renderQualityGate();
  } catch (error) {
    state.qualityAssets = null;
    state.qualityGate = null;
    $("#learningGateStatus").textContent = "读取失败";
    $("#learningQualityAssets").innerHTML = `<div class="empty-list learning-empty">固定质量资产读取失败：${escapeHtml(error.message)}</div>`;
    $("#learningRegressionCandidates").innerHTML = "";
  }
}

function renderQualityGate() {
  const assets = state.qualityAssets;
  const gate = state.qualityGate;
  if (!assets || !gate) return;
  const status = gate.status || "not_run";
  const badge = $("#learningGateStatus");
  badge.textContent = GATE_STATUS_LABELS[status] || status;
  badge.dataset.gateStatus = status;
  const latest = gate.latestRun;
  const cards = [
    { label: "启用 Gold 样本", value: gate.assets.goldSampleCount, hint: gate.assets.goldSetVersions.join("、") || "尚未启用 Gold Set" },
    { label: "启用回归案例", value: gate.assets.regressionCaseCount, hint: gate.assets.regressionSuiteVersions.join("、") || "尚未启用回归集" },
    { label: "回归通过率", value: latest ? qualityPercent(latest.regressionPassRate) : "—", hint: latest ? `${latest.regressionPassed} / ${latest.regressionTotal} 通过` : "尚未运行门禁" },
    { label: "Gold 术语准确率", value: latest ? qualityPercent(latest.goldTermAccuracy) : "—", hint: latest ? `事实准确率 ${qualityPercent(latest.goldFactAccuracy)}` : "尚未运行门禁" }
  ];
  const blocking = (latest?.blocking || []).map((item) => `<li>${escapeHtml(item.message || item.code || "")}</li>`).join("");
  $("#learningQualityAssets").innerHTML = `
    <div class="learning-quality-cards">
      ${cards.map((card) => `<article class="learning-quality-card"><strong>${escapeHtml(String(card.value))}</strong><span>${escapeHtml(card.label)}</span><small>${escapeHtml(card.hint)}</small></article>`).join("")}
    </div>
    ${blocking ? `<div class="learning-quality-blocking"><strong>阻断原因</strong><ul>${blocking}</ul></div>` : ""}
    ${latest ? `<p class="learning-quality-meta">最近一次运行：${escapeHtml(latest.createdAt || "")} · 受测技能 ${escapeHtml(latest.skillId || "未记录")} · 触发方式 ${escapeHtml(latest.triggeredBy || "manual")}</p>` : ""}`;

  const candidates = assets.regressionCandidates || [];
  const pending = candidates.filter((item) => item.status === "pending");
  $("#learningRegressionCandidates").innerHTML = candidates.length
    ? `<div class="learning-quality-candidates"><h3>回归候选（${pending.length} 条待审批 / 共 ${candidates.length} 条）</h3>${candidates.slice(0, 20).map((item) => {
      const payload = item.payload || {};
      return `<article class="learning-quality-candidate" data-status="${escapeHtml(item.status)}">
        <div class="learning-quality-candidate-body">
          <p class="learning-quality-source">${escapeHtml(payload.source || "")}</p>
          <p class="learning-quality-pair"><span class="bad">${escapeHtml(payload.failingTranslation || "")}</span><span class="good">${escapeHtml(payload.expectedTranslation || "")}</span></p>
          <small>状态：${escapeHtml(item.status)}${item.approval?.reviewer ? ` · 审批人 ${escapeHtml(item.approval.reviewer)}` : ""}${item.approval?.note ? ` · ${escapeHtml(item.approval.note)}` : ""}</small>
        </div>
        ${item.status === "pending" ? `<div class="learning-quality-candidate-actions">
          <button class="button ghost small" type="button" data-regression-decision="approve" data-asset-id="${escapeHtml(item.id)}">批准入集</button>
          <button class="button ghost small" type="button" data-regression-decision="reject" data-asset-id="${escapeHtml(item.id)}">拒绝</button>
        </div>` : ""}
      </article>`;
    }).join("")}</div>`
    : '<div class="empty-list learning-empty">当前范围还没有回归候选。人工批准的 AIQA 失败案例可以在问题库里提为候选。</div>';
  $$("[data-regression-decision]").forEach((button) => button.addEventListener("click", () => decideRegressionCandidateFromUi(button.dataset.assetId, button.dataset.regressionDecision, button)));
}

async function decideRegressionCandidateFromUi(assetId, decision, button) {
  const reviewer = prompt(decision === "approve" ? "批准人姓名（会写进审批记录）" : "拒绝人姓名（会写进审批记录）");
  if (!reviewer) return;
  const note = decision === "reject" ? prompt("拒绝原因（必填）") : prompt("批准备注（可留空）") || "";
  if (decision === "reject" && !note) return toast("拒绝回归候选必须写原因");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "处理中……";
  try {
    await api(`/api/quality/regression-candidates/${encodeURIComponent(assetId)}/decision`, {
      method: "POST",
      body: JSON.stringify({ ...learningActionBody(), decision, reviewer, note })
    });
    toast(decision === "approve" ? "回归候选已批准，可并入回归集" : "回归候选已拒绝");
    await loadQualityGate();
  } catch (error) {
    toast(error.message);
    button.disabled = false;
    button.textContent = original;
  }
}

async function seedGoldSetFromTrajectories(button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "生成中……";
  try {
    const preview = await api("/api/quality/gold-sets/from-trajectories", { method: "POST", body: JSON.stringify(learningActionBody()) });
    if (!preview.candidates.length) {
      toast("当前范围还没有人工采纳的终稿，无法生成 Gold Set");
      return;
    }
    if (!confirm(`将从 ${preview.acceptedTotal} 条人工采纳终稿中取 ${preview.candidates.length} 条建立固定 Gold Set 并启用。建立后内容不可改，只能发新版本。继续？`)) return;
    const created = await api("/api/quality/gold-sets", {
      method: "POST",
      body: JSON.stringify({ ...learningActionBody(), samples: preview.candidates, status: "active", changeNote: "从人工采纳终稿生成" })
    });
    toast(`已建立 Gold Set ${created.asset.seriesId} v${created.asset.version}，共 ${created.asset.itemCount} 个样本`);
    await loadQualityGate();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function buildRegressionSuiteFromUi(button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "生成中……";
  try {
    const created = await api("/api/quality/regression-suites", { method: "POST", body: JSON.stringify({ ...learningActionBody(), changeNote: "由已批准回归候选生成" }) });
    toast(`已建立回归集 v${created.asset.version}，共 ${created.asset.itemCount} 个失败案例`);
    await loadQualityGate();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function runQualityGateFromUi(button) {
  const original = button.textContent;
  const previousRunId = state.qualityGate?.latestRun?.id || "";
  try {
    const started = await api("/api/quality/runs", { method: "POST", body: JSON.stringify({ ...learningActionBody(), triggeredBy: "ui" }) });
    toast(started.message || "质量门禁已进入任务中心");
    button.disabled = true;
    button.textContent = "执行中……";
    // 门禁按固定样本逐条真跑模型，耗时随样本数增长；这里只轮询结论是否落库。
    const deadline = Date.now() + 2 * 60 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await loadQualityGate();
      const latest = state.qualityGate?.latestRun;
      if (latest && latest.id !== previousRunId) {
        toast(latest.decision === "pass" ? "质量门禁通过" : `质量门禁未通过：${latest.decision}`);
        break;
      }
    }
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function auditTrainingExport(button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "统计中……";
  try {
    const report = await api("/api/learning/export", { method: "POST", body: JSON.stringify({ ...learningActionBody(), format: "json" }) });
    state.trainingExport = report;
    $("#learningExportSummary").textContent = `SFT ${report.sft.count} 条 · DPO ${report.dpo.count} 条`;
    const reasons = (audit) => Object.entries(audit.droppedByReason || {}).map(([reason, count]) => `<li>${escapeHtml(reason)} · ${count} 条</li>`).join("") || "<li>没有丢弃样本</li>";
    $("#learningExportReport").innerHTML = `
      <div class="learning-export-grid">
        <article><h4>SFT 监督数据</h4><strong>${report.sft.count}</strong><small>输入 ${report.sft.audit.input} 条 · 丢弃 ${report.sft.audit.dropped} 条</small><ul>${reasons(report.sft.audit)}</ul></article>
        <article><h4>DPO 偏好数据</h4><strong>${report.dpo.count}</strong><small>输入 ${report.dpo.audit.input} 条 · 丢弃 ${report.dpo.audit.dropped} 条</small><ul>${reasons(report.dpo.audit)}</ul></article>
      </div>
      <p class="learning-quality-meta">已从训练数据中排除 ${report.manifest.excludedEvaluationSources} 条固定评测原文（Gold ${report.manifest.goldSampleCount} 个样本、回归 ${report.manifest.regressionCaseCount} 个案例），避免训练集吃掉自己的基准。</p>`;
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function downloadTrainingDataset(dataset, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "导出中……";
  try {
    const response = await fetch("/api/learning/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...learningActionBody(), format: "jsonl", dataset })
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `导出失败：${response.status}`);
    }
    const blob = await response.blob();
    if (!blob.size) {
      toast("当前范围没有可导出的样本");
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = `kami-${dataset}-${learningActionBody().locale}.jsonl`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
    toast(`${dataset.toUpperCase()} 数据集已导出`);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

const TRAINING_STATUS_LABEL = {
  draft: "草稿", frozen: "数据已冻结", submitted: "已提交", running: "训练中",
  succeeded: "训练成功", failed: "失败", cancelled: "已取消", registered: "产物已登记", promoted: "已投产"
};

const TRAINING_NEXT_ACTIONS = {
  frozen: [["submitted", "标记为已提交"]],
  submitted: [["running", "标记为训练中"], ["failed", "标记失败"]],
  running: [["succeeded", "标记训练成功"], ["failed", "标记失败"]],
  succeeded: [["registered", "登记产出模型"]],
  registered: [["promoted", "过门禁并投产"]]
};

async function loadTrainingRuns() {
  const params = new URLSearchParams(learningActionBody());
  try {
    const payload = await api(`/api/training/runs?${params}`);
    state.trainingRuns = payload.runs || [];
    renderTrainingRuns();
  } catch (error) {
    $("#learningTrainingCount").textContent = "读取失败";
    $("#learningTrainingList").innerHTML = `<div class="empty-list learning-empty">微调任务读取失败：${escapeHtml(error.message)}</div>`;
  }
}

function renderTrainingRuns() {
  const runs = state.trainingRuns || [];
  $("#learningTrainingCount").textContent = `${runs.length} 个任务`;
  $("#learningTrainingList").innerHTML = runs.length
    ? runs.map((run) => {
      const payload = run.payload || {};
      const datasets = (payload.datasets || []).map((item) => `${item.kind.toUpperCase()} ${item.recordCount} 条 · 指纹 ${String(item.contentFingerprint).slice(0, 12)}…`).join("；");
      const actions = (TRAINING_NEXT_ACTIONS[run.status] || [])
        .map(([status, label]) => `<button class="button ghost small" type="button" data-training-advance="${escapeHtml(status)}" data-run-id="${escapeHtml(run.id)}">${escapeHtml(label)}</button>`)
        .join("");
      return `<article class="learning-training-item" data-status="${escapeHtml(run.status)}">
        <div class="learning-training-head">
          <span class="learning-training-status">${escapeHtml(TRAINING_STATUS_LABEL[run.status] || run.status)}</span>
          <strong>${escapeHtml(run.name)}</strong>
          <small>${escapeHtml(run.method.toUpperCase())} · 基座 ${escapeHtml(run.baseModel || "未填")}${run.teacherModel ? ` · 教师 ${escapeHtml(run.teacherModel)}` : ""}</small>
        </div>
        <p class="learning-training-datasets">${escapeHtml(datasets || "无数据集")}</p>
        ${run.artifactModelId ? `<p class="learning-training-artifact">产出模型：${escapeHtml(run.artifactModelId)}${payload.gate ? ` · 门禁 ${escapeHtml(payload.gate.decision)}（${escapeHtml(payload.gate.runId || "")}）` : ""}</p>` : ""}
        ${run.error ? `<p class="learning-training-error">${escapeHtml(run.error)}</p>` : ""}
        <div class="learning-training-actions">
          <button class="button ghost small" type="button" data-training-manifest="${escapeHtml(run.id)}">下载交接清单</button>
          ${actions}
        </div>
      </article>`;
    }).join("")
    : '<div class="empty-list learning-empty">当前范围还没有微调任务</div>';
  $$("[data-training-advance]").forEach((button) => button.addEventListener("click", () => advanceTrainingRunFromUi(button.dataset.runId, button.dataset.trainingAdvance, button)));
  $$("[data-training-manifest]").forEach((button) => button.addEventListener("click", () => downloadTrainingManifest(button.dataset.trainingManifest)));
}

async function createTrainingRunFromUi(button) {
  const method = $("#trainingMethod").value;
  const baseModel = $("#trainingBaseModel").value.trim();
  if (!baseModel) return toast("请先填写基座模型");
  const teacherModel = $("#trainingTeacherModel").value.trim();
  if (method === "distillation" && !teacherModel) return toast("蒸馏必须填写教师模型");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "冻结中……";
  try {
    const created = await api("/api/training/runs", {
      method: "POST",
      body: JSON.stringify({ ...learningActionBody(), method, baseModel, teacherModel })
    });
    toast(`已冻结 ${created.run.totalRecords} 条样本并建立任务`);
    await loadTrainingRuns();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function advanceTrainingRunFromUi(runId, status, button) {
  const body = { ...learningActionBody(), status, by: "工作台" };
  if (status === "registered") {
    const modelId = prompt("产出模型 ID（外部训练平台返回的模型或适配器标识）");
    if (!modelId) return;
    body.artifact = { modelId, adapterUri: prompt("适配器地址（可留空）") || "" };
  }
  if (status === "failed") {
    body.error = prompt("失败原因") || "未填写原因";
  }
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "处理中……";
  try {
    await api(`/api/training/runs/${encodeURIComponent(runId)}/advance`, { method: "POST", body: JSON.stringify(body) });
    toast(status === "promoted" ? "门禁通过，微调模型已投产" : "任务状态已更新");
    await loadTrainingRuns();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function downloadTrainingManifest(runId) {
  try {
    const payload = await api(`/api/training/runs/${encodeURIComponent(runId)}/manifest`);
    const blob = new Blob([JSON.stringify(payload.manifest, null, 2)], { type: "application/json" });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = `kami-training-manifest-${runId}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  } catch (error) {
    toast(error.message);
  }
}

/** 领域下拉里的中文名：提示条要用用户看得懂的说法，不直接抛 game / marketing。 */
function learningDomainLabel(domain) {
  const option = [...($("#learningDomain")?.options || [])].find((item) => item.value === String(domain));
  return option ? option.textContent.trim() : String(domain || "");
}

/**
 * 范围分布常驻面板：每个「语体 × 领域」各有多少条轨迹、来自哪些文件，点一下切过去。
 *
 * 以前只在"当前范围没轨迹"时才提示一句，用户在具体范围里看不到别的范围有没有料、
 * 料来自哪个文件。现在常驻显示：有轨迹的范围按条数排序列出，当前范围高亮。
 */
function renderLearningScopeHint(scopeCounts, trajectoryCount) {
  const container = $("#learningScopeHint");
  if (!container) return;
  const scopes = learningArray(scopeCounts)
    .map((item) => ({
      contentType: item.contentType || item.content_type || "general",
      domain: item.domain || "general",
      count: Number(item.count) || 0,
      files: learningArray(item.files).map((file) => ({ name: String(file?.name || ""), count: Number(file?.count) || 0 })).filter((file) => file.name)
    }))
    .filter((item) => item.count > 0)
    .sort((left, right) => right.count - left.count);
  if (!scopes.length) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }
  const allScopes = learningAllScopes();
  const currentContentType = learningScopeSelected("contentType");
  const currentDomain = learningScopeSelected("domain");
  const total = scopes.reduce((sum, item) => sum + item.count, 0);
  const emptyNote = !allScopes && trajectoryCount === 0
    ? `<p class="learning-scope-empty">当前选择（${escapeHtml(contentTypeLabel(currentContentType))} × ${escapeHtml(learningDomainLabel(currentDomain))}）还没有轨迹；挑一个下面有轨迹的范围，或选「全部」一起看。</p>`
    : "";
  container.hidden = false;
  container.innerHTML = `<div class="learning-scope-head"><strong>本项目各范围的轨迹</strong><small>${scopes.length} 个范围有轨迹 · 共 ${total} 条${allScopes ? "" : " · 当前范围已标出，点任一范围可切换"}</small></div>${emptyNote}<div class="learning-scope-rows">${scopes.map((item) => {
    const current = !allScopes && item.contentType === currentContentType && item.domain === currentDomain;
    const fileText = item.files.slice(0, 2).map((file) => `${file.name}（${file.count} 条）`).join("、");
    const moreText = item.files.length > 2 ? ` 等 ${item.files.length} 个文件` : "";
    return `<button type="button" class="learning-scope-row${current ? " current" : ""}" data-learning-scope-content="${escapeHtml(item.contentType)}" data-learning-scope-domain="${escapeHtml(item.domain)}"><span class="learning-scope-name">${escapeHtml(contentTypeLabel(item.contentType))} × ${escapeHtml(learningDomainLabel(item.domain))}</span><span class="learning-scope-count">${item.count} 条</span><small class="learning-scope-files">${item.files.length ? `来源：${escapeHtml(`${fileText}${moreText}`)}` : "来源文件未记录"}</small></button>`;
  }).join("")}</div>`;
  $$("#learningScopeHint [data-learning-scope-content]").forEach((button) => button.addEventListener("click", async () => {
    $("#learningContentType").value = button.dataset.learningScopeContent;
    $("#learningDomain").value = button.dataset.learningScopeDomain;
    await loadLearning(state.learningLocale);
  }));
}

function renderLearning() {
  if (!state.learningData) return;
  const { payload, champions, candidates, evaluations, evidence } = learningPayload();
  const trajectories = validLearningTrajectories(payload.trajectories || evidence);
  const scopedSkills = learningArray(payload.skills).filter(learningScopeMatches);
  const trajectoryCount = trajectories.length;
  const skillCount = scopedSkills.length || candidates.length + champions.length;
  const pendingCount = candidates.filter((skill) => !learningEvaluationFor(skill, evaluations)).length;
  $("#learningTrajectoryCount").textContent = trajectoryCount.toLocaleString("zh-CN");
  $("#learningSkillCount").textContent = skillCount.toLocaleString("zh-CN");
  $("#learningPendingCount").textContent = pendingCount.toLocaleString("zh-CN");
  renderLearningScopeHint(payload.scopeCounts, trajectoryCount);
  renderLearningChampion(champions, payload.scopeCounts);
  renderLearningCandidates(candidates, evaluations, champions, trajectoryCount);
  const selected = candidates.find((item) => learningId(item) === state.learningSelectedSkillId) || candidates[0];
  renderLearningEvaluation(selected, selected ? learningEvaluationFor(selected, evaluations) : null, learningChampionFor(selected, champions));
  renderLearningConflicts(state.conflictReport);
  renderLearningEvidence(evidence, candidates);
  syncLearningScopeBoundActions();
  bindLearningCardEvents();
  refreshActions();
}

function bindLearningCardEvents() {
  $$("[data-learning-select]").forEach((card) => {
    const select = () => { state.learningSelectedSkillId = card.dataset.learningSelect; renderLearning(); };
    card.addEventListener("click", (event) => { if (!event.target.closest("button, summary, a")) select(); });
    card.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } });
  });
  $$("[data-learning-action]").forEach((button) => button.addEventListener("click", () => runLearningAction(button.dataset.skillId, button.dataset.learningAction, button)));
}

async function loadLearning(locale = state.learningLocale) {
  state.learningLocale = locale;
  renderLocaleStrip($("#learningLocales"), locale, loadLearning);
  $("#learningError").hidden = true;
  state.learningLoading = true;
  refreshActions();
  try {
    const scope = learningActionBody();
    const params = new URLSearchParams({ locale, contentType: scope.contentType, domain: scope.domain, project: scope.project });
    state.learningData = await api(`/api/learning?${params}`);
    state.learningLoading = false;
    state.conflictReport = null;
    renderLearning();
    // 规则冲突、固定质量资产、微调任务都是按「一个范围」结算的：全部视图下不拿
    // "跨范围"口径去问它们，免得给出看着像结论的混合数字。
    if (learningAllScopes()) renderLearningScopeBoundNotice();
    else {
      loadConflictReport();
      loadQualityGate();
      loadTrainingRuns();
    }
  } catch (error) {
    state.learningData = null;
    state.learningLoading = false;
    $("#learningErrorMessage").textContent = error.message;
    $("#learningError").hidden = false;
    $("#learningTrajectoryCount").textContent = "—";
    $("#learningSkillCount").textContent = "—";
    $("#learningPendingCount").textContent = "—";
    $("#learningChampionStatus").textContent = "未加载";
    $("#learningCandidateCount").textContent = "—";
    $("#learningEvidenceCount").textContent = "—";
    $("#learningChampion").innerHTML = '<div class="empty-list learning-empty">学习数据读取失败</div>';
    $("#learningCandidateList").innerHTML = '<div class="empty-list learning-empty">学习数据读取失败</div>';
    $("#learningEvaluationMatrix").innerHTML = '<div class="empty-list learning-empty">学习数据读取失败</div>';
    $("#learningEvidenceList").innerHTML = '<div class="empty-list learning-empty">学习数据读取失败</div>';
    $("#learningConflictCount").textContent = "未加载";
    refreshActions();
  }
}

/** 全部视图下，范围强绑定的三块统一显示"选具体范围后查看"。 */
function renderLearningScopeBoundNotice() {
  const notice = '<div class="empty-list learning-empty"><div><strong>先选具体「内容语体 × 业务领域」</strong><span>规则冲突审查、固定质量资产与微调任务都按单个范围结算，不跨范围合并。</span></div></div>';
  // 先按"尚未扫描"清掉旧结论，再盖上跨范围说明，避免残留上一轮的报告。
  renderLearningConflicts(null);
  $("#learningGateStatus").textContent = "需选定范围";
  $("#learningQualityAssets").innerHTML = notice;
  $("#learningRegressionCandidates").innerHTML = "";
  $("#learningTrainingCount").textContent = "需选定范围";
  $("#learningTrainingList").innerHTML = notice;
  $("#learningConflictCount").textContent = "需选定范围";
  $("#learningConflictList").innerHTML = notice;
  state.qualityAssets = null;
  state.qualityGate = null;
  state.trainingRuns = [];
}

/**
 * 全部视图下把"按单个范围结算"的动作按钮也一起置灰：
 * 这些接口会在服务端按作用域校验，传 all 会直接报"不允许使用通配值"。
 * 按钮标题写清为什么不能点，避免用户点了才看到报错。
 */
const LEARNING_SCOPE_BOUND_BUTTONS = ["learningGateRun", "learningGoldSeed", "learningRegressionBuild", "learningExportAudit", "learningExportSft", "learningExportDpo", "trainingCreate", "learningConflictScan"];

function syncLearningScopeBoundActions() {
  const allScopes = learningAllScopes();
  for (const id of LEARNING_SCOPE_BOUND_BUTTONS) {
    const button = document.getElementById(id);
    if (!button) continue;
    button.disabled = allScopes;
    if (allScopes) button.title = "先选具体「语体 × 领域」：这些操作按单个范围结算，不能跨范围执行";
    else if (button.title.startsWith("先选具体")) button.title = "";
  }
}

function learningActionBody() {
  return { locale: state.learningLocale, contentType: $("#learningContentType").value, domain: $("#learningDomain").value, project: state.activeProjectId || "default" };
}

async function runLearningAction(skillId, action, button) {
  if (!skillId) return toast("技能缺少可操作的版本 ID");
  if (action === "evaluate") return runSkillEvaluation(skillId, button);
  const prompts = { activate: "确认批准这个候选并替换当前生效版本？原版本仍可回滚。", reject: "确认拒绝这个候选版本？它会保留在审计记录中。", rollback: "确认回滚到上一已验证版本？当前版本不会被删除。" };
  if (prompts[action] && !confirm(prompts[action])) return;
  const original = button?.textContent;
  if (button) { button.disabled = true; button.textContent = "处理中……"; }
  try {
    await api(`/api/learning/skills/${encodeURIComponent(skillId)}/${action}`, { method: "POST", body: JSON.stringify(learningActionBody()) });
    toast({ activate: "候选已批准并成为当前生效版本", reject: "候选已拒绝", rollback: "已回滚到上一验证版本" }[action] || "操作已完成");
    await loadLearning(state.learningLocale);
  } catch (error) {
    toast(error.message);
    if (button) { button.disabled = false; button.textContent = original; }
  }
}

async function runSkillEvaluation(skillId, button) {
  const original = button?.textContent;
  try {
    const created = await api(`/api/learning/skills/${encodeURIComponent(skillId)}/evaluate`, { method: "POST", body: JSON.stringify(learningActionBody()) });
    if (!created.jobId) {
      // 留出集不足 20 条：服务端已生成可审计的 insufficient 结论，无需模型调用。
      toast(created.result?.conclusion || "证据不足，暂不能发起真实评测");
      await loadLearning(state.learningLocale);
      return;
    }
    if (created.alreadyRunning) toast("该候选已有进行中的评测任务，已接续跟踪");
    await watchEvaluationJob(created.jobId, button, original);
    await loadLearning(state.learningLocale);
  } catch (error) {
    toast(error.message);
    if (button) { button.disabled = false; button.textContent = original; }
  }
}

async function watchEvaluationJob(jobId, button, original) {
  const deadline = Date.now() + 2 * 60 * 60 * 1000;
  while (Date.now() < deadline) {
    let job;
    try {
      ({ job } = await api(`/api/learning/evaluation-jobs/${encodeURIComponent(jobId)}`));
    } catch (error) {
      toast(error.message);
      if (button) { button.disabled = false; button.textContent = original; }
      return;
    }
    const { requested, completed, failed } = job.progress;
    if (button) {
      button.disabled = true;
      button.textContent = `评测中 ${completed}/${requested}${failed ? `（${failed} 失败）` : ""}……`;
    }
    if (job.status === "interrupted") {
      try {
        ({ job } = await api(`/api/learning/evaluation-jobs/${encodeURIComponent(jobId)}/resume`, { method: "POST" }));
      } catch (error) {
        toast(`评测任务无法续跑：${error.message}`);
        return;
      }
    }
    if (["completed", "failed"].includes(job.status)) {
      if (job.status === "completed") {
        const report = job.result?.report;
        toast(report?.promotable ? "候选评测完成并通过晋升门槛，可批准启用" : `候选评测完成：${report?.conclusion || "未通过晋升门槛"}`);
      } else {
        toast(`评测任务失败：${job.error || "未知错误"}`);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  toast("评测任务长时间未结束，请稍后在学习中心查看");
}

/** 全部视图下的可选范围：项目里有轨迹的「语体 × 领域」，按条数排序。 */
function learningScopesWithTrajectories() {
  return learningArray(state.learningData?.scopeCounts || state.learningData?.data?.scopeCounts)
    .map((item) => ({
      contentType: item.contentType || item.content_type || "general",
      domain: item.domain || "general",
      count: Number(item.count) || 0,
      files: learningArray(item.files).map((file) => String(file?.name || "")).filter(Boolean)
    }))
    .filter((item) => item.count > 0)
    .sort((left, right) => right.count - left.count);
}

/**
 * 全部视图下没有"当前范围"：生成候选前必须先落到一个具体范围。
 * 只有一个有轨迹的范围就直接用；多个则让用户挑（附条数与来源文件）。
 */
async function resolveLearningScopeForGeneration() {
  const scopes = learningScopesWithTrajectories();
  if (!scopes.length) {
    toast("当前项目还没有可用于学习的轨迹");
    return false;
  }
  let picked = scopes[0];
  if (scopes.length > 1) {
    const choice = await openChoiceDialog({
      kicker: "PICK SCOPE",
      title: "先选一个范围生成候选技能",
      summary: "候选技能按「语言 × 语体 × 领域 × 项目」隔离，必须落到具体范围；下面只列有轨迹的范围。",
      options: scopes.map((scope) => {
        const files = scope.files.slice(0, 2).join("、");
        const more = scope.files.length > 2 ? ` 等 ${scope.files.length} 个文件` : "";
        return {
          id: `${scope.contentType}\u0000${scope.domain}`,
          label: `${contentTypeLabel(scope.contentType)} × ${learningDomainLabel(scope.domain)}`,
          hint: `${scope.count} 条轨迹${scope.files.length ? ` · 来源：${files}${more}` : ""}`
        };
      })
    });
    if (!choice) return false;
    const [contentType, domain] = String(choice).split("\u0000");
    picked = scopes.find((scope) => scope.contentType === contentType && scope.domain === domain) || picked;
  }
  $("#learningContentType").value = picked.contentType;
  $("#learningDomain").value = picked.domain;
  await loadLearning(state.learningLocale);
  return true;
}

async function generateLearningSkill() {
  if (learningAllScopes() && !(await resolveLearningScopeForGeneration())) return;
  setBusy(true, "正在提炼候选技能……");
  try {
    const result = await api("/api/learning/skills/generate", { method: "POST", body: JSON.stringify(learningActionBody()) });
    const generated = result.skill || result.candidate || result.data;
    if (generated) state.learningSelectedSkillId = learningId(generated);
    toast("已根据近期轨迹生成隔离候选，下一步请运行评测");
    await loadLearning(state.learningLocale);
  } catch (error) { toast(error.message); }
  finally { setBusy(false); }
}

async function cleanTable() {
  if (!state.importFile) return toast("请先选择表格");
  setBusy(true, "识别与清洗中…");
  state.importBatchLearning = [];
  renderImportBatchLearning();
  const progressId = globalThis.crypto?.randomUUID?.() || `import-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const progressControl = { done: false };
  const progressWatcher = watchImportProgress(progressId, progressControl);
  try {
    const result = await api("/api/term-import/preview", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      filename: state.importFile.name,
      base64: await fileToBase64(state.importFile),
      progressId
    }) });
    result.candidates.forEach((candidate) => { candidate.selected = candidate.decision === "ready" && !candidate.existing; });
    state.importPreview = result;
    state.importCompleted = false;
    state.importVisibleCount = { terms: 150, styles: 150 };
    const mappings = result.sheets.map((sheet) => `${sheet.sheet}：日语列 ${sheet.sourceColumn}，简体中文列 ${Object.entries(sheet.targetColumns).map(([locale, column]) => `${state.bootstrap.locales[locale].shortLabel} ${column}`).join(" / ")}`).join("；");
    const structureText = result.structureAnalysis?.used
      ? "AI 已识别列结构（支持无表头）"
      : result.structureAnalysis?.requested ? "AI 结构识别不可用，已回退本地整列推断" : "使用本地整列推断";
    const aiText = result.ai?.used ? `AI 已复核 ${result.ai.reviewed} 条` : result.ai?.requested ? `AI 清洗不可用，已回退本地规则` : "使用本地规则清洗";
    $("#mappingNote").textContent = `${mappings}。${structureText}；${aiText}。候选不会在确认前写入正式术语库。`;
    renderImportCandidates();
    toast(`已筛出 ${result.candidates.length} 组候选，请审核后导入`);
  } catch (error) {
    updateImportProgress({ message: `识别失败：${error.message}`, percent: 100 });
    toast(error.message);
  }
  finally {
    progressControl.done = true;
    await progressWatcher;
    setBusy(false);
  }
}

async function commitImport() {
  if (!state.importPreview) return;
  if (!selectedCandidates().length) return toast("请至少选择一组候选资产");
  setBusy(true, "正在分库写入…");
  // 几千条的分库写入要跑几分钟：预检批次已经建了后台任务，这里跟着它的进度走，
  // 不要只让按钮变成"正在分库写入…"然后就静止不动。
  const backgroundTaskId = state.importPreview.backgroundTaskId || "";
  let watching = Boolean(backgroundTaskId);
  const watcher = (async () => {
    const startedAt = Date.now();
    while (watching) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (!watching) return;
      const task = await api(`/api/background-tasks/${encodeURIComponent(backgroundTaskId)}`).catch(() => null);
      if (!task) return;
      updateImportProgress({ ...(task.progress || {}), message: `${task.progress?.message || "正在分库写入"} · 已用时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒` });
      if (["completed", "failed", "needs_attention"].includes(task.status)) return;
    }
  })();
  try {
    const result = await api("/api/term-import/commit", { method: "POST", body: JSON.stringify({
      ...projectPayload(),
      batchId: state.importPreview.batchId,
      filename: state.importPreview.filename,
      candidates: state.importPreview.candidates,
      backgroundTaskId: state.importPreview.backgroundTaskId || ""
    }) });
    state.importCompleted = true;
    const importedIds = new Set(result.imported.map((item) => `${item.locale}\u0000${item.source}\u0000${item.target}`));
    state.importPreview.candidates.forEach((candidate) => {
      if (importedIds.has(`${candidate.locale}\u0000${candidate.source}\u0000${candidate.target}`)) candidate.existing = true;
      candidate.selected = false;
    });
    state.importBatchLearning = learningRunsFromPayload(result, { includeProfileFallback: true });
    renderImportBatchLearning();
    const pendingStyles = (result.styleFallbacks || []).slice(0, 4).map((item) => `${state.bootstrap.locales[item.locale]?.shortLabel || item.locale} ${contentTypeLabel(item.contentType)} ${styleDistillProgress(item)}`).join("；");
    const learnedText = state.importBatchLearning.length ? `本批已形成 ${state.importBatchLearning.length} 个风格学习范围，具体内容见下方。` : "本批没有生成可展示的风格学习结果。";
    const skippedReasons = Object.entries(result.summary.skippedByReason || {}).map(([reason, count]) => `${reason} ${count}`).join("；");
    $("#mappingNote").textContent = `批次已完成：写入术语 ${result.summary.terms || 0} 条、完整译例 / 风格证据 ${result.summary.memories || 0} 条、生成风格草稿 ${result.summary.styleProfiles || 0} 个，跳过 ${result.summary.skipped ?? result.skipped.length} 条${skippedReasons ? `（${skippedReasons}）` : ""}。${learnedText}${pendingStyles ? ` 尚在积累：${pendingStyles}。` : ""}所有资产均按日语→简体中文语言对与自动识别语体隔离。`;
    renderImportCandidates();
    await Promise.all([...new Set(result.imported.filter((item) => item.assetType === "term").map((item) => item.locale))].map((locale) => loadAssets(locale)));
    toast(`已导入 ${result.summary.terms || 0} 条术语和 ${result.summary.memories || 0} 条翻译记忆`);
  } catch (error) { toast(error.message); }
  finally {
    watching = false;
    await watcher;
    setBusy(false);
  }
}

function populateSelects() {
  const contentOptions = Object.entries(state.bootstrap.contentTypes).map(([value, details]) => `<option value="${value}">${details.label}</option>`).join("");
  $("#assetForm select[name=contentType]").innerHTML = contentOptions;
  // 学习中心可以把语体整维度放开：默认仍是"待分类文本"，最后一项留给"全部语体"。
  $("#learningContentType").innerHTML = `${contentOptions}<option value="all">全部语体</option>`;
  if ([...$("#learningContentType").options].some((option) => option.value === "general")) $("#learningContentType").value = "general";
  $("#taskLocale").innerHTML = Object.entries(state.bootstrap.locales).map(([locale, details]) => `<option value="${locale}">日语→${details.label}</option>`).join("");
}

function bindEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  $$('input[name="importPurpose"]').forEach((input) => input.addEventListener("change", () => syncImportPurposeControls({ resetDefaults: true })));
  $("#importAiCleaning")?.addEventListener("change", (event) => { state.assetImportAiCleaning = event.target.checked; });
  $("#importStyleEvidence")?.addEventListener("change", (event) => { state.assetImportStyleEvidence = event.target.checked; });
  $("#memoryStyleEvidence")?.addEventListener("change", (event) => { state.memoryStyleEvidence = event.target.checked; });
  $("#assetPreflightDialog").addEventListener("close", () => resolveAssetPreflight());
  $("#assetPreflightClose").addEventListener("click", () => closeAssetPreflightDialog());
  $("#assetPreflightAiCleaning")?.addEventListener("change", (event) => {
    state.assetImportAiCleaning = event.target.checked;
    renderAssetPreflight();
  });
  $("#assetPreflightStyleEvidence")?.addEventListener("change", (event) => {
    state.assetImportStyleEvidence = event.target.checked;
    renderAssetPreflight();
  });
  $$(".translation-mode").forEach((button) => button.addEventListener("click", () => setTranslationMode(button.dataset.translationMode)));
  $("#primaryAction").addEventListener("click", () => {
    if (state.view === "workbench" && state.translationMode === "single") translate();
    else if (state.view === "workbench" && state.batchRunning) {
      pauseBatch().catch((error) => toast(error.message));
    }
    else if (state.view === "workbench") state.batchPreview ? runBatch() : prepareBatch();
    else if (state.view === "import") state.assetPreflight ? $("#assetPreflightDialog").showModal() : state.importPreview && !state.importCompleted ? commitImport() : state.importFiles.length ? setImportFiles(state.importFiles) : cleanTable();
    else if (state.view === "tasks") loadTasks().catch((error) => toast(error.message));
    else if (state.view === "memories") loadMemories(state.memoryLocale).catch((error) => toast(error.message));
    else if (state.view === "styles") loadStyleGuidance(state.styleLocale).catch((error) => toast(error.message));
    else if (state.view === "learning") generateLearningSkill();
    else if (state.view === "autoqa") {
      const source = state.qaSource || "batch";
      const task = source === "batch" ? runQaFromBatch() : source === "file" ? runQaFromFile() : runAutoQa();
      Promise.resolve(task).catch((error) => toast(error.message));
    }
    else { resetTermDialog(); $("#assetDialog").showModal(); }
  });
  $("#secondaryAction").addEventListener("click", () => {
    if (state.view === "autoqa") return clearAutoQa();
    if (state.view === "workbench" && state.translationMode === "batch") resetBatch().catch((error) => toast(error.message));
    else if (state.view === "workbench") clearTranslation();
    else resetImport();
  });
  $("#tertiaryAction").addEventListener("click", async () => {
    if (state.view === "workbench" && state.translationMode === "batch") return exportBatch();
    await navigator.clipboard.writeText(state.lastResult.translation);
    toast("译文已复制");
  });
  $("#cancelBatchAction")?.addEventListener("click", () => cancelBatchRun().catch((error) => toast(error.message)));
  $("#reviewImportFile").addEventListener("change", (event) => submitReviewImport(event.target.files?.[0]));
  $("#batchJumpNext").addEventListener("click", () => jumpToNextBatchIssue());
  $("#batchQualityTier")?.addEventListener("change", () => {
    syncQualityTier($("#batchQualityTier").value, $("#batchQualityTier"));
    if (state.batchPreview) saveBatchProgress();
    toast(`质量档已设为${$("#batchQualityTier").selectedOptions[0]?.textContent || "自动"}，下一段起生效`);
  });
  $("#qualityTier")?.addEventListener("change", () => {
    syncQualityTier($("#qualityTier").value, $("#qualityTier"));
    if (state.batchPreview) saveBatchProgress();
  });
  $("#batchBriefRerun")?.addEventListener("click", () => rerunBatchBrief());
  $("#batchBriefEditToggle")?.addEventListener("click", () => toggleBatchBriefEdit());
  $("#batchBriefSave")?.addEventListener("click", () => saveBatchBriefEdit());
  $("#batchBriefCancel")?.addEventListener("click", () => { state.batchBriefDraft = null; renderBatchBrief(); });
  $("#batchConsistencyRun")?.addEventListener("click", () => runConsistencyCheckNow());
  $("#batchBriefPanel")?.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-brief-note-remove]");
    if (!remove || !state.batchBriefDraft) return;
    state.batchBriefDraft.notes.splice(Number(remove.dataset.briefNoteRemove), 1);
    renderBatchBrief();
  });
  $("#qaSourceTabs").addEventListener("click", (event) => {
    const tab = event.target.closest(".qa-source-tab");
    if (tab) setQaSource(tab.dataset.qaSource);
  });
  $("#qaBatchLoad").addEventListener("click", () => runQaFromBatch());
  $("#qaFile").addEventListener("change", (event) => {
    state.qaFile = event.target.files?.[0] || null;
    $("#qaFilePrompt").textContent = state.qaFile ? `已选择：${state.qaFile.name}` : "上传双语文件";
    $("#qaFileRun").disabled = !state.qaFile;
    refreshActions();
  });
  $("#qaFileRun").addEventListener("click", () => runQaFromFile());
  $("#qaFilters").addEventListener("click", (event) => {
    const chip = event.target.closest(".qa-filter-chip");
    if (!chip) return;
    state.qaFilter = chip.dataset.qaFilter || "";
    state.qaCursor = -1;
    renderQaSegments();
  });
  $("#qaJumpNext").addEventListener("click", () => jumpToNextQaSegment());
  $("#qaDownload").addEventListener("click", () => downloadQaReport());
  $("#sourceText").addEventListener("input", previewClassificationAndMatches);
  $("#sourceText").addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text/plain") || "";
    if (!shouldRoutePasteToBatch(text)) return;
    event.preventDefault();
    loadPastedTextAsBatch(text).catch((error) => toast(error.message));
  });
  $("#autoQaSource").addEventListener("input", () => {
    $("#autoQaSourceCount").textContent = `${[...$("#autoQaSource").value].length} 字`;
    $("#autoQaState").textContent = "等待质检";
    $("#autoQaState").className = "badge neutral";
    refreshActions();
  });
  $("#autoQaTarget").addEventListener("input", () => {
    $("#autoQaState").textContent = "等待质检";
    $("#autoQaState").className = "badge neutral";
    refreshActions();
  });
  ["autoQaSource", "autoQaTarget"].forEach((id) => $(`#${id}`).addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) runAutoQa().catch((error) => toast(error.message));
  }));
  $("#batchPasteText").addEventListener("input", () => {
    if ($("#batchPasteText").value.trim()) {
      state.batchFile = null;
      state.batchBase64 = "";
      state.batchPreview = null;
      state.batchClassification = null;
      state.batchStyleProfile = null;
      $("#batchFile").value = "";
      $("#batchFilePrompt").textContent = "已输入粘贴长文";
      $("#batchFileMeta").textContent = `${[...$("#batchPasteText").value.trim()].length} 字 · 等待解析`;
      $("#batchDropZone").classList.add("has-file");
      renderBatchSegments();
    }
    refreshActions();
  });
  $("#batchPasteText").addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text/plain") || "";
    if (!shouldRoutePasteToBatch(text)) return;
    event.preventDefault();
    loadPastedTextAsBatch(text).catch((error) => toast(error.message));
  });
  $("#batchFile").addEventListener("change", (event) => setBatchFile(event.target.files[0]));
  $("#batchSegmentationMode").addEventListener("change", () => {
    if (!state.batchPreview) return;
    state.batchPreview = null;
    state.batchClassification = null;
    state.batchStyleProfile = null;
    renderBatchSegments();
    refreshActions();
    if (state.batchFile || $("#batchPasteText").value.trim()) prepareBatch();
  });
  $("#batchDropZone").addEventListener("dragover", (event) => { event.preventDefault(); $("#batchDropZone").classList.add("dragging"); });
  $("#batchDropZone").addEventListener("dragleave", () => $("#batchDropZone").classList.remove("dragging"));
  $("#batchDropZone").addEventListener("drop", (event) => { event.preventDefault(); $("#batchDropZone").classList.remove("dragging"); setBatchFile(event.dataTransfer.files[0]); });
  $("#assetSearch").addEventListener("input", () => {
    clearTimeout(termSearchTimer);
    termSearchTimer = setTimeout(() => {
      if (state.view !== "assets" || !state.assetLibraryId) return;
      loadLibraryEntries("term", { append: false }).catch((error) => toast(error.message));
    }, 300);
  });
  $("#assetMore").addEventListener("click", () => loadLibraryEntries("term", { append: true }).catch((error) => toast(error.message)));
  // 库列表：启用开关、打开 / 导入 / 导出 / 设置 / 删除。
  for (const [kind, selector] of [["term", "#assetLibraryBody"], ["tm", "#memoryLibraryBody"]]) {
    $(selector).addEventListener("click", (event) => {
      const toggle = event.target.closest("[data-library-toggle]");
      if (toggle) {
        toggleLibraryEnabled(kind, toggle.dataset.id, toggle.checked).catch((error) => {
          toggle.checked = !toggle.checked;
          toast(error.message);
        });
        return;
      }
      const button = event.target.closest("[data-library-action]");
      if (!button) return;
      const libraryId = button.dataset.id || "";
      if (button.dataset.libraryAction === "open") openLibrary(kind, libraryId).catch((error) => toast(error.message));
      else if (button.dataset.libraryAction === "import") importIntoLibrary(kind, libraryId);
      else if (button.dataset.libraryAction === "export") exportLibrary(kind, libraryId, button);
      else if (button.dataset.libraryAction === "settings") openProjectSettings({ tab: "libraries" });
      else if (button.dataset.libraryAction === "delete") deleteLibrary(kind, libraryId);
    });
  }
  $("#assetBreadcrumbBack").addEventListener("click", () => closeLibrary("term").catch((error) => toast(error.message)));
  // 面包屑返回是"退一步"：在文件层里先退到文件列表，在文件列表里才退到库列表。
  $("#memoryBreadcrumbBack").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    // 切换期间禁用：连点两次会连跳两级，既容易点错也会让页面处于中间状态。
    if (button.disabled) return;
    button.disabled = true;
    try {
      if (state.memoryLibraryFile) await closeLibraryFile("tm");
      else await closeLibrary("tm");
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  });
  $("#memoryFileBody").addEventListener("click", (event) => {
    const button = event.target.closest("[data-file-action]");
    if (!button) return;
    const key = button.dataset.key || "";
    if (button.dataset.fileAction === "open") openLibraryFile("tm", key).catch((error) => toast(error.message));
    else if (button.dataset.fileAction === "export") {
      exportLibrary("tm", state.memoryLibraryId, button, key);
    } else if (button.dataset.fileAction === "delete") deleteLibraryFile("tm", key).catch((error) => toast(error.message));
  });
  $("#assetList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-term-action]");
    if (!button) return;
    const entry = state.assetEntries.find((item) => item.id === button.dataset.id);
    if (button.dataset.termAction === "edit") openTermEditDialog(entry);
    else if (button.dataset.termAction === "delete") deleteTermEntry(entry).catch((error) => toast(error.message));
  });
  $("#memoryList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-memory-action]");
    if (!button) return;
    const entry = state.memories.find((item) => item.id === button.dataset.id);
    if (button.dataset.memoryAction === "edit") openMemoryEntryDialog(entry);
    else if (button.dataset.memoryAction === "delete") deleteMemoryEntry(entry).catch((error) => toast(error.message));
  });
  $("#importTermLibrary")?.addEventListener("change", (event) => { state.importTermLibraryId = event.target.value; });
  $("#importTmLibrary")?.addEventListener("change", (event) => { state.importTmLibraryId = event.target.value; });
  $("#memoryEntryForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const id = $("#memoryEntryId").value;
    if (!id) return;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await api(`/api/memories/${encodeURIComponent(id)}?locale=${encodeURIComponent(state.memoryLocale)}`, {
        method: "PATCH",
        body: JSON.stringify({ source: form.source.value, target: form.target.value, entryKey: form.entryKey.value })
      });
      $("#memoryEntryDialog").close();
      toast("TM 条目已更新");
      await loadAssetsSafeRefresh("tm");
    } catch (error) { toast(error.message); }
    finally { submit.disabled = false; }
  });
  $("#termLibraryFile").addEventListener("change", (event) => {
    const files = event.target.files;
    if (!files.length) return;
    switchView("import");
    setImportFiles(files, { intent: "terms", returnView: "assets" }).finally(() => { event.target.value = ""; });
  });
  $("#memorySearch").addEventListener("input", () => {
    clearTimeout(memorySearchTimer);
    memorySearchTimer = setTimeout(() => {
      if (state.view !== "memories") return;
      if (!state.memoryLibraryId) return;
      loadLibraryEntries("tm", { append: false }).catch((error) => toast(error.message));
    }, 300);
  });
  $("#memoryMore").addEventListener("click", () => loadLibraryEntries("tm", { append: true }).catch((error) => toast(error.message)));
  $("#memoryFile").addEventListener("change", (event) => {
    state.memoryImportFiles = [...event.target.files];
    state.memoryImportFile = state.memoryImportFiles[0] || null;
    $("#memoryImportButton").disabled = !state.memoryImportFiles.length;
    $("#memoryImportButton").textContent = state.memoryImportFiles.length > 1 ? `重新预检 ${state.memoryImportFiles.length} 个文件` : "重新预检 TM";
    renderMemoryImportFiles();
    if (!state.memoryImportFiles.length) {
      $("#memoryImportNote").textContent = "选择文件后会自动本地预检；确认后写入主 TM。";
      $("#memoryImportPreview").hidden = true;
      return;
    }
    // 选中即预检：等用户再点一次按钮，很多人会以为"没导入"。
    previewMemoryImport();
  });
  $("#memoryImportButton").addEventListener("click", () => previewMemoryImport());
  $("#memoryImportConfirm").addEventListener("click", () => commitMemoryImport());
  $("#taskLocale").addEventListener("change", loadTasks);
  $("#taskStatus").addEventListener("change", loadTasks);
  $("#taskType").addEventListener("change", loadTasks);
  $("#taskSearch").addEventListener("input", () => { clearTimeout(state.taskSearchTimer); state.taskSearchTimer = setTimeout(() => loadTasks().catch((error) => toast(error.message)), 250); });
  $("#refreshTasks").addEventListener("click", () => loadTasks().catch((error) => toast(error.message)));
  $("#styleStatus").addEventListener("change", renderStyleGuidance);
  $("#refreshStyles").addEventListener("click", () => loadStyleGuidance(state.styleLocale).catch((error) => toast(error.message)));
  $("#logLevels").addEventListener("click", (event) => {
    const chip = event.target.closest(".log-level-chip");
    if (!chip) return;
    state.logLevel = chip.dataset.level || "";
    loadLogs().catch((error) => toast(error.message));
  });
  $("#logSearch").addEventListener("input", (event) => {
    state.logSearch = event.target.value.trim();
    clearTimeout(state.logSearchTimer);
    state.logSearchTimer = setTimeout(() => loadLogs().catch((error) => toast(error.message)), 250);
  });
  $("#logVerbosity").addEventListener("change", async (event) => {
    const level = event.target.value;
    try {
      const settings = await api("/api/logs/settings", { method: "POST", body: JSON.stringify({ level }) });
      $("#logVerbosity").value = settings.level;
      toast(`记录等级已切换为「${LOG_LEVEL_LABELS[settings.level] || settings.level}」`);
      await loadLogs();
    } catch (error) { toast(error.message); }
  });
  $("#logAutoRefresh").addEventListener("change", () => { if (state.view === "logs") startLogAutoRefresh(); else stopLogAutoRefresh(); });
  $("#logRefresh").addEventListener("click", () => loadLogs().catch((error) => toast(error.message)));
  $("#logDownload").addEventListener("click", () => { window.open("/api/logs/download", "_blank", "noopener"); });
  $("#logClear").addEventListener("click", async () => {
    if (!confirm("清空日志？磁盘上的日志文件也会一起删除。")) return;
    try {
      await api("/api/logs", { method: "DELETE" });
      await loadLogs();
      toast("日志已清空");
    } catch (error) { toast(error.message); }
  });
  $("#styleGuideFile").addEventListener("change", (event) => {
    state.styleGuideFile = event.target.files[0] || null;
    $("#styleGuideImportButton").disabled = !state.styleGuideFile;
    renderStyleGuidePicker();
    const note = $("#styleGuideImportNote");
    note.className = "library-import-note";
    note.textContent = state.styleGuideFile
      ? "已选择文件，点右侧按钮导入并立即启用。"
      : "人工风格指南按你的原话生效，优先级高于自动蒸馏出的规则，只作用于当前项目。";
  });
  $("#styleGuideImportButton").addEventListener("click", () => importStyleGuide());
  $("#retryLearning").addEventListener("click", () => loadLearning(state.learningLocale));
  $("#learningContentType").addEventListener("change", () => loadLearning(state.learningLocale));
  $("#learningDomain").addEventListener("change", () => loadLearning(state.learningLocale));
  $("#learningConflictScan").addEventListener("click", (event) => runConflictScan(event.currentTarget));
  $("#learningGateRun").addEventListener("click", (event) => runQualityGateFromUi(event.currentTarget));
  $("#learningGoldSeed").addEventListener("click", (event) => seedGoldSetFromTrajectories(event.currentTarget));
  $("#learningRegressionBuild").addEventListener("click", (event) => buildRegressionSuiteFromUi(event.currentTarget));
  $("#learningExportAudit").addEventListener("click", (event) => auditTrainingExport(event.currentTarget));
  $("#learningExportSft").addEventListener("click", (event) => downloadTrainingDataset("sft", event.currentTarget));
  $("#learningExportDpo").addEventListener("click", (event) => downloadTrainingDataset("dpo", event.currentTarget));
  $("#trainingCreate").addEventListener("click", (event) => createTrainingRunFromUi(event.currentTarget));
  $("#termFile").addEventListener("change", (event) => setImportFiles(event.target.files));
  $("#dropZone").addEventListener("dragover", (event) => { event.preventDefault(); $("#dropZone").classList.add("dragging"); });
  $("#dropZone").addEventListener("dragleave", () => $("#dropZone").classList.remove("dragging"));
  $("#dropZone").addEventListener("drop", (event) => { event.preventDefault(); $("#dropZone").classList.remove("dragging"); setImportFiles(event.dataTransfer.files); });
  $("#assetPreflightConfirm").addEventListener("click", () => confirmAssetPreflight());
  $$('[data-import-candidate-tab]').forEach((button) => button.addEventListener("click", () => setImportCandidateTab(button.dataset.importCandidateTab)));
  [["#selectAllTermCandidates", "terms"], ["#selectAllStyleCandidates", "styles"]].forEach(([selector, kind]) => $(selector).addEventListener("change", (event) => {
    indexedImportCandidates(kind).forEach(({ candidate }) => { if (!candidate.existing && candidate.decision !== "excluded") candidate.selected = event.target.checked; });
    renderImportCandidates();
  }));
  $("#assetForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const editingId = $("#assetDialogId").value;
    const payload = {
      source: form.get("source"), target: form.get("target"),
      aliases: String(form.get("aliases") || "").split(/[,，]/).map((value) => value.trim()).filter(Boolean),
      forbidden: String(form.get("forbidden") || "").split(/[,，]/).map((value) => value.trim()).filter(Boolean),
      contentTypes: [form.get("contentType")], domains: ["game"], enforcement: "preferred", note: form.get("note")
    };
    try {
      if (editingId) {
        // 编辑只改内容：库归属由服务端保留，不会被"默认库"覆盖。
        await api(`/api/assets/${encodeURIComponent(editingId)}?locale=${encodeURIComponent(state.assetLocale)}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await api("/api/assets", { method: "POST", body: JSON.stringify({
          ...projectPayload(),
          locale: state.assetLocale,
          // 打开某个库时"新增单条"就加进这个库；在库列表页则用项目默认库。
          term: { ...payload, ...(state.assetLibraryId ? { libraryId: state.assetLibraryId } : {}) }
        }) });
      }
      resetTermDialog();
      $("#assetDialog").close();
      await loadAssetsSafeRefresh("term");
      toast(editingId ? "术语已更新" : `已保存到${state.bootstrap.locales[state.assetLocale].label}术语库`);
    } catch (error) { toast(error.message); }
  });
  $("#refreshReferences").addEventListener("click", () => loadReferences().catch((error) => toast(error.message)));
  $("#referenceStatus").addEventListener("change", (event) => { state.referenceStatus = event.target.value; loadReferences().catch((error) => toast(error.message)); });
  $("#referenceLibrary").addEventListener("change", (event) => { state.referenceLibraryId = event.target.value; loadReferences().catch((error) => toast(error.message)); });
  $("#referenceSearch").addEventListener("change", (event) => { state.referenceSearch = event.target.value.trim(); loadReferences().catch((error) => toast(error.message)); });
  $("#referenceFileInput").addEventListener("change", (event) => {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    uploadReferenceFiles(files).catch((error) => toast(error.message));
  });
  $("#closeReferenceDetail").addEventListener("click", () => { $("#referenceDetailPanel").hidden = true; });
  $("#referenceList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-reference-action]");
    if (button) referenceAction(button.dataset.referenceAction, button.dataset.id, button).catch((error) => toast(error.message));
  });
  $("#referenceChunks").addEventListener("click", (event) => {
    const button = event.target.closest("[data-reference-action]");
    if (button) referenceAction(button.dataset.referenceAction, button.dataset.id, button).catch((error) => toast(error.message));
  });
  $("#referenceDetailActions").addEventListener("click", (event) => {
    const button = event.target.closest("[data-reference-action]");
    if (button) referenceAction(button.dataset.referenceAction, button.dataset.id, button).catch((error) => toast(error.message));
  });
  $("#autoQaIssues").addEventListener("click", (event) => {
    const button = event.target.closest("[data-qa-issue-delete]");
    if (button) deleteAutoQaIssue(button).catch((error) => toast(error.message));
  });
  $("#openProvider").addEventListener("click", openProviderSettings);
  $("#confirmTermReplace").addEventListener("click", applyTermSuggestion);
  $("#toggleTargetEdit").addEventListener("click", toggleTargetEdit);
  $("#acceptTranslation").addEventListener("click", acceptSingleTranslation);
  $("#sendToAutoQa").addEventListener("click", sendCurrentTranslationToAutoQa);
  $("#openSettings").addEventListener("click", openParameterSettings);
  $("#projectSelect").addEventListener("change", (event) => selectProject(event.target.value).catch((error) => toast(error.message)));
  $("#newProject").addEventListener("click", () => getProjectWizard().open());
  $("#openProjectSettings").addEventListener("click", openProjectSettings);
  $("#deleteProject").addEventListener("click", openDeleteProjectDialog);
  $("#deleteProjectSelectAll").addEventListener("change", (event) => {
    $$("#deleteProjectList input[type=checkbox]").forEach((input) => { input.checked = event.target.checked; });
    updateDeleteSelection();
  });
  $("#deleteProjectList").addEventListener("change", updateDeleteSelection);
  $("#deleteProjectData").addEventListener("change", updateDeleteConfirmLabel);
  $("#deleteProjectForm").addEventListener("submit", deleteProjectFromDialog);
  $("#acceptAllSegments").addEventListener("click", acceptAllSegments);
  $("#batchToAutoQa").addEventListener("click", sendBatchToAutoQa);
  $$('[data-close]').forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.close}`).close()));
}

async function initialize() {
  try {
    const [bootstrap, health] = await Promise.all([api("/api/bootstrap"), api("/api/health")]);
    state.bootstrap = bootstrap;
    state.serverVersion = health.version || "0.0.0";
    await loadProjects();
    // 资产后台不可用时服务端直接拒绝启动，界面不会再出现"已回退到 JSON"的降级态。
    const batchModeButton = $('.translation-mode[data-translation-mode="batch"]');
    if (!supportsBatchApi(state.serverVersion)) {
      batchModeButton.title = "批次模块等待服务重启后启用";
      batchModeButton.querySelector("small").textContent = "等待服务重启后启用";
    }
    $("#serverDot").classList.add("online");
    $("#serverStatus").textContent = "服务在线";
    $("#providerLabel").textContent = `${state.bootstrap.provider.model} · ${new URL(state.bootstrap.provider.baseUrl).hostname}`;
    if (state.bootstrap.backend?.adminUrl) {
      $("#openAdmin").href = state.bootstrap.backend.adminUrl;
      $("#openAdmin").title = `${state.bootstrap.backend.label} · 日语→简体中文术语后台`;
    } else $("#openAdmin").hidden = true;
    populateSelects();
    renderLocaleStrip($("#workbenchLocales"), state.workbenchLocale, updateWorkbenchLocale);
    renderLocaleStrip($("#assetLocales"), state.assetLocale, updateAssetLocale);
    renderLocaleStrip($("#memoryLocales"), state.memoryLocale, updateMemoryLocale);
    renderLocaleStrip($("#styleLocales"), state.styleLocale, updateStyleLocale);
    renderLocaleStrip($("#learningLocales"), state.learningLocale, loadLearning);
    // 质检页改成"来源"分区后没有语言 chip（只有 zh-CN）：必须容错，
    // 否则这里抛错会被外层 catch 吞掉，后面的 bindEvents() 全都不执行。
    if ($("#autoQaLocales")) renderLocaleStrip($("#autoQaLocales"), state.autoQaLocale, updateAutoQaLocale);
    bindEvents();
    updateBatchSegmentationOptions("粘贴长文.txt");
    setTranslationMode("single");
    await loadAssets(state.assetLocale);
    await loadMemories(state.memoryLocale);
    updateWorkbenchLocale(state.workbenchLocale);
    updateAutoQaLocale(state.autoQaLocale);
    refreshActions();
    await restoreBatchProgress();
  } catch (error) {
    $("#serverStatus").textContent = "连接失败";
    $("#providerLabel").textContent = error.message;
  }
}

initialize();


