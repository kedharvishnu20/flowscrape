# FlowScrape v3 End-to-End Activity Manual

This is the deep technical manual for FlowScrape v3.

It documents:
- full runtime activity flow from UI to execution to export
- message contracts between side panel, service worker, and content scripts
- key state variables and what they store
- module responsibilities and exact function entry points
- MCP server behavior, transport, and pipeline persistence

This file complements the high-level reference in `docs/flowscrape-reference.md`.

## 1) Runtime Topology

FlowScrape has three concurrent execution surfaces in Chrome extension mode:

1. Side panel UI
- Authoring and run controls.
- Main files: `sidepanel/index.html`, `sidepanel/pipeline-builder.js`.

2. Background service worker
- Orchestrator, run state, ethics checks, proxy/rate/captcha integration, checkpointing, export.
- Main file: `background/service-worker.js`.

3. Content script runtime
- Page-level DOM interaction, element selection, extraction, selector picker, form actions.
- Main file: `content/injector.js`.

Additional support surfaces:
- Checkpointing: `checkpoint/*.js`
- Safety: `ethics/*.js` and `background/ethics-engine.js`
- Data parsers: `data-sources/*.js`
- Exporters: `exporters/*.js`
- Script generation: `script-gen/*.js`
- Standalone MCP server: `mcp/server.mjs`

## 2) End-to-End Activity Map

### Activity A: Build or edit a pipeline

Entry points:
- UI controls and events in `sidepanel/pipeline-builder.js`
- Main renderer: `renderPipeline()`

Flow:
1. User adds, reorders, edits, expands, or removes steps.
2. `_pipeline` state is mutated.
3. `saveState()` persists `_pipeline` into `chrome.storage.local` key `fs_active_pipeline_<tabId>`.
4. `renderPipeline()` rebuilds node cards and connection wires.

Primary variables:
- `_pipeline`: full working pipeline model.
- `_expandedNodeId`: selected expanded card.
- `_insertCtx`: insertion context for add-step palette.
- `_boardState`: zoom/pan state and fit status.

### Activity B: Upload a previously built pipeline file

Entry points:
- Button: `btn-upload-pipeline`
- Hidden file input: `input-upload-pipeline`
- Handlers in `bindGlobalControls()`.

Flow:
1. User chooses JSON file.
2. File is parsed (`JSON.parse`).
3. `_normalizeImportedPipeline()` validates and normalizes shape.
4. `_normalizeImportedStep()` enforces required fields (`id`, `type`, `config`) and recursively normalizes branches.
5. `_pipeline` is replaced, then saved and rendered.

Validation behavior:
- Requires top-level object containing `steps` array.
- Generates step IDs for missing/duplicate IDs.
- Supports `children`, `ifBranch`, `elseBranch` recursion.

### Activity C: Download the current pipeline file

Entry points:
- Button: `btn-download-pipeline`
- Handler in `bindGlobalControls()`.

Flow:
1. If no steps, warns and aborts.
2. Serializes current `_pipeline` with metadata (`exportedAt`, `source`).
3. Creates Blob (`application/json`) and downloads timestamped JSON file.

### Activity D: Start pipeline execution

Entry points:
- Side panel `btn-master-run`.
- Message to SW: `pipeline:start`.

Flow:
1. Side panel builds payload from `_pipeline`, current `tabId`, current page origin/path, bypass flags.
2. Service worker handler `_registerHandler(MSG.PIPELINE_START, ...)` validates input.
3. SW creates per-run state in `_runStates` map with unique `runId`.
4. SW executes ethics gates (`runEthicsGates`).
5. On hard block, aborts with `EthicsBlock`.
6. On pass/warn, launches `_executePipeline(runId, pipeline, tabId)` asynchronously.
7. Side panel switches UI to running state and starts monitor timer.

Primary run-state variables (service worker):
- `_runStates`: `Map<runId, runState>`
- `runState.active`
- `runState.paused`
- `runState.runId`
- `runState.tabId`
- `runState.enableSniffer`
- `runState.results`
- `runState.screenshots`
- `runState.networks` (added when sniffer captures)

### Activity E: Step dispatch and execution

Execution surfaces:
- SW executes orchestration-level steps and API/loop/branch logic.
- Content script executes DOM steps via `step:execute` messages.

