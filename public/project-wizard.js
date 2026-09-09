const steps = [
  { id: "project", title: "项目信息", hint: "创建隔离工作区", optional: false },
  { id: "source", title: "待译原文件", hint: "导入后自动分段", optional: true },
  { id: "terms", title: "术语库", hint: "打开审核导入", optional: true },
  { id: "tm", title: "翻译记忆", hint: "写入主 TM", optional: true },
  { id: "style", title: "风格指南", hint: "生成待批准规范", optional: true },
  { id: "qa", title: "QA 设置", hint: "调整检查规则", optional: true }
];

const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const fileNames = (files) => Array.from(files || []).map((file) => file.name).join("、");

function filePicker({ id, accept, multiple = false, files = [], title, hint }) {
  const selected = fileNames(files);
  return `<label class="pw-file" for="${id}">
    <input id="${id}" type="file" data-file="${id}" accept="${accept}" ${multiple ? "multiple" : ""} />
    <span class="pw-file-icon" aria-hidden="true">＋</span>
    <span class="pw-file-copy"><strong>${title}</strong><small>${selected ? escape(selected) : hint}</small></span>
  </label>`;
}

export function createProjectWizard(dialog, {
  onCreateProject,
  onImportSource,
  onImportTerms,
  onPreviewTm,
  onCommitTm,
  onImportStyleGuide,
  onOpenQaSettings,
  onFinished
} = {}) {
  let index = 0;
  let project = null;
  let projectDraft = { name: "", description: "" };
  let sourceFile = null;
  let termFiles = [];
  let tmFile = null;
  let tmPreview = null;
  let styleFile = null;
  let busy = false;
  let error = "";
  const summary = [];
  const find = (selector) => dialog.querySelector(selector);

  function reset() {
    index = 0;
    project = null;
    projectDraft = { name: "", description: "" };
    sourceFile = null;
    termFiles = [];
    tmFile = null;
    tmPreview = null;
    styleFile = null;
    busy = false;
    error = "";
    summary.length = 0;
  }

  function stepMarkup() {
    const step = steps[index];
    if (step.id === "project") {
      return `<div class="pw-field-grid">
        <label><span>项目名称</span><input data-name required maxlength="80" placeholder="例如：Asia 2026 日中本地化" value="${escape(project?.name || projectDraft.name)}" ${project ? "disabled" : ""} /></label>
        <label><span>项目说明</span><textarea data-description maxlength="500" placeholder="可选：产品、版本或交付范围" ${project ? "disabled" : ""}>${escape(project?.description || projectDraft.description)}</textarea></label>
      </div>
      <div class="pw-note"><strong>${project ? "项目已创建" : "项目级隔离"}</strong><p>${project ? "可以直接继续，稍后在项目设置中仍可修改配置。" : "术语库、TM、风格规范、QA 记录和学习轨迹都会绑定到这个项目。"}</p></div>`;
    }
    if (step.id === "source") {
      return `${filePicker({ id: "source", accept: ".txt,.md,.docx,.xlsx,.csv,.xliff,.mqxliff", files: sourceFile ? [sourceFile] : [], title: "选择待译原文件", hint: "支持 TXT / Markdown / DOCX / XLSX / CSV / XLIFF / MQXLIFF，最大 10MB" })}
        <div class="pw-note"><strong>导入后会自动分段</strong><p>点击下一步后进入批次翻译工作区，不会自动开始翻译。</p></div>`;
    }
    if (step.id === "terms") {
      return `${filePicker({ id: "terms", accept: ".xlsx,.csv,.xliff,.mqxliff", multiple: true, files: termFiles, title: "选择术语表文件", hint: "支持 XLSX / CSV / XLIFF / MQXLIFF，可多选" })}
        <div class="pw-note"><strong>下一步会打开审核窗口</strong><p>候选不会直接入库；你确认后才写入当前项目的术语库。</p></div>`;
    }
    if (step.id === "tm") {
      const preview = tmPreview?.candidates?.length
        ? `<div class="pw-preview"><strong>识别到 ${tmPreview.candidates.length} 条 TM</strong><ul>${tmPreview.candidates.slice(0, 5).map((item) => `<li><span>${escape(item.source)}</span><b>→</b><span>${escape(item.target)}</span></li>`).join("")}</ul></div>`
        : "";
      return `${filePicker({ id: "tm", accept: ".xlsx,.csv,.xliff,.mqxliff", files: tmFile ? [tmFile] : [], title: "选择 TM 文件", hint: "支持 XLSX / CSV / XLIFF / MQXLIFF" })}
        ${preview}
        <div class="pw-note"><strong>下一步会写入主 TM</strong><p>未选择文件时直接下一步即可跳过；导入后仍可在记忆库页面查看。</p></div>`;
    }
    if (step.id === "style") {
      return `${filePicker({ id: "style", accept: ".txt,.md,.docx", files: styleFile ? [styleFile] : [], title: "选择风格指南", hint: "支持 TXT / Markdown / DOCX，最大 5MB" })}
        <div class="pw-note"><strong>导入后不会自动启用</strong><p>风格指南会生成待批准规范，需要在风格指导页确认后才会参与翻译。</p></div>`;
    }
    return `<div class="pw-qa-card">
      <strong>项目 QA 规则</strong>
      <p>默认使用当前项目的 QA 规则。你可以现在打开完整设置逐项调整，也可以直接完成，之后在项目设置里再改。</p>
      <button type="button" class="pw-secondary" data-open-qa>打开完整 QA 规则设置</button>
    </div>`;
  }

  function render() {
    const step = steps[index];
    dialog.innerHTML = `<form class="pw-form" novalidate>
      <header class="pw-header">
        <div><span class="pw-kicker">NEW PROJECT · STEP ${index + 1} / ${steps.length}</span><h2 id="projectWizardTitle">新建项目</h2><p>${step.hint}</p></div>
        <button type="button" class="pw-close" data-close-wizard aria-label="关闭新建项目向导">×</button>
      </header>
      <ol class="pw-steps">${steps.map((item, itemIndex) => `<li class="${itemIndex === index ? "active" : itemIndex < index ? "done" : ""}"><span>${itemIndex + 1}</span><div><strong>${item.title}</strong><small>${item.optional ? "可选" : "必填"}</small></div></li>`).join("")}</ol>
      <div class="pw-body">${stepMarkup()}${error ? `<div class="pw-error" role="alert">${escape(error)}</div>` : ""}${summary.length ? `<div class="pw-summary"><strong>已完成</strong>${summary.map((item) => `<span>${escape(item)}</span>`).join("")}</div>` : ""}</div>
      <footer class="pw-footer">
        <button type="button" class="pw-ghost" data-close-wizard>取消</button>
        <div>
          ${index > 0 ? '<button type="button" class="pw-ghost" data-back>上一步</button>' : ""}
          ${step.optional ? '<button type="button" class="pw-ghost" data-skip>跳过</button>' : ""}
          <button type="button" class="pw-primary" data-next ${busy ? "disabled" : ""}>${busy ? "处理中…" : index === 0 ? "创建并继续" : index === steps.length - 1 ? "完成" : "下一步"}</button>
        </div>
      </footer>
    </form>`;
  }

  function clearCurrentStep() {
    const step = steps[index];
    if (step.id === "source") sourceFile = null;
    if (step.id === "terms") termFiles = [];
    if (step.id === "tm") { tmFile = null; tmPreview = null; }
    if (step.id === "style") styleFile = null;
  }

  function finish() {
    dialog.close();
    onFinished?.([...summary]);
  }

  async function advance() {
    if (busy) return;
    error = "";
    const step = steps[index];
    if (step.id === "project" && !project) {
      projectDraft = {
        name: find("[data-name]").value.trim(),
        description: find("[data-description]").value.trim()
      };
    }
    busy = true;
    render();
    try {
      if (step.id === "project") {
        if (!project) {
          if (!projectDraft.name) throw new Error("请填写项目名称");
          project = await onCreateProject(projectDraft);
          summary.push(`项目已创建：${project.name}`);
        }
      } else if (step.id === "source" && sourceFile) {
        await onImportSource(sourceFile);
        summary.push(`待译原文件已导入：${sourceFile.name}`);
        sourceFile = null;
      } else if (step.id === "terms" && termFiles.length) {
        await onImportTerms(termFiles);
        summary.push(`术语表已进入审核：${fileNames(termFiles)}`);
        termFiles = [];
      } else if (step.id === "tm" && tmFile) {
        if (!tmPreview) tmPreview = await onPreviewTm(tmFile);
        if (tmPreview?.candidates?.length) {
          await onCommitTm(tmPreview);
          summary.push(`TM 已写入主记忆库：${tmPreview.candidates.length} 条`);
        } else {
          summary.push(`TM 文件没有可写入条目：${tmFile.name}`);
        }
        tmFile = null;
        tmPreview = null;
      } else if (step.id === "style" && styleFile) {
        const result = await onImportStyleGuide(styleFile);
        summary.push(`风格指南已导入为待批准规范：${result?.filename || styleFile.name}`);
        styleFile = null;
      }
      if (index === steps.length - 1) {
        finish();
        return;
      }
      index += 1;
    } catch (caught) {
      error = caught.message || String(caught);
    } finally {
      busy = false;
      if (dialog.open) render();
    }
  }

  function skip() {
    if (busy) return;
    error = "";
    clearCurrentStep();
    if (index === steps.length - 1) return finish();
    index += 1;
    render();
  }

  dialog.addEventListener("submit", (event) => event.preventDefault());
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); dialog.close(); });
  dialog.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button || busy) return;
    if (button.matches("[data-close-wizard]")) return dialog.close();
    if (button.matches("[data-back]")) {
      index = Math.max(0, index - 1);
      error = "";
      render();
      return;
    }
    if (button.matches("[data-skip]")) return skip();
    if (button.matches("[data-open-qa]")) {
      dialog.close();
      onFinished?.([...summary]);
      await onOpenQaSettings?.();
      return;
    }
    if (button.matches("[data-next]")) await advance();
  });
  dialog.addEventListener("change", async (event) => {
    const input = event.target;
    if (input.matches("[data-name], [data-description]")) {
      projectDraft[input.matches("[data-name]") ? "name" : "description"] = input.value;
      return;
    }
    if (!input.matches("[data-file]")) return;
    const kind = input.dataset.file;
    if (kind === "source") sourceFile = input.files[0] || null;
    if (kind === "terms") termFiles = [...input.files];
    if (kind === "style") styleFile = input.files[0] || null;
    if (kind === "tm") {
      tmFile = input.files[0] || null;
      tmPreview = null;
      if (tmFile) {
        busy = true;
        error = "";
        render();
        try {
          tmPreview = await onPreviewTm(tmFile);
        } catch (caught) {
          error = caught.message || String(caught);
        } finally {
          busy = false;
        }
      }
    }
    render();
  });

  return {
    open() {
      if (dialog.open) return;
      reset();
      render();
      dialog.showModal();
      find("[data-name]")?.focus();
    }
  };
}
