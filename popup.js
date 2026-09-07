/* Popup: read-only status view. State is written by the content script into
 * chrome.storage.local under `ttc_status`. */
function render(s) {
  const state = document.getElementById("state");
  const dot = document.getElementById("dot");
  const lines = document.getElementById("lines");
  const folder = document.getElementById("folder");
  const file = document.getElementById("file");
  if (!s) {
    state.textContent = "閒置（尚未在 Teams 分頁啟動）";
    return;
  }
  state.textContent = s.capturing ? "擷取中…" : "閒置";
  dot.className = "dot " + (s.capturing ? "rec" : "idle");
  lines.textContent = `${s.lines || 0} 行`;
  folder.textContent = s.folder || "尚未選擇";
  file.textContent = s.lastFile || "—";
}

chrome.storage.local.get("ttc_status", (r) => render(r.ttc_status));
chrome.storage.onChanged.addListener((changes) => {
  if (changes.ttc_status) render(changes.ttc_status.newValue);
});
