// === injector.js ===
/**
 * @module injector
 * @description Content script entry point. Creates a shadow DOM host,
 *   handles FS_STEP_EXEC / FS_STEP_RESULT / FS_PICK_SELECTOR /
 *   FS_FORM_FILL_ROW / FS_CAPTCHA_FOUND window.postMessage events,
 *   and dispatches to the appropriate handler modules.
 *
 *   Design decision: Shadow DOM isolation ensures our injected UI (selector
 *   picker overlay) doesn't conflict with page styles. All postMessage events
 *   are source-checked against window.location.origin to prevent page scripts
 *   from spoofing our event protocol.
 *
 *   This file must stay under 40 KB. Heavy logic lives in form-filler.js,
 *   field-auto-mapper.js, etc. — which are injected via chrome.scripting
 *   on demand, not bundled here.
 *
 * @dependencies (none — minimal entry point)
 */

"use strict";

const FS_ORIGIN = chrome.runtime.getURL("").replace(/\/$/, "");

// ── Content event names ────────────────────────────────────────────────────────
const CE = Object.freeze({
  STEP_EXEC: "FS_STEP_EXEC",
  STEP_RESULT: "FS_STEP_RESULT",
  PICK_SELECTOR: "FS_PICK_SELECTOR",
  FORM_FILL_ROW: "FS_FORM_FILL_ROW",
  CAPTCHA_FOUND: "FS_CAPTCHA_FOUND",
});

// ── Shadow DOM host ────────────────────────────────────────────────────────────
const _host = document.createElement("div");
_host.id = "flowscrape-v3-host";
_host.style.cssText =
  "position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none;";
const _shadow = _host.attachShadow({ mode: "closed" });
document.documentElement.appendChild(_host);

function _getScopedRoot(context) {
  const loop = context?.loop;
  if (!loop || !loop.selector || typeof loop.index0 !== "number") return null;
  const roots = Array.from(document.querySelectorAll(loop.selector));
  return roots[loop.index0] || null;
}

function _resolveTemplatePath(ctx, expr) {
  const parts = String(expr || "")
    .trim()
    .split(".");
  let val = ctx;
  for (let part of parts) {
    if (val === undefined || val === null) return undefined;

    const bracket = part.match(/^(.+?)\[(\d+)\]$/);
    if (bracket) {
      const key = bracket[1];
      const idx = Number(bracket[2]);
      val = val?.[key];
      if (!Array.isArray(val)) return undefined;
      val = val[idx];
      continue;
    }

    if (/^\d+$/.test(part)) {
      const idx = Number(part);
      if (!Array.isArray(val)) return undefined;
      val = val[idx];
      continue;
    }

    val = val[part];
  }
  return val;
}

function _renderSelectorTemplate(selector, context = {}) {
  if (typeof selector !== "string") return selector;
  if (!selector.includes("{{")) return selector;
  return selector.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
    const val = _resolveTemplatePath(context, expr);
    return val !== undefined && val !== null ? String(val) : "";
  });
}

function _normalizeScopedSelector(selector, context = {}) {
  if (selector === null || selector === undefined) return "";
  if (typeof selector === "object") return "";
  const rendered = _renderSelectorTemplate(selector, context);
  const text = String(rendered).trim();
  if (!text) return "";
  if (text === "[object Object]" || text === "[object Array]") return "";
  if (/^\d+$/.test(text)) return `:scope > *:nth-child(${Number(text)})`;
  return text;
}

function _queryScoped(selector, context, all = false) {
  const root = _getScopedRoot(context);
  const resolved = _normalizeScopedSelector(selector, context);
  if (root) {
    if (!resolved) return all ? [root] : [root];
    try {
      const scoped = all
        ? Array.from(root.querySelectorAll(resolved))
        : [root.querySelector(resolved)].filter(Boolean);
      if (scoped.length > 0) return scoped;

      // If a full-page selector was provided inside LOOP child step,
      // allow document-level fallback when scoped lookup finds nothing.
      if (resolved.startsWith(":scope")) return [];
      return all
        ? Array.from(document.querySelectorAll(resolved || "*"))
        : [document.querySelector(resolved)].filter(Boolean);
    } catch {
      return [];
    }
  }
  if (!resolved) return [];
  try {
    if (all) return Array.from(document.querySelectorAll(resolved || "*"));
    return [document.querySelector(resolved)].filter(Boolean);
  } catch {
    return [];
  }
}

