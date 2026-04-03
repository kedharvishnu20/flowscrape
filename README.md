# FlowScrape v3

> Production-grade Chrome Extension for web automation and data extraction.
> Manifest Version 3 · Chrome 120+ · ES2022 · No bundler required.

---

## 🚀 Quick Start (under 5 minutes)

1. **Clone / download** this folder
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer mode** (top-right)
4. Click **Load unpacked** → select the `flowscrape-v3/` folder
5. Click the FlowScrape icon in the toolbar → side panel opens

No `npm install`. No build step. No webpack. Pure ES modules with `type: "module"` in the service worker.

---

## 📁 Project Structure

```
flowscrape-v3/
├── manifest.json              MV3 manifest
├── icons/                     Extension icons (add your 16/32/48/128 PNGs)
│
├── background/                Service Worker context
│   ├── service-worker.js      Pipeline orchestrator + message bus
│   ├── proxy-manager.js       Proxy pool: parse · test · rotate · apply
│   ├── api-key-manager.js     AES-GCM key store · captcha dispatch
│   ├── rate-limiter.js        Token bucket + exponential backoff
│   └── ethics-engine.js       6-gate pre-run ethics orchestrator
│
├── content/                   Content script context
│   ├── injector.js            Shadow DOM host · step dispatcher
│   ├── form-filler.js         8 input handlers · React fiber hack
│   ├── field-auto-mapper.js   Levenshtein + Jaccard auto-mapper
│   ├── captcha-detector.js    reCAPTCHA v2/v3 · hCaptcha · Turnstile
│   └── smart-sleep.js         3-tier adaptive wait
│
├── sidepanel/
│   ├── index.html             Premium dark UI · 5 tabs
│   └── pipeline-builder.js   Tab controller · run control · forms
│
├── ethics/
│   ├── robots-parser.js       RFC 9309 compliant parser
│   └── pii-detector.js        SSN · CC · email · phone scanner
│
├── checkpoint/
│   ├── cursor-store.js        IDB cursor read/write
│   ├── row-buffer.js          Ring buffer · flush every 50 rows/30s
│   └── resume-manager.js      Incomplete run detection
│
├── data-sources/
│   ├── csv-parser.js          Streaming · BOM-safe · auto-delimiter
│   └── json-parser.js         Streaming JSON array + JSONL
│
├── exporters/
│   ├── text-exporters.js      CSV · JSON · JSONL · TSV · XML · Markdown
│   └── stream-writer.js       FSA API · Blob fallback · chunked writes
│
├── script-gen/
│   ├── pipeline-compiler.js   Pipeline JSON → AST
│   ├── python-emitter.js      AST → Python 3.11 (playwright)
│   └── node-emitter.js        AST → Node 20 (playwright + axios)
│
└── utils/
    ├── logger.js              Structured levelled logger (never logs secrets)
    ├── strings.js             All UI strings (i18n-ready)
    ├── levenshtein.js         Levenshtein + Jaccard similarity
    └── deduplicator.js        djb2 row dedup
```

---

## 🔐 Security Model

| Storage Tier | What Goes Here |
|--------------|---------------|
| `chrome.storage.session` | Proxy credentials (user/pass) · API key ciphertexts |
| `chrome.storage.local` | Proxy pool metadata (no creds) · recipes · settings |
| `IndexedDB` | Data rows · cursors · row buffers |
| **Module scope only** | AES-GCM session encryption key (never persisted) |

**Key facts:**
- API keys encrypted with AES-GCM 256-bit before any storage
- Session key is `crypto.subtle.generateKey()` — never extractable
- Proxy credentials auto-purged by Chrome on browser close
- Logger never logs secrets, keys, passwords, or PII values

---

## 🌐 Proxy Pool

**Supported input formats:**
```
203.0.113.5:8080
203.0.113.5:8080:user:pass
socks5://203.0.113.5:1080
http://user:pass@203.0.113.5:3128
[{"host":"…","port":8080,"user":"u","pass":"p","type":"http"}]
CSV with header: host,port,username,password,type
```

**Rotation modes:** Round-Robin · Random · Sticky (per-domain) · Geo-Target

**Health check:** `https://httpbin.org/ip` HEAD request, 5s timeout. Async, never blocks pipeline.

---

## 📋 Form Fill Ethics Constraints (Hard Blocks)

These are enforced in JavaScript, not just the UI:

| Block | Trigger |
|-------|---------|
| `EthicsBlock.PasswordField` | Any `input[type=password]` in field mapping |
| `EthicsBlock.HiddenField` | Any `input[type=hidden]` in field mapping |
| `EthicsBlock.SubmitCapExceeded` | Rows > 5000 (500 without explicit confirm) |
| `EthicsBlock.DelayFloor` | Inter-row delay < 800ms |
| `EthicsBlock.DomainMismatch` | Submit target ≠ pipeline's declared origin |

---

## 🚦 Ethics Gates (Pre-Run, All 6)

```
Gate 1: robots.txt    → warn if Disallow found
Gate 2: PII scan      → warn if SSN/CC/email/phone in data file
Gate 3: Rate limit    → warn if > 100 req/hr estimated
Gate 4: Captcha       → warn if > 50 solves/hr estimated
Gate 5: Proxy geo     → warn if proxy region ≠ declared region (> 5000km)
Gate 6: Domain lock   → BLOCK if any step URL ≠ declared targetOrigin
```

---

## 🔑 Supported API Providers

**Captcha:** 2captcha · Anti-Captcha · CapSolver · DeathByCaptcha · NoCaptchaAI

**Enrichment:** Hunter.io · Clearbit · Abstract API · IPinfo · OpenAI · Claude (Anthropic)

**Notifications:** Slack · Discord · Telegram · SMTP

---

## 📤 Export Formats

CSV · JSON · JSONL · TSV · XML · Markdown

All exported via chunked stream-writer (1000 rows/chunk) — no OOM on 10k+ rows.

---

## 🖥 Script Export

The pipeline can be exported as a runnable script:

- **Python 3.11** — `playwright` + `requests`
- **Node 20** — `playwright` + `csv-parse`

Credentials are **always redacted** in exported scripts — replaced with `os.environ.get(...)` references.

---

## ⚡ Performance Targets

| Metric | Target |
|--------|--------|
| `injector.js` size | < 40 KB |
| Data parsers | Stream chunks; never full-file RAM load |
| Row buffer flush | Every 50 rows or 30s |
| Deduplicator | In-flight, djb2 hash |

---

## 🔧 Adding Your Icons

The manifest references `icons/icon{16,32,48,128}.png`. Add these to the `icons/` folder. You can use any tool to generate them (e.g., GIMP, Inkscape, or an online favicon generator).

---

## 📄 License

MIT — See LICENSE file.

*FlowScrape v3 · Built complete or not at all.*

## 🤖 MCP Server

The repository now includes a standalone MCP server under [`mcp/`](mcp/). It exposes workspace file tools, pipeline compilation and emission, PII/robots checks, and row-formatting helpers for use from an MCP client.

For the full point-by-point reference, see [docs/flowscrape-reference.md](docs/flowscrape-reference.md).

For full end-to-end activity documentation with state variables, message flow, and module-level behavior, see [docs/flowscrape-e2e-activity-manual.md](docs/flowscrape-e2e-activity-manual.md).

The MCP server also supports HTTP mode for clients that cannot spawn local processes, and it can save reusable pipeline definitions into the `pipelines/` folder.