Service worker path:
- `_executePipeline(...)`
- `_executeStepList(...)` for nested structures

Content script path:
- `chrome.runtime.onMessage` receives `step:execute`
- `_handleEvent()` routes to `_executeStep(step)`

Important behavior:
- Config templating resolved in SW before sending steps (`_resolveConfig`, `_resolveAny`, `_resolveStr`).
- `EXTRACT` rows are merged into run memory and checkpoint row-buffer.
- Optional-step failures are logged and skipped.
- Non-optional failures stop the run.

### Activity F: API sniff capture during run

Entry points:
- Page-side network sniffer emits `FS_NETWORK_SNIFF` message.
- Content script relays to SW `network:sniff`.

Flow:
1. SW finds active run matching `tabId`.
2. Capture only when `runState.enableSniffer === true`.
3. Appends request/response metadata into `runState.networks`.
4. Included in ZIP export (CSV or JSON) when available.

### Activity G: Data extraction and checkpoint persistence

Flow:
1. Content step `EXTRACT` returns rows array.
2. SW appends rows to in-memory `runState.results`.
3. SW pushes each row to checkpoint buffer (`pushRow(runId, row)`).
4. Buffer auto-flushes every 50 rows or 30 seconds.
5. Finalize flush happens at run end and before export.

Checkpoint variables and constants:
- `checkpoint/row-buffer.js`
  - `FLUSH_INTERVAL_MS = 30000`
  - `FLUSH_ROWS_COUNT = 50`
  - `_buffers` map
  - `_flushTimers` map
  - `_idbDB`

### Activity H: Export

Entry points:
- Explicit `EXPORT` step in pipeline.
- Run completion flow.

Flow:
1. SW assembles rows from in-memory + IndexedDB buffer.
2. Builds content in selected format.
3. Handles screenshots and sniffer artifacts.
4. Produces either direct file output or ZIP bundle.

Relevant helpers in SW:
- `_doExport`
- `_buildZip`
- `_dataUrlToBytes`

Exporter modules:
- `exporters/text-exporters.js`
- `exporters/stream-writer.js`

### Activity I: Pause/stop/status lifecycle

Messages:
- `pipeline:pause`
- `pipeline:stop`
- `pipeline:status`

Flow:
- Pause toggles `runState.paused`.
- Stop toggles `runState.active = false` and ends loop.
- Status messages drive monitor UI and progress bars.

### Activity J: Script export

Entry points:
- Side panel `btn-export-script`.
- SW message `script:export`.

Flow:
1. SW compiles pipeline AST (`compilePipeline`).
2. Emits language output (`emitPython` or `emitNode`).
3. Side panel downloads generated script file.

### Activity K: Safety and ethics gates

Core logic:
- `background/ethics-engine.js`
- `ethics/robots-parser.js`
- `ethics/pii-detector.js`

Gate summary:
1. robots gate
2. pii gate
3. rate-limit gate
4. captcha gate
5. proxy-geo gate
6. domain-lock gate

Hard constraints include:
- password/hidden form-fill restrictions
- submit volume ceiling
- minimum inter-row delay
- domain mismatch block

### Activity L: Proxy and key management

Proxy manager (`background/proxy-manager.js`):
- parses text/json/csv proxy inputs
- manages rotation mode
- tests and marks proxy health
- applies and clears Chrome proxy settings

Key manager (`background/api-key-manager.js`):
- creates session AES key in memory
- encrypts API keys for session storage
- solves captcha via selected providers

### Activity M: Resume and partial data retrieval

Resume components:
- `checkpoint/cursor-store.js`
- `checkpoint/resume-manager.js`

Data retrieval:
- SW handler `data:download` returns buffered rows for partial download.
- Side panel monitor provides download action.

## 3) Message Contracts

Canonical message names in SW (`background/service-worker.js`):
- `pipeline:start`
- `pipeline:pause`
- `pipeline:stop`
- `pipeline:status`
- `step:execute`
- `step:result`
- `proxy:select`
- `proxy:rotate`
- `proxy:test`
- `captcha:solve`
- `captcha:result`
- `key:get`
- `form:rowStart`
- `form:rowResult`
- `checkpoint:save`

