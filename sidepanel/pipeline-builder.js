// === sidepanel/pipeline-builder.js ===
"use strict";

const MSG = {
  PIPELINE_START: "pipeline:start",
  PIPELINE_STOP: "pipeline:stop",
};
const SK = { PIPELINE: "fs_active_pipeline" };

// ── Step Registry ─────────────────────────────────────────────────────────────
const STEP_REGISTRY = {
  NAVIGATE: {
    icon: "🌐",
    cat: "Action",
    desc: "Go to URL",
    def: { url: "https://", wait: true },
  },
  CLICK: {
    icon: "🖱️",
    cat: "Action",
    desc: "Click element",
    def: { selector: "", all: false },
  },
  FILL: {
    icon: "✏️",
    cat: "Action",
    desc: "Fill input / form",
    def: {
      mode: "single",
      selector: "",
      text: "",
      delayMs: 50,
      append: false,
      fields: [],
      submitSelector: "",
    },
  },
  HOVER: {
    icon: "👆",
    cat: "Action",
    desc: "Hover element",
    def: { selector: "" },
  },
  SELECT: {
    icon: "📑",
    cat: "Action",
    desc: "Dropdown select",
    def: { selector: "", value: "" },
  },
  SCROLL: {
    icon: "↕️",
    cat: "Action",
    desc: "Scroll page",
    def: { mode: "pixel", amount: 500 },
  },
  KEYBOARD: {
    icon: "⌨",
    cat: "Action",
    desc: "Press key",
    def: { key: "Enter" },
  },
  DRAG_DROP: {
    icon: "✋",
    cat: "Action",
    desc: "Drag & Drop",
    def: { source: "", target: "" },
  },

  WAIT: { icon: "⏳", cat: "Flow", desc: "Wait (ms)", def: { ms: 1000 } },
  IF_ELSE: {
    icon: "🔀",
    cat: "Flow",
    desc: "Conditional branch",
    def: { condition: "exists", selector: "", value: "", attr: "" },
  },
  LOOP: {
    icon: "🔁",
    cat: "Flow",
    desc: "Loop / repeat",
    def: { type: "elements", selector: "", max: 10, onFail: "skip" },
  },
  PAGINATE: {
    icon: "📄",
    cat: "Flow",
    desc: "Pagination click",
    def: { selector: "" },
  },

  EXTRACT: {
    icon: "📤",
    cat: "Data",
    desc: "Extract data",
    def: { fields: [] },
  },
  SCREENSHOT: {
    icon: "📸",
    cat: "Data",
    desc: "Capture screenshot",
    def: { quality: 100 },
  },
  EXPORT: {
    icon: "💾",
    cat: "Data",
    desc: "Export results",
    def: { format: "csv" },
  },
};

// ── State ─────────────────────────────────────────────────────────────────────
let _pipeline = { steps: [] };
let _expandedNodeId = null;
let _insertCtx = { index: -1, parentId: "", branchKey: "" };
let _runState = { active: false, timer: null, startTs: 0, runId: null };
let _dragSourceId = null;
let _keyListening = false;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const elCanvas = document.getElementById("pipeline-canvas");
const elPalette = document.getElementById("step-palette-overlay");
const elPaletteSearch = document.getElementById("palette-search");
const elPaletteContent = document.getElementById("palette-content");

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  bindNavTabs();
  bindGlobalControls();
  bindPalette();
  bindDelegatedEvents();

  const { [SK.PIPELINE]: saved } = await chrome.storage.local.get(SK.PIPELINE);
  if (saved?.steps) _pipeline = saved;
  renderPipeline();
  populatePalette();
  listenToSystem();

  chrome.runtime
    .sendMessage({ type: "checkpoint:check" })
    .then((res) => {
      if (res?.ok && res.result?.hasResumable && res.result.runs?.length > 0) {
        const banner = document.createElement("div");
        banner.className = "resume-banner";
        banner.innerHTML = `<span>⟳ Incomplete run found</span><button class="btn" id="btn-resume-run" style="font-size:11px;">Download Data</button>`;
        document.getElementById("view-monitor")?.prepend(banner);
        document
          .getElementById("btn-resume-run")
          ?.addEventListener("click", () =>
            document.getElementById("btn-download-partial")?.click(),
          );
      }
    })
    .catch(() => {});
}

async function saveState() {
  await chrome.storage.local.set({ [SK.PIPELINE]: _pipeline });
}

// ── Nav tabs ──────────────────────────────────────────────────────────────────
function bindNavTabs() {
  document.querySelectorAll(".nav-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".nav-pill")
        .forEach((b) => b.classList.remove("active"));
      document
        .querySelectorAll(".view")
        .forEach((v) => v.classList.remove("active"));
      btn.classList.add("active");
      document
        .getElementById(`view-${btn.dataset.tab}`)
        ?.classList.add("active");
    });
  });
}