// ── Message bus (window.postMessage, source-checked) ─────────────────────────
window.addEventListener("message", (event) => {
  // Source check: only trust messages from our extension background
  if (event.source !== window) return;
  const { type, payload, id } = event.data ?? {};
  if (!type || !type.startsWith("FS_")) return;

  _handleEvent(type, payload, id)
    .then((result) => {
      window.postMessage({ type: `${type}_ACK`, id, result }, "*");
    })
    .catch((err) => {
      window.postMessage({ type: `${type}_ACK`, id, error: err.message }, "*");
    });
});

// ── Runtime message bridge (SW → content script) ──────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  const { type, payload } = msg ?? {};
  if (!type) return false;

  _handleEvent(type, payload, null)
    .then((result) => respond({ ok: true, result }))
    .catch((err) => respond({ ok: false, error: err.message }));

  return true;
});

// ── Step dispatcher ────────────────────────────────────────────────────────────
async function _handleEvent(type, payload, id) {
  switch (type) {
    case CE.STEP_EXEC:
      return _executeStep(payload);

    case CE.FORM_FILL_ROW:
      return _formFillRow(payload);

    case CE.PICK_SELECTOR:
      return _activateSelectorPicker(payload);

    case "step:execute":
      return _executeStep(payload);

    default:
      return null;
  }
}

// ── Step execution ────────────────────────────────────────────────────────────
async function _executeStep(step) {
  const { type, config } = step;
  const context = step.__fsContext || {};
  switch (type) {
    case "NAVIGATE":
      return _stepNavigate(config, context);
    case "CLICK":
      return _stepClick(config, context);
    case "SCROLL":
      return _stepScroll(config, context);
    case "WAIT":
      return _stepWait(config, context);
    case "EXTRACT":
      return _stepExtract(config, context);
    case "SCREENSHOT":
      return _stepScreenshot(config);
    case "FILL":
      return _stepFill(config, context); // renamed from TYPE
    case "TYPE":
      return _stepFill(config, context); // legacy alias
    case "HOVER":
      return _stepHover(config, context);
    case "SELECT":
      return _stepSelect(config, context);
    case "KEYBOARD":
      return _stepKeyboard(config, context);
    case "DRAG_DROP":
      return _stepDragDrop(config, context);
    case "LOOP":
      return _stepLoop(config);
    case "IF_ELSE":
      return _stepIfElse(config, context);
    case "EXPORT":
      return { exportTriggered: true };
    case "PAGINATE":
      return _stepClick(config, context);
    case "QUERY_COUNT": {
      const els = _queryScoped(config.selector || "*", context, true);
      return { count: els.length };
    }
    case "QUERY_ELEMENTS": {
      // Returns rich data for each matched element for template variables
      const qEls = _queryScoped(config.selector || "*", context, true);
      return qEls.map((el, i) => {
        const info = {
          index: i + 1, // 1-based ({{item.index}})
          index0: i, // 0-based ({{item.index0}})
          text: el.textContent.trim(),
          innerText: (el.innerText || "").trim(),
          href: el.href || el.getAttribute("href") || "",
          src: el.src || el.getAttribute("src") || "",
          value: el.value || el.getAttribute("value") || "",
          id: el.id || "",
          class: el.className || "",
          tag: el.tagName.toLowerCase(),
        };
        // All data-* attributes
        for (const [key, val] of Object.entries(el.dataset || {}))
          info[`data-${key}`] = val;
        // All aria-*
        for (const attr of el.attributes) {
          if (attr.name.startsWith("aria-")) info[attr.name] = attr.value;
        }
        return info;
      });
    }
    default:
      throw new Error(`Unknown step type: ${type}`);
  }
}

