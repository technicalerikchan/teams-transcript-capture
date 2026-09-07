/*
 * Teams Transcript Capture — content script
 * ------------------------------------------
 * Injected on the Teams web page. Responsibilities:
 *   1. Inject a floating widget (start/stop + folder button + status).
 *   2. Scrape Teams live captions from the DOM into an ordered transcript.
 *   3. On stop, build a Markdown file and write it into a user-picked folder
 *      (via the File System Access API). If that folder is inside a synced
 *      OneDrive location, OneDrive uploads it automatically.
 *
 * All File System Access calls happen on a user gesture (button click) so the
 * browser grants the required transient user activation.
 *
 * NOTE ON SELECTORS: Teams' caption DOM is undocumented and changes between
 * releases. The selectors in SEL below are best-effort with fallbacks. If
 * capture produces empty/garbled output, calibrate SEL against the live DOM
 * (see README "Calibration").
 */
(() => {
  "use strict";
  if (window.__ttcLoaded) return; // avoid double-injection on SPA re-nav
  window.__ttcLoaded = true;

  const log = (...a) => console.log("[TTC]", ...a);

  // ---------------------------------------------------------------------------
  // Caption selectors (calibrate against live Teams DOM if needed)
  // ---------------------------------------------------------------------------
  const SEL = {
    // The wrapper element that contains the live-caption lines.
    container: [
      '[data-tid="closed-caption-renderer-wrapper"]',
      '[data-tid="closed-captions-renderer"]',
      '[data-tid="closed-caption-v2-window-wrapper"]',
      '[class*="closedCaption"]',
      '[class*="closed-caption"]',
    ],
    // A single caption line within the container.
    line: [
      '.fui-ChatMessageCompact',
      '[data-tid="closed-caption-message"]',
      '.ui-chat__item',
      '[class*="captionMessage"]',
      'div[role="listitem"]',
    ],
    // Speaker name inside a caption line.
    speaker: [
      '[data-tid="author"]',
      '.ui-chat__message__author',
      '[class*="authorName"]',
      '[class*="author"]',
    ],
    // Spoken text inside a caption line.
    text: [
      '[data-tid="closed-caption-text"]',
      '.ui-chat__message__content',
      '[class*="captionText"]',
      '[class*="messageContent"]',
    ],
  };

  const pickOne = (root, sels) => {
    for (const s of sels) {
      try { const el = root.querySelector(s); if (el) return el; } catch (_) {}
    }
    return null;
  };
  const pickAll = (root, sels) => {
    for (const s of sels) {
      try { const els = root.querySelectorAll(s); if (els.length) return Array.from(els); } catch (_) {}
    }
    return [];
  };
  const findContainer = () => pickOne(document, SEL.container);

  // ---------------------------------------------------------------------------
  // IndexedDB: persist the picked directory handle across page loads
  // ---------------------------------------------------------------------------
  const DB_NAME = "ttc-db";
  const STORE = "handles";
  const openDB = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const idbGet = async (k) => {
    const db = await openDB();
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, "readonly").objectStore(STORE).get(k);
      t.onsuccess = () => res(t.result);
      t.onerror = () => rej(t.error);
    });
  };
  const idbSet = async (k, v) => {
    const db = await openDB();
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, "readwrite").objectStore(STORE).put(v, k);
      t.onsuccess = () => res();
      t.onerror = () => rej(t.error);
    });
  };

  // ---------------------------------------------------------------------------
  // Folder handle helpers (File System Access API)
  // ---------------------------------------------------------------------------
  let folderHandle = null;

  const fsaSupported = () => typeof window.showDirectoryPicker === "function";

  /** Ensure we have a directory handle with readwrite permission.
   *  MUST be called from within a user gesture. */
  async function ensureFolder(forcePick) {
    let handle = forcePick ? null : (folderHandle || (await idbGet("dir")));
    if (!handle) {
      handle = await window.showDirectoryPicker({ mode: "readwrite", startIn: "documents" });
      await idbSet("dir", handle);
    }
    // Verify / request permission (needs the current user gesture).
    let perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") {
      perm = await handle.requestPermission({ mode: "readwrite" });
      if (perm !== "granted") throw new Error("資料夾寫入權限被拒");
    }
    folderHandle = handle;
    await idbSet("dir", handle);
    return handle;
  }

  async function writeFile(handle, name, content) {
    const fh = await handle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(content);
    await w.close();
  }

  /** Fallback if FSA fails: download via a blob link (lands in Downloads). */
  function downloadFallback(name, content) {
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ---------------------------------------------------------------------------
  // Capture engine
  // ---------------------------------------------------------------------------
  let capturing = false;
  let observer = null;
  let pollTimer = null;
  let containerEl = null;
  let startTime = null;
  let orderCounter = 0;
  const entries = new Map(); // ttId -> { speaker, text, order, tsMs }

  const scan = () => {
    if (!capturing || !containerEl || !document.contains(containerEl)) return;
    const lines = pickAll(containerEl, SEL.line);
    // Fallback: if no line matched, treat direct children as lines.
    const nodes = lines.length ? lines : Array.from(containerEl.children);
    const now = Date.now();
    for (const node of nodes) {
      if (!node.dataset) continue;
      if (!node.dataset.ttcId) node.dataset.ttcId = String(++orderCounter) + "-" + Math.random().toString(36).slice(2, 6);
      const id = node.dataset.ttcId;
      const spEl = pickOne(node, SEL.speaker);
      const txEl = pickOne(node, SEL.text);
      const speaker = spEl ? spEl.textContent.trim() : "";
      let text = txEl ? txEl.textContent.trim() : node.textContent.trim();
      if (!txEl && speaker && text.startsWith(speaker)) text = text.slice(speaker.length).trim();
      if (!text) continue;
      const existing = entries.get(id);
      if (!existing) {
        entries.set(id, { speaker, text, order: ++orderCounter, tsMs: now });
      } else if (existing.speaker && speaker && existing.speaker !== speaker) {
        // Virtual-list recycled this node for a new speaker: freeze the old
        // entry under a synthetic key, then start a fresh one.
        entries.set("frozen-" + id + "-" + existing.order, { ...existing });
        entries.set(id, { speaker, text, order: ++orderCounter, tsMs: now });
      } else {
        // Caption line grows / corrects in place — keep the latest text.
        existing.speaker = speaker || existing.speaker;
        existing.text = text;
      }
    }
    updateStatus();
  };

  function attachObserver() {
    const bind = () => {
      containerEl = findContainer();
      if (containerEl) {
        if (observer) observer.disconnect();
        observer = new MutationObserver(() => scan());
        observer.observe(containerEl, { childList: true, subtree: true, characterData: true });
        scan();
        return true;
      }
      return false;
    };
    bind();
    pollTimer = setInterval(() => {
      if (!capturing) return;
      if (!containerEl || !document.contains(containerEl)) bind();
      else scan();
    }, 1000);
  }

  function detachObserver() {
    if (observer) { observer.disconnect(); observer = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ---------------------------------------------------------------------------
  // Output building
  // ---------------------------------------------------------------------------
  const two = (n) => String(n).padStart(2, "0");
  const clock = (ms) => {
    const d = new Date(ms);
    return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  };

  function getMeetingTitle() {
    // Try a few likely places; fall back to document.title.
    const sels = ['[data-tid="call-title"]', '[data-tid="calling-participant-stream-title"]', 'h1', 'header [role="heading"]'];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    const t = (document.title || "").replace(/\s*[\|·-]\s*Microsoft Teams.*$/i, "").trim();
    return t || "";
  }

  function sanitize(name) {
    return name.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 80);
  }

  function buildFilename() {
    const d = new Date(startTime || Date.now());
    const date = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
    const hm = `${two(d.getHours())}${two(d.getMinutes())}`;
    const title = sanitize(getMeetingTitle());
    const base = title ? `${title}_${date}_${hm}` : `TeamsTranscript_${date}_${hm}`;
    return `${base}.md`;
  }

  function buildMarkdown() {
    const list = Array.from(entries.values()).sort((a, b) => a.order - b.order);
    const out = [];
    let last = "";
    for (const e of list) {
      const sig = e.speaker + "|" + e.text;
      if (sig === last) continue; // drop consecutive duplicates
      last = sig;
      const who = e.speaker ? `${e.speaker}：` : "";
      out.push(`[${clock(e.tsMs)}] ${who}${e.text}`);
    }
    const started = startTime ? new Date(startTime) : new Date();
    const header =
      `# Teams Transcript\n\n` +
      `- 會議：${getMeetingTitle() || "(未偵測到標題)"}\n` +
      `- 日期：${started.toLocaleDateString()}\n` +
      `- 擷取開始：${clock(startTime || Date.now())}\n` +
      `- 擷取結束：${clock(Date.now())}\n` +
      `- 對話行數：${out.length}\n\n` +
      `---\n\n`;
    return header + out.join("\n") + "\n";
  }

  // ---------------------------------------------------------------------------
  // Start / stop
  // ---------------------------------------------------------------------------
  async function start() {
    if (!fsaSupported()) {
      toast("此瀏覽器不支援 File System Access API，請用桌面版 Chrome。");
      return;
    }
    try {
      await ensureFolder(false); // uses this click's user activation
    } catch (e) {
      toast("需要先選擇 OneDrive 資料夾：" + (e.message || e));
      return;
    }
    entries.clear();
    orderCounter = 0;
    startTime = Date.now();
    capturing = true;
    attachObserver();
    if (!containerEl) toast("已開始，但尚未偵測到字幕。請在 Teams 開啟 live captions。");
    else toast("已開始擷取字幕。");
    renderUI();
    updateStatus();
  }

  async function stop() {
    capturing = false;
    detachObserver();
    scan(); // final flush of anything still in the DOM
    const md = buildMarkdown();
    const name = buildFilename();
    let saved = false;
    try {
      const handle = await ensureFolder(false); // permission on this gesture
      await writeFile(handle, name, md);
      saved = true;
      toast(`已存檔：${name}（OneDrive 將自動同步）`);
    } catch (e) {
      log("write failed, falling back to download", e);
      downloadFallback(name, md);
      toast(`寫入資料夾失敗，已改用下載：${e.message || e}`);
    }
    lastFile = name;
    renderUI();
    updateStatus(saved);
  }

  async function pickFolder() {
    try {
      const h = await ensureFolder(true);
      toast(`已選擇資料夾：${h.name}`);
      updateStatus();
    } catch (e) {
      toast("選擇資料夾取消或失敗：" + (e.message || e));
    }
  }

  // ---------------------------------------------------------------------------
  // Status shared with the popup via chrome.storage.local
  // ---------------------------------------------------------------------------
  let lastFile = "";
  function updateStatus(savedOk) {
    try {
      chrome.storage?.local.set({
        ttc_status: {
          capturing,
          lines: entries.size,
          folder: folderHandle ? folderHandle.name : "",
          lastFile,
          savedOk: !!savedOk,
          updatedAt: Date.now(),
        },
      });
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Floating UI
  // ---------------------------------------------------------------------------
  let ui = null;
  function injectUI() {
    if (document.getElementById("ttc-widget")) return;
    const style = document.createElement("style");
    style.textContent = `
      #ttc-widget{position:fixed;right:16px;bottom:16px;z-index:2147483647;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        background:#1f1f1f;color:#fff;border-radius:10px;padding:8px 10px;
        box-shadow:0 4px 16px rgba(0,0,0,.35);display:flex;align-items:center;gap:8px;
        font-size:13px;user-select:none}
      #ttc-widget button{cursor:pointer;border:0;border-radius:6px;padding:6px 10px;
        font-size:13px;font-weight:600;color:#fff;background:#3a3a3a}
      #ttc-widget button:hover{filter:brightness(1.15)}
      #ttc-toggle.rec{background:#c62828}
      #ttc-toggle.idle{background:#2e7d32}
      #ttc-folder{background:#3a3a3a}
      #ttc-count{opacity:.85;min-width:44px;text-align:right}
      #ttc-toast{position:fixed;right:16px;bottom:64px;z-index:2147483647;max-width:320px;
        background:#000;color:#fff;padding:8px 12px;border-radius:8px;font-size:12px;
        box-shadow:0 4px 16px rgba(0,0,0,.4);opacity:0;transition:opacity .2s}
    `;
    document.documentElement.appendChild(style);

    ui = document.createElement("div");
    ui.id = "ttc-widget";
    ui.innerHTML = `
      <button id="ttc-toggle" class="idle">● 開始擷取</button>
      <span id="ttc-count">0 行</span>
      <button id="ttc-folder" title="選擇 / 變更 OneDrive 資料夾">📁</button>
    `;
    document.body.appendChild(ui);
    ui.querySelector("#ttc-toggle").addEventListener("click", () => (capturing ? stop() : start()));
    ui.querySelector("#ttc-folder").addEventListener("click", () => pickFolder());
    renderUI();
  }

  function renderUI() {
    if (!ui) return;
    const btn = ui.querySelector("#ttc-toggle");
    const cnt = ui.querySelector("#ttc-count");
    if (capturing) {
      btn.textContent = "■ 停止並存檔";
      btn.className = "rec";
    } else {
      btn.textContent = "● 開始擷取";
      btn.className = "idle";
    }
    cnt.textContent = `${entries.size} 行`;
  }

  let toastTimer = null;
  function toast(msg) {
    let t = document.getElementById("ttc-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "ttc-toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.style.opacity = "0"), 4000);
    log(msg);
  }

  // Keep the counter fresh in the UI while capturing.
  setInterval(renderUI, 1000);

  // Popup can ask the content script to (re)pick a folder or read status.
  try {
    chrome.runtime?.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === "ttc-pick-folder") { pickFolder(); sendResponse({ ok: true }); }
      if (msg?.type === "ttc-get-status") {
        sendResponse({ capturing, lines: entries.size, folder: folderHandle ? folderHandle.name : "", lastFile });
      }
      return true;
    });
  } catch (_) {}

  // Restore a previously-picked folder name for display (no permission prompt here).
  idbGet("dir").then((h) => { if (h) { folderHandle = h; updateStatus(); } }).catch(() => {});

  // Inject the widget once the page body exists.
  const boot = () => { if (document.body) injectUI(); else setTimeout(boot, 500); };
  boot();
  log("content script loaded");
})();
