/*
 * Teams Transcript Capture — content script (v0.2.1)
 * ---------------------------------------------------
 * v0.2.1 fixes from the first AUTO test (user report: widget showed 0 lines
 * while captions were visibly streaming; no save, no Copilot tab):
 *   1. Captions likely render in an IFRAME (or Shadow DOM). The widget frame
 *      now also scrapes iframes (same-origin only) and all frames forward
 *      found lines to the background worker, which aggregates them in
 *      chrome.storage. Any frame that reaches "meeting end" can flush them.
 *   2. Container/roster lookups pierce open shadow roots.
 *   3. Pending writes survive navigation: they are handed to the background
 *      worker (chrome.storage) and auto-flushed on the next Teams page load.
 *   4. New 🔍 button dumps a DOM diagnostic (frames, shadow roots, selectors
 *      found, line counts) to the console and clipboard for calibration.
 *   5. Widget shows which frame found captions; folder authorize reminder
 *      fires as soon as a meeting is detected (not only at save time).
 */
(() => {
  "use strict";
  if (window.__ttcLoaded) return; // avoid double-injection on SPA re-nav
  window.__ttcLoaded = true;

  const log = (...a) => console.log("[TTC]", ...a);

  // ---------------------------------------------------------------------------
  // Selectors (calibrate against live Teams DOM if needed)
  // ---------------------------------------------------------------------------
  const SEL = {
    container: [
      '[data-tid="closed-caption-renderer-wrapper"]',
      '[data-tid="closed-captions-renderer"]',
      '[data-tid="closed-caption-v2-window-wrapper"]',
      '[class*="closedCaption"]',
      '[class*="closed-caption"]',
    ],
    line: [
      '.fui-ChatMessageCompact',
      '[data-tid="closed-caption-message"]',
      '.ui-chat__item',
      '[class*="captionMessage"]',
      'div[role="listitem"]',
    ],
    speaker: [
      '[data-tid="author"]',
      '.ui-chat__message__author',
      '[class*="authorName"]',
      '[class*="author"]',
    ],
    text: [
      '[data-tid="closed-caption-text"]',
      '.ui-chat__message__content',
      '[class*="captionText"]',
      '[class*="messageContent"]',
    ],
    meetTitle: [
      '[data-tid="call-title"]',
      '[data-tid="calling-participant-stream-title"]',
      // Teams 2.0 (v2): title is a plain h1 inside the meeting stage header.
      '[data-tid="meeting-title"]',
      '[role="heading"][data-tid]',
      'h1',
    ],
    meetControl: [
      '#hangup-button',
      '[data-tid="hangup-button"]',
      '[data-tid="call-controls"]',
      // Teams 2.0: control bar container classes.
      '[class*="callControl" i]',
      '[class*="controlbar" i]',
      'button[data-tid*="hangup" i]',
      'button[aria-label*="leave" i]',
      'button[aria-label*="掛斷" i]',
    ],
    captionsBtn: [
      '[data-tid="closed-caption-button"]',
      '[data-tid="closed-captions-button"]',
      '[data-tid="closed-caption-toggle"]',
      'button[data-tid*="caption" i]',
      'button[aria-label*="caption" i]',
      'button[aria-label*="字幕"]',
    ],
    rosterBtn: [
      '[data-tid="roster-button"]',
      '[data-tid="people-button"]',
      'button[aria-label*="People" i]',
      'button[aria-label*="人員"]',
    ],
    rosterPanel: [
      '[data-tid="roster-panel"]',
      '[class*="roster-panel"]',
      '[class*="rosterList"]',
    ],
    rosterItem: [
      '[data-tid="roster-participant"]',
      '[data-tid="participant-item"]',
      '[role="listitem"]',
    ],
  };

  // DOM helpers that pierce open shadow roots (composed traversal).
  const deepQueryAll = (root, sel) => {
    try {
      const out = [];
      const walk = (node) => {
        if (!node) return;
        if (node.querySelectorAll) {
          for (const el of node.querySelectorAll(sel)) out.push(el);
        }
        // Recurse into shadow roots of custom/host elements.
        for (const child of node.children || []) {
          if (child.shadowRoot) walk(child.shadowRoot);
          walk(child);
        }
        if (node.shadowRoot) walk(node.shadowRoot);
      };
      walk(root);
      return out;
    } catch (_) { return []; }
  };
  const deepQueryOne = (root, sel) => {
    const all = deepQueryAll(root, sel);
    return all.length ? all[0] : null;
  };

  const pickOne = (root, sels) => {
    for (const s of sels) {
      try { const el = deepQueryOne(root, s); if (el) return el; } catch (_) {}
    }
    return null;
  };
  const pickAll = (root, sels) => {
    for (const s of sels) {
      try { const els = deepQueryAll(root, s); if (els.length) return Array.from(els); } catch (_) {}
    }
    return [];
  };
  const findContainer = () => pickOne(document, SEL.container);

  // ---------------------------------------------------------------------------
  // Same-origin iframe registry: scan caption containers inside iframes too.
  // ---------------------------------------------------------------------------
  const frameScan = () => {
    for (const f of Array.from(document.querySelectorAll("iframe"))) {
      try {
        const doc = f.contentDocument;
        if (!doc) continue;
        const c = pickOne(doc, SEL.container);
        if (c && !frameContainers.includes(c)) frameContainers.push(c);
      } catch (_) { /* cross-origin frame: the same content script runs there
                       and reports via the background aggregate instead. */ }
    }
  };
  const frameContainers = []; // same-origin caption containers found in iframes

  // ---------------------------------------------------------------------------
  // IndexedDB: persist folder handles per tenant + settings
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
  // Folder handles (File System Access API), one per tenant
  // ---------------------------------------------------------------------------
  const handles = new Map(); // tenantKey -> FileSystemDirectoryHandle
  let copilotUrl = "https://m365.cloud.microsoft/chat";

  const fsaSupported = () => typeof window.showDirectoryPicker === "function";

  const storeKeyFor = (tenantKey) => "dir:" + tenantKey;

  async function ensureFolderFor(tenantKey, forcePick) {
    let handle = forcePick ? null : handles.get(tenantKey);
    if (!handle) {
      const legacy = !forcePick && (await idbGet("dir")); // v0.1 single-folder migration
      if (legacy && (await legacy.queryPermission({ mode: "readwrite" })) === "granted") {
        handle = legacy;
      } else {
        handle = await window.showDirectoryPicker({ mode: "readwrite", startIn: "documents" });
      }
    }
    let perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") {
      perm = await handle.requestPermission({ mode: "readwrite" });
      if (perm !== "granted") throw new Error("資料夾寫入權限被拒");
    }
    handles.set(tenantKey, handle);
    await idbSet(storeKeyFor(tenantKey), handle);
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
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ---------------------------------------------------------------------------
  // Tenant detection
  // ---------------------------------------------------------------------------
  let tenantEmail = "";
  const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const SELF_MARKERS = ["(你)", "(You)", "(來賓)", "(Guest)"];

  function detectTenant() {
    for (const el of deepQueryAll(document, 'button[aria-label], [role="button"][aria-label]')) {
      const m = (el.getAttribute("aria-label") || "").match(EMAIL_RE);
      if (m) { tenantEmail = m[0]; break; }
    }
    if (!tenantEmail) {
      try {
        for (let i = 0; i < localStorage.length && i < 500; i++) {
          const k = localStorage.key(i);
          const v = String(localStorage.getItem(k) || "");
          const m = v.match(EMAIL_RE);
          if (m && v.length < 4000) { tenantEmail = m[0]; break; }
        }
      } catch (_) {}
    }
    if (tenantEmail) log("tenant:", tenantEmail);
    return tenantKeyNow();
  }
  const tenantKeyNow = () => (tenantEmail ? tenantEmail.split("@")[1].toLowerCase() : "default");

  // ---------------------------------------------------------------------------
  // Meeting detection + AUTO mode
  // ---------------------------------------------------------------------------
  let autoMode = true;
  let inMeeting = false;
  let meetVotes = 0;
  let captionsTried = 0;
  let rosterOpened = false;
  let folderReminded = false;
  let autoRetryCooldown = 0;
  /** In-meeting signal: Teams 2.0 often has no call-title, so the gate is
   *  "caption area OR control bar present" — title is only used for naming. */
  const isInMeetingRaw = () =>
    !!pickOne(document, SEL.container) ||
    !!pickOne(document, SEL.meetControl);
  async function tryEnableCaptions() {
    if (findContainer() || frameContainers.length) return true;
    if (captionsTried >= 3) return false;
    const btn = pickOne(document, SEL.captionsBtn);
    if (!btn) return false;
    if (btn.getAttribute("aria-pressed") === "true") return true;
    btn.click();
    captionsTried++;
    log("clicked captions toggle", btn.getAttribute("data-tid") || btn.getAttribute("aria-label"));
    return true;
  }

  function tryOpenRoster() {
    if (rosterOpened) return;
    const btn = pickOne(document, SEL.rosterBtn);
    if (btn) { btn.click(); rosterOpened = true; log("opened roster"); }
  }

  // ---------------------------------------------------------------------------
  // Capture engine (this frame) + forwarding to background aggregate
  // ---------------------------------------------------------------------------
  let capturing = false;
  let observer = null;
  let pollTimer = null;
  let containerEl = null;
  let startTime = null;
  let orderCounter = 0;
  const entries = new Map();  // this frame's own lines
  const participants = new Set();
  let meetingTitle = "";
  let frameLineSeq = 0;
  let isTop = window.top === window;
  let bgLineCount = 0; // lines accepted by background (reported from flush)

  /** Forward new/updated caption lines to the background worker. Called
   *  periodically; sends only this frame's entries delta. */
  let lastForwarded = 0;
  async function forwardLines(force) {
    if (isTop) return; // top frame keeps its own entries too; forwarding is for child frames
    const all = Array.from(entries.values()).sort((a, b) => a.order - b.order);
    if (!force && all.length - lastForwarded < 1) return;
    const batch = all.slice(lastForwarded).map((e) => ({ tsMs: e.tsMs, speaker: e.speaker, text: e.text }));
    if (!batch.length) return;
    lastForwarded = all.length;
    try {
      const r = await chrome.runtime.sendMessage({ type: "ttc-line-batch", lines: batch });
      if (r?.ok) bgLineCount += batch.length;
    } catch (e) { log("forward failed", e); }
  }

  /** Scrape one container's DOM subtree into `entries`. */
  const scanContainer = (container) => {
    const lines = pickAll(container, SEL.line);
    const nodes = lines.length ? lines : Array.from(container.children);
    const now = Date.now();
    for (const node of nodes) {
      if (!node.dataset) continue;
      if (!node.dataset.ttcId) node.dataset.ttcId = String(++orderCounter) + "-" + Math.random().toString(36).slice(2, 6);
      const id = node.dataset.ttcId + "@" + (container.ownerDocument === document ? "top" : "f" + frameLineSeq);
      const spEl = pickOne(node, SEL.speaker);
      const txEl = pickOne(node, SEL.text);
      const speaker = spEl ? spEl.textContent.trim() : "";
      let text = txEl ? txEl.textContent.trim() : node.textContent.trim();
      if (!txEl && speaker && text.startsWith(speaker)) text = text.slice(speaker.length).trim();
      if (!text) continue;
      if (speaker) participants.add(speaker);
      const existing = entries.get(id);
      if (!existing) {
        entries.set(id, { speaker, text, order: ++orderCounter, tsMs: now });
      } else if (existing.speaker && speaker && existing.speaker !== speaker) {
        entries.set("frozen-" + id + "-" + existing.order, { ...existing });
        entries.set(id, { speaker, text, order: ++orderCounter, tsMs: now });
      } else {
        existing.speaker = speaker || existing.speaker;
        existing.text = text;
      }
    }
  };

  const scan = () => {
    if (!capturing) return;
    if (containerEl && document.contains(containerEl)) scanContainer(containerEl);
    else { containerEl = findContainer(); if (containerEl) bindObserverTo(containerEl); }
    if (frameContainers.length) {
      frameScan(); // refresh same-origin iframe containers
      for (const c of frameContainers) if (c.isConnected) scanContainer(c);
    }
    if (!isTop) forwardLines(false);
    updateStatus();
  };

  function bindObserverTo(container) {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => scan());
    observer.observe(container, { childList: true, subtree: true, characterData: true });
  }

  function attachObserver() {
    containerEl = findContainer();
    if (containerEl) bindObserverTo(containerEl);
    frameScan();
    pollTimer = setInterval(() => {
      if (!capturing) return;
      scan();
      collectParticipants();
    }, 1000);
  }

  function detachObserver() {
    if (observer) { observer.disconnect(); observer = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  /** Names from the roster panel (if open) + everything captions showed. */
  function collectParticipants() {
    const panel = pickOne(document, SEL.rosterPanel) ||
      frameContainers.map((c) => pickOne(c.ownerDocument, SEL.rosterPanel)).find(Boolean);
    if (panel) {
      for (const item of pickAll(panel, SEL.rosterItem)) {
        const t = (item.textContent || "").trim();
        if (t && t.length < 80) participants.add(t);
      }
    }
  }

  /** Reduce raw names: strip self markers, drop self, dedupe case-insensitively. */
  function otherParticipants() {
    const selfHints = [tenantEmail].filter(Boolean).map((s) => s.toLowerCase());
    const seen = new Map();
    for (const raw of participants) {
      let n = raw;
      for (const mk of SELF_MARKERS) n = n.replace(mk, "").trim();
      if (!n || n.length < 2) continue;
      const low = n.toLowerCase();
      if (selfHints.some((h) => low === h || (tenantEmail && low === tenantEmail.split("@")[0]))) continue;
      if (!seen.has(low)) seen.set(low, n);
    }
    return Array.from(seen.values());
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
    const sels = ['[data-tid="call-title"]', '[data-tid="calling-participant-stream-title"]', '[data-tid="meeting-title"]', '[role="heading"][data-tid]', 'h1', 'header [role="heading"]'];
    for (const s of sels) {
      const el = deepQueryOne(document, s) || frameContainers.map((c) => pickOne(c.ownerDocument, [s])).find(Boolean);
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
    const others = otherParticipants();
    const base =
      others.length === 1 ? `${sanitize(others[0])}_${date}_${hm}`
      : meetingTitle ? `${sanitize(meetingTitle)}_${date}_${hm}`
      : `TeamsTranscript_${date}_${hm}`;
    return `${base}.md`;
  }

  function buildMarkdown(list) {
    const out = [];
    let last = "";
    for (const e of list) {
      const sig = e.speaker + "|" + e.text;
      if (sig === last) continue;
      last = sig;
      const who = e.speaker ? `${e.speaker}：` : "";
      out.push(`[${clock(e.tsMs)}] ${who}${e.text}`);
    }
    const started = startTime ? new Date(startTime) : new Date();
    const others = otherParticipants();
    const header =
      `# Teams Transcript\n\n` +
      `- 會議：${meetingTitle || getMeetingTitle() || "(未偵測到標題)"}\n` +
      `- 日期：${started.toLocaleDateString()}\n` +
      `- 擷取開始：${clock(startTime || Date.now())}\n` +
      `- 擷取結束：${clock(Date.now())}\n` +
      `- 與會者：${others.length ? others.join("、") : "(未偵測)"}\n` +
      (tenantEmail ? `- 帳號：${tenantEmail}\n` : "") +
      `- 對話行數：${out.length}\n\n` +
      `---\n\n`;
    return header + out.join("\n") + "\n";
  }

  // ---------------------------------------------------------------------------
  // Copilot bridge (semi-automatic)
  // ---------------------------------------------------------------------------
  function buildPrompt(md) {
    const others = otherParticipants();
    return [
      "You are generating professional meeting minutes from a Teams live-caption transcript.",
      `Meeting: ${meetingTitle || "(unknown title)"}`,
      `Participants: ${others.length ? others.join(", ") : "unknown"}`,
      `Date: ${new Date(startTime || Date.now()).toLocaleDateString()}`,
      "",
      "Produce meeting minutes in English using exactly this structure:",
      "## Summary",
      "(max 5 bullets)",
      "## Decisions Made",
      "## Action Items",
      "(each with Owner and Due date; write unassigned / TBD when not stated in the transcript)",
      "## Open Questions",
      "",
      "Transcript:",
      md,
    ].join("\n");
  }

  /** AUTO-PASTE mode: instead of clipboard hand-off, park the prompt and let
   *  the COPILOT TAB itself inject + send it. The Copilot page is a different
   *  origin, so this content script must ALSO run there (manifest match) and
   *  pick the parked prompt up. Flow:
   *    meeting tab: save transcript -> park prompt (chrome.storage) -> open tab
   *    copilot tab: ttc-copilot.js sees parked prompt -> injects into Lexical
   *                 editor -> clicks Send -> parks nothing, done. */
  async function runBridge({ prompt }) {
    // 1) Park the prompt for the Copilot tab to pick up (survives context death).
    try {
      await chrome.storage.local.set({
        ttc_autopaste: { prompt, at: Date.now(), title: meetingTitle || "" },
      });
    } catch (e) {
      log("park failed", e);
      toast("無法暫存 prompt（storage 錯誤）— 逐字稿已存檔");
    }
    // 2) Keep a clipboard copy as belt-and-braces (harmless if blocked).
    try { await navigator.clipboard.writeText(prompt); } catch (_) {}
    // 3) Open the Copilot tab (worker first, window.open fallback).
    let tabOk = false;
    try {
      const r = await Promise.race([
        chrome.runtime?.sendMessage({ type: "ttc-open-tab", url: copilotUrl }),
        new Promise((res) => setTimeout(() => res(null), 1500)),
      ]);
      tabOk = !!r?.ok;
    } catch (_) {}
    if (!tabOk) {
      try { window.open(copilotUrl, "_blank"); tabOk = true; } catch (_) {}
    }
    toast(tabOk ? "已開啟 Copilot 分頁 — 全自動貼上+送出中，完成後會通知"
                : "Copilot 分頁開啟失敗 — 請手動開啟 m365.cloud.microsoft/chat");
  }

  /** One-click retry of a parked prompt (gesture unlocks the clipboard). */
  function armPromptFlush() {
    const flush = async () => {
      window.removeEventListener("click", flush, true);
      try {
        const st = await chrome.storage.local.get(["ttc_clip_prompt"]);
        const p = st.ttc_clip_prompt;
        if (!p) return;
        await navigator.clipboard.writeText(p);
        await chrome.storage.local.remove("ttc_clip_prompt");
        toast("prompt 已補複製 — 到 Copilot 分頁貼上送出");
      } catch (e) { toast("補複製失敗：仍無剪貼簿權限"); }
    };
    window.addEventListener("click", flush, { capture: true, once: true });
  }

  /** On page load: if a prompt was parked (context died mid-bridge), copy it
   *  automatically once the document is focusable; keeps the promise even if
   *  the meeting tab is long gone. */
  async function tryFlushPrompt() {
    try {
      const st = await chrome.storage.local.get(["ttc_clip_prompt", "ttc_clip_at"]);
      const p = st.ttc_clip_prompt;
      if (!p) return;
      // Only auto-flush prompts younger than 24h; older ones stay until a click.
      if (Date.now() - (st.ttc_clip_at || 0) > 24 * 3600 * 1000) return;
      try {
        await navigator.clipboard.writeText(p);
        await chrome.storage.local.remove("ttc_clip_prompt");
        toast("已補複製上次的會議記錄 prompt — 到 Copilot 貼上送出");
      } catch (_) { armPromptFlush(); }
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Save flow (any frame may own it; lines come from the bg aggregate)
  // ---------------------------------------------------------------------------
  async function buildFinalLines() {
    const local = Array.from(entries.values()).sort((a, b) => a.order - b.order);
    let bg = [];
    try {
      const r = await chrome.runtime.sendMessage({ type: "ttc-get-lines" });
      if (r?.ok && Array.isArray(r.lines)) bg = r.lines;
    } catch (_) {}
    // Merge, dedupe by speaker+text+tsMs bucket, keep chronological order.
    const seen = new Set();
    const merged = [...local, ...bg]
      .sort((a, b) => (a.tsMs || 0) - (b.tsMs || 0))
      .filter((e) => {
        const k = e.speaker + "|" + e.text + "|" + Math.floor((e.tsMs || 0) / 1000);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    return merged;
  }

  async function start(fromAuto) {
    if (!fsaSupported()) {
      toast("此瀏覽器不支援 File System Access API，請用桌面版 Chrome / Arc。");
      return;
    }
    // Fresh meeting: drop lines left in the background aggregate so the
    // previous meeting's captions can never leak into this transcript.
    try { await chrome.storage.local.set({ ttc_bg_lines: [], ttc_bg_count: 0 }); } catch (_) {}
    entries.clear();
    participants.clear();
    orderCounter = 0;
    captionsTried = 0;
    rosterOpened = false;
    lastForwarded = 0;
    startTime = Date.now();
    meetingTitle = getMeetingTitle();
    capturing = true;
    attachObserver();
    if (fromAuto) {
      tryOpenRoster();
      toast("AUTO：偵測到會議，已開始擷取字幕");
    } else {
      toast("已開始擷取字幕。");
    }
    renderUI();
    updateStatus();
  }

  async function stop(fromAuto) {
    capturing = false;
    detachObserver();
    scan(); // final flush of anything still in this frame's DOM
    collectParticipants();
    if (!meetingTitle) meetingTitle = getMeetingTitle();
    const list = await buildFinalLines();
    if (!list.length) {
      toast("沒有抓到任何字幕行 — 按 🔍 送出診斷報告幫我校正 selector");
      renderUI();
      updateStatus(false);
      return;
    }
    const md = buildMarkdown(list);
    const name = buildFilename();
    const tenantKey = tenantKeyNow();
    const prompt = buildPrompt(md);
    const handle = handles.get(tenantKey);
    let saved = false;
    try {
      if (handle && (await handle.queryPermission({ mode: "readwrite" })) === "granted") {
        await writeFile(handle, name, md);
        saved = true;
        try { await handle.getDirectoryHandle("minutes", { create: true }); } catch (_) {}
      } else {
        // Defer to a gesture now; ALSO park in chrome.storage so the next
        // Teams page load can flush it even if this tab dies (SPA teardown).
        await chrome.storage.local.set({
          ttc_pending: {
            name, content: md, tenantKey, prompt,
            savedAt: Date.now(),
          },
        });
        armGestureFlush();
        toast("逐字稿已暫存 — 點一下頁面以授權存檔（離開也不會丟，下次開頁自動補存）");
      }
      if (saved) toast(`已存檔：${name}（OneDrive 將自動同步）`);
    } catch (e) {
      log("write failed, falling back to download", e);
      downloadFallback(name, md);
      toast(`寫入資料夾失敗，已改用下載：${e.message || e}`);
    }
    if (saved) {
      lastFile = name;
      // Clear the bg aggregate once safely written.
      try { await chrome.storage.local.set({ ttc_bg_lines: [], ttc_bg_count: 0 }); } catch (_) {}
      runBridge({ prompt });
    }
    renderUI();
    updateStatus(saved);
  }

  /** On every Teams page load: if a parked transcript exists, ask the user
   *  (one click grants the gesture) to flush it. */
  async function tryFlushParked() {
    // document_start: <body> may not exist yet; defer until DOM is interactive
    // so toast() (which the flush prompt depends on) can render.
    if (!document.body) {
      await new Promise((res) => {
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", res, { once: true });
        } else {
          setTimeout(res, 300);
        }
      });
    }
    try {
      const st = await chrome.storage.local.get("ttc_pending");
      const p = st.ttc_pending;
      if (!p || !p.name) return;
      toast("有上次未存檔的逐字稿 — 按「💾 補存」按鈕存檔");
    } catch (_) {}
  }

  /** Shared flush: the ONLY place that disposes a parked transcript.
   *  Layer 1: current handle (fresh grant or remembered).
   *  Layer 2: requestPermission on the stale handle (same gesture).
   *  Layer 3: re-pick folder (same gesture).
   *  Layer 4: download to ~/Downloads — never fails, always ends with the
   *  bytes somewhere on disk. */
  async function flushParkedCore() {
    const act = () => {
      try { return `activation=${navigator.userActivation ? navigator.userActivation.isActive : "n/a"}`; }
      catch (_) { return "activation=?"; }
    };
    let p = null;
    try {
      p = (await chrome.storage.local.get("ttc_pending")).ttc_pending;
    } catch (_) {}
    if (!p || !p.name) { toast("沒有待補存的逐字稿"); return; }
    const key = p.tenantKey || tenantKeyNow();
    log("flush start", p.name, `folder=${handles.get(key)?.name || "?"}`, act());
    // Chromium's FSA broker refuses getFileHandle(create:true) on macOS File
    // Provider mounts (~/Library/CloudStorage/OneDrive...): NotAllowedError
    // regardless of grant state, with active gesture and a valid handle
    // (confirmed on this machine 2026-09-17: OS-level write works, FSA write
    // fails; requestPermission never resolves). So: download channel FIRST —
    // it bypasses the broker entirely and always lands in ~/Downloads.
    try {
      downloadFallback(p.name, p.content);
      log("downloaded via <a download> channel");
      await chrome.storage.local.remove("ttc_pending");
      toast(`已下載：${p.name}（在「下載」資料夾）— 請搬進 OneDrive/transcript，或按 📁 重選本機資料夾`);
      runBridge({ prompt: p.prompt });
      renderUI();
      return;
    } catch (e0) { log("download channel failed", e0); }
    // Download blocked (rare): fall back to FSA attempts.
    try {
      const h = handles.get(key) || (await idbGet(storeKeyFor(key)));
      if (h) {
        try {
          await writeFile(h, p.name, p.content);
          await afterFlush(p);
          return;
        } catch (e1) { log("layer1 write failed", e1); }
        try {
          const granted = (await h.requestPermission({ mode: "readwrite" })) === "granted";
          log("layer2 requestPermission ->", granted, act());
          if (granted) {
            await writeFile(h, p.name, p.content);
            await afterFlush(p);
            return;
          }
        } catch (e2) { log("layer2 requestPermission failed", e2); }
      }
      const h2 = await ensureFolderFor(key, true);
      log("layer3 picked", h2.name, act());
      await writeFile(h2, p.name, p.content);
      await afterFlush(p);
    } catch (e) {
      log("flushParkedCore fallback error", e);
      toast(`補存失敗：${e.message || e}`);
    }
  }

  async function afterFlush(p) {
    await chrome.storage.local.remove("ttc_pending");
    toast(`已存檔：${p.name}`);
    lastFile = p.name;
    updateStatus(true);
    runBridge({ prompt: p.prompt });
    renderUI();
  }

  /** One-click gesture flush for a write deferred during this page's life. */
  function armGestureFlush() {
    const flush = () => {
      window.removeEventListener("click", flush, true);
      flushParkedCore();
    };
    window.addEventListener("click", flush, { capture: true, once: true });
  }

  async function pickFolder() {
    try {
      const key = tenantKeyNow();
      const h = await ensureFolderFor(key, true);
      toast(`已選擇資料夾（${key}）：${h.name}`);
      updateStatus();
    } catch (e) {
      toast("選擇資料夾取消或失敗：" + (e.message || e));
    }
  }

  async function runDiagnostics() {
    // Fuzzy sweeps: even when exact selectors miss, find caption-ish DOM.
    const fuzzy = [];
    try {
      const seen = new Set();
      const grab = (el, why) => {
        if (!el || seen.has(el)) return;
        seen.add(el);
        const html = (el.outerHTML || "").replace(/\s+/g, " ").slice(0, 300);
        fuzzy.push({ why, tag: el.tagName, tid: el.getAttribute?.("data-tid") || "", cls: (el.className || "").toString().slice(0, 120), html });
      };
      for (const el of document.querySelectorAll('[class*="caption" i]')) grab(el, "class~caption");
      for (const el of document.querySelectorAll('[data-tid*="caption" i]')) grab(el, "tid~caption");
      for (const el of document.querySelectorAll('[aria-live]')) grab(el, "aria-live");
      for (const el of document.querySelectorAll('[class*="Caption" i]')) grab(el, "class~Caption");
    } catch (_) {}
    const rep = {
      url: location.href,
      isTop,
      popup: !!window.opener, // meeting often opens as a popup window
      frames: Array.from(document.querySelectorAll("iframe")).map((f) => {
        let same = false, hasCaption = false;
        try { same = !!f.contentDocument; hasCaption = same ? !!pickOne(f.contentDocument, SEL.container) : false; } catch (_) {}
        return { src: (f.src || "").slice(0, 120), sameOrigin: same, captionContainer: hasCaption };
      }),
      topShadowHosts: (() => { let n = 0; try { for (const el of document.querySelectorAll("*")) if (el.shadowRoot) n++; } catch (_) {} return n; })(),
      selectors: Object.fromEntries(Object.entries({
        container: SEL.container, line: SEL.line, meetTitle: SEL.meetTitle,
        captionsBtn: SEL.captionsBtn, rosterBtn: SEL.rosterBtn,
      }).map(([k, sels]) => [k, sels.map((s) => ({ s, hit: (() => { try { return !!deepQueryOne(document, s); } catch (_) { return false; } })() }))])),
      fuzzy: fuzzy.slice(0, 12),
      counts: {
        thisFrameLines: entries.size,
        capturing, inMeeting, autoMode,
        frameContainers: frameContainers.length,
        captionsTried,
        events,
      },
    };
    console.log("[TTC] DIAGNOSTIC REPORT", JSON.stringify(rep, null, 2));
    const text = JSON.stringify(rep, null, 2);
    try { await navigator.clipboard.writeText(text); toast("診斷已複製到剪貼簿並印在 console — 貼給 Claude 即可校正"); }
    catch (_) { toast("診斷已印在 console（F12）— 複製貼給 Claude"); }
    return rep;
  }

  // ---------------------------------------------------------------------------
  // AUTO watchdog: meeting start/end transitions (debounced, 1.5s poll)
  // ---------------------------------------------------------------------------
  // Event ring for diagnostics: last 20 start/stop/error events.
  const events = [];
  const pushEvent = (kind, detail) => {
    events.push({ kind, detail: String(detail || "").slice(0, 120), at: new Date().toLocaleTimeString() });
    if (events.length > 20) events.shift();
    log("event:", kind, detail || "");
  };

  // Self-healing AUTO watchdog: as long as (in meeting + AUTO on + not
  // capturing) we keep trying to start, whatever killed the previous attempt.
  // Caption enabling retries in the background with its own budget per meeting.
  setInterval(async () => {
    const now = isInMeetingRaw();
    if (now !== inMeeting) {
      meetVotes++;
      if (meetVotes < 2) return;
      inMeeting = now;
      meetVotes = 0;
      pushEvent(inMeeting ? "meeting-detected" : "meeting-left");
      if (!inMeeting && capturing) {
        await stop(true);
        pushEvent("auto-stopped");
      }
    } else {
      meetVotes = 0;
    }
    if (inMeeting && autoMode && !capturing) {
      if (autoRetryCooldown > Date.now()) return;
      autoRetryCooldown = Date.now() + 5000;
      detectTenant();
      try {
        await start(true);
        pushEvent("auto-started", `lines=${entries.size}`);
      } catch (e) {
        pushEvent("auto-start-error", e && e.message);
      }
      if (!folderReminded) {
        folderReminded = true;
        const has = handles.get(tenantKeyNow());
        if (!has) toast(`會議偵測成功，但此帳號還沒選資料夾 — 會議中或結束後按 📁 選擇（${tenantKeyNow()}）`);
      }
      // Kick captions; a separate interval keeps retrying while in meeting.
      tryEnableCaptions();
    }
  }, 1500);

  // Keep retrying captions while capturing in a meeting (budget resets on start()).
  setInterval(async () => {
    if (!capturing || !inMeeting) return;
    const on = findContainer() || frameContainers.length;
    if (!on) {
      const ok = await tryEnableCaptions();
      if (!ok && captionsTried === 0) pushEvent("captions-btn-not-found");
    }
  }, 6000);

  setInterval(() => { if (capturing && !meetingTitle) meetingTitle = getMeetingTitle(); }, 3000);

  // ---------------------------------------------------------------------------
  // Status shared with the popup via chrome.storage.local
  // ---------------------------------------------------------------------------
  let lastFile = "";
  function updateStatus(savedOk) {
    try {
      chrome.storage?.local.set({
        ttc_status: {
          capturing,
          auto: autoMode,
          lines: entries.size + bgLineCount,
          folder: handles.get(tenantKeyNow())?.name || "",
          tenant: tenantEmail || tenantKeyNow(),
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
        font-size:13px;user-select:none;box-sizing:border-box;max-width:100vw;
        max-height:100vh;flex-wrap:wrap;overflow:auto}
      #ttc-widget button{cursor:pointer;border:0;border-radius:6px;padding:6px 10px;
        font-size:13px;font-weight:600;color:#fff;background:#3a3a3a}
      #ttc-widget button:hover{filter:brightness(1.15)}
      #ttc-widget #ttc-drag{cursor:grab;touch-action:none;padding:6px;flex-shrink:0}
      #ttc-widget #ttc-drag:active{cursor:grabbing}
      #ttc-toggle.rec{background:#c62828}
      #ttc-toggle.idle{background:#2e7d32}
      #ttc-auto.on{background:#1565c0}
      #ttc-auto.off{background:#555}
      #ttc-folder{background:#3a3a3a}
      #ttc-diag{background:#6a1b9a}
      #ttc-count{opacity:.85;min-width:44px;text-align:right}
      #ttc-tenant{opacity:.7;font-size:11px;max-width:140px;overflow:hidden;text-overflow:ellipsis}
      #ttc-toast{position:fixed;right:16px;bottom:64px;z-index:2147483647;max-width:320px;
        background:#000;color:#fff;padding:8px 12px;border-radius:8px;font-size:12px;
        box-shadow:0 4px 16px rgba(0,0,0,.4);opacity:0;transition:opacity .2s}
    `;
    document.documentElement.appendChild(style);

    ui = document.createElement("div");
    ui.id = "ttc-widget";
    ui.innerHTML = `
      <button id="ttc-drag" type="button" title="拖曳移動面板；方向鍵微調" aria-label="移動面板">⠿</button>
      <button id="ttc-auto" class="on" type="button" title="AUTO：進會議自動擷取、結束自動存檔">AUTO</button>
      <button id="ttc-toggle" class="idle">● 開始擷取</button>
      <span id="ttc-count">0 行</span>
      <button id="ttc-flush" type="button" title="補存上次未存檔的逐字稿" style="display:none;background:#e65100">💾 補存</button>
      <button id="ttc-folder" title="選擇 / 變更此帳號的 OneDrive 資料夾">📁</button>
      <button id="ttc-diag" type="button" title="診斷：DOM 結構報告（校正 selector 用）">🔍</button>
      <span id="ttc-tenant" title="偵測到的登入帳號"></span>
    `;
    document.body.appendChild(ui);
    ui.querySelector("#ttc-toggle").addEventListener("click", () => (capturing ? stop(false) : start(false)));
    ui.querySelector("#ttc-flush").addEventListener("click", () => flushParkedCore());
    ui.querySelector("#ttc-folder").addEventListener("click", () => pickFolder());
    ui.querySelector("#ttc-diag").addEventListener("click", () => runDiagnostics());
    ui.querySelector("#ttc-auto").addEventListener("click", () => {
      autoMode = !autoMode;
      try { chrome.storage.local.set({ ttc_auto: autoMode }).catch(() => {}); } catch (_) {}
      renderUI();
      toast(autoMode ? "AUTO 已開啟" : "AUTO 已關閉（手動模式）");
    });
    renderUI();
    setupWidgetDragging();
  }

  function setupWidgetDragging() {
    const handle = ui.querySelector("#ttc-drag");
    const storageKey = "ttc_widget_position";
    let drag = null;
    let interacted = false;
    let position = null;
    let saveTimer = null;

    const savePosition = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        try {
          chrome.storage.local.set({ [storageKey]: position }).catch(() => {});
        } catch (_) {}
      }, 150);
    };
    const moveTo = (left, top) => {
      const bounds = ui.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      const height = document.documentElement.clientHeight;
      position = {
        left: Math.max(0, Math.min(left, width - bounds.width)),
        top: Math.max(0, Math.min(top, height - bounds.height)),
      };
      ui.style.right = "auto";
      ui.style.bottom = "auto";
      ui.style.left = `${position.left}px`;
      ui.style.top = `${position.top}px`;
    };
    const keepVisible = () => {
      const bounds = ui.getBoundingClientRect();
      const previous = position;
      moveTo(bounds.left, bounds.top);
      if (previous && (previous.left !== position.left || previous.top !== position.top)) {
        savePosition();
      }
    };

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !event.isPrimary || drag) return;
      interacted = true;
      const bounds = ui.getBoundingClientRect();
      drag = { pointerId: event.pointerId, offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      moveTo(event.clientX - drag.offsetX, event.clientY - drag.offsetY);
    });
    const endDrag = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag = null;
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      keepVisible();
      savePosition();
    };
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
    handle.addEventListener("lostpointercapture", endDrag);
    handle.addEventListener("keydown", (event) => {
      const offsets = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] };
      const offset = offsets[event.key];
      if (!offset) return;
      event.preventDefault();
      interacted = true;
      const bounds = ui.getBoundingClientRect();
      moveTo(bounds.left + offset[0], bounds.top + offset[1]);
      savePosition();
    });
    window.addEventListener("resize", keepVisible);
    new ResizeObserver(keepVisible).observe(ui);
    keepVisible();
    try {
      chrome.storage.local.get(storageKey).then((result) => {
        const saved = result[storageKey];
        if (!interacted && Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) {
          moveTo(saved.left, saved.top);
        }
      }).catch(() => {});
    } catch (_) {}
  }

  async function renderUI() {
    if (!ui) return;
    const btn = ui.querySelector("#ttc-toggle");
    const cnt = ui.querySelector("#ttc-count");
    const autoBtn = ui.querySelector("#ttc-auto");
    const tenantEl = ui.querySelector("#ttc-tenant");
    if (capturing) {
      btn.textContent = "■ 停止並存檔";
      btn.className = "rec";
    } else {
      btn.textContent = "● 開始擷取";
      btn.className = "idle";
    }
    autoBtn.className = autoMode ? "on" : "off";
    autoBtn.textContent = autoMode ? "AUTO" : "MANUAL";
    cnt.textContent = `${entries.size + bgLineCount} 行`;
    // Visible affordance: a parked transcript exists and still needs a home.
    let hasPending = false;
    try { hasPending = !!(await chrome.storage.local.get("ttc_pending")).ttc_pending; } catch (_) {}
    const flushBtn = ui.querySelector("#ttc-flush");
    if (flushBtn) flushBtn.style.display = hasPending ? "" : "none";
    tenantEl.textContent = tenantEmail || "";
  }

  let toastTimer = null;
  function toast(msg) {
    let t = document.getElementById("ttc-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "ttc-toast";
      // document_start has no <body> yet; documentElement keeps position:fixed working.
      (document.body || document.documentElement).appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = "1";
    toastTimer = setTimeout(() => (t.style.opacity = "0"), 4000);
    log(msg);
  }

  setInterval(renderUI, 1000);

  // Popup can ask the content script to (re)pick a folder or read status.
  try {
    chrome.runtime?.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === "ttc-pick-folder") { pickFolder(); sendResponse({ ok: true }); }
      if (msg?.type === "ttc-get-status") {
        sendResponse({
          capturing, auto: autoMode, lines: entries.size + bgLineCount,
          folder: handles.get(tenantKeyNow())?.name || "",
          tenant: tenantEmail || tenantKeyNow(), lastFile,
        });
      }
      return true;
    });
  } catch (_) {}

  // Boot: restore handles + settings, then flush anything parked.
  (async () => {
    try {
      const legacy = await idbGet("dir");
      if (legacy) handles.set("default", legacy);
      detectTenant();
      const key = tenantKeyNow();
      const stored = await idbGet(storeKeyFor(key));
      if (stored) handles.set(key, stored);
    } catch (_) {}
    try {
      const res = await chrome.storage?.local.get(["ttc_auto", "ttc_copilot_url"]);
      if (res && typeof res.ttc_auto === "boolean") autoMode = res.ttc_auto;
      if (res && typeof res.ttc_copilot_url === "string" && res.ttc_copilot_url) copilotUrl = res.ttc_copilot_url;
    } catch (_) {}
    updateStatus();
    if (isTop) { tryFlushParked(); tryFlushPrompt(); }
  })();

  const boot = () => { if (document.body) injectUI(); else setTimeout(boot, 500); };
  boot();
  log("content script loaded (v0.2.1)");
})();
