import fs from "fs";

const TARGET = "c:/MY SPACE/MY LAPTOP/project works/fully automated web scraper/flowscrape-v3/background/service-worker.js";
let content = fs.readFileSync(TARGET, "utf-8");

// Change single _runState to multi-map
content = content.replace(
  `let _runState = {
  active: false,
  paused: false,
  runId: null,
  tabId: null,
  results: [],
  screenshots: [],
};`,
  `const _runStates = new Map();`
);

// Update _broadcastLog definition
content = content.replace(
  `function _broadcastLog(level, message) {
  chrome.runtime
    .sendMessage({ type: "pipeline:log", payload: { level, message } })`,
  `function _broadcastLog(level, message, runId) {
  chrome.runtime
    .sendMessage({ type: "pipeline:log", payload: { level, message, runId } })`
);

// We need to carefully replace other _runState appearances.
// For PIPELINE_START:
content = content.replace(
  `_registerHandler(MSG.PIPELINE_START, async (payload, sender) => {
  if (_runState.active) throw new Error("Pipeline already running");`,
  `_registerHandler(MSG.PIPELINE_START, async (payload, sender) => {`
);

content = content.replace(
  `  const runId = \`run_\${Date.now()}_\${Math.random().toString(36).slice(2, 8)}\`;
  _runState = {
    active: true,
    paused: false,
    runId,
    tabId: tabId ?? sender.tab?.id,
    results: [],
  };`,
  `  const runId = \`run_\${Date.now()}_\${Math.random().toString(36).slice(2, 8)}\`;
  const runState = {
    active: true,
    paused: false,
    runId,
    tabId: tabId ?? sender.tab?.id,
    results: [],
    screenshots: []
  };
  _runStates.set(runId, runState);`
);

content = content.replace(`tabId: _runState.tabId,`, `tabId: runState.tabId,`);

content = content.replace(
  `    _runState = {
      active: false,
      paused: false,
      runId: null,
      tabId: null,
      results: [],
    };`,
  `    _runStates.delete(runId);`
);

content = content.replace(`_executePipeline(runId, pipeline, _runState.tabId).catch((err) => {`, `_executePipeline(runId, pipeline, runState.tabId).catch((err) => {`);

// In _captureScreenshot
content = content.replace(
  `async function _captureScreenshot(tabId, config = {}) {`,
  `async function _captureScreenshot(tabId, config = {}, runId) {
  const runState = _runStates.get(runId);
  if (!runState) return;`
);

content = content.replace(`if (!Array.isArray(_runState.screenshots)) _runState.screenshots = [];`, `if (!Array.isArray(runState.screenshots)) runState.screenshots = [];`);
content = content.replace(`_runState.screenshots.push({ dataUrl, ts: Date.now() });`, `runState.screenshots.push({ dataUrl, ts: Date.now() });`);
content = content.replace(`\`Screenshot #\${_runState.screenshots.length} captured.\`,`, `\`Screenshot #\${runState.screenshots.length} captured.\`, runId`);

// _doExport
content = content.replace(
  `async function _doExport(runId, config) {
  const idbRows = await readAllRows(runId).catch(() => []);
  const allRows = [..._runState.results];`,
  `async function _doExport(runId, config) {
  const runState = _runStates.get(runId);
  if (!runState) return;
  const idbRows = await readAllRows(runId).catch(() => []);
  const allRows = [...runState.results];`
);
content = content.replace(`const screenshots = _runState.screenshots || [];`, `const screenshots = runState.screenshots || [];`);
content = content.replace(`\`Exported ZIP: \${allRows.length} rows + \${screenshots.length} screenshots.\`,`, `\`Exported ZIP: \${allRows.length} rows + \${screenshots.length} screenshots.\`, runId`);
content = content.replace(`\`Exported \${allRows.length} rows as \${fmt.toUpperCase()}.\`,`, `\`Exported \${allRows.length} rows as \${fmt.toUpperCase()}.\`, runId`);
content = content.replace(`_broadcastLog("warn-log", "Export: no data collected.");`, `_broadcastLog("warn-log", "Export: no data collected.", runId);`);

