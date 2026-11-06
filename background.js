/* Local OneDrive routing and durable save retries (MV3 service worker). */
importScripts('routing.js');
const { validRoute, resolveRoute, routeForTenant, pendingKey } = TtcRouting;
const HOST = 'com.teams_transcript_capture.writer';
const LINE_CAP = 5000;
let saveQueue = Promise.resolve();

function allowedSender(sender) {
  if (sender.id !== chrome.runtime.id) return false;
  try {
    const url = new URL(sender.url);
    if (url.protocol === 'chrome-extension:') return url.hostname === chrome.runtime.id;
    return url.protocol === 'https:' && (['teams.cloud.microsoft', 'teams.live.com', 'teams.microsoft.com'].includes(url.hostname) || url.hostname.endsWith('.teams.microsoft.com'));
  } catch (_) { return false; }
}

function nativeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(HOST, message, result => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(`本機寫檔程式未連線：${error.message}`));
      else if (!result?.ok) reject(new Error(result?.error || '本機寫檔失敗'));
      else resolve(result);
    });
  });
}

const RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

/* OneDrive mounts (File Provider) wake lazily after sleep or long idle; the
 * first native write can fail while the mount is still warming up. Retry the
 * write a bounded number of times, pinging the host between attempts (cheap
 * round trip that exercises the mount check) before giving up and leaving
 * the item parked for the manual flush. */
async function saveWithWarmup(pending, route) {
  let lastError = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await delay(RETRY_DELAYS_MS[attempt - 1]);
      try { await nativeMessage({ action: 'ping' }); } catch (_) { /* write attempt reports the real error */ }
    }
    try {
      const result = await nativeMessage({ action: 'write', route, name: pending.name, content: pending.content });
      if (result.route !== route || typeof result.path !== 'string') throw new Error('本機寫檔回覆無效；暫存保留');
      return result;
    } catch (e) { lastError = e; }
  }
  throw lastError;
}

async function saveTranscript(input) {
  if (!input || typeof input.name !== 'string' || typeof input.content !== 'string' || !input.content || typeof input.id !== 'string') {
    return { ok: false, error: '無效的逐字稿資料' };
  }
  const key = pendingKey(input);
  const settings = await chrome.storage.local.get(['ttc_route', key]);
  const existing = settings[key];
  if (existing && (existing.content !== input.content || existing.tenantKey !== input.tenantKey || existing.name !== input.name || existing.route !== input.route)) {
    return { ok: false, error: '待存檔 ID 衝突；保留原始暫存' };
  }
  // New sessions freeze the profile's selection at capture start. Legacy
  // pending items prefer their recorded tenant, never today's other tenant.
  const route = validRoute(input.route) ? input.route : routeForTenant(input.tenantKey) || resolveRoute(settings.ttc_route, null);
  const pending = { ...input, route };
  await chrome.storage.local.set({ [key]: pending });
  let result;
  let error = null;
  try {
    if (!route) throw new Error('無法辨識目的地；請在擴充功能中選擇 CDK 或 Tao 後按補存');
    result = await saveWithWarmup(pending, route);
  } catch (e) { error = e; }
  const status = {
    state: error ? 'native-write-failed' : 'saved',
    at: new Date().toISOString(), file: pending.name, tenantKey: pending.tenantKey,
    route, folder: result?.path?.replace(/\/[^/]+$/, '') || null,
    error: error ? { name: error.name, message: error.message } : null,
  };
  await chrome.storage.local.set({ ttc_last_save: status });
  if (error) return { ok: false, error: error.message, route };
  await chrome.storage.local.remove(key);
  const { ttc_pending: legacy } = await chrome.storage.local.get('ttc_pending');
  if (legacy?.name === pending.name && legacy.savedAt === pending.savedAt && legacy.tenantKey === pending.tenantKey) {
    await chrome.storage.local.remove('ttc_pending');
  }
  return { ok: true, path: result.path, route };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!allowedSender(sender)) { sendResponse({ ok: false, error: 'Unsupported sender' }); return; }
      if (msg?.type === 'ttc-get-route') {
        const { ttc_route: selection = 'auto' } = await chrome.storage.local.get('ttc_route');
        sendResponse({ ok: true, selection, route: resolveRoute(selection, msg.tenantKey) });
        return;
      }
      if (msg?.type === 'ttc-routing-status') {
        sendResponse(await nativeMessage({ action: 'ping' }));
        return;
      }
      if (msg?.type === 'ttc-save-transcript') {
        const task = saveQueue.then(() => saveTranscript(msg.pending));
        saveQueue = task.catch(() => {});
        sendResponse(await task);
        return;
      }
      if (msg?.type === 'ttc-open-tab' && typeof msg.url === 'string' && /^https:\/\//.test(msg.url)) {
        await chrome.tabs.create({ url: msg.url });
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === 'ttc-line-batch' && Array.isArray(msg.lines)) {
        const st = await chrome.storage.local.get(['ttc_bg_lines', 'ttc_bg_count']);
        const arr = Array.isArray(st.ttc_bg_lines) ? st.ttc_bg_lines : [];
        for (const l of msg.lines) arr.push({ tsMs: l.tsMs, speaker: String(l.speaker || ''), text: String(l.text || '') });
        while (arr.length > LINE_CAP) arr.shift();
        await chrome.storage.local.set({ ttc_bg_lines: arr, ttc_bg_count: (st.ttc_bg_count || 0) + msg.lines.length, ttc_bg_ts: Date.now() });
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === 'ttc-get-lines') {
        const st = await chrome.storage.local.get('ttc_bg_lines');
        sendResponse({ ok: true, lines: Array.isArray(st.ttc_bg_lines) ? st.ttc_bg_lines : [] });
        return;
      }
      sendResponse({ ok: false });
    } catch (error) {
      sendResponse({ ok: false, error: String(error.message || error) });
    }
  })();
  return true;
});
