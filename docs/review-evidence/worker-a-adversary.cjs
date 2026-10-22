'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const repoRoot = path.resolve(process.argv[2] || process.env.MORI_REVIEW_REPO || process.cwd());
const baselineRoot = process.argv[3] || process.env.MORI_REVIEW_BASELINE;
const outputDir = path.resolve(process.env.MORI_REVIEW_OUTPUT || path.join(require('node:os').tmpdir(), 'mori-independent-source-review'));
fs.mkdirSync(outputDir, { recursive: true });
const root = path.join(repoRoot, 'overlay/extensions/browser-bridge');
const source = fs.readFileSync(`${root}/service-worker.js`, 'utf8');
// Freeze the reviewed worker; B is being developed concurrently by its owner.
fs.writeFileSync(path.join(outputDir, 'worker-a-source.js'), source);
const clone = value => structuredClone(value);
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function ticks() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
function initialRecord(id, tabId, conversation) {
  return { sessionId: id, tabId, provider: 'chatgpt', documentId: `doc_${id}`, pageInstanceId: `page_${id}`,
    conversationRef: `/c/${conversation}`, routeRevision: 0, sequence: 7, generation: 0, phase: 'idle',
    outcome: null, observation: 'fresh', announced: true, closed: false, turnId: null,
    contentGenerationToken: null, lastContentSequence: 2, unknownAfterReload: false,
    lastObservationAt: Date.now(), conversationTitle: `Name ${conversation}`, requestPreview: `Submitted ${conversation}` };
}
function event() { const listeners = []; return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)), listeners }; }
async function harness(options = {}) {
  const utils = require(`${root}/provider-utils.js`), coordinator = require(`${root}/session-coordinator.js`);
  const transportApi = require(`${root}/transport.js`);
  const recordA = initialRecord('record_A', 11, 'A');
  const store = { local: { moriClientId: 'review_client', moriCredential: { clientId: 'review_client',
    instanceId: 'desktop_review', port: transportApi.PORTS[0], key: Buffer.alloc(32, 7).toString('base64url') },
    moriSettings: { enabled: true }, moriOutbox: { v: 1, events: [] } },
    session: { moriSessions: { v: 1, browserRunId: 'run_review', tabs: {11: 'record_A'}, sessions: {record_A: recordA} } } };
  if (options.seed) options.seed(store);
  const writes = [], recoveryCalls = [], transports = [], timerJobs = new Map(), identities = new Map(), observationSequences = new Map(); let clock = 0, timerId = 0;
  const tabs = new Map([[11, { id: 11, status: 'complete', url: 'https://chatgpt.com/c/A', windowId: 1 }]]);
  let queryCount = 0;
  const chrome = {
    runtime: { id: 'review_extension', getManifest: () => ({version:'0.1.7'}), getURL: path => `chrome-extension://review_extension/${path}`,
      onMessage:event(), onStartup:event(), onInstalled:event(), openOptionsPage() {} },
    storage: {},
    tabs: { query: query => { queryCount++; return options.query ? options.query(query, queryCount) : Promise.resolve([...tabs.values()]); },
      get: async id => { if (options.get) await options.get(id); if (!tabs.has(id)) throw Error('missing tab'); return clone(tabs.get(id)); },
      sendMessage: async (id, message) => {
        if(options.send){const override=await options.send(id,message);if(override!==undefined)return override;}
        return message.type === 'mori.observer.identity' ? clone(identities.get(id))
          : ({ok:true, pageInstanceId:message.pageInstanceId, conversationRef:message.conversationRef});
      },
      onRemoved:event(), onUpdated:event(), update: async id => clone(tabs.get(id)) },
    windows: { update: async () => ({}) }, permissions: {contains:async()=>true},
    alarms: {create: (...args) => options.alarm ? options.alarm(...args) : Promise.resolve(), onAlarm:event()}, action:{onClicked:event()},
  };
  for (const area of ['local','session']) chrome.storage[area] = {
    setAccessLevel: async () => { if (options.failure === `${area}.access`) throw Error('controlled'); },
    get: async keys => {
      if (options.failure === `${area}.get`) throw Error('controlled');
      return Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(key=>Object.hasOwn(store[area],key)).map(key=>[key,clone(store[area][key])]));
    },
    set: async values => {
      writes.push({area, values:clone(values), event:'begin'});
      if (options.write) await options.write(area, values, writes);
      if (options.failure === `${area}.set`) throw Error('controlled');
      Object.assign(store[area],clone(values)); writes.push({area,values:clone(values),event:'commit'});
    },
  };
  const fakeTransport = class {
    constructor(config) { this.config = config; transports.push(this); }
    setEnabled(enabled) { this.enabled = enabled; }
    isReady() { return false; }
    async ensureConnected() {}
    disconnect() {}
  };
  const context = { chrome, crypto: crypto.webcrypto, URL, Promise, Date, Set, Map, Object, Number, Array, structuredClone,
    setTimeout: (fn, ms) => { const id=++timerId; timerJobs.set(id,{fn,at:clock+ms}); return id; },
    clearTimeout: id => timerJobs.delete(id), importScripts() {},
    MoriProviderUtils:utils, MoriSessionCoordinator:coordinator, MoriOutbox:require(`${root}/outbox.js`),
    MoriTransport:{...transportApi,Transport:fakeTransport},
    MoriObserverRecovery:{createRecovery:()=>({ensure:async tab=>{recoveryCalls.push(clone(tab));return {ok:true,disposition:'healthy'};},invalidate(){},invalidateAll(){}})},
  };
  vm.runInNewContext(options.workerSource || source,context);
  await ticks();
  const result = {store,writes,recoveryCalls,tabs,chrome,identities,transports,
    async message(message, sender) {
      return new Promise(resolve => chrome.runtime.onMessage.listeners[0](message,sender||{id:chrome.runtime.id,url:chrome.runtime.getURL('options.html')},resolve));
    },
    async status() { return result.message({type:'mori.options.status'}); },
    async advance(ms) { clock+=ms; for(const [id,job] of [...timerJobs]) if(job.at<=clock){timerJobs.delete(id);job.fn();} await ticks(); },
    async observe(tabId, conversation, pageInstanceId, values={}) {
      tabs.set(tabId,{id:tabId,status:'complete',url:`https://chatgpt.com/c/${conversation}`,windowId:1});
      const sender={id:chrome.runtime.id,frameId:0,documentId:`doc_${conversation}`,url:`https://chatgpt.com/c/${conversation}`,tab:{id:tabId}};
      let lease={};
      if ((options.workerSource||source).includes("message.type === 'mori.observer.register'")) {
        let identity=identities.get(tabId);
        if (!identity||identity.pageInstanceId!==pageInstanceId||identity.route.conversationRef!==`/c/${conversation}`) {
          identity={ok:true,v:1,observerVersion:'0.1.7',pageInstanceId,
            route:{provider:'chatgpt',path:`/c/${conversation}`,conversationRef:`/c/${conversation}`},binding:{state:'confirmed',epoch:`binding_${conversation}`},lease:null};
          identities.set(tabId,identity);
          const granted=await result.message({type:'mori.observer.register',v:1,pageInstanceId,observerVersion:'0.1.7',attemptId:null},sender);
          if (!granted.ok) return granted;
          identity.lease={workerEpoch:granted.workerEpoch,leaseId:granted.leaseId,bindingEpoch:granted.bindingEpoch};
        }
        lease=identity.lease;
      }
      const sequence=(observationSequences.get(tabId)||9)+1;observationSequences.set(tabId,sequence);
      return result.message({type:'mori.observation',v:1,pageInstanceId,contentSequence:sequence,observedAt:Date.now(),
        status:'idle',generationToken:null,outcome:null,conversationTitle:`Name ${conversation}`,requestPreview:`Submitted ${conversation}`,...lease,...values},sender);
    },
  };
  return result;
}

