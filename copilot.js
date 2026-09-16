/*
 * TTC Copilot autopaste — content script on m365.cloud.microsoft (chat page).
 * Picks up a prompt parked by the Teams meeting tab (chrome.storage
 * ttc_autopaste), types it into the Lexical composer, and clicks Send.
 *
 * The parked prompt is consumed exactly once; on any failure it is put back
 * with a retry counter (max 5) so a transient not-ready composer doesn't lose
 * the minutes request. A marker badge (ttc-autopaste-badge) shows progress.
 */
(() => {
  "use strict";
  if (window.__ttcAutopasteLoaded) return;
  window.__ttcAutopasteLoaded = true;

  const log = (...a) => console.log("[TTC-AP]", ...a);
  const MAX_RETRY = 5;

  let badge = null;
  function showBadge(text, sticky) {
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "ttc-autopaste-badge";
      badge.style.cssText = `position:fixed;right:16px;bottom:16px;z-index:2147483647;
        background:#6a1b9a;color:#fff;padding:10px 14px;border-radius:10px;
        font:600 13px -apple-system,BlinkMacSystemFont,sans-serif;
        box-shadow:0 4px 16px rgba(0,0,0,.35);max-width:340px`;
      document.body.appendChild(badge);
    }
    badge.textContent = text;
    badge.style.display = "block";
    if (!sticky) setTimeout(() => { badge.style.display = "none"; }, 6000);
  }

  const editor = () => document.querySelector('[contenteditable="true"][role="textbox"]');
  const sendBtn = () =>
    Array.from(document.querySelectorAll("button")).find(
      (b) => (b.getAttribute("aria-label") || "").toLowerCase() === "send" && !b.disabled
    );

  function typeIntoEditor(text) {
    const ed = editor();
    if (!ed) return false;
    ed.focus();
    // execCommand insertText works with Lexical (verified live on this page).
    return document.execCommand("insertText", false, text);
  }

  async function attempt() {
    let st;
    try {
      st = await chrome.storage.local.get("ttc_autopaste");
    } catch (_) { return; }
    const job = st.ttc_autopaste;
    if (!job || !job.prompt) return;

    // Ignore stale jobs (>1h) — the meeting is long over; keep manual flow.
    if (Date.now() - (job.at || 0) > 3600 * 1000) {
      await chrome.storage.local.remove("ttc_autopaste");
      log("dropped stale job");
      return;
    }

    // The Copilot chat page is an SPA: composer may take seconds to mount.
    const ed = await waitFor(() => editor(), 20000, 500);
    if (!ed) return retry(job, "composer-not-found");
    // Wait until Send is enabled (it appears once the app is interactive).
    await waitFor(() => sendBtn() || document.querySelector("textarea, [contenteditable='true']"), 15000, 500);

    showBadge("TTC：偵測到待送的會議記錄請求，輸入中…", true);
    const typed = typeIntoEditor(job.prompt);
    if (!typed || !editor().textContent.trim()) return retry(job, "insert-failed");

    // Small settle delay so Lexical commits state and enables Send.
    await sleep(800);
    const btn = sendBtn();
    if (!btn) return retry(job, "send-button-not-found");
    btn.click();
    log("sent");

    // Confirm: composer clears and the conversation grows.
    await sleep(2500);
    const cleared = !editor() || editor().textContent.trim().length === 0;
    await chrome.storage.local.remove("ttc_autopaste");
    showBadge(cleared ? "TTC：會議記錄請求已送出 ✓（minutes 生成中）"
                      : "TTC：請求已送出 ✓", false);
    setTimeout(() => showBadge("TTC：完成後請把 minutes 存到 transcript 旁的 minutes/ 資料夾", false), 4000);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, timeout, step) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { const v = fn(); if (v) return v; } catch (_) {}
      await sleep(step);
    }
    return null;
  }

  async function retry(job, why) {
    job.tries = (job.tries || 0) + 1;
    job.lastError = why;
    log("retry", job.tries, why);
    if (job.tries >= MAX_RETRY) {
      await chrome.storage.local.set({ ttc_clip_prompt: job.prompt, ttc_clip_at: Date.now() });
      await chrome.storage.local.remove("ttc_autopaste");
      showBadge("TTC：自動送出失敗（" + why + "）— prompt 已複製到剪貼簿，請手動貼上", true);
      return;
    }
    await chrome.storage.local.set({ ttc_autopaste: job });
    setTimeout(attempt, 3000);
  }

  // Kick shortly after load (SPA needs time) and also on focus (tab was opened
  // in background; storage events don't fire here reliably).
  setTimeout(attempt, 2500);
  window.addEventListener("focus", () => setTimeout(attempt, 1200));
})();