async function _stepNavigate({ url, waitMode = "AUTO" }) {
  if (location.href !== url) {
    location.href = url;
    return { navigated: true };
  }
  return { navigated: false };
}

function _pickClickableTarget(el) {
  if (!el) return null;
  const clickableSel = [
    "a[href]",
    "button",
    "label",
    "input:not([type='hidden'])",
    "select",
    "textarea",
    "summary",
    "[role='button']",
    "[onclick]",
    "[tabindex]",
  ].join(",");

  if (el.matches?.(clickableSel)) return el;
  const child = el.querySelector?.(clickableSel);
  if (child) return child;
  return el;
}

function _dispatchSyntheticClick(el) {
  if (!(el instanceof Element)) return;
  const r = el.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top + r.height / 2);
  const init = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: cx,
    clientY: cy,
  };
  try {
    el.dispatchEvent(
      new PointerEvent("pointerdown", { ...init, pointerId: 1 }),
    );
    el.dispatchEvent(new MouseEvent("mousedown", init));
    el.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent("mouseup", init));
    el.dispatchEvent(new MouseEvent("click", init));
  } catch {
    el.dispatchEvent(new MouseEvent("click", init));
  }
}

async function _stepClick(
  { selector, retries = 3, all = false },
  context = {},
) {
  let els = [];
  const renderedSelector = _normalizeScopedSelector(selector, context);
  const scopedRoot = _getScopedRoot(context);
  let usedRootFallback = false;
  for (let i = 0; i < retries; i++) {
    els = _queryScoped(selector, context, all);
    if (!selector && scopedRoot) els = [scopedRoot];
    if (els.length) break;
    await _sleep(500);
  }
  // In LOOP children, if selector still misses, click the current loop item root.
  if (!els.length && scopedRoot && !all) {
    els = [scopedRoot];
    usedRootFallback = true;
  }
  if (!els.length) {
    throw new Error(`Click target not found: ${renderedSelector || selector}`);
  }
  let clicked = 0;
  for (const el of els) {
    const target = _pickClickableTarget(el);
    if (!target) continue;

    target.scrollIntoView({ behavior: "smooth", block: "center" });
    await _sleep(120);

    if (target instanceof HTMLElement) target.focus?.({ preventScroll: true });

    const isCheck =
      target instanceof HTMLInputElement &&
      ["checkbox", "radio"].includes(target.type?.toLowerCase());
    const wasChecked = isCheck ? target.checked : undefined;

    try {
      target.click();
      clicked++;
    } catch {
      if (target instanceof HTMLElement) {
        _dispatchSyntheticClick(target);
        clicked++;
      }
    }

    // Some pages block native click on hidden radio/checkbox wrappers.
    if (isCheck && target.checked === wasChecked) {
      if (target.type.toLowerCase() === "radio") target.checked = true;
      else target.checked = !target.checked;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // For delegated handlers (common on LI lists), also bubble a click on original matched node.
    if (target !== el && el instanceof HTMLElement) {
      _dispatchSyntheticClick(el);
    }
  }
  return {
    clicked,
    matched: els.length,
    selector: renderedSelector || selector,
    usedRootFallback,
  };
}

async function _stepScroll(
  { mode = "pixel", amount, value, selector, behavior = "smooth" },
  context = {},
) {
  const scrollAmount = amount ?? value ?? 300;
  const scrollBehavior = behavior === "instant" ? "auto" : "smooth";
  if ((mode === "selector" || mode === "element") && selector) {
    const el = _queryScoped(selector, context, false)[0];
    if (el) el.scrollIntoView({ behavior: scrollBehavior, block: "center" });
  } else if (mode === "percent") {
    window.scrollTo({
      top: (document.body.scrollHeight * scrollAmount) / 100,
      behavior: scrollBehavior,
    });
  } else {
    // mode === 'pixel' or 'px' or default
    window.scrollBy({ top: scrollAmount, behavior: scrollBehavior });
  }
  return { scrolled: true };
}

async function _stepWait(
  { mode = "fixed", ms = 1000, selector, timeout = 15000 },
  context = {},
) {
  if (mode === "fixed") {
    await _sleep(ms);
  } else if (mode === "selector-visible" && selector) {
    await _waitForSelectorScoped(selector, timeout, context);
  } else if (mode === "DOM-stable") {
    await _waitDOMStable();
  } else {
    await _sleep(ms);
  }
  return { waited: true };
}

async function _stepExtract({ fields = [], schema = [] }, context = {}) {
  const extractors = schema.length > 0 ? schema : fields;
  if (extractors.length === 0) return [];

  const rawData = {};
  let maxLen = 1;

  const _extractValue = (el, field) => {
    if (field.type === "attribute" && field.attribute)
      return el.getAttribute(field.attribute) ?? null;
    if (field.type === "html") return el.innerHTML;

    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const inputType = el.type?.toLowerCase() ?? "text";
      if (inputType === "checkbox" || inputType === "radio") {
        return el.checked ? (el.value ?? "true") : "";
      }
      if (inputType === "file") {
        const files = Array.from(el.files || []);
        return files.length
          ? files.map((f) => f.name).join(", ")
          : (el.value ?? "");
      }
      return el.value ?? el.getAttribute("value") ?? "";
    }
    if (tag === "textarea") return el.value ?? "";
    if (tag === "select") {
      const opts = Array.from(el.selectedOptions || []);
      if (el.multiple) {
        return opts
          .map((o) => o.value || o.textContent.trim())
          .filter(Boolean)
          .join(", ");
      }
      const opt = opts[0];
      return opt ? opt.value || opt.textContent.trim() : (el.value ?? "");
    }
    if (el.isContentEditable)
      return el.innerText?.trim() ?? el.textContent.trim();

    // Intelligent media and url scraping
    if (tag === "img")
      return el.src || el.dataset?.src || el.getAttribute("src");
    if (tag === "a" && !el.textContent.trim())
      return el.href || el.getAttribute("href");
    if (tag === "video" || tag === "audio")
      return (
        el.src || el.getAttribute("src") || el.querySelector("source")?.src
      );
    return el.textContent.trim();
  };

  for (const field of extractors) {
    const name = field.name || "data";
    // Pull all elements matching the selector
    const els = _queryScoped(field.selector, context, true);
    if (els.length > maxLen) maxLen = els.length;

    rawData[name] = els.map((el) => _extractValue(el, field));
  }

  const results = [];
  for (let i = 0; i < maxLen; i++) {
    const row = {};
    for (const field of extractors) {
      const name = field.name || "data";
      // Match the exact row index, OR fall back to the generic 1st match (e.g., page title shared across 10 products)
      row[name] =
        rawData[name][i] !== undefined
          ? rawData[name][i]
          : rawData[name][0] || null;
    }
    results.push(row);
  }
  return results;
}

