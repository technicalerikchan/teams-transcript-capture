const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const routing = require('../routing.js');
const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const manifest = require('../manifest.json');

function load(initial = {}) {
  const storage = structuredClone(initial), downloads = [], messages = [], matches = new Map(), requests = [];
  const document = { body: null, title: 'Calendar | Microsoft Teams', readyState: 'complete', visibilityState: 'visible', children: [],
    documentElement: { appendChild() {} }, querySelectorAll: selector => matches.get(selector) || [], contains: node => !!node, addEventListener() {} };
  const window = { addEventListener() {}, removeEventListener() {} }; window.top = window;
  let saver = async () => ({ ok: false, error: 'Native host unavailable' });
  const context = { window, document, TtcRouting: routing, crypto: { randomUUID }, location: { href: 'https://teams.cloud.microsoft/' },
    navigator: { clipboard: { async writeText() {} } }, localStorage: { length: 0 }, sessionStorage: { length: 0 },
    console: { log() {} }, setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    chrome: { runtime: { getManifest: () => manifest, onMessage: { addListener() {} }, async sendMessage(msg) {
      requests.push(msg);
      if (msg.type === 'ttc-save-transcript') return saver(msg.pending);
      if (msg.type === 'ttc-get-route') return { route: routing.resolveRoute(storage.ttc_route, msg.tenantKey), selection: storage.ttc_route || 'auto' };
      return { ok: true, lines: [] };
    } }, storage: { onChanged: { addListener() {} }, local: {
      async get(keys) { return keys === null ? structuredClone(storage) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in storage).map(k => [k, structuredClone(storage[k])])); },
      async set(values) { Object.assign(storage, structuredClone(values)); }, async remove(key) { delete storage[key]; },
    } } }, downloads, messages };
  vm.createContext(context);
  vm.runInContext(source.replace(/\}\)\(\);\s*$/, `
    toast = message => messages.push(message);
    runBridge = async () => {};
    downloadFallback = (name, content) => downloads.push({name, content});
    globalThis.api = { runDiagnostics, stop, start, flushParkedCore, downloadPending, detectTenant,
      fixture(container = null, route = 'tao') {
        tenantEmail = 'erik@taodigitalsolutions.com'; captureTenant = 'taodigitalsolutions.com'; captureRoute = route;
        startTime = Date.now(); meetingTitle = 'Test meeting'; capturing = true; containerEl = container;
        entries.set('first', {speaker:'Test', text:'First line', order:1, tsMs:startTime});
      }, setSelection(value) { routeSelection = value; }, routeNow,
    };
  })();`), context);
  return { api: context.api, storage, downloads, matches, document, requests, setSaver(fn) { saver = fn; } };
}

test('idle diagnostics show version and meeting selectors, without a fabricated meeting', async () => {
  const env = load(); const rep = await env.api.runDiagnostics();
  assert.equal(rep.version, manifest.version); assert.equal(rep.meetingDetectedNow, false);
  assert.equal(rep.counts.capturing, false); assert.ok(rep.selectors.meetControl.length);
});
test('save diagnostics survive reload without leaking transcript/prompt bodies', async () => {
  const env = load({ttc_last_save:{error:{name:'NotAllowedError'}}, ttc_pending:{name:'meeting.md', content:'PRIVATE_BODY', prompt:'PRIVATE_PROMPT', savedAt:123}});
  const rep = await env.api.runDiagnostics();
  assert.equal(rep.saveDiagnostics.lastSave.error.name, 'NotAllowedError');
  assert.equal(rep.saveDiagnostics.pending[0].name, 'meeting.md');
  assert.doesNotMatch(JSON.stringify(rep), /PRIVATE_BODY|PRIVATE_PROMPT/);
});
test('native failure retains each meeting independently; never automatically downloads', async () => {
  const env = load();
  env.api.fixture(); await env.api.stop(false);
  env.api.fixture(); await env.api.stop(false);
  assert.equal(routing.pendingItems(env.storage).length, 2);
  assert.equal(env.downloads.length, 0);
  assert.equal(env.storage.ttc_last_save.state, 'native-write-failed');
  assert.match(env.storage.ttc_last_save.error.message, /unavailable/);
});
test('changing profile selection does not reroute a captured meeting', async () => {
  const env = load(); env.api.fixture(null, 'cdk'); env.api.setSelection('tao'); await env.api.stop(false);
  const save = env.requests.find(m => m.type === 'ttc-save-transcript');
  assert.equal(save.pending.route, 'cdk');
});
test('legacy pending keeps its recorded tenant instead of inheriting this profile', async () => {
  const env = load({ttc_route:'tao',ttc_pending:{name:'old.md',tenantKey:'cdk.com',savedAt:1,content:'Old text'}});
  await env.api.flushParkedCore();
  const save = env.requests.find(m => m.type === 'ttc-save-transcript');
  assert.equal(save.pending.tenantKey, 'cdk.com'); assert.ok(save.pending.id.startsWith('legacy-'));
});
test('manual download backup keeps recovery data', async () => {
  const env = load(); env.api.fixture(); await env.api.stop(false); await env.api.downloadPending();
  assert.equal(env.downloads.length, 1); assert.equal(routing.pendingItems(env.storage).length, 1);
});
test('last visible DOM lines are captured before confirmed native save', async () => {
  const env = load(); let content;
  const node = {dataset:{},children:[],querySelectorAll:()=>[],textContent:'Last DOM line'};
  env.api.fixture({ownerDocument:env.document,children:[node],querySelectorAll:()=>[]});
  env.setSaver(async p => { content = p.content; delete env.storage[routing.pendingKey(p)]; return {ok:true,route:'tao',path:'/tao/transcript/test.md'}; });
  await env.api.stop(false);
  assert.match(content, /First line/); assert.match(content, /Last DOM line/);
  assert.equal(routing.pendingItems(env.storage).length, 0); assert.equal(env.storage.ttc_status.savedOk, true);
});
test('account detection ignores emails on participant buttons', () => {
  const env = load();
  env.matches.set('button[aria-label], [role="button"][aria-label]', [{getAttribute:k=> k === 'aria-label' ? 'Other attendee other@cdk.com' : 'participant'}]);
  assert.equal(env.api.detectTenant(), 'default');
});
