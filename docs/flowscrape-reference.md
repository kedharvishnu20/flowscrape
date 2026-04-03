# FlowScrape v3 Reference

This document is the point-by-point reference for the repository and the MCP server that now ships with it.

## 1. What This Project Is

FlowScrape v3 is a Chrome extension for browser automation and data extraction.

It is built as a Manifest V3 extension with:

- a background service worker that orchestrates pipeline execution
- content scripts that interact with pages
- a side panel UI for building and starting pipelines
- checkpoint, ethics, data source, and export modules that support reliable runs
- a standalone MCP server in `mcp/` for external agent access

## 2. Top-Level Architecture

The repository is organized around a single flow:

1. A user builds or loads a pipeline definition in the side panel.
2. The pipeline is sent to the background service worker.
3. The background worker coordinates tab execution, proxy/rate-limit behavior, ethics gates, checkpointing, and export.
4. Content scripts perform page-level actions and extraction.
5. Extracted data is buffered, deduplicated, checkpointed, and exported.
6. The MCP server exposes the same core capabilities to external clients.

## 3. Main Repository Areas

### Extension runtime

- [manifest.json](../manifest.json)
- [background/service-worker.js](../background/service-worker.js)
- [content/injector.js](../content/injector.js)
- [content/form-filler.js](../content/form-filler.js)
- [content/field-auto-mapper.js](../content/field-auto-mapper.js)
- [content/captcha-detector.js](../content/captcha-detector.js)
- [content/smart-sleep.js](../content/smart-sleep.js)

### Pipeline and UI

- [sidepanel/index.html](../sidepanel/index.html)
- [sidepanel/pipeline-builder.js](../sidepanel/pipeline-builder.js)
- [script-gen/pipeline-compiler.js](../script-gen/pipeline-compiler.js)
- [script-gen/python-emitter.js](../script-gen/python-emitter.js)
- [script-gen/node-emitter.js](../script-gen/node-emitter.js)

### Ethics and safety

- [ethics/robots-parser.js](../ethics/robots-parser.js)
- [ethics/pii-detector.js](../ethics/pii-detector.js)
- [ethics/ethics-engine.js](../background/ethics-engine.js)

### Checkpointing and export

- [checkpoint/cursor-store.js](../checkpoint/cursor-store.js)
- [checkpoint/row-buffer.js](../checkpoint/row-buffer.js)
- [checkpoint/resume-manager.js](../checkpoint/resume-manager.js)
- [exporters/text-exporters.js](../exporters/text-exporters.js)
- [exporters/stream-writer.js](../exporters/stream-writer.js)

### MCP server

- [mcp/server.mjs](../mcp/server.mjs)
- [mcp/README.md](../mcp/README.md)

## 4. Chrome Extension Behavior

### Manifest

The extension is defined in [manifest.json](../manifest.json). It uses:

- MV3 service worker background execution
- content scripts at `document_start` and `document_idle`
- a side panel UI
- broad host permissions for automation
- extension resources exposed through `web_accessible_resources`

### Background service worker

The service worker is the orchestration layer. It owns pipeline execution, log broadcast, screenshots, export finalization, and run state management.

Important responsibilities include:

- starting and stopping pipeline runs
- dispatching step execution
- tracking active run state by `runId`
- handling screenshots and export bundles
- coordinating network sniffing when enabled
- managing pause/stop/status messages

### Content scripts

The content layer handles page interaction and extraction. It is responsible for:

- filling forms
- selecting elements
- reading DOM values
- detecting page conditions
- building selectors
- relaying network sniff events

## 5. Pipeline Model

The side panel builds pipeline JSON. The compiler turns that JSON into an AST that can be validated and emitted into runnable code.

### Core compiler behavior

[script-gen/pipeline-compiler.js](../script-gen/pipeline-compiler.js) does two main things:

- validates that the recipe is an object with a `steps` array
- normalizes steps into a recursive AST with `children`, `ifBranch`, and `elseBranch`

It also provides `serializePipeline()`, which redacts sensitive keys before producing JSON.

### Supported recursive structures

- `children`
- `ifBranch`
- `elseBranch`

### Pipeline metadata

The AST includes:

- `name`
- `version`
- `targetOrigin`
- `steps`
- `meta.compiledAt`
- `meta.stepCount`

## 6. Script Emission

The repository can emit runnable automation code from the pipeline AST.

### Python emitter

[script-gen/python-emitter.js](../script-gen/python-emitter.js) emits Python 3.11 using Playwright and Requests.

It supports:

- navigation
- clicks
- waits
- extraction
- form fill
- export placeholders
- scrolling
- loops
- if/else branches
- API calls

### Node emitter

[script-gen/node-emitter.js](../script-gen/node-emitter.js) emits Node 20 ESM using Playwright and fetch/csv parsing support.

The Node emitter mirrors the Python emitter’s step handling closely so the same pipeline can be exported in either runtime.

## 7. Safety Model

The project uses explicit safety checks rather than relying on convention.

### robots.txt

[ethics/robots-parser.js](../ethics/robots-parser.js) parses robots.txt using RFC 9309 style path matching.

Key behavior:

- longest matching rule wins
- `*` is treated as a wildcard
- `$` anchors the end of the path
- results are cached for 15 minutes

### PII scanning

[ethics/pii-detector.js](../ethics/pii-detector.js) looks for common PII patterns:

- SSN
- Visa
- Mastercard
- Amex
- email
- phone

It works on rows and raw text, and it only reports findings, not the raw sensitive values.

### Extension-level ethics gates

The main README documents the current policy gates:

- robots.txt warning
- PII scan warning
- rate-limit warning
- captcha warning
- proxy geo warning
- domain lock blocking

## 8. Checkpointing and Export

The repository is designed to survive long or interrupted runs.

### Checkpoint modules

- cursor storage tracks resume positions
- row buffers batch writes
- resume logic detects incomplete runs

### Export modules

- CSV
- JSON
- JSONL
- TSV
- XML
- Markdown

The stream writer is chunked so large exports do not have to live fully in memory.

## 9. MCP Server Reference

The MCP server lives in [mcp/server.mjs](../mcp/server.mjs) and uses the repository root as its workspace.

### Purpose

The server exposes the key FlowScrape capabilities to an external agent or MCP client:

- repository file access
- pipeline validation and code generation
- safety scans
- row rendering helpers

### How to run

From the `mcp/` folder:

```bash
npm install
npm start -- --root "c:\MY SPACE\MY LAPTOP\project works\fully automated web scraper\flowscrape-v3"
```

HTTP mode is also available for MCP clients that can connect over Streamable HTTP:

```bash
npm run start:http -- --root "c:\MY SPACE\MY LAPTOP\project works\fully automated web scraper\flowscrape-v3" --port 3000
```

The HTTP endpoint is exposed at `http://localhost:3000/mcp`.

### Workspace rules

- file paths are resolved relative to the repo root
- path traversal outside the workspace root is blocked
- files larger than about 2 MB are skipped by text search

### MCP tool catalog

#### Repository tools

- `repo_list_files`
- `repo_read_file`
- `repo_write_file`
- `repo_search_text`

#### Pipeline tools

- `pipeline_compile`
- `pipeline_validate`
- `pipeline_serialize`
- `pipeline_emit_python`
- `pipeline_emit_node`
- `pipeline_list`
- `pipeline_save`
- `pipeline_load`
- `pipeline_report`

#### Safety tools

- `pii_scan_text`
- `pii_scan_rows`
- `robots_check`

#### Formatting tools

- `rows_to_text`

### Tool-by-tool details

`repo_list_files`

- Input: `directory`, `maxDepth`
- Output: tree-like list of files and folders rooted at the workspace

`repo_read_file`

- Input: `path`, `startLine`, `endLine`
- Output: text slice with the resolved workspace-relative path

`repo_write_file`

- Input: `path`, `content`
- Output: confirmation with bytes written

`repo_search_text`

- Input: `query`, `regex`, `caseSensitive`, `include`, `maxResults`
- Output: matched lines with file path and line number

`pipeline_compile`

- Input: `recipeJson` or `recipe`
- Output: compiled AST and compile errors

`pipeline_validate`

- Input: `recipeJson` or `recipe`
- Output: compile errors, unsupported steps, warnings, and a boolean `ok`

`pipeline_serialize`

- Input: `pipelineJson` or `pipeline`
- Output: redacted JSON string

`pipeline_emit_python`

- Input: `recipeJson` or `recipe`
- Output: compile errors and Python source code when valid

`pipeline_emit_node`

- Input: `recipeJson` or `recipe`
- Output: compile errors and Node source code when valid

`pipeline_list`

- Input: `query`, `limit`
- Output: saved pipeline files with their relative paths and names

`pipeline_save`

- Input: `name`, `pipelineJson` or `pipeline`, `overwrite`
- Output: saved pipeline path and confirmation metadata

`pipeline_load`

- Input: `name`
- Output: loaded pipeline JSON from the `pipelines/` folder

`pii_scan_text`

- Input: `text`, `limit`
- Output: list of pattern matches and a summary string

`pii_scan_rows`

- Input: `rowsJson` or `rows`, `limit`
- Output: row-level findings and a summary string

`robots_check`

- Input: `origin`, `path`, `userAgent`
- Output: `allowed`, `crawlDelay`, `fetchError`

`rows_to_text`

- Input: `rowsJson`, `format`, `filename`
- Output: rendered text in the selected export format

`pipeline_report`

- Input: `recipeJson` or `recipe`
- Output: high-level summary, errors, and generated byte counts

## 10. File Layout at a Glance

```text
flowscrape-v3/
├── background/        orchestration and runtime control
├── checkpoint/        resume and persistence helpers
├── content/           page interaction and extraction
├── data-sources/      CSV and JSON parsers
├── ethics/            robots and PII guardrails
├── exporters/         row export helpers
├── icons/             extension icons
├── mcp/               standalone MCP server
├── script-gen/        pipeline compilation and code emission
├── sidepanel/         pipeline builder UI
└── utils/             shared helpers
```

## 11. Practical Usage Notes

- The extension is designed to run unpacked in Chrome.
- The MCP server is separate from the extension runtime and is intended for local agent access.
- The generated scripts redact sensitive fields by design.
- The repo already includes a minimal README; this document is the fuller technical reference.

## 12. If You Need Even More Detail

The most useful next documentation additions would be:

- a step-by-step pipeline schema reference
- a line-by-line MCP tool example gallery
- a module-by-module architecture map for `background/`, `content/`, and `sidepanel/`