Additional custom handlers:
- `network:sniff`
- `key:set`
- `proxy:update`
- `script:export`
- `checkpoint:check`
- `data:download`

Side panel receives runtime messages:
- `pipeline:status`
- `pipeline:log`

Content script accepts:
- `step:execute`
- `FS_FORM_FILL_ROW`
- `FS_PICK_SELECTOR`

## 4) Key State Variables by Module

### 4.1 Side panel state (`sidepanel/pipeline-builder.js`)

Global state:
- `SK.PIPELINE`: storage key namespace (tab-scoped)
- `_tabId`: current tab id for side panel context
- `_pipeline`: full pipeline object
- `_expandedNodeId`: expanded card id
- `_insertCtx`: where next inserted step lands
- `_runState`: `{ active, timer, startTs, runId }`
- `_dragSourceId`: source step id for DnD
- `_keyListening`: keyboard-capture flag
- `_boardState`: pan/zoom and fit model

DOM handles:
- `elCanvas`, `elPalette`, `elPaletteSearch`, `elPaletteContent`
- `elBoardViewport`, `elBoardStage`, `elPipelineWires`, `elBoardZoomLabel`

### 4.2 Service worker state (`background/service-worker.js`)

Core state:
- `_runStates`: all active/in-flight runs
- `_handlers`: message handler registry

Execution and lifecycle helpers:
- `_startHeartbeat`
- `_executePipeline`
- `_executeStepList`
- `_executeLoop`
- `_executeIfElse`
- `_captureScreenshot`
- `_doExport`

Template resolution:
- `_resolvePath`
- `_resolveStr`
- `_resolveConfig`
- `_resolveAny`

### 4.3 Content runtime state (`content/injector.js`)

Core constants:
- `FS_ORIGIN`
- `CE` message constant map

Picker state:
- `_pickerActive`
- `_pickerResolve`

Dispatcher:
- `_handleEvent`
- `_executeStep`

Selector and scoped query helpers:
- `_getScopedRoot`
- `_resolveTemplatePath`
- `_renderSelectorTemplate`
- `_normalizeScopedSelector`
- `_queryScoped`

### 4.4 Proxy manager (`background/proxy-manager.js`)

State variables:
- `_pool`
- `_credMap`
- `_rrIndex`
- `_stickyMap`
- `_rotationMode`

Storage keys:
- `STORAGE_KEY_POOL`
- `STORAGE_KEY_CREDS`

### 4.5 Rate limiter (`background/rate-limiter.js`)

State variables:
- `_buckets`
- `_retryState`

Tuning constants:
- `DEFAULT_CAPACITY`
- `DEFAULT_REFILL_RATE`

### 4.6 Ethics engine (`background/ethics-engine.js`)

Key constants:
- `MAX_FORM_ROWS_DEFAULT`
- `MAX_FORM_ROWS_CONFIRMED`
- `MIN_INTER_ROW_DELAY_MS`
- `ROBOTS_CACHE_TTL_MS`

State:
- `_robotsCache`

Types:
- `EthicsBlock`
- `EthicsWarn`

### 4.7 Row buffer (`checkpoint/row-buffer.js`)

State:
- `_buffers`
- `_flushTimers`
- `_idbDB`

Constants:
- `FLUSH_INTERVAL_MS`
- `FLUSH_ROWS_COUNT`
- `DB_NAME`
- `STORE_ROWS`

### 4.8 Cursor store (`checkpoint/cursor-store.js`)

State and constants:
- `_db`
- `DB_NAME`
- `DB_VERSION`
- `STORE_CURSORS`

### 4.9 Key manager (`background/api-key-manager.js`)

Key constants and state:
- `SESSION_KEY_KEYS`
- `SESSION_KEY_SK` (documented as non-storage key marker)
- `_sessionCryptoKey`

### 4.10 Logger and dedup (`utils/*.js`)

Logger:
- `LEVELS`
- `CURRENT_LEVEL`
- `_buffer`
- `MAX_BUFFER`

Deduplicator:
- `_seen`
- `_totalDuplicates`

## 5) Pipeline Step Support Matrix

