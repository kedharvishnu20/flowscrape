// === csv.js (exporter) ===
/**
 * @module exporters/csv
 * @description Export rows to CSV format using stream-writer for large data.
 * @dependencies stream-writer
 */
import { writeRowsChunked } from './stream-writer.js';

export async function exportCSV(rows, filename = 'export.csv') {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);

  const formatter = (chunk, isFirst) => {
    const lines = [];
    if (isFirst) lines.push(headers.map(_csvEsc).join(','));
    for (const row of chunk) {
      lines.push(headers.map(h => _csvEsc(row[h] ?? '')).join(','));
    }
    return lines.join('\r\n') + '\r\n';
  };

  await writeRowsChunked(rows, filename, 'text/csv', formatter);
}

function _csvEsc(val) {
  const str = String(val ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
// === END csv.js ===


// === json.js (exporter) ===
/**
 * @module exporters/json
 * @description Export rows to JSON array format.
 * @dependencies stream-writer
 */
export async function exportJSON(rows, filename = 'export.json') {
  if (!rows.length) return;
  const { writeRowsChunked: wrc } = await import('./stream-writer.js');
  let first = true;
  const formatter = (chunk, isFirst, isLast) => {
    let out = '';
    if (isFirst) out += '[\n';
    for (let i = 0; i < chunk.length; i++) {
      const isLastRow = isLast && i === chunk.length - 1;
      out += '  ' + JSON.stringify(chunk[i]) + (isLastRow ? '' : ',') + '\n';
    }
    if (isLast) out += ']\n';
    return out;
  };
  await wrc(rows, filename, 'application/json', formatter);
}
// === END json.js ===


// === jsonl.js (exporter) ===
/**
 * @module exporters/jsonl
 * @description Export rows to JSONL (newline-delimited JSON) format.
 * @dependencies stream-writer
 */
export async function exportJSONL(rows, filename = 'export.jsonl') {
  const { writeRowsChunked: wrc } = await import('./stream-writer.js');
  const formatter = (chunk) => chunk.map(r => JSON.stringify(r)).join('\n') + '\n';
  await wrc(rows, filename, 'application/jsonl', formatter);
}
// === END jsonl.js ===


// === tsv.js (exporter) ===
/**
 * @module exporters/tsv
 * @description Export rows to TSV (tab-separated values) format.
 * @dependencies stream-writer
 */
export async function exportTSV(rows, filename = 'export.tsv') {
  if (!rows.length) return;
  const { writeRowsChunked: wrc } = await import('./stream-writer.js');
  const headers = Object.keys(rows[0]);
  const formatter = (chunk, isFirst) => {
    const lines = [];
    if (isFirst) lines.push(headers.join('\t'));
    for (const row of chunk) {
      lines.push(headers.map(h => String(row[h] ?? '').replace(/\t/g, ' ')).join('\t'));
    }
    return lines.join('\n') + '\n';
  };
  await wrc(rows, filename, 'text/tab-separated-values', formatter);
}
// === END tsv.js ===


// === xml.js (exporter) ===
/**
 * @module exporters/xml
 * @description Export rows to XML format.
 * @dependencies stream-writer
 */
export async function exportXML(rows, filename = 'export.xml') {
  const { writeRowsChunked: wrc } = await import('./stream-writer.js');
  const escape = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const formatter = (chunk, isFirst, isLast) => {
    let out = '';
    if (isFirst) out += '<?xml version="1.0" encoding="UTF-8"?>\n<rows>\n';
    for (const row of chunk) {
      out += '  <row>\n';
      for (const [k, v] of Object.entries(row)) {
        out += `    <${k}>${escape(v)}</${k}>\n`;
      }
      out += '  </row>\n';
    }
    if (isLast) out += '</rows>\n';
    return out;
  };
  await wrc(rows, filename, 'application/xml', formatter);
}
// === END xml.js ===


// === markdown.js (exporter) ===
/**
 * @module exporters/markdown
 * @description Export rows to Markdown table format.
 * @dependencies stream-writer
 */
export async function exportMarkdown(rows, filename = 'export.md') {
  if (!rows.length) return;
  const { writeRowsChunked: wrc } = await import('./stream-writer.js');
  const headers = Object.keys(rows[0]);
  const esc = s => String(s ?? '').replace(/\|/g, '\\|');

  const formatter = (chunk, isFirst) => {
    let out = '';
    if (isFirst) {
      out += '| ' + headers.map(esc).join(' | ') + ' |\n';
      out += '| ' + headers.map(() => '---').join(' | ') + ' |\n';
    }
    for (const row of chunk) {
      out += '| ' + headers.map(h => esc(row[h] ?? '')).join(' | ') + ' |\n';
    }
    return out;
  };
  await wrc(rows, filename, 'text/markdown', formatter);
}
// === END markdown.js ===