// ── Global controls ───────────────────────────────────────────────────────────
function bindGlobalControls() {
  document
    .getElementById("btn-clear-pipeline")
    .addEventListener("click", () => {
      _pipeline.steps = [];
      _expandedNodeId = null;
      saveState();
      renderPipeline();
    });

  const btnRun = document.getElementById("btn-master-run");
  const btnStop = document.getElementById("btn-master-stop");

  btnRun.addEventListener("click", async () => {
    if (!_pipeline.steps.length) {
      logToMonitor("warn-log", "Pipeline is empty.");
      return;
    }
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab) {
      logToMonitor("warn-log", "No active tab found.");
      return;
    }
    const bypassRobots =
      document.getElementById("bypass-robots")?.checked || false;
    let urlObj = null;
    try {
      urlObj = new URL(tab.url);
    } catch {}

    document.getElementById("mon-errs").textContent = "0";
    document.getElementById("mon-rows").textContent = "0";
    document.getElementById("mon-progress-fill").style.width = "0%";
    document.getElementById("mon-progress-text").textContent = "0%";

    const res = await chrome.runtime.sendMessage({
      type: MSG.PIPELINE_START,
      payload: {
        pipeline: _pipeline,
        tabId: tab.id,
        targetOrigin: urlObj ? urlObj.origin : null,
        targetPath: urlObj ? urlObj.pathname : "/",
        bypassRobots,
      },
    });
    if (res?.ok) {
      _runState = {
        active: true,
        startTs: Date.now(),
        runId: res.result?.runId,
        timer: null,
      };
      btnRun.classList.add("hidden");
      btnStop.classList.remove("hidden");
      document.querySelector('[data-tab="monitor"]').click();
      startMonitorTimer();
      logToMonitor("info-log", "Pipeline started.");
    } else {
      logToMonitor(
        "error-log",
        `Failed to start: ${res?.error || "Unknown error"}`,
      );
    }
  });

  btnStop.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: MSG.PIPELINE_STOP });
    stopRunUI();
    logToMonitor("warn-log", "Pipeline stopped by user.");
  });

  document.getElementById("btn-clear-logs").addEventListener("click", () => {
    document.getElementById("mon-logs").innerHTML = "";
  });

  document
    .getElementById("btn-save-key-2captcha")
    ?.addEventListener("click", async () => {
      const val = document.getElementById("key-2captcha").value.trim();
      if (!val) return;
      const res = await chrome.runtime.sendMessage({
        type: "key:set",
        payload: { provider: "2captcha", value: val },
      });
      logToMonitor(
        res?.ok ? "info-log" : "error-log",
        res?.ok ? "2Captcha key saved." : "Failed to save 2Captcha key.",
      );
    });
  document
    .getElementById("btn-save-key-openai")
    ?.addEventListener("click", async () => {
      const val = document.getElementById("key-openai").value.trim();
      if (!val) return;
      const res = await chrome.runtime.sendMessage({
        type: "key:set",
        payload: { provider: "openai", value: val },
      });
      logToMonitor(
        res?.ok ? "info-log" : "error-log",
        res?.ok ? "OpenAI key saved." : "Failed to save OpenAI key.",
      );
    });
  document
    .getElementById("btn-update-proxies")
    ?.addEventListener("click", async () => {
      const text = document.getElementById("config-proxy-text").value.trim();
      const mode = document.getElementById("config-proxy-mode").value;
      if (!text) return logToMonitor("warn-log", "Paste proxy list first.");
      const res = await chrome.runtime.sendMessage({
        type: "proxy:update",
        payload: { text, mode },
      });
      logToMonitor(
        res?.ok ? "info-log" : "error-log",
        res?.ok
          ? `Proxy pool updated: ${res.result?.count || 0} entries.`
          : "Failed to update proxy pool.",
      );
    });
  document
    .getElementById("btn-export-script")
    ?.addEventListener("click", async () => {
      if (!_pipeline.steps.length)
        return logToMonitor("warn-log", "Pipeline is empty.");
      const format = "python"; // prompt() is blocked in sidepanel, defaulting to python
      const res = await chrome.runtime.sendMessage({
        type: "script:export",
        payload: { pipeline: _pipeline, format },
      });
      if (res?.ok && res.result?.code) {
        const blob = new Blob([res.result.code], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `flowscrape_${format}.${format === "python" ? "py" : "mjs"}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        logToMonitor("info-log", `Exported as ${format} script.`);
      } else {
        logToMonitor(
          "error-log",
          `Export failed: ${res?.error || "Unknown error"}`,
        );
      }
    });
  document
    .getElementById("btn-download-partial")
    ?.addEventListener("click", async () => {
      const res = await chrome.runtime.sendMessage({
        type: "data:download",
        payload: { runId: _runState.runId || "latest" },
      });
      if (res?.ok && res.result?.rows?.length > 0) {
        const rows = res.result.rows.map((r) => {
          const { runId, ...c } = r;
          return c;
        });
        const headers = Array.from(new Set(rows.flatMap(Object.keys)));
        const csv =
          headers.join(",") +
          "\n" +
          rows
            .map((r) =>
              headers
                .map((h) => `"${String(r[h] || "").replace(/"/g, '""')}"`)
                .join(","),
            )
            .join("\n");
        const blob = new Blob([csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `flowscrape_partial_${Date.now()}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        logToMonitor("info-log", `Downloaded ${rows.length} partial rows.`);
      } else {
        logToMonitor("warn-log", "No collected data available yet.");
      }
    });
}

function startMonitorTimer() {
  if (_runState.timer) clearInterval(_runState.timer);
  _runState.timer = setInterval(() => {
    const s = Math.floor((Date.now() - _runState.startTs) / 1000);
    document.getElementById("mon-time").textContent =
      `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, 1000);
}
function stopRunUI() {
  _runState.active = false;
  clearInterval(_runState.timer);
  document.getElementById("btn-master-run").classList.remove("hidden");
  document.getElementById("btn-master-stop").classList.add("hidden");
  document.getElementById("mon-state").textContent = "Stopped";
  document.getElementById("mon-state").style.color = "var(--text-dim)";
  document
    .querySelectorAll(".node-card")
    .forEach((n) => n.classList.remove("running"));
}

// ── Palette ───────────────────────────────────────────────────────────────────
function bindPalette() {
  document
    .getElementById("btn-close-palette")
    .addEventListener("click", () => elPalette.classList.remove("open"));
  elPaletteSearch.addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    document
      .querySelectorAll(".palette-category")
      .forEach((c) => (c.style.display = "none"));
    document.querySelectorAll(".palette-item").forEach((item) => {
      const match =
        item.dataset.type.toLowerCase().includes(q) ||
        item.dataset.desc.toLowerCase().includes(q);
      item.style.display = match ? "flex" : "none";
      if (match)
        item
          .closest(".palette-group")
          .querySelector(".palette-category").style.display = "block";
    });
  });
}
function populatePalette() {
  const cats = { Action: [], Flow: [], Data: [] };
  for (const [type, data] of Object.entries(STEP_REGISTRY))
    cats[data.cat].push({ type, ...data });
  let html = "";
  for (const [cat, items] of Object.entries(cats)) {
    html += `<div class="palette-group"><div class="palette-category">${cat}</div><div class="palette-grid">`;
    html += items
      .map(
        (
          i,
        ) => `<div class="palette-item" data-action="add-step" data-type="${i.type}" data-desc="${i.desc}">
      <div class="palette-item-icon" style="background:var(--step-${i.type});">${i.icon}</div>
      <div class="palette-item-label">${i.type}</div></div>`,
      )
      .join("");
    html += `</div></div>`;
  }
  elPaletteContent.innerHTML = html;
}