Extension runtime supports (current registry includes these):
- `WEBSITE`
- `NAVIGATE`
- `CLICK`
- `FILL` (and legacy alias `TYPE`)
- `HOVER`
- `SELECT`
- `SCROLL`
- `KEYBOARD`
- `DRAG_DROP`
- `WAIT`
- `IF_ELSE`
- `LOOP`
- `PAGINATE`
- `EXTRACT`
- `SCREENSHOT`
- `EXPORT`
- `API`
- `API_SNIFFER`

Notes:
- `API` executes in SW, not in content script.
- `EXPORT` is coordinated in SW and may include rows, screenshots, and API-sniffer outputs.

## 6) Persistence Model

Storage surfaces:
- `chrome.storage.local`
  - active tab-scoped pipeline definition
  - run-log metadata
  - proxy pool metadata
- `chrome.storage.session`
  - encrypted API key payloads
  - sensitive proxy credentials
- IndexedDB (`flowscrape_v3`)
  - `data_rows`
  - `cursors`

Pipeline upload/download behavior:
- Upload updates tab-scoped local pipeline state immediately.
- Download serializes current in-memory pipeline state.

## 7) MCP End-to-End Layer

MCP server file:
- `mcp/server.mjs`

Transport variables:
- `ROOT`
- `TRANSPORT_MODE` (`stdio`, `http`, `both`)
- `HTTP_PORT`
- `PIPELINES_DIR`

Pipeline persistence tools:
- `pipeline_list`
- `pipeline_save`
- `pipeline_load`

HTTP transport path:
- endpoint `/mcp`
- session map maintained in-memory (`httpSessions`)

Operational behavior:
- file paths are rooted to workspace
- traversal outside root is blocked
- pipeline save/load uses JSON files in `pipelines/`

## 8) Failure Modes and Recovery

Common failure classes:
- invalid selector or missing DOM element
- step execution rejection from content runtime
- blocked ethics gate
- proxy unavailability
- captcha solve failure or missing key
- malformed uploaded pipeline JSON

Recovery behavior currently implemented:
- optional step skip on error
- checkpoint save and cursor progress
- monitor logging with runId linkage
- partial row download support
- resume detection through checkpoint modules

## 9) Operational Checklist for Complete Runs

Pre-run:
1. Confirm target tab and domain
2. Confirm pipeline non-empty
3. Confirm ethics-sensitive settings (delay, row count, captcha)
4. Confirm proxy mode and pool health (if used)

Run-time:
1. Watch monitor logs and progress
2. Observe per-step status updates
3. Verify extraction count increments
4. Trigger stop only when needed (preserves partial state)

Post-run:
1. Download result data
2. Download pipeline JSON for reproducibility
3. Export script if external execution is required
4. Archive pipeline file and logs

## 10) Developer Maintenance Notes

If you change message contracts:
- update `MSG` map in service worker
- update sender/receiver bindings in side panel and content script
- update this manual and `docs/flowscrape-reference.md`

If you add a new step type:
1. add it to side panel `STEP_REGISTRY`
2. add execution support in content runtime and/or SW
3. add support to compiler/emitter if script export must include it
4. update safety and docs

If you add persistence fields:
- keep backward compatibility in `_normalizeImportedPipeline()`
- ensure missing fields are defaulted safely

## 11) File Index

Primary implementation files referenced in this manual:
- `manifest.json`
- `sidepanel/index.html`
- `sidepanel/pipeline-builder.js`
- `background/service-worker.js`
- `background/proxy-manager.js`
- `background/rate-limiter.js`
- `background/api-key-manager.js`
- `background/ethics-engine.js`
- `content/injector.js`
- `content/form-filler.js`
- `ethics/robots-parser.js`
- `ethics/pii-detector.js`
- `checkpoint/row-buffer.js`
- `checkpoint/cursor-store.js`
- `checkpoint/resume-manager.js`
- `data-sources/csv-parser.js`
- `data-sources/json-parser.js`
- `exporters/text-exporters.js`
- `exporters/stream-writer.js`
- `script-gen/pipeline-compiler.js`
- `script-gen/python-emitter.js`
- `script-gen/node-emitter.js`
- `mcp/server.mjs`

---

If you want this manual expanded further, the next level is a line-by-line API appendix for every exported function signature and each message payload schema with examples.
