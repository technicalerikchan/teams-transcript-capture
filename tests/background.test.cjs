const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const routing = require('../routing.js');
const id = 'klhggdgabghfgeaapigeihkmmeinjokn';
function load(initial = {}, native = msg => ({ok:true,route:msg.route,path:`/${msg.route}/transcript/${msg.name}`})) {
  const storage = structuredClone(initial), calls = []; let listener;
  const ctx = { URL, TtcRouting:routing, importScripts() {}, chrome:{ runtime:{id, onMessage:{addListener:fn=>listener=fn}, sendNativeMessage(_host,msg,callback){calls.push(msg); callback(native(msg));}}, storage:{local:{
    async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in storage).map(k=>[k,structuredClone(storage[k])]));},
    async set(value){Object.assign(storage,structuredClone(value));}, async remove(key){delete storage[key];},
  }}}};
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(__dirname,'../background.js'),'utf8'),ctx);
  return {storage,calls,send: (message,url='https://teams.cloud.microsoft/')=>new Promise(resolve=>listener(message,{id,url},resolve))};
}
const pending = (id='one', route=null, tenantKey='cdk.com') => ({id,route,tenantKey,name:'meeting.md',content:'Transcript',savedAt:1});

test('account routing requires exact domains, profile selection overrides account', () => {
  assert.equal(routing.resolveRoute('auto','CDK.COM'),'cdk');
  assert.equal(routing.resolveRoute('auto','taodigitalsolutions.com'),'tao');
  assert.equal(routing.resolveRoute('auto','cdk.com.attacker.test'),null);
  assert.equal(routing.resolveRoute('auto','__proto__'),null);
  assert.equal(routing.resolveRoute('tao','cdk.com'),'tao');
});
test('new meeting freezes selected CDK route despite later Tao profile setting', async () => {
  const env = load({ttc_route:'tao'}); const p = pending('one','cdk');
  const result = await env.send({type:'ttc-save-transcript',pending:p});
  assert.equal(result.ok,true); assert.equal(env.calls[0].route,'cdk');
  assert.equal(env.storage[routing.pendingKey(p)],undefined);
});
test('legacy pending with CDK domain is never rerouted to Tao', async () => {
  const p = pending(); const env = load({ttc_route:'tao',ttc_pending:p});
  const result = await env.send({type:'ttc-save-transcript',pending:p});
  assert.equal(result.route,'cdk'); assert.equal(env.storage.ttc_pending,undefined);
});
test('unknown tenant is preserved and does not invoke native host', async () => {
  const env = load(); const p = pending('unknown',null,'default');
  const result = await env.send({type:'ttc-save-transcript',pending:p});
  assert.equal(result.ok,false); assert.equal(env.calls.length,0); assert.ok(env.storage[routing.pendingKey(p)]);
});
test('host failure retains multiple pending items', async () => {
  const env = load({},()=>({ok:false,error:'OneDrive unavailable'}));
  for (const id of ['one','two']) await env.send({type:'ttc-save-transcript',pending:pending(id)});
  assert.equal(routing.pendingItems(env.storage).length,2); assert.equal(env.storage.ttc_last_save.state,'native-write-failed');
});
test('unrelated website cannot invoke local writer', async () => {
  const env = load(); const result = await env.send({type:'ttc-save-transcript',pending:pending()},'https://example.com/');
  assert.equal(result.ok,false); assert.equal(env.calls.length,0);
});
test('invalid host acknowledgement leaves recovery intact', async () => {
  const env = load({},()=>({ok:true,route:'tao',path:'/wrong/meeting.md'})); const p = pending();
  const result = await env.send({type:'ttc-save-transcript',pending:p});
  assert.equal(result.ok,false); assert.ok(env.storage[routing.pendingKey(p)]);
});