// ── Deep step helpers ─────────────────────────────────────────────────────────
function _findStepDeep(steps, id) {
  for (const s of steps) {
    if (s.id === id) return s;
    let found = null;
    if (s.children) found = _findStepDeep(s.children, id);
    if (!found && s.ifBranch) found = _findStepDeep(s.ifBranch, id);
    if (!found && s.elseBranch) found = _findStepDeep(s.elseBranch, id);
    if (found) return found;
  }
  return null;
}
function _removeStepDeep(steps, id) {
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].id === id) {
      steps.splice(i, 1);
      return true;
    }
    if (steps[i].children && _removeStepDeep(steps[i].children, id))
      return true;
    if (steps[i].ifBranch && _removeStepDeep(steps[i].ifBranch, id))
      return true;
    if (steps[i].elseBranch && _removeStepDeep(steps[i].elseBranch, id))
      return true;
  }
  return false;
}

// ── Add / remove / open palette ───────────────────────────────────────────────
function _addStep(type) {
  const reg = STEP_REGISTRY[type];
  const newStep = {
    id: "s_" + Date.now() + Math.floor(Math.random() * 1000),
    type,
    config: { ...JSON.parse(JSON.stringify(reg.def)), optional: false },
  };
  if (type === "LOOP") {
    newStep.children = [];
  }
  if (type === "IF_ELSE") {
    newStep.ifBranch = [];
    newStep.elseBranch = [];
  }

  const { index, parentId, branchKey } = _insertCtx;
  if (parentId) {
    const parent = _findStepDeep(_pipeline.steps, parentId);
    if (parent && Array.isArray(parent[branchKey])) {
      index === -1
        ? parent[branchKey].push(newStep)
        : parent[branchKey].splice(index, 0, newStep);
    }
  } else {
    index === -1 || index >= _pipeline.steps.length
      ? _pipeline.steps.push(newStep)
      : _pipeline.steps.splice(Math.max(0, index), 0, newStep);
  }
  elPalette.classList.remove("open");
  _expandedNodeId = newStep.id;
  saveState();
  renderPipeline();
}

function _openPalette(index, parentId = "", branchKey = "") {
  _insertCtx = { index, parentId, branchKey };
  elPaletteSearch.value = "";
  populatePalette();
  elPalette.classList.add("open");
  elPaletteSearch.focus();
}

// ── Pipeline renderer ─────────────────────────────────────────────────────────
function renderPipeline() {
  if (!_pipeline.steps.length) {
    elCanvas.innerHTML = `<div class="empty-state"><div style="font-size:32px;margin-bottom:16px;">✨</div>
      <div>Start building your flow.</div>
      <button class="btn btn-primary" style="margin-top:16px;" data-action="open-palette" data-index="-1" data-parent-id="" data-branch="">+ Add First Step</button></div>`;
    return;
  }
  let html = `<div class="insert-step top-insert" data-action="open-palette" data-index="0" data-parent-id="" data-branch="">+</div>`;
  _pipeline.steps.forEach((step, i) => {
    html += renderStepNode(step, i, _pipeline.steps.length, "", "");
  });
  elCanvas.innerHTML = html;
  bindConfigInputs();
  bindDragAndDrop();
}

function renderStepNode(step, index, total, parentId, branchKey) {
  const reg = STEP_REGISTRY[step.type] || { icon: "?", desc: "" };
  const isExpanded = _expandedNodeId === step.id;
  const isFirst = index === 0,
    isLast = index === total - 1;

  let html = `<div class="node-wrapper" data-index="${index}" data-id="${step.id}" data-parent-id="${parentId}" data-branch="${branchKey}">`;
  html += `<div class="flow-line ${isFirst && !parentId ? "top-line" : ""} ${isLast && !parentId ? "bottom-line" : ""}"></div>`;
  html += `<div class="flow-line-animated"></div>`;
  html += `<div class="node-card ${isExpanded ? "expanded" : ""}" style="border-left:4px solid var(--step-${step.type},#64748B);" draggable="true" data-drag-id="${step.id}">`;
  html += `<div class="node-header" data-action="toggle-expand" data-id="${step.id}">
    <div class="node-icon-box" style="background:var(--step-${step.type},#64748B);">${reg.icon}</div>
    <div class="node-title-group">
      <div class="node-title">${step.type} <span class="node-status-icon running-spinner">⏳</span></div>
      <div class="node-subtitle">${getStepSubtitle(step)}</div>
    </div>
    <div class="node-actions">
      <button class="btn-icon action-btn" data-action="test-step" data-id="${step.id}" title="Test Step">▶</button>
      <button class="btn-icon action-btn" style="color:var(--red);" data-action="remove-step" data-id="${step.id}" title="Remove">✕</button>
    </div>
  </div>`;
  html += `<div class="node-config">${generateConfigHtml(step)}</div>`;
  html += `</div>`; // end .node-card

  // LOOP container body
  if (step.type === "LOOP") {
    html += `<div class="loop-body">
      <div class="loop-scope-bar"></div>
      <div class="loop-body-inner">`;
    const children = step.children || [];
    children.forEach((child, ci) => {
      html += renderStepNode(child, ci, children.length, step.id, "children");
    });
    html += `<div class="insert-inner" data-action="open-palette" data-index="-1" data-parent-id="${step.id}" data-branch="children" title="Add step inside loop">+</div>`;
    html += `</div></div>`;
    html += `<div class="loop-end-marker">↩ LOOP END</div>`;
  }

  // IF_ELSE container branches
  if (step.type === "IF_ELSE") {
    html += `<div class="if-branches">`;
    for (const bk of ["ifBranch", "elseBranch"]) {
      const isIf = bk === "ifBranch";
      const branch = step[bk] || [];
      html += `<div class="if-branch ${isIf ? "if-true" : "if-false"}">`;
      html += `<div class="branch-header">${isIf ? "IF ✓ (met)" : "ELSE ✗ (not met)"}</div>`;
      html += `<div class="loop-body-inner">`;
      branch.forEach((child, ci) => {
        html += renderStepNode(child, ci, branch.length, step.id, bk);
      });
      html += `<div class="insert-inner" data-action="open-palette" data-index="-1" data-parent-id="${step.id}" data-branch="${bk}" title="Add step in branch">+</div>`;
      html += `</div></div>`;
    }
    html += `</div>`;
    html += `<div class="ifelse-end-marker">↩ IF END</div>`;
  }

  // Bottom insert between steps
  html += `<div class="insert-step" data-action="open-palette" data-index="${index + 1}" data-parent-id="${parentId}" data-branch="${branchKey}">+</div>`;
  html += `</div>`; // end .node-wrapper
  return html;
}

