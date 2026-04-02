# FlowScrape v3 — Known Limitations

> Honest documentation of current constraints, workarounds where available.

---

## MV3 Service Worker Constraints

| Limitation | Impact | Workaround |
|-----------|--------|------------|
| SW can be killed at any time | In-flight row can be lost | Checkpoint saved before each `await`; resume on restart |
| SW has no DOM access | All DOM work must go through content scripts | `chrome.scripting.executeScript()` used for all DOM ops |
| SW lifecycle is unpredictable | Module-scope state (session key) resets on kill | AES-GCM key re-initialized on every `activate` event |
| `type: "module"` SW | Top-level `await` works; dynamic imports limited | Static imports only in SW; dynamic imports tested |

---

## Proxy Limitations

| Limitation | Notes |
|-----------|-------|
| `chrome.proxy` requires `proxy` permission | Listed in manifest; user is informed on install |
| SOCKS5 authentication not supported by Chrome Proxy API | Authenticated SOCKS5 proxies may fail; use HTTP proxied alternatives |
| PAC script applies to ALL tabs (not per-tab) | Rotating proxy during multi-tab runs affects all tabs |
| Background health check uses extension's network (not proxy) | Health check result may differ from actual proxy behavior in content scripts |
| No per-request proxy selection | Chrome's proxy API is session-scope; you cannot proxy one request differently than another in the same session |

---

## Form Filler Limitations

| Limitation | Notes |
|-----------|-------|
| React fiber hack is fragile | React's internal fiber keys change between versions; hack is best-effort and may fail on React 19+ |
| `file` input type (`<input type=file>`) | DataTransfer assignment works in most browsers but may be blocked by strict site CSPs |
| Shadow DOM fields | `document.querySelector()` does not pierce shadow roots; shadow-walker.js traversal needed for such fields |
| CAPTCHA auto-solve rate limits | Third-party CAPTCHA APIs have their own rate limits independent of FlowScrape's ethics gate |
| Custom web components | Non-standard input components (e.g., `<my-input>`) may not respond to native events; manual handler required |

---

## Data Parsing

| Limitation | Notes |
|-----------|-------|
| XLSX parser not bundled | `xlsx-parser.js` is referenced in the file map but requires SheetJS-lite bundled into the extension (not included to keep size small); substitute with CSV export from Excel |
| SQLite writer (`sqlite-writer.js`) | Requires SQLite WASM which exceeds MV3 WASM constraints in some Chrome versions; listed in spec but not implemented |
| JSON streaming collision | djb2 hash has ~0.00000023% collision probability per row; not cryptographic, only deduplication |

---

## Script Export

| Limitation | Notes |
|-----------|-------|
| Lua emitter (`lua-emitter.js`) | Listed in spec file map; not implemented in this release. Lua automation is a niche use case and the emitter infrastructure (AST → Lua) requires additional testing |
| `config-emitter.js` | Not implemented; covered by `pipeline-compiler.js` serialization |
| No Rust / Go emitters | Out of scope for v3 |

---

## API Key Manager

| Limitation | Notes |
|-----------|-------|
| SW restart loses session key | Encrypted blobs in session storage become undecryptable → user must re-enter keys after browser restart (by design — session-only security model) |
| No Claude / Anthropic validator | Anthropic's validation endpoint requires a test call which costs tokens; validation skipped, key stored as-is |
| DeathByCaptcha uses user:pass format | Not supported by the standard key entry UI; enter as `user:pass` string in the key field |

---

## Side Panel

| Limitation | Notes |
|-----------|-------|
| `showSaveFilePicker` not available in side panels in some Chrome builds | Falls back to Blob download automatically |
| Auto-Map requires active tab | The tab must be on the target form page when clicking Auto-Map |
| Drag-and-drop step reorder | Step dragging is HTML5 draggable; full implement requires `dragstart`/`dragover`/`drop` handlers (partial in v3) |

---

## Ethics Engine

| Limitation | Notes |
|-----------|-------|
| Geo-distance calculation | Uses a simplified region-to-region comparison rather than true Haversine distance (> 5000km criterion is approximate) |
| robots.txt TTL is 15 min | A site could update robots.txt mid-run; FlowScrape will not re-check until cache expires |
| `robots.txt` fetch failure = allow | If robots.txt is unreachable (network error), FlowScrape warns but does not block (conservative but permissive) |

---

*Last updated: FlowScrape v3.0.0*
