/* Background service worker (v0.2.1)
 * - Opens tabs on request (content scripts can't call chrome.tabs in MV3).
 * - Aggregates caption lines from ALL frames of the meeting tab into
 *   chrome.storage.local (the frame that saves reads them back at flush).
 *   This survives per-frame teardown and lets any frame own the save. */
const LINE_CAP = 5000;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "ttc-open-tab" && typeof msg.url === "string" && /^https:\/\//.test(msg.url)) {
        chrome.tabs.create({ url: msg.url });
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === "ttc-line-batch" && Array.isArray(msg.lines)) {
        const st = await chrome.storage.local.get(["ttc_bg_lines", "ttc_bg_count"]);
        const arr = Array.isArray(st.ttc_bg_lines) ? st.ttc_bg_lines : [];
        for (const l of msg.lines) {
          arr.push({ tsMs: l.tsMs, speaker: String(l.speaker || ""), text: String(l.text || "") });
        }
        while (arr.length > LINE_CAP) arr.shift();
        await chrome.storage.local.set({
          ttc_bg_lines: arr,
          ttc_bg_count: (st.ttc_bg_count || 0) + msg.lines.length,
          ttc_bg_ts: Date.now(),
        });
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === "ttc-get-lines") {
        const st = await chrome.storage.local.get("ttc_bg_lines");
        sendResponse({ ok: true, lines: Array.isArray(st.ttc_bg_lines) ? st.ttc_bg_lines : [] });
        return;
      }
      sendResponse({ ok: false });
    } catch (e) {
      try { sendResponse({ ok: false, error: String(e) }); } catch (_) {}
    }
  })();
  return true; // async response
});