function getStepSubtitle(step) {
  const c = step.config;
  switch (step.type) {
    case "NAVIGATE":
      return c.url || "No URL";
    case "CLICK":
      return c.selector
        ? `${c.all ? "All: " : ""}${c.selector}`
        : "No selector";
    case "FILL":
      return c.mode === "multi"
        ? `${(c.fields || []).length} fields`
        : c.selector || "No selector";
    case "WAIT":
      return `Wait ${c.ms}ms`;
    case "LOOP":
      return `${c.type} mode · max ${c.max}`;
    case "IF_ELSE":
      return `${c.condition}: ${c.selector || "?"}`;
    default:
      return STEP_REGISTRY[step.type]?.desc || "";
  }
}

// ── Config HTML generators ────────────────────────────────────────────────────
function generateConfigHtml(step) {
  const c = step.config;
  let html = "";

  // ── NAVIGATE ──
  if (step.type === "NAVIGATE") {
    html += field(step, "url", "URL", "text", c.url || "");
    html += toggle(step, "wait", "Wait for page load");
    html += toggle(step, "optional", "optional");
    return html;
  }

  // ── CLICK ──
  if (step.type === "CLICK") {
    html += selectorRow(step, "selector");
    html += toggle(step, "all", "Click ALL matching elements");
    html += toggle(step, "optional", "optional");
    return html;
  }

  // ── FILL (single + multi) ──
  if (step.type === "FILL") {
    const mode = c.mode || "single";
    html += `<div class="mode-toggle" style="margin-bottom:8px;">
      <button class="btn ${mode === "single" ? "btn-primary" : ""}" data-action="set-fill-mode" data-id="${step.id}" data-mode="single">Single Field</button>
      <button class="btn ${mode === "multi" ? "btn-primary" : ""}" data-action="set-fill-mode" data-id="${step.id}" data-mode="multi">Multi Fields</button>
    </div>`;
    if (mode === "single") {
      html += selectorRow(step, "selector");
      html += field(step, "text", "Text to type", "text", c.text || "");
      html += field(
        step,
        "delayMs",
        "Delay per char (ms)",
        "number",
        c.delayMs ?? 50,
      );
      html += toggle(step, "append", "Append (don't clear field)");
    } else {
      // multi mode
      html += toggle(step, "append", "Append to ALL fields (don't clear)");
      html += `<div id="fill-fields-${step.id}" style="margin-bottom:8px;">`;
      (c.fields || []).forEach((f, fi) => {
        html += `<div class="fill-field-row">
          <input type="text" value="${esc(f.selector || "")}" disabled placeholder="selector" style="flex:1.5;font-size:10px;">
          <input type="text" value="${esc(f.value || "")}"    disabled placeholder="value"    style="flex:2;">
          <button class="btn btn-icon" style="color:var(--red);" data-action="remove-fill-field" data-id="${step.id}" data-index="${fi}">✕</button>
        </div>`;
      });
      html += `</div>
      <div class="flex gap-2" style="align-items:flex-end;margin-bottom:8px;">
        <div style="flex:1"><label style="margin-top:0;">Value</label><input type="text" id="new-fill-val-${step.id}" placeholder="e.g. John Doe"></div>
        <button class="btn btn-primary" data-action="add-fill-field" data-id="${step.id}" style="height:28px;">🎯 Pick Field</button>
      </div>`;
      html += `<label style="margin-top:6px;">Submit Button Selector (optional)</label>`;
      html += selectorRow(step, "submitSelector");
    }
    html += toggle(step, "optional", "optional");
    return html;
  }

  // ── KEYBOARD ──
  if (step.type === "KEYBOARD") {
    html += `<label>Key to Press</label>
    <div class="flex gap-2" style="margin-bottom:10px;align-items:center;">
      <div class="key-display" id="key-disp-${step.id}">${esc(c.key || "Not set")}</div>
      <button class="btn key-register-btn" id="key-reg-${step.id}" data-action="register-key" data-id="${step.id}">🔴 Register Key</button>
    </div>`;
    html += toggle(step, "optional", "optional");
    return html;
  }

  // ── LOOP ──
  if (step.type === "LOOP") {
    const ltype = c.type || "elements";
    html += `<label>Iteration Mode</label>
    <select id="cfg-${step.id}-type" data-id="${step.id}" data-key="type" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="elements" ${ltype === "elements" ? "selected" : ""}>Loop through Elements (auto-count)</option>
      <option value="count"    ${ltype === "count" ? "selected" : ""}>Fixed Count (N times)</option>
      <option value="paginate" ${ltype === "paginate" ? "selected" : ""}>Paginate (click Next)</option>
    </select>`;
    if (ltype === "elements") {
      html += `<div style="background:rgba(99,102,241,0.08);border:1px solid var(--step-LOOP,#6366F1);border-radius:4px;padding:6px 10px;font-size:11px;color:var(--step-LOOP,#6366F1);margin-bottom:8px;">
        🔁 Iterates over ALL matched elements automatically.</div>`;
      html += selectorRow(step, "selector");
      html += field(
        step,
        "max",
        "Safety max (0 = unlimited)",
        "number",
        c.max ?? 0,
      );
    } else if (ltype === "count") {
      html += field(step, "max", "Repeat N times", "number", c.max ?? 10);
    } else {
      // paginate
      html += selectorRow(step, "selector");
      html += field(step, "max", "Max pages", "number", c.max ?? 10);
    }
    html += `<label>On iteration failure</label>
    <select id="cfg-${step.id}-onFail" data-id="${step.id}" data-key="onFail" class="cfg-bind" style="margin-bottom:8px;">
      <option value="skip" ${(c.onFail || "skip") === "skip" ? "selected" : ""}>Skip and continue</option>
      <option value="stop" ${c.onFail === "stop" ? "selected" : ""}>Stop loop, keep data</option>
    </select>`;
    html += toggle(step, "optional", "optional");
    return html;
  }

  // ── IF_ELSE ──
  if (step.type === "IF_ELSE") {
    const cond = c.condition || "exists";
    html += `<label>Condition</label>
    <select id="cfg-${step.id}-condition" data-id="${step.id}" data-key="condition" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="exists"       ${cond === "exists" ? "selected" : ""}>Element exists</option>
      <option value="not-exists"   ${cond === "not-exists" ? "selected" : ""}>Element does NOT exist</option>
      <option value="text-equals"  ${cond === "text-equals" ? "selected" : ""}>Text equals value</option>
      <option value="text-contains"${cond === "text-contains" ? "selected" : ""}>Text contains value</option>
      <option value="attr-equals"  ${cond === "attr-equals" ? "selected" : ""}>Attribute equals value</option>
      <option value="attr-contains"${cond === "attr-contains" ? "selected" : ""}>Attribute contains value</option>
    </select>`;
    html += selectorRow(step, "selector");
    if (
      ["text-equals", "text-contains", "attr-equals", "attr-contains"].includes(
        cond,
      )
    ) {
      html += field(step, "value", "Value to compare", "text", c.value || "");
    }
    if (["attr-equals", "attr-contains"].includes(cond)) {
      html += field(step, "attr", "Attribute name", "text", c.attr || "");
    }
    html += `<p style="font-size:11px;color:var(--text-dim);margin-top:8px;margin-bottom:0;">
      Add steps in the <b>IF ✓</b> and <b>ELSE ✗</b> blocks below the card.</p>`;
    return html;
  }

  // ── SCROLL ──
  if (step.type === "SCROLL") {
    html += `<label>Mode</label><select id="cfg-${step.id}-mode" data-id="${step.id}" data-key="mode" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="pixel"   ${(c.mode || "pixel") === "pixel" ? "selected" : ""}>Pixel (scroll by amount)</option>
      <option value="percent" ${c.mode === "percent" ? "selected" : ""}>Percent of page</option>
      <option value="selector"${c.mode === "selector" ? "selected" : ""}>To element (selector)</option>
    </select>`;
    if (c.mode === "selector") {
      html += selectorRow(step, "selector");
    } else {
      html += field(step, "amount", "Amount", "number", c.amount ?? 500);
    }
    html += toggle(step, "optional", "optional");
    return html;
  }

  // ── EXPORT ──
  if (step.type === "EXPORT") {
    html += `<label>Format</label><select id="cfg-${step.id}-format" data-id="${step.id}" data-key="format" class="cfg-bind" style="margin-bottom:8px;">
      <option value="csv"  ${(c.format || "csv") === "csv" ? "selected" : ""}>CSV</option>
      <option value="json" ${c.format === "json" ? "selected" : ""}>JSON</option>
      <option value="jsonl"${c.format === "jsonl" ? "selected" : ""}>JSONL</option>
      <option value="tsv"  ${c.format === "tsv" ? "selected" : ""}>TSV</option>
    </select>`;
    html += toggle(step, "optional", "optional");
    return html;
  }

  // ── EXTRACT ──
  if (step.type === "EXTRACT") {
    html += `<div id="extract-fields-${step.id}">`;
    (c.fields || []).forEach((f, fi) => {
      html += `<div class="flex gap-2" style="margin-bottom:4px;align-items:center;">
        <input type="text" value="${esc(f.name || "")}"     disabled style="flex:1;">
        <input type="text" value="${esc(f.selector || "")}" disabled style="flex:2;">
        <select data-action="update-extract-type" data-id="${step.id}" data-index="${fi}" style="flex:0.8;font-size:11px;padding:4px 6px;">
          <option value="text" ${(f.type || "text") === "text" ? "selected" : ""}>Text</option>
          <option value="html" ${f.type === "html" ? "selected" : ""}>HTML</option>
          <option value="attribute" ${f.type === "attribute" ? "selected" : ""}>Attr</option>
        </select>
        <button class="btn btn-icon" style="color:var(--red);" data-action="remove-extract-field" data-id="${step.id}" data-index="${fi}">✕</button>
      </div>`;
    });
    html += `</div>
    <div class="flex gap-2" style="margin-top:12px;align-items:flex-end;">
      <div style="flex:1"><label style="margin-top:0;">Field Name</label><input type="text" id="new-ex-name-${step.id}" placeholder="e.g. price"></div>
      <button class="btn btn-primary" data-action="add-extract-field" data-id="${step.id}" style="height:28px;">🎯 Pick Element</button>
    </div>`;
    html += toggle(step, "optional", "optional");
    return html;
  }

  // ── Generic fallback ──
  for (const [key, value] of Object.entries(c)) {
    if (typeof value === "boolean") {
      html += toggle(step, key, key);
    } else if (typeof value === "number") {
      html += field(step, key, key, "number", value);
    } else if (typeof value === "string") {
      if (key === "selector" || key === "source" || key === "target")
        html += selectorRow(step, key);
      else html += field(step, key, key, "text", value);
    }
  }
  return html;
}