const results=[];
async function check(name,fn) {try{await fn();results.push({name,status:'PASS'});}catch(error){results.push({name,status:'FAIL',reason:error.message});}}
async function reconcilePause(workerSource=source){
  const queryHold=deferred(),writeHold=deferred();let reached=false;
  const ui=await harness({workerSource,
    seed:store=>{store.session.moriSessions.tabs[22]='record_B';store.session.moriSessions.sessions.record_B=initialRecord('record_B',22,'B');},
    query:(_query,count)=>count===1?queryHold.promise:Promise.resolve([]),
    write:async(area,values)=>{if(!reached&&area==='session'&&values.moriSessions.sessions.record_A?.closed){reached=true;await writeHold.promise;}},
  });
  queryHold.resolve([]);await ticks();assert.equal(reached,true,'first close must actually reach its persistence latch');
  let controlReturned=false;const control=ui.message({type:'mori.options.enabled',enabled:false}).then(value=>{controlReturned=true;return value;});
  await ticks();assert.equal(controlReturned,false,'pause success must wait for earlier admitted persistence');
  assert.equal((await ui.observe(33,'C','page_C')).ok,false,'control receipt must immediately stop later admissions');
  writeHold.resolve();assert.equal((await control).ok,true);await ticks();
  assert.equal(ui.store.local.moriSettings.enabled,false);
  assert.equal(ui.store.session.moriSessions.sessions.record_A.closed,true);
  assert.equal(ui.store.session.moriSessions.sessions.record_B.closed,false,'later enumeration candidate may not start after pause request');
  assert.equal(ui.store.local.moriOutbox.events.length,1,'the earlier durable close remains available');
}
async function main() {
  if (!baselineRoot) throw new Error('Supply the baseline snapshot directory as argument 3 or MORI_REVIEW_BASELINE.');
  await check('pending initial query does not block readiness; deadline invalidates late empty reply',async()=>{
    const pending=deferred(), ui=await harness({query:()=>pending.promise});
    let resolved=false, response;
    ui.status().then(value=>{resolved=true;response=value;});await ticks();
    assert.equal(resolved,true);assert.equal(response.ok,true);assert.equal(response.paired,true);
    await ui.advance(1499);assert.equal((await ui.status()).diagnostic,null);
    await ui.advance(1);assert.equal((await ui.status()).diagnostic,'tab_query_timeout');
    pending.resolve([]);await ticks();
    assert.equal(ui.store.session.moriSessions.tabs[11],'record_A');
    assert.equal(ui.store.session.moriSessions.sessions.record_A.closed,false);
    assert.equal(ui.store.local.moriCredential.instanceId,'desktop_review');
  });
  for (const failure of ['sync','reject']) await check(`${failure} query failure remains nonfatal; alarm can request fresh observation`,async()=>{
    const ui=await harness({query:(query,count)=>{if(count===1){if(failure==='sync')throw Error('controlled');return Promise.reject(Error('controlled'));}return Promise.resolve([{id:11,url:'https://chatgpt.com/c/A'}]);}});
    assert.equal((await ui.status()).ok,true);assert.equal((await ui.status()).diagnostic,'tab_query_failed');
    ui.chrome.alarms.onAlarm.emit({name:'mori-reconnect'});await ticks();
    assert.equal(ui.recoveryCalls.length,1);assert.equal(ui.recoveryCalls[0].id,11);
    assert.equal((await ui.status()).diagnostic,null);
  });
  await check('alarm retries physical reconciliation after the initial query failed',async()=>{
    const ui=await harness({query:(_query,count)=>count===1?Promise.reject(Error('controlled')):Promise.resolve([])});
    assert.equal(ui.store.session.moriSessions.sessions.record_A.closed,false);
    ui.chrome.alarms.onAlarm.emit({name:'mori-reconnect'});await ticks();
    assert.equal(ui.store.session.moriSessions.sessions.record_A.closed,true);
    assert.equal(ui.store.local.moriOutbox.events.filter(event=>event.kind==='closed').length,1);
  });
  await check('alarm reconciles a tab removed while paused after monitoring resumes',async()=>{
    const ui=await harness();assert.equal((await ui.message({type:'mori.options.enabled',enabled:false})).ok,true);
    ui.tabs.delete(11);ui.chrome.tabs.onRemoved.emit(11);await ticks();
    assert.equal(ui.store.session.moriSessions.sessions.record_A.closed,false);
    assert.equal((await ui.message({type:'mori.options.enabled',enabled:true})).ok,true);
    ui.chrome.alarms.onAlarm.emit({name:'mori-reconnect'});await ticks();
    assert.equal(ui.store.session.moriSessions.sessions.record_A.closed,true);
    assert.equal(ui.store.local.moriOutbox.events.filter(event=>event.kind==='closed').length,1);
  });
  await check('old enumeration does not close newly admitted B',async()=>{
    const pending=deferred(), ui=await harness({query:(query,count)=>count===1?pending.promise:Promise.resolve([])});
    assert.equal((await ui.observe(22,'B','page_B')).ok,true);
    const bId=ui.store.session.moriSessions.tabs[22];assert.ok(bId);
    pending.resolve([{id:11}]);await ticks();
    assert.equal(ui.store.session.moriSessions.tabs[22],bId);assert.equal(ui.store.session.moriSessions.sessions[bId].closed,false);
  });
  await check('old enumeration does not close replaced A document/route',async()=>{
    const pending=deferred(), ui=await harness({query:(query,count)=>count===1?pending.promise:Promise.resolve([])});
    assert.equal((await ui.observe(11,'B','page_B')).ok,true);
    const bId=ui.store.session.moriSessions.tabs[11];assert.notEqual(bId,'record_A');
    pending.resolve([]);await ticks();
    assert.equal(ui.store.session.moriSessions.tabs[11],bId);assert.equal(ui.store.session.moriSessions.sessions[bId].closed,false);
  });
  await check('URL-redacted live tab is not closed',async()=>{
    const ui=await harness({query:query=>Promise.resolve(Object.hasOwn(query,'url')?[]:[{id:11}])});
    assert.equal(ui.store.session.moriSessions.tabs[11],'record_A');
    assert.equal(ui.store.session.moriSessions.sessions.record_A.closed,false);
  });
  for(const failure of ['local.access','session.access','local.get','session.get']) await check(`${failure} still fails closed`,async()=>{
    const ui=await harness({failure});const status=await ui.status();assert.equal(status.ok,false);assert.equal(status.connection.code,'storage_failed');
  });
  await check('invalid credential is local_data_invalid',async()=>{
    const ui=await harness({seed:store=>{store.local.moriCredential.key='bad';}});const status=await ui.status();
    assert.equal(status.ok,false);assert.equal(status.connection.code,'local_data_invalid');
  });
  await check('close commit failure preserves durable receipt and raises storage_failed',async()=>{
    const ui=await harness({query:()=>Promise.resolve([]),write:(area,values)=>{if(area==='session'&&values.moriSessions.sessions.record_A.closed)throw Error('controlled');}});
    const status=await ui.status();assert.equal(status.ok,false);assert.equal(status.connection.code,'storage_failed');
    assert.equal(ui.store.local.moriOutbox.events.length,1);assert.equal(ui.store.local.moriOutbox.events[0].kind,'closed');
    assert.equal(ui.store.session.moriSessions.sessions.record_A.closed,false);
  });
  await check('alarm failure has separate category',async()=>{
    const ui=await harness({alarm:()=>{throw Error('controlled');}});const status=await ui.status();
    assert.equal(status.ok,true);assert.equal(status.diagnostic,'alarm_failed');
  });
  await check('pause waits for admitted close, immediately blocks new observations, and stops remaining query candidates',()=>reconcilePause());
  await check('reconcile pause sensitivity: removing between-record gate fails on later B closure',async()=>{
    const exact='      if (generation !== controlGeneration || admissionBlockReason()) return;\n      const record = sessions.sessions[candidate.sessionId];';
    assert.equal(source.includes(exact),true,'mutation target must exist');
    const mutation=source.replace(exact,'      const record = sessions.sessions[candidate.sessionId];');
    let caught;try{await reconcilePause(mutation);}catch(error){caught=error;}
    assert.ok(caught);assert.match(caught.message,/later enumeration candidate/);
  });
  await check('pause after durable terminal journal waits for session persistence and preserves receipt',async()=>{
    const hold=deferred();let enabled=false,reached=false;
    const ui=await harness({write:async(area,values)=>{if(enabled&&!reached&&area==='session'&&values.moriSessions.sessions.record_A?.phase==='settled'){reached=true;await hold.promise;}}});
    assert.equal((await ui.observe(11,'A','page_A',{status:'running',generationToken:'generation_A'})).ok,true);
    enabled=true;
    const terminal=ui.observe(11,'A','page_A',{status:'settled',generationToken:'generation_A',outcome:'unverified'});
    await ticks();assert.equal(reached,true);assert.equal(ui.store.local.moriOutbox.events.filter(event=>event.kind==='terminal').length,1);
    let returned=false;const pause=ui.message({type:'mori.options.enabled',enabled:false}).then(value=>{returned=true;return value;});
    await ticks();assert.equal(returned,false);hold.resolve();
    assert.equal((await terminal).ok,true);assert.equal((await pause).ok,true);await ticks();
    assert.equal(ui.store.local.moriSettings.enabled,false);assert.equal(ui.store.local.moriOutbox.events.filter(event=>event.kind==='terminal').length,1);
    assert.equal(ui.store.session.moriSessions.sessions.record_A.phase,'settled');
  });
  await check('final focus response cannot accept a route changed while its response was in flight',async()=>{
    let ui,focusChecks=0;
    ui=await harness({send:(_id,message)=>{
      if(message.type==='mori.focus.check'&&++focusChecks===2){
        ui.tabs.set(11,{id:11,status:'complete',url:'https://chatgpt.com/c/B',windowId:1});
        return {ok:true,pageInstanceId:message.pageInstanceId,conversationRef:message.conversationRef};
      }
    }});
    assert.equal((await ui.observe(11,'A','page_A')).ok,true);
    const saved=ui.store.session.moriSessions,record=saved.sessions[saved.tabs[11]];
    const response=await ui.transports[0].config.onFocus({v:1,browserRunId:saved.browserRunId,requestId:'focus_review',noticeSequence:null,
      sessionId:record.sessionId,tabId:11,pageInstanceId:record.pageInstanceId,routeRevision:record.routeRevision,conversationRef:'/c/A'});
    assert.equal(focusChecks,2,'final validation must reach the delayed old response');
    assert.equal(response.ok,false,'current route B must not yield focus success for A');
  });
  await check('baseline sensitivity: query throw incorrectly becomes storage failure',async()=>{
    const baseline=fs.readFileSync(path.join(path.resolve(baselineRoot), 'overlay/extensions/browser-bridge/service-worker.js'),'utf8');
    const ui=await harness({workerSource:baseline,query:()=>{throw Error('controlled');}});const status=await ui.status();
    assert.equal(status.ok,false);assert.equal(status.connection.code,'storage_failed');
  });
  const output={scope:'Actual frozen worker/coordinator/outbox at persistence and Chrome API boundaries; reviewer-owned API doubles; not real Chrome or recovery completion',sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),results};
  fs.writeFileSync(path.join(outputDir, 'worker-a-results.json'),JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify(output,null,2));process.exitCode=results.every(result=>result.status==='PASS')?0:1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
