/* Profile-local routing controls; no browser filesystem authorization needed. */
function render(s) {
  document.getElementById('state').textContent = s ? (s.capturing ? '擷取中…' : '閒置') : '尚未在 Teams 分頁啟動';
  document.getElementById('dot').className = 'dot ' + (s?.capturing ? 'rec' : 'idle');
  document.getElementById('auto').textContent = s ? (s.auto ? 'AUTO 開' : 'AUTO 關') : '—';
  document.getElementById('lines').textContent = `${s?.lines || 0} 行`;
  document.getElementById('folder').textContent = s?.folder || '請設定分流';
  document.getElementById('tenant').textContent = s?.tenant || '未偵測';
  document.getElementById('file').textContent = s?.lastFile || '—';
}
const route = document.getElementById('route');
const result = document.getElementById('routing-result');
chrome.storage.local.get(['ttc_status', 'ttc_route']).then(data => {
  render(data.ttc_status);
  route.value = TtcRouting.validRoute(data.ttc_route) ? data.ttc_route : 'auto';
});
route.addEventListener('change', async () => {
  await chrome.storage.local.set({ ttc_route: route.value });
  result.textContent = '已記住此 profile 的設定；適用下一場會議，已暫存會議保留原目的地。';
});
document.getElementById('check-routing').addEventListener('click', async () => {
  result.textContent = '檢查中…';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'ttc-routing-status' });
    if (!response?.ok) throw new Error(response?.error || '未連線');
    result.textContent = Object.entries(response.routes).map(([key, target]) => `${TtcRouting.ROUTES[key].label}: ${target.available ? '已掛載' : '未掛載'}\n${target.path}`).join('\n\n');
  } catch (error) { result.textContent = error.message; }
});
chrome.storage.onChanged.addListener(changes => {
  if (changes.ttc_status) render(changes.ttc_status.newValue);
  if (changes.ttc_route) route.value = changes.ttc_route.newValue || 'auto';
});