// ── Config helpers ────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function field(step, key, label, type, value) {
  return `<label>${label}</label>
    <input type="${type}" id="cfg-${step.id}-${key}" value="${esc(value)}"
      data-id="${step.id}" data-key="${key}" class="cfg-bind" style="margin-bottom:8px;">`;
}
function selectorRow(step, key) {
  const v = step.config[key] || "";
  const isMultiSelect =
    ["EXTRACT", "LOOP"].includes(step.type) && key === "selector";
  const modeBadge = isMultiSelect ? "🔀 Bulk" : "🎯 Specific";
  return `<label>${key}</label>
    <div class="flex gap-2" style="margin-bottom:8px;">
      <input type="text" id="cfg-${step.id}-${key}" value="${esc(v)}"
        data-id="${step.id}" data-key="${key}" class="cfg-bind" style="flex:1;">
      <span class="selector-mode-badge" style="padding:4px 8px; background:var(--bg-hover); border-radius:var(--radius-sm); font-size:10px; white-space:nowrap; display:flex; align-items:center; min-width:70px;">${modeBadge}</span>
      <button class="btn btn-icon" data-action="pick-selector" data-id="${step.id}" data-key="${key}"
        style="background:var(--bg-hover);color:var(--text-main);font-size:16px;" title="Pick element">🎯</button>
    </div>`;
}
function toggle(step, key, label) {
  const checked = step.config[key] ? "checked" : "";
  return `<div class="toggle-wrap">
    <input type="checkbox" id="cfg-${step.id}-${key}" ${checked} data-id="${step.id}" data-key="${key}" class="cfg-bind">
    <div class="toggle-switch"></div>
    <span>${label}</span>
  </div>`;
}

