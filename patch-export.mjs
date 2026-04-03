import fs from "fs";

const TARGET =
  "c:/MY SPACE/MY LAPTOP/project works/fully automated web scraper/flowscrape-v3/background/service-worker.js";
let content = fs.readFileSync(TARGET, "utf-8");

// Replace the if (screenshots.length > 0) with a condition that checks networks too
const exportOriginal = `
  if (screenshots.length > 0) {
    // Bundle everything into a ZIP
    const zipFiles = [];
    if (allRows.length > 0) {
      zipFiles.push({
        name: \`data.\${dataExt}\`,
        bytes: enc.encode("\\uFEFF" + dataContent),
      });
    }
    screenshots.forEach((s, i) => {
      zipFiles.push({
        name: \`screenshot_\${i + 1}_\${s.ts}.png\`,
        bytes: _dataUrlToBytes(s.dataUrl),
      });
    });
    const zipBytes = _buildZip(zipFiles);
    const blob = new Blob([zipBytes], { type: "application/zip" });
    const zipUrl = URL.createObjectURL(blob);
    await chrome.downloads.download({
      url: zipUrl,
      filename: \`flowscrape_export_\${ts}.zip\`,
      saveAs: false,
    });
    _broadcastLog(
      "info-log",
      \`Exported ZIP: \${allRows.length} rows + \${screenshots.length} screenshots.\`, runId
    );
  } else if (allRows.length > 0) {`;

const exportNew = `
  const networks = runState.networks || [];
  if (screenshots.length > 0 || networks.length > 0) {
    // Bundle everything into a ZIP
    const zipFiles = [];
    if (allRows.length > 0) {
      zipFiles.push({
        name: \`data.\${dataExt}\`,
        bytes: enc.encode("\\uFEFF" + dataContent),
      });
    }
    screenshots.forEach((s, i) => {
      zipFiles.push({
        name: \`screenshot_\${i + 1}_\${s.ts}.png\`,
        bytes: _dataUrlToBytes(s.dataUrl),
      });
    });
    
    if (networks.length > 0) {
      const netHeaders = ["timestamp", "method", "url", "status", "type", "requestBody", "responseBody"];
      let netContent = "";
      if (fmt === "json" || fmt === "jsonl") {
          netContent = JSON.stringify(networks, null, 2);
          zipFiles.push({
              name: \`api-sniffer.json\`,
              bytes: enc.encode(netContent)
          });
      } else {
          netContent = netHeaders.join(",") + "\\n" +
            networks.map(n => netHeaders.map(h => \`"\${String(n[h] || "").replace(/"/g, '""')}"\`).join(",")).join("\\n");
          zipFiles.push({
              name: \`api-sniffer.csv\`,
              bytes: enc.encode("\\uFEFF" + netContent)
          });
      }
    }

    const zipBytes = _buildZip(zipFiles);
    const blob = new Blob([zipBytes], { type: "application/zip" });
    const zipUrl = URL.createObjectURL(blob);
    await chrome.downloads.download({
      url: zipUrl,
      filename: \`flowscrape_export_\${ts}.zip\`,
      saveAs: false,
    });
    _broadcastLog(
      "info-log",
      \`Exported ZIP: \${allRows.length} rows, \${screenshots.length} screens, \${networks.length} APIs.\`, runId
    );
  } else if (allRows.length > 0) {`;

content = content.replace(exportOriginal, exportNew);
fs.writeFileSync(TARGET, content);
console.log("Export patched.");