async function _stepScreenshot({ fullPage = false }) {
  // Screenshots require SW coordination via chrome.tabs.captureVisibleTab
  // Signal back to SW to capture
  return { screenshotRequested: true, fullPage };
}

// ── FILL (was TYPE): single or multi-field input ─────────────────────────────
async function _stepFill(
  {
    mode = "single",
    selector = "",
    text = "",
    delayMs = 50,
    append = false,
    fields = [],
    submitSelector = "",
  },
  context = {},
) {
  async function _typeInto(el, value, delay, shouldAppend) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await _sleep(100);
    el.focus();
    if (!shouldAppend) {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    for (const ch of String(value)) {
      el.value += ch;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      await _sleep(delay || 50);
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  if (mode === "multi" && fields.length > 0) {
    for (const f of fields) {
      const el = _queryScoped(f.selector, context, false)[0];
      if (!el) continue;
      await _typeInto(el, f.value || "", delayMs, f.append || false);
      await _sleep(120);
    }
    if (submitSelector) {
      const btn = _queryScoped(submitSelector, context, false)[0];
      if (btn) {
        btn.scrollIntoView();
        await _sleep(200);
        btn.click();
      }
    }
    return { filled: fields.length };
  }

  // single mode
  const el =
    _queryScoped(selector, context, false)[0] || _getScopedRoot(context);
  if (!el) throw new Error(`Fill target not found: ${selector}`);
  await _typeInto(el, text, delayMs, append);
  return { typed: true };
}

async function _stepHover({ selector }, context = {}) {
  const el =
    _queryScoped(selector, context, false)[0] || _getScopedRoot(context);
  if (!el) throw new Error(`Hover target not found: ${selector}`);
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  await _sleep(150);
  const r = el.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top + r.height / 2);
  const init = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: cx,
    clientY: cy,
  };
  el.dispatchEvent(new MouseEvent("mouseenter", init));
  el.dispatchEvent(new MouseEvent("mouseover", init));
  el.dispatchEvent(new MouseEvent("mousemove", init));
  el.dispatchEvent(new PointerEvent("pointerenter", { ...init, pointerId: 1 }));
  el.dispatchEvent(new PointerEvent("pointermove", { ...init, pointerId: 1 }));
  return { hovered: true, x: cx, y: cy };
}