// ── Config input binding ──────────────────────────────────────────────────────
function bindConfigInputs(container = document) {
  container.querySelectorAll(".cfg-bind").forEach((el) => {
    // Basic trick to clear old listeners if we ever accidentally rebind
    const newEl = el.cloneNode(true);
    if (el.parentNode) el.parentNode.replaceChild(newEl, el);

    newEl.addEventListener("change", (e) => {
      const step = _findStepDeep(_pipeline.steps, e.target.dataset.id);
      if (!step) return;
      const key = e.target.dataset.key;
      if (e.target.type === "checkbox") step.config[key] = e.target.checked;
      else if (e.target.type === "number")
        step.config[key] = parseFloat(e.target.value) || 0;
      else step.config[key] = e.target.value;
      saveState();

      // Re-render card config if marked (mode-switching selects)
      if (e.target.dataset.rerender === "true") _rerenderCardConfig(step);
      else {
        const sub = e.target
          .closest(".node-card")
          ?.querySelector(".node-subtitle");
        if (sub) sub.textContent = getStepSubtitle(step);
      }
    });

    if (newEl.type === "text" || newEl.type === "number") {
      newEl.addEventListener("input", (e) => {
        const step = _findStepDeep(_pipeline.steps, e.target.dataset.id);
        if (!step) return;
        const key = e.target.dataset.key;
        step.config[key] =
          e.target.type === "number"
            ? parseFloat(e.target.value) || 0
            : e.target.value;
        const sub = e.target
          .closest(".node-card")
          ?.querySelector(".node-subtitle");
        if (sub) sub.textContent = getStepSubtitle(step);
      });
    }
  });
}

function _rerenderCardConfig(step) {
  const configEl = document.querySelector(
    `.node-wrapper[data-id="${step.id}"] .node-config`,
  );
  if (configEl) {
    configEl.innerHTML = generateConfigHtml(step);
    bindConfigInputs(configEl);
  }
  // Also re-render loop body insert if LOOP mode changed
  const sub = document.querySelector(
    `.node-wrapper[data-id="${step.id}"] .node-subtitle`,
  );
  if (sub) sub.textContent = getStepSubtitle(step);
}

// ── Drag-and-drop node reorder ────────────────────────────────────────────────
function bindDragAndDrop() {
  // We attach dragstart on the card itself (it has draggable="true")
  document.querySelectorAll(".node-card[data-drag-id]").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      _dragSourceId = card.dataset.dragId;
      e.dataTransfer.effectAllowed = "move";
      card.style.opacity = "0.45";
    });
    card.addEventListener("dragend", () => {
      card.style.opacity = "1";
      _dragSourceId = null;
    });
  });
  document.querySelectorAll(".node-wrapper").forEach((w) => {
    w.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      w.style.outline = "2px solid var(--accent)";
    });
    w.addEventListener("dragleave", () => {
      w.style.outline = "none";
    });
    w.addEventListener("drop", (e) => {
      e.preventDefault();
      w.style.outline = "none";
      if (!_dragSourceId) return;
      const targetId = w.dataset.id;
      if (!targetId || targetId === _dragSourceId) return;
      // Only reorder within the same parent for now (root level)
      const srcIdx = _pipeline.steps.findIndex((s) => s.id === _dragSourceId);
      const tgtIdx = _pipeline.steps.findIndex((s) => s.id === targetId);
      if (srcIdx !== -1 && tgtIdx !== -1) {
        const [moved] = _pipeline.steps.splice(srcIdx, 1);
        _pipeline.steps.splice(tgtIdx, 0, moved);
        saveState();
        renderPipeline();
      }
      _dragSourceId = null;
    });
  });
}