// _executeLoop
// add runState to execute loop condition
content = content.replace(`for (let i = 0; i < iters && _runState.active; i++) {`, `const runState = _runStates.get(runId);\n  for (let i = 0; i < iters && runState?.active; i++) {`);
content = content.replace(
`_broadcastLog(
          "info-log",
          \`Loop: found \${elementsData.length} elements for "\${selector}"\`,
        );`,
`_broadcastLog(
          "info-log",
          \`Loop: found \${elementsData.length} elements for "\${selector}"\`,
          runId
        );`
);
content = content.replace(
`_broadcastLog(
          "warn-log",
          \`Loop: no elements matched "\${selector}" — skipping.\`,
        );`,
`_broadcastLog(
          "warn-log",
          \`Loop: no elements matched "\${selector}" — skipping.\`,
          runId
        );`
);
content = content.replace(
`_broadcastLog("warn-log", \`Loop: element query failed: \${e.message}\`);`,
`_broadcastLog("warn-log", \`Loop: element query failed: \${e.message}\`, runId);`
);
content = content.replace(
`_broadcastLog("info-log", \`Loop [\${i + 1}/\${iters}] done.\`);`,
`_broadcastLog("info-log", \`Loop [\${i + 1}/\${iters}] done.\`, runId);`
);
content = content.replace(
`_broadcastLog("warn-log", \`Loop [\${i + 1}/\${iters}] — \${e.message}\`);`,
`_broadcastLog("warn-log", \`Loop [\${i + 1}/\${iters}] — \${e.message}\`, runId);`
);

content = content.replace(
`_broadcastLog(
    "info-log",
    \`IF_ELSE: condition \${met ? "met → IF" : "not met → ELSE"} branch.\`,
  );`,
`_broadcastLog(
    "info-log",
    \`IF_ELSE: condition \${met ? "met → IF" : "not met → ELSE"} branch.\`,
    runId
  );`
);

// _executeStepList
content = content.replace(
`for (const step of steps) {
    if (!_runState.active || _runState.runId !== runId) break;`,
`const runState = _runStates.get(runId);
  for (const step of steps) {
    if (!runState || !runState.active) break;`
);

content = content.replace(
`chrome.runtime
      .sendMessage({
        type: "pipeline:status",
        payload: { state: "running", currentStepId: step.id, progress: {} },
      })`,
`chrome.runtime
      .sendMessage({
        type: "pipeline:status",
        payload: { state: "running", currentStepId: step.id, progress: {}, runId },
      })`
);

content = content.replace(`await _captureScreenshot(tabId, resolvedStep.config);`, `await _captureScreenshot(tabId, resolvedStep.config, runId);`);

content = content.replace(
`_broadcastLog(
        "info-log",
        \`API \${apiResult.method} \${apiResult.url} → \${apiResult.status}\`,
      );`,
`_broadcastLog(
        "info-log",
        \`API \${apiResult.method} \${apiResult.url} → \${apiResult.status}\`,
        runId
      );`
);

content = content.replace(`_runState.results.push(...resp.result);`, `runState.results.push(...resp.result);`);
content = content.replace(`for (const row of resp.result) await pushRow(row);`, `for (const row of resp.result) await pushRow(runId, row);`);
content = content.replace(
`_broadcastLog(
          "info-log",
          \`Extracted \${resp.result.length} rows (total: \${_runState.results.length}).\`,
        );`,
`_broadcastLog(
          "info-log",
          \`Extracted \${resp.result.length} rows (total: \${runState.results.length}).\`,
          runId
        );`
);

// _executePipeline
content = content.replace(
`while (
    _runState.active &&
    _runState.runId === runId &&
    stepIndex < pipeline.steps.length
  ) {
    if (_runState.paused) {`,
`while (
    _runStates.has(runId) &&
    _runStates.get(runId).active &&
    stepIndex < pipeline.steps.length
  ) {
    const runState = _runStates.get(runId);
    if (runState.paused) {`
);

content = content.replace(
`chrome.runtime
      .sendMessage({
        type: "pipeline:status",
        payload: {
          state: "running",
          currentStepId: step.id,
          progress: { current: progressCount, total },
        },
      })`,
`chrome.runtime
      .sendMessage({
        type: "pipeline:status",
        payload: {
          state: "running",
          currentStepId: step.id,
          progress: { current: progressCount, total },
          runId
        },
      })`
);