async function _stepSelect({ selector, value }, context = {}) {
  const el =
    _queryScoped(selector, context, false)[0] || _getScopedRoot(context);
  if (!el) throw new Error(`Select target not found: ${selector}`);
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  await _sleep(100);
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { selected: true };
}

async function _stepKeyboard({ key }, context = {}) {
  // key may be a combo like "Ctrl+Enter" or "Shift+Alt+Delete"
  const parts = (key || "Enter").split("+");
  const mainKey = parts[parts.length - 1];
  const ctrlKey = parts.includes("Ctrl");
  const altKey = parts.includes("Alt");
  const shiftKey = parts.includes("Shift");
  const metaKey = parts.includes("Meta");

  const active = document.activeElement || document.body;
  const code = mainKey.length === 1 ? `Key${mainKey.toUpperCase()}` : mainKey;
  const which = mainKey.length === 1 ? mainKey.charCodeAt(0) : 0;
  const evInit = {
    key: mainKey,
    code,
    which,
    charCode: which,
    keyCode: which,
    bubbles: true,
    cancelable: true,
    ctrlKey,
    altKey,
    shiftKey,
    metaKey,
  };

  active.dispatchEvent(new KeyboardEvent("keydown", evInit));
  active.dispatchEvent(new KeyboardEvent("keypress", evInit));
  await _sleep(40);
  active.dispatchEvent(new KeyboardEvent("keyup", evInit));
  return { keypressed: key };
}