// ── Event delegation ──────────────────────────────────────────────────────────
function bindDelegatedEvents() {
  document.body.addEventListener("click", (e) => {
    const accHeader = e.target.closest(".accordion-header");
    if (accHeader) {
      accHeader.parentElement.classList.toggle("open");
      return;
    }

    const toggleWrap = e.target.closest(".toggle-wrap");
    if (toggleWrap && !e.target.matches('input[type="checkbox"]')) {
      const cb = toggleWrap.querySelector('input[type="checkbox"]');
      if (cb) {
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }

    const target = e.target.closest("[data-action]");
    if (!target) return;
    if (target.classList.contains("action-btn")) e.stopPropagation();

    const action = target.dataset.action;
    const id = target.dataset.id;

    switch (action) {
      case "add-step":
        _addStep(target.dataset.type);
        break;
      case "open-palette":
        _openPalette(
          parseInt(target.dataset.index, 10),
          target.dataset.parentId || "",
          target.dataset.branch || "",
        );
        break;
      case "toggle-expand":
        _toggleExpand(id);
        break;
      case "remove-step":
        _removeStep(e, id);
        break;
      case "test-step":
        _testStep(e, id);
        break;
      case "pick-selector":
        _pickSelector(id, target.dataset.key);
        break;
      case "add-extract-field":
        _addExtractField(id);
        break;
      case "remove-extract-field":
        _removeExtractField(id, parseInt(target.dataset.index, 10));
        break;
      case "update-extract-type": {
        const step = _findStepDeep(_pipeline.steps, id);
        if (step?.config?.fields) {
          step.config.fields[parseInt(target.dataset.index, 10)].type =
            target.value;
          saveState();
        }
        break;
      }
      case "set-fill-mode": {
        const step = _findStepDeep(_pipeline.steps, id);
        if (step) {
          step.config.mode = target.dataset.mode;
          saveState();
          _rerenderCardConfig(step);
        }
        break;
      }
      case "add-fill-field":
        _addFillField(id);
        break;
      case "remove-fill-field":
        _removeFillField(id, parseInt(target.dataset.index, 10));
        break;
      case "register-key":
        _registerKey(id);
        break;
    }
  });
}

// ── Step actions ──────────────────────────────────────────────────────────────
function _toggleExpand(id) {
  _expandedNodeId = _expandedNodeId === id ? null : id;
  renderPipeline();
}
function _removeStep(e, id) {
  e.stopPropagation();
  _removeStepDeep(_pipeline.steps, id);
  if (_expandedNodeId === id) _expandedNodeId = null;
  saveState();
  renderPipeline();
}
async function _testStep(e, id) {
  e.stopPropagation();
  const step = _findStepDeep(_pipeline.steps, id);
  if (!step) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return alert("No active tab to test against.");
  const card = document.querySelector(
    `.node-wrapper[data-id="${id}"] .node-card`,
  );
  if (card) card.classList.add("running");
  try {
    const res = await chrome.runtime.sendMessage({
      type: "step:execute",
      payload: { step, tabId: tab.id },
    });
    if (res?.error) throw new Error(res.error);
    if (card) {
      card.classList.remove("running");
      card.classList.add("success");
    }
  } catch (err) {
    if (card) {
      card.classList.remove("running");
      card.classList.add("error");
    }
    alert(
      err.message.includes("Receiving end")
        ? "Refresh the target webpage first."
        : `Test failed: ${err.message}`,
    );
  }
}

// ── Selector picker with mode toggle ──────────────────────────────────────────
async function _pickSelector(stepId, key) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return alert("No active tab available.");

  const stepType = _findStepDeep(_pipeline.steps, stepId)?.type;
  const defaultBulk =
    key === "selector" && ["EXTRACT", "LOOP"].includes(stepType);

  // Show mode selector modal
  const mode = await _selectSelectorMode(defaultBulk);
  if (mode === null) return; // cancelled

  try {
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: "FS_PICK_SELECTOR",
      payload: { bulk: mode },
    });
    if (resp?.ok && resp.result) {
      const input = document.getElementById(`cfg-${stepId}-${key}`);
      if (input) {
        input.value = resp.result;
        const badge = input.parentElement?.querySelector(
          ".selector-mode-badge",
        );
        if (badge) badge.textContent = mode ? "🔀 Bulk" : "🎯 Specific";
        input.dispatchEvent(new Event("change"));
      }
    }
  } catch {
    alert("Refresh the target webpage to connect the picker.");
  }
}