content = content.replace(`await _captureScreenshot(targetTabId, resolvedStep.config);`, `await _captureScreenshot(targetTabId, resolvedStep.config, runId);`);

content = content.replace(`_runState.results.push(...resp.result);`, `runState.results.push(...resp.result);`);
content = content.replace(`for (const row of resp.result) await pushRow(row);`, `for (const row of resp.result) await pushRow(runId, row);`);

content = content.replace(
`_broadcastLog(
        isCritical ? "error-log" : "warn-log",
        \`[\${resolvedStep.type}] \${err.message}\${isCritical ? "" : " (optional, skipping)"}\`,
      );`,
`_broadcastLog(
        isCritical ? "error-log" : "warn-log",
        \`[\${resolvedStep.type}] \${err.message}\${isCritical ? "" : " (optional, skipping)"}\`,
        runId
      );`
);

content = content.replace(`_runState.active = false;`, `runState.active = false;`);

// Find the line that creates `stateStr = _runState.active ? "completed" : "stopped"`
content = content.replace(
`const stateStr = _runState.active ? "completed" : "stopped";
  chrome.runtime
    .sendMessage({
      type: "pipeline:status",
      payload: {
        state: stateStr,
        currentStepId: null,
        progress: { current: progressCount, total },
      },
    })
    .catch(() => {});
  _runState = {
    active: false,
    paused: false,
    runId: null,
    tabId: null,
    results: [],
  };`,
`const endRunState = _runStates.get(runId);
  const stateStr = endRunState?.active ? "completed" : "stopped";
  chrome.runtime
    .sendMessage({
      type: "pipeline:status",
      payload: {
        state: stateStr,
        currentStepId: null,
        progress: { current: progressCount, total },
        runId
      },
    })
    .catch(() => {});
  _runStates.delete(runId);`
);

content = content.replace(
`_registerHandler(MSG.PIPELINE_PAUSE, async () => {
  _runState.paused = true;
  logger.info(MODULE, "pipeline-paused", { runId: _runState.runId });
  return { ok: true };
});`,
`_registerHandler(MSG.PIPELINE_PAUSE, async (payload) => {
  const rs = _runStates.get(payload?.runId);
  if(rs) {
    rs.paused = true;
    logger.info(MODULE, "pipeline-paused", { runId: rs.runId });
  }
  return { ok: true };
});`
);

content = content.replace(
`_registerHandler(MSG.PIPELINE_STOP, async () => {
  _runState.active = false;
  _runState.paused = false;
  const runId = _runState.runId;
  _runState.runId = null;
  await chrome.alarms.clear("fs_sw_heartbeat");
  logger.info(MODULE, "pipeline-stopped", { runId });
  return { ok: true };
});`,
`_registerHandler(MSG.PIPELINE_STOP, async (payload) => {
  const rs = _runStates.get(payload?.runId);
  if(rs) {
    rs.active = false;
    rs.paused = false;
    logger.info(MODULE, "pipeline-stopped", { runId: rs.runId });
  }
  if(_runStates.size === 0) await chrome.alarms.clear("fs_sw_heartbeat");
  return { ok: true };
});`
);

content = content.replace(
`_registerHandler(MSG.PIPELINE_STATUS, async () => {
  return { ..._runState };
});`,
`_registerHandler(MSG.PIPELINE_STATUS, async (payload) => {
  return { ...(_runStates.get(payload?.runId) || { active: false, paused: false, runId: payload?.runId }) };
});`
);

// One more check in heartbeat:
content = content.replace(`logger.debug(MODULE, "heartbeat", { active: _runState.active });`, `logger.debug(MODULE, "heartbeat", { active: _runStates.size > 0 });`);

// Fix pushRow call in executeStepList (if missed)
content = content.replace(`for (const row of resp.result) await pushRow(row);`, `for (const row of resp.result) await pushRow(runId, row);`);
// Fix pushRow call in executePipeline (if missed)
content = content.replace(`for (const row of resp.result) await pushRow(row);`, `for (const row of resp.result) await pushRow(runId, row);`);

fs.writeFileSync(TARGET, content);
console.log("Patched service-worker.js");