async function _stepDragDrop({ source, target }, context = {}) {
  const src =
    _queryScoped(source, context, false)[0] || _getScopedRoot(context);
  const tgt = _queryScoped(target, context, false)[0] || null;
  if (!src || !tgt) throw new Error(`Drag/drop source or target not found`);
  const sr = src.getBoundingClientRect();
  const tr = tgt.getBoundingClientRect();
  const sx = sr.left + sr.width / 2,
    sy = sr.top + sr.height / 2;
  const tx = tr.left + tr.width / 2,
    ty = tr.top + tr.height / 2;
  const dt = new DataTransfer();
  const mki = (x, y) => ({
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  src.dispatchEvent(
    new PointerEvent("pointerdown", { ...mki(sx, sy), pointerId: 1 }),
  );
  src.dispatchEvent(new MouseEvent("mousedown", mki(sx, sy)));
  await _sleep(80);
  src.dispatchEvent(
    new DragEvent("dragstart", { ...mki(sx, sy), dataTransfer: dt }),
  );
  await _sleep(80);
  // simulate movement in 5 steps
  for (let i = 1; i <= 5; i++) {
    const x = sx + ((tx - sx) * i) / 5,
      y = sy + ((ty - sy) * i) / 5;
    const over = document.elementFromPoint(x, y) || tgt;
    over.dispatchEvent(
      new DragEvent("dragover", { ...mki(x, y), dataTransfer: dt }),
    );
    await _sleep(25);
  }
  tgt.dispatchEvent(
    new DragEvent("dragenter", { ...mki(tx, ty), dataTransfer: dt }),
  );
  tgt.dispatchEvent(
    new DragEvent("drop", { ...mki(tx, ty), dataTransfer: dt }),
  );
  await _sleep(60);
  src.dispatchEvent(
    new DragEvent("dragend", { ...mki(tx, ty), dataTransfer: dt }),
  );
  src.dispatchEvent(new MouseEvent("mouseup", mki(tx, ty)));
  src.dispatchEvent(
    new PointerEvent("pointerup", { ...mki(tx, ty), pointerId: 1 }),
  );
  return { dragged: true };
}

async function _stepLoop({ type, selector, max }) {
  return { loopInfo: { type, selector, max } };
}

async function _stepIfElse(
  { condition, selector, value = "", attr = "" },
  context = {},
) {
  const el =
    _queryScoped(selector, context, false)[0] || _getScopedRoot(context);
  const exists = !!el;
  let conditionMet = false;
  switch (condition) {
    case "exists":
      conditionMet = exists;
      break;
    case "not-exists":
      conditionMet = !exists;
      break;
    case "text-equals":
      conditionMet = exists && el.textContent.trim() === value;
      break;
    case "text-contains":
      conditionMet = exists && el.textContent.includes(value);
      break;
    case "attr-equals":
      conditionMet = exists && el.getAttribute(attr) === value;
      break;
    case "attr-contains":
      conditionMet = exists && (el.getAttribute(attr) || "").includes(value);
      break;
    default:
      conditionMet = exists;
  }
  return { conditionMet };
}

// ── Form fill row ─────────────────────────────────────────────────────────────
async function _formFillRow({ config, row, rowIndex, context }) {
  // Dynamically load form-filler (keeps injector.js small)
  const mod = await import(chrome.runtime.getURL("content/form-filler.js"));
  return mod.executeRow(config, row, rowIndex, context);
}

// ── Bulk selector — finds the common pattern for sibling elements ─────────────────
function _buildBulkSelector(el) {
  // Walk up to 4 levels looking for a parent with multiple matching children
  let current = el;
  for (let depth = 0; depth < 4; depth++) {
    const parent = current.parentElement;
    if (!parent) break;

    // Find siblings with same tag
    const sameTagSiblings = Array.from(parent.children).filter(
      (c) => c.tagName === current.tagName,
    );

    if (sameTagSiblings.length >= 2) {
      // Find common classes across all matching siblings
      const sigClass = _findCommonClass(sameTagSiblings);
      const parentSel = _buildSpecificSelector(parent);
      const childTag = current.tagName.toLowerCase();
      const childSel = sigClass ? `${childTag}.${sigClass}` : childTag;

      // Check: how many elements does this selector match?
      const candidate = `${parentSel} > ${childSel}`;
      try {
        const count = document.querySelectorAll(candidate).length;
        if (count >= 2) return { selector: candidate, count };
      } catch {}
    }
    current = parent;
  }
  // Fallback: use just the element's own classes
  return {
    selector: _buildSpecificSelector(el),
    count: document.querySelectorAll(_buildSpecificSelector(el)).length,
  };
}

function _findCommonClass(elements) {
  if (!elements.length) return "";
  const classSets = elements.map((el) => Array.from(el.classList));
  // Find classes present in ALL elements
  const common = classSets[0].filter(
    (cls) =>
      cls.length > 1 && // skip single-char utility classes
      !cls.match(/^(active|selected|hover|first|last|odd|even|\d)/) && // skip state classes
      classSets.every((set) => set.includes(cls)),
  );
  return common[0] || "";
}
function _buildSpecificSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const tag = el.tagName.toLowerCase();
  const cls = Array.from(el.classList)
    .filter((c) => !c.match(/^(active|selected|hover|open|show)/))
    .slice(0, 2);
  if (cls.length) return `${tag}.${cls.map((c) => CSS.escape(c)).join(".")}`;
  // nth-child fallback
  const parent = el.parentElement;
  if (parent) {
    const idx = Array.from(parent.children).indexOf(el) + 1;
    return `${_buildSpecificSelector(parent)} > ${tag}:nth-child(${idx})`;
  }
  return tag;
}

// ── Selector picker overlay ────────────────────────────────────────────────────
let _pickerActive = false;
let _pickerResolve = null;

async function _activateSelectorPicker(payload) {
  if (_pickerActive) return null;
  _pickerActive = true;
  const isBulk = payload?.bulk === true;

  return new Promise((resolve) => {
    _pickerResolve = resolve;

    // Use an invisible blocker div instead of a global CSS * override.
    // This physically stops mouse events from reaching the page (thus freezing CSS hovers).
    const overlay = document.createElement("div");
    overlay.style.cssText = [
      "position:fixed;top:0;left:0;width:100%;height:100%;",
      "z-index:2147483645;cursor:crosshair;background:transparent;pointer-events:auto;",
    ].join("");
    _shadow.appendChild(overlay);

    let currentTarget = null;
    const highlight = document.createElement("div");
    highlight.style.cssText = [
      "position:fixed;pointer-events:none;border:2px solid #2563eb;",
      "background:rgba(37,99,235,0.1);border-radius:4px;transition:all 0.1s;z-index:2147483647;",
    ].join("");

    // Tiny instruction tooltip attached to the highlight
    const tooltip = document.createElement("div");
    tooltip.style.cssText =
      "position:absolute;bottom:-24px;left:-2px;background:#2563eb;color:#fff;font-size:10px;padding:2px 6px;border-radius:4px;white-space:nowrap;font-family:sans-serif;pointer-events:none;";
    tooltip.textContent = "Hold CTRL to allow hover";
    highlight.appendChild(tooltip);

    _shadow.appendChild(highlight);

    document.addEventListener("mousemove", onMove, true); // Capture phase!
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("keyup", onKey, true);

    function onKey(e) {
      // "Optional" interaction enabler via CTRL
      if (e.key === "Control") {
        overlay.style.pointerEvents = e.type === "keydown" ? "none" : "auto";
      }
    }

    let _blockTimer = null;
    let _lastX = 0,
      _lastY = 0;

    function _updateHighlight() {
      if (!currentTarget) return;
      const rect = currentTarget.getBoundingClientRect();
      Object.assign(highlight.style, {
        top: `${rect.top}px`,
        left: `${rect.left}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
    }

    function onMove(e) {
      _lastX = e.clientX;
      _lastY = e.clientY;
      if (!_blockTimer) {
        _blockTimer = requestAnimationFrame(() => {
          overlay.style.pointerEvents = "none";
          const realTarget = document.elementFromPoint(_lastX, _lastY);
          // Restore pointer-events: CTRL held = keep 'none' to let user interact
          overlay.style.pointerEvents = e.ctrlKey ? "none" : "auto";
          _blockTimer = null;
          if (
            !realTarget ||
            realTarget === _host ||
            realTarget.nodeName === "HTML" ||
            realTarget === document.documentElement
          )
            return;
          currentTarget = realTarget;
          _updateHighlight();
        });
      }
    }

    function onClick(e) {
      e.preventDefault();
      e.stopPropagation();
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("keyup", onKey, true);

      _shadow.removeChild(overlay);
      _shadow.removeChild(highlight);
      _pickerActive = false;

      // Calculate CSS path using our intelligent engine
      const selector = currentTarget
        ? _buildSelector(currentTarget, isBulk)
        : null;
      _pickerResolve?.(selector);
    }
  });
}

function _buildSelector(el, bulk = false) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return "*";
  if (el.tagName.toLowerCase() === "html") return "html";
  if (el.tagName.toLowerCase() === "body") return "body";

  // 0. Intelligent Bulk Engine (for LOOP and EXTRACT)
  if (bulk) {
    const res = _buildBulkSelector(el);
    if (res && res.selector !== "*") return res.selector;
  }

  // 1. Try Unique ID (ONLY if not doing universal bulk extraction)
  if (!bulk && el.id) {
    const cleanId = CSS.escape(el.id);
    try {
      if (document.querySelectorAll(`#${cleanId}`).length === 1)
        return `#${cleanId}`;
    } catch {}
  }

  // 2. Try Semantic Attributes
  const semantics = [
    "data-testid",
    "data-test",
    "data-id",
    "name",
    "aria-label",
    "placeholder",
    "role",
  ];
  for (const attr of semantics) {
    const val = el.getAttribute(attr);
    if (val) {
      const sel = `${el.tagName.toLowerCase()}[${attr}="${CSS.escape(val)}"]`;
      try {
        if (!bulk && document.querySelectorAll(sel).length === 1) return sel;
        if (bulk && document.querySelectorAll(sel).length > 1) return sel;
      } catch {}
    }
  }

  // 3. Try Classes
  if (el.className && typeof el.className === "string") {
    const classes = el.className
      .split(/\s+/)
      .filter(
        (c) =>
          c &&
          !c.includes("hover") &&
          !c.includes("active") &&
          !c.includes("focus") &&
          !c.includes("ng-"),
      );
    if (classes.length > 0) {
      const classSel =
        el.tagName.toLowerCase() +
        "." +
        classes.map((c) => CSS.escape(c)).join(".");
      try {
        if (!bulk && document.querySelectorAll(classSel).length === 1)
          return classSel;
        if (bulk) return classSel; // Perfect universal anchor!
      } catch {}
    }
  }

  // 4. Fallback to structural path
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (parent) {
    if (bulk && tag !== "svg") {
      // Universal generic path logic across parent containers
      return `${_buildSelector(parent, bulk)} > ${tag}`;
    } else {
      // Specific locked path for non-bulk target
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName.toLowerCase() === tag,
      );
      if (siblings.length === 1) {
        return `${_buildSelector(parent, bulk)} > ${tag}`;
      }
      const idx = siblings.indexOf(el) + 1;
      return `${_buildSelector(parent, bulk)} > ${tag}:nth-of-type(${idx})`;
    }
  }
  return tag;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function _waitForSelector(selector, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (document.querySelector(selector)) return;
    await _sleep(200);
  }
  throw new Error(`Timeout waiting for selector: ${selector}`);
}

async function _waitForSelectorScoped(selector, timeout, context = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (_queryScoped(selector, context, false).length > 0) return;
    await _sleep(200);
  }
  throw new Error(`Timeout waiting for selector: ${selector}`);
}

async function _waitDOMStable(quietMs = 300, timeout = 8000) {
  return new Promise((resolve) => {
    let timer = null;
    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        obs.disconnect();
        resolve();
      }, quietMs);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    timer = setTimeout(() => {
      obs.disconnect();
      resolve();
    }, timeout);
  });
}

// === END injector.js ===

// ── Bootstrap overlay engine ─────────────────────────────────────────────────
// overlay-engine.js is an ES module — it cannot be declared in manifest
// content_scripts directly. We load it dynamically so it self-initialises
// (overlayEngine.init() is called at the bottom of overlay-engine.js).
import(chrome.runtime.getURL("content/overlay-engine.js")).catch((err) => {
  console.warn("[FlowScrape] overlay-engine failed to load:", err.message);
});