async function _selectSelectorMode(defaultBulk) {
  const modal = document.createElement("div");
  modal.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center;
    z-index: 9999; backdrop-filter: blur(4px);
  `;

  const card = document.createElement("div");
  card.style.cssText = `
    background: var(--bg-raised); border: 1px solid var(--bg-border); border-radius: 12px;
    padding: 24px; max-width: 380px; box-shadow: var(--shadow-fly);
  `;

  card.innerHTML = `
    <div style="margin-bottom: 20px;">
      <h2 style="margin: 0 0 8px; font-size: 16px;">Selector Mode</h2>
      <p style="margin: 0; color: var(--text-dim); font-size: 12px;">Choose how to match elements:</p>
    </div>
    <div style="display: flex; gap: 12px; margin-bottom: 16px;">
      <button class="selector-mode-btn" data-mode="specific" style="flex:1; padding:12px; border-radius:8px; border:2px solid var(--accent); background:rgba(99,102,241,0.1); color:var(--text-main); cursor:pointer; font-weight:600; transition:all 0.2s;">
        🎯 Specific
        <div style="font-size:10px; color:var(--text-dim); font-weight:normal; margin-top:4px;">Single element</div>
      </button>
      <button class="selector-mode-btn" data-mode="bulk" style="flex:1; padding:12px; border-radius:8px; border:2px solid var(--bg-border); background:transparent; color:var(--text-main); cursor:pointer; font-weight:600; transition:all 0.2s;">
        🔀 Bulk
        <div style="font-size:10px; color:var(--text-dim); font-weight:normal; margin-top:4px;">Multiple matches</div>
      </button>
    </div>
    <button class="btn" style="width:100%; margin-top:16px;" id="modal-cancel">Cancel</button>
  `;

  let result = null;

  return new Promise((resolve) => {
    const buttons = card.querySelectorAll(".selector-mode-btn");
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        result = btn.dataset.mode === "bulk";
        modal.remove();
        resolve(result);
      });
    });

    card.querySelector("#modal-cancel").addEventListener("click", () => {
      modal.remove();
      resolve(null);
    });

    const defaultBtn = card.querySelector(
      `[data-mode="${defaultBulk ? "bulk" : "specific"}"]`,
    );
    if (defaultBtn) {
      defaultBtn.style.borderColor = "var(--accent)";
      defaultBtn.style.background = "rgba(99,102,241,0.15)";
    }

    modal.appendChild(card);
    document.body.appendChild(modal);
  });
}

// ── Extract field management ──────────────────────────────────────────────────
async function _addExtractField(stepId) {
  const nameInput = document.getElementById(`new-ex-name-${stepId}`);
  if (!nameInput?.value.trim()) return alert("Enter a field name first.");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: "FS_PICK_SELECTOR",
      payload: { bulk: true },
    });
    if (resp?.ok && resp.result) {
      const step = _findStepDeep(_pipeline.steps, stepId);
      if (step) {
        step.config.fields.push({
          name: nameInput.value.trim(),
          selector: resp.result,
          type: "text",
        });
        saveState();
        renderPipeline();
      }
    }
  } catch {
    alert("Refresh the target webpage to connect the picker.");
  }
}
function _removeExtractField(stepId, idx) {
  const step = _findStepDeep(_pipeline.steps, stepId);
  if (step?.config?.fields) {
    step.config.fields.splice(idx, 1);
    saveState();
    renderPipeline();
  }
}

// ── Fill field management ─────────────────────────────────────────────────────
async function _addFillField(stepId) {
  const valInput = document.getElementById(`new-fill-val-${stepId}`);
  const value = valInput?.value || "";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: "FS_PICK_SELECTOR",
      payload: { bulk: false },
    });
    if (resp?.ok && resp.result) {
      const step = _findStepDeep(_pipeline.steps, stepId);
      if (step) {
        if (!Array.isArray(step.config.fields)) step.config.fields = [];
        step.config.fields.push({ selector: resp.result, value });
        saveState();
        renderPipeline();
      }
    }
  } catch {
    alert("Refresh the target webpage to connect the picker.");
  }
}
function _removeFillField(stepId, idx) {
  const step = _findStepDeep(_pipeline.steps, stepId);
  if (step?.config?.fields) {
    step.config.fields.splice(idx, 1);
    saveState();
    renderPipeline();
  }
}

// ── Keyboard register ─────────────────────────────────────────────────────────
function _registerKey(stepId) {
  if (_keyListening) return;
  _keyListening = true;
  const btn = document.getElementById(`key-reg-${stepId}`);
  const disp = document.getElementById(`key-disp-${stepId}`);
  if (btn) {
    btn.textContent = "⏺ Press key(s)...";
    btn.classList.add("listening");
  }

  const onKey = (e) => {
    // Ignore standalone modifier presses
    if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();

    // Build combo string e.g. "Ctrl+Shift+Enter"
    const parts = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Meta");
    parts.push(e.key === " " ? "Space" : e.key);
    const combo = parts.join("+");

    const step = _findStepDeep(_pipeline.steps, stepId);
    if (step) {
      step.config.key = combo;
      saveState();
    }
    if (disp) disp.textContent = combo;
    if (btn) {
      btn.textContent = `✓ ${combo}`;
      btn.classList.remove("listening");
    }
    document.removeEventListener("keydown", onKey, true);
    _keyListening = false;
  };

  document.addEventListener("keydown", onKey, true);
  setTimeout(() => {
    if (!_keyListening) return;
    document.removeEventListener("keydown", onKey, true);
    _keyListening = false;
    if (btn) {
      btn.textContent = "🔴 Register Key";
      btn.classList.remove("listening");
    }
  }, 15000);
}

// ── System listeners ──────────────────────────────────────────────────────────
function listenToSystem() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "pipeline:status") {
      const info = msg.payload;
      if (info.progress?.total) {
        const pct = Math.round(
          (info.progress.current / info.progress.total) * 100,
        );
        const fill = document.getElementById("mon-progress-fill");
        if (fill) {
          fill.style.width = `${pct}%`;
          document.getElementById("mon-progress-text").textContent = `${pct}%`;
        }
        document.getElementById("mon-rows").textContent = info.progress.current;
      }
      if (info.currentStepId) {
        document
          .querySelectorAll(".node-card")
          .forEach((n) => n.classList.remove("running", "success", "error"));
        const active = document.querySelector(
          `.node-wrapper[data-id="${info.currentStepId}"] .node-card`,
        );
        if (active) {
          active.classList.add("running");
          active.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        document.getElementById("mon-state").textContent = "Running...";
        document.getElementById("mon-state").style.color = "var(--text-main)";
      }
      if (info.state === "completed" || info.state === "stopped") {
        stopRunUI();
        document.getElementById("mon-state").textContent =
          info.state === "completed" ? "Success" : "Stopped";
        document.getElementById("mon-state").style.color =
          info.state === "completed" ? "var(--green)" : "var(--text-dim)";
        logToMonitor(
          info.state === "completed" ? "info-log" : "warn-log",
          `Pipeline ${info.state}.`,
        );
      }
    }
    if (msg.type === "pipeline:log") {
      logToMonitor(msg.payload.level, msg.payload.message);
      if (msg.payload.level === "error-log") {
        const el = document.getElementById("mon-errs");
        if (el) el.textContent = parseInt(el.textContent || "0") + 1;
      }
    }
  });
}

function logToMonitor(levelClass, message) {
  const logs = document.getElementById("mon-logs");
  if (!logs) return;
  const d = new Date();
  const ts = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
  const div = document.createElement("div");
  div.className = `log-entry ${levelClass}`;
  div.innerHTML = `<span class="log-ts">[${ts}]</span><span class="log-msg">${message}</span>`;
  logs.appendChild(div);
  logs.scrollTop = logs.scrollHeight;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", init);
else init();
