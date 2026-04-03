# FlowScrape v3 MCP

This folder contains a standalone Model Context Protocol server for the FlowScrape workspace.

## What it exposes

- Workspace file tools: list, read, write, and text search
- Pipeline tooling: compile, validate, serialize, and emit Python or Node scripts
- Pipeline storage: save, load, and list reusable pipeline files
- Safety checks: PII scan and robots.txt check
- Row formatting: render CSV, JSON, JSONL, TSV, XML, or Markdown

## Install

From this folder:

```bash
npm install
```

## Run

Local stdio mode:

```bash
npm start -- --root "c:\MY SPACE\MY LAPTOP\project works\fully automated web scraper\flowscrape-v3"
```

HTTP mode for broader MCP clients:

```bash
npm run start:http -- --root "c:\MY SPACE\MY LAPTOP\project works\fully automated web scraper\flowscrape-v3" --port 3000
```

If your MCP client accepts a command directly, point it at `node server.mjs` inside this folder.

If your client supports MCP over HTTP, connect it to `http://localhost:3000/mcp` after starting HTTP mode.

## Notes

- The server is rooted at the repository folder by default.
- File tools refuse paths that escape the workspace root.
- The generated scripts are based on the existing `script-gen/` modules in this repo.
- Saved pipelines live in the `pipelines/` folder and can be reloaded later.