/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
// Plumbing only: these artificial sockets/readers establish no Chrome,
// provider-DOM, continuous-scope, authentication or timing acceptance result.
const test = require('node:test');
const assert = require('node:assert/strict');
const {createWorkerCapture} = require('../extensions/browser-bridge/native-measurement-worker');
const {createContentCapture} = require('../extensions/browser-bridge/native-measurement-content');

function runtime() {
  const listeners = new Set(), messages = [];
  const chrome = {runtime:{id:'owned-extension',getURL:p => `chrome-extension://owned-extension/${p}`,
    onMessage:{addListener:f => listeners.add(f),removeListener:f => listeners.delete(f)},
    sendMessage:async m => { messages.push(structuredClone(m)); return {ok:true,recording:false,acceptedRecords:m.records.length}; }}};
  return {chrome,messages,listeners,
    request(message,sender) { let response,asynchronous = false;
      for (const listener of listeners) asynchronous ||= listener(message,sender,r => {response = r;}) === true;
      return {response,asynchronous}; },
    async requestAsync(message,sender) {
      return new Promise(resolve => { for (const listener of listeners) {
        const keep = listener(message,sender,resolve); if (keep) return;
      }});
    }};
}
class Socket {
  constructor(...args) {this.args = args;this.sent = [];this.listeners = new Set();this.closeListeners = new Set();this.throwSend = false;}
  addEventListener(kind,listener) {if(kind === 'message')this.listeners.add(listener);if(kind === 'close')this.closeListeners.add(listener);}
  removeEventListener(kind,listener) {if(kind === 'message')this.listeners.delete(listener);if(kind === 'close')this.closeListeners.delete(listener);}
  send(...args) {if(this.throwSend)throw new Error('owned-send-failure');this.sent.push(args);return 71;}
  receive(value) {for(const f of this.listeners)f({data:JSON.stringify(value)});}
  close() {for(const f of [...this.closeListeners])f({type:'close'});return 83;}
}
function ticking() {let at = 10;return () => at++;}
const scope = {kind:'view',viewEpoch:'private-view',bindingEpoch:'private-binding',samplingEpoch:'private-sampling',
  workerEpoch:'private-worker',leaseId:'private-lease',documentId:'private-document',startUnobserved:true};
const identity = {browserRunId:'private-run',sessionId:'private-session',eventId:'private-event',sequence:1,
  tabId:29,pageInstanceId:'private-page',routeRevision:0,turnId:'private-turn',generation:1,kind:'terminal',scope};
const observation = {contentSequence:1,pageInstanceId:identity.pageInstanceId,generationToken:'private-generation',
  samplingEpoch:scope.samplingEpoch,workerEpoch:scope.workerEpoch,leaseId:scope.leaseId,bindingEpoch:scope.bindingEpoch,
  viewEpoch:scope.viewEpoch,scopeKind:scope.kind,startUnobserved:true};
const sender = {id:'owned-extension',frameId:0,documentId:scope.documentId,documentLifecycle:'active',
  tab:{id:29},url:'https://chatgpt.com/c/private-route'};
function packet(records,extra = {}) {return {type:'mori.native.records',v:1,clockOrigin:2000,missing:false,records,...extra};}
function outbound(event = identity) {return {...event,type:'scope.event',v:1,schema:2,provider:'chatgpt',
  phase:'settled',outcome:'unverified',observation:'fresh',observedAt:1700000000000,replay:false,
  conversationRef:null,conversationTitle:'',requestPreview:'',gap:null};}
function ack(event = identity,extra = {}) {return {type:'scope.event.ack',schema:2,eventId:event.eventId,
  browserRunId:event.browserRunId,sessionId:event.sessionId,sequence:event.sequence,disposition:'committed_current',duplicate:false,proof:'private-proof',reason:null,...extra};}
function dom() {return {provider:'chatgpt',scopeKind:'view',state:'running',reason:'observed',
  counts:{main:1,display:1,composer:1,editor:1,form:1,stop:1,busy:1},sameScope:true,
  continuity:'unknown',continuous1s:false,uncertainty:null,interval:[0,1]};}

test('native adapters: real API bytes pass through and anonymous sample/event/ACK ordinals correlate', t => {
  const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => capture.dispose());
  const socket = new capture.WebSocketClass('ws://127.0.0.1:23333');
  const bytes = JSON.stringify(outbound());
  assert.equal(socket.send(bytes),71);
  assert.equal(socket.sent[0][0],bytes);
  assert.equal(r.request(packet([{kind:'observation',at:2011,observation}]),sender).response.ok,true);
  assert.equal(capture.sink.linkSample({contentSequence:1,pageInstanceId:identity.pageInstanceId,generationToken:observation.generationToken},scope,[identity]),true);
  socket.receive(ack());
  assert.equal(capture.sink.currentAck(identity,{sameConnection:true}),true);
  const snapshot = capture.snapshot(), link = snapshot.records.find(r => r.kind === 'sample_link');
  assert.equal(snapshot.independentScopeVerified,false);
  assert.equal(snapshot.linkStatus,'link_unverified');
  assert.equal(snapshot.formalAcceptance,false);
  assert.equal(link.sampleOrdinal,1);
  assert.equal(link.eventOrdinal,1);
  for (const k of ['sameScope','sameDocument','sameSampling','generationMatched','samePage','sameLease']) assert.equal(link[k],true);
  assert.equal(snapshot.records.find(r => r.kind === 'current_ack').eventOrdinal,1);
  const serialized = JSON.stringify(snapshot);
  for (const raw of [...Object.values(scope),...Object.values(identity),observation.generationToken]) {
    if(typeof raw === 'string' && raw.startsWith('private-'))assert.equal(serialized.includes(raw),false);
  }
  assert.equal(serialized.includes(sender.url),false);
});

test('native adapters: one sample keeps multiple event identities and old scope fails equality', t => {
  const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => capture.dispose());
  const socket = new capture.WebSocketClass('ws://127.0.0.1:23333');
  const old = {...identity,eventId:'private-old-event',kind:'closed',scope:{...scope,samplingEpoch:'private-old-sampling'}};
  capture.sink.linkSample({contentSequence:1,pageInstanceId:identity.pageInstanceId,generationToken:observation.generationToken},scope,[old,identity]);
  socket.send(JSON.stringify(outbound(old)));socket.send(JSON.stringify(outbound()));
  r.request(packet([{kind:'observation',at:2011,observation}]),sender);
  const links = capture.snapshot().records.filter(r => r.kind === 'sample_link');
  assert.equal(links.length,2);
  assert.deepEqual(links.map(r => r.sampleOrdinal),[1,1]);
  assert.deepEqual(links.map(r => r.eventOrdinal),[1,2]);
  assert.deepEqual(links.map(r => r.sameSampling),[false,true]);
  assert.deepEqual(links.map(r => r.sameScope),[false,true]);
});

test('native adapters: raw ACK and current ACK are distinct, ambiguous retries remain unknown', t => {
  const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => capture.dispose());
  const a = new capture.WebSocketClass('ws://127.0.0.1:23333'), b = new capture.WebSocketClass('ws://127.0.0.1:23333');
  a.send(JSON.stringify(outbound()));b.send(JSON.stringify(outbound()));
  a.receive(ack());b.receive(ack());
  assert.equal(capture.sink.currentAck(identity),false);
  assert.equal(capture.snapshot().status,'unknown');
  assert.equal(capture.snapshot().records.filter(r => r.kind === 'raw_ack').length,2);
  assert.equal(capture.snapshot().records.filter(r => r.kind === 'current_ack').length,0);
});

test('native adapters: duplicate durable ACK is valid capture data and never a current proof', t => {
  const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => capture.dispose());
  const socket = new capture.WebSocketClass('ws://127.0.0.1:23333');
  socket.send(JSON.stringify(outbound()));
  socket.receive(ack(identity,{disposition:'duplicate_durable',duplicate:true,proof:null}));
  assert.equal(capture.snapshot().missing,false);
  assert.equal(capture.snapshot().records.find(r => r.kind === 'raw_ack').disposition,'duplicate_durable');
  assert.equal(capture.sink.currentAck(identity),false);
  assert.equal(capture.snapshot().records.some(r => r.kind === 'current_ack'),false);
});

test('native adapters: ordinary ping/pong clocks need a unique at value per physical socket', t => {
  const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => capture.dispose());
  const socket = new capture.WebSocketClass('ws://127.0.0.1:23333');
  socket.send(JSON.stringify({type:'ping',at:1700000000000}));socket.receive({type:'pong',at:1700000000000});
  const row = capture.snapshot().records.find(r => r.kind === 'ping');
  assert.equal(row.pingAt,1700000000000);assert.ok(row.before <= row.after);
  socket.send(JSON.stringify({type:'ping',at:1700000000000}));socket.receive({type:'pong',at:1700000000000});
  assert.equal(capture.snapshot().missing,true);
  assert.equal(capture.snapshot().records.filter(r => r.kind === 'ping').length,1);
});

test('native adapters: content receiver rejects unknown keys, accessors and untrusted senders', t => {
  const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => capture.dispose());
  let accessed = false;
  const message = {v:1};Object.defineProperty(message,'type',{get(){accessed = true;return 'mori.native.records';}});
  r.request(message,sender);assert.equal(accessed,false);
  r.request(packet([{kind:'observation',at:2011,observation:{...observation,text:'must-not-retain'}}]),sender);
  r.request(packet([{kind:'observation',at:2011,observation}]),{...sender,frameId:1});
  r.request(packet([{kind:'observation',at:2011,observation}]),{...sender,url:'http://chatgpt.com/'});
  r.request(packet([{kind:'observation',at:2011,observation}]),{...sender,url:'https://chatgpt.com:444/'});
  assert.equal(capture.snapshot().records.length,0);
  assert.equal(JSON.stringify(capture.snapshot()).includes('must-not-retain'),false);
});

test('native adapters: exact options source can asynchronously export even without a frameId', async t => {
  const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => capture.dispose());
  const options = {id:r.chrome.runtime.id,url:r.chrome.runtime.getURL('options.html')};
  assert.equal(r.request({type:'mori.native.export',v:1},{...options,url:'https://chatgpt.com/'}).asynchronous,false);
  const snapshot = await r.requestAsync({type:'mori.native.export',v:1},options);
  assert.equal(snapshot.v,1);assert.equal(snapshot.formalAcceptance,false);
});

test('native adapters: content clock targets the exact document and export adds a final probe', async t => {
  const r = runtime(), calls = [];
  r.chrome.tabs = {sendMessage:async (tabId,message,options) => {
    calls.push({tabId,message,options});
    return {type:'mori.native.clock',v:1,probeOrdinal:message.probeOrdinal,clockOrigin:2000,received:2010,sent:2011};
  }};
  const capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => capture.dispose());
  r.request(packet([{kind:'observation',at:2011,observation}]),sender);
  const snapshot = await r.requestAsync({type:'mori.native.export',v:1},{id:r.chrome.runtime.id,url:r.chrome.runtime.getURL('options.html')});
  assert.ok(calls.length >= 2);
  assert.equal(calls[0].options.documentId,sender.documentId);
  assert.equal(calls[0].tabId,sender.tab.id);
  assert.ok(snapshot.records.filter(r => r.kind === 'content_clock').length >= 2);
  assert.equal(JSON.stringify(snapshot).includes(sender.documentId),false);
});

test('native adapters: content batches category samples only and accepts worker clock probes', async t => {
  const r = runtime();let disposed = false;
  const capture = createContentCapture({chrome:r.chrome,document:{},readRoute:() => null,provider:'chatgpt',
    readerFactory:opts => {assert.equal(opts.observeMutations,true);return {sample:dom,dispose(){disposed = true;}};},
    now:ticking(),timeOrigin:2000});
  t.after(() => capture.dispose());
  capture.sink.record('sample_valid');capture.sink.observation(observation);
  assert.equal(await capture.flush(),true);
  const batch = r.messages[0];
  assert.equal(batch.type,'mori.native.records');assert.equal(batch.records[0].kind,'dom');
  assert.equal(Object.hasOwn(batch.records[0].sample,'interval'),false);
  assert.equal(batch.records[0].sample.continuous1s,false);
  const clock = r.request({type:'mori.native.clock',v:1,probeOrdinal:64},{id:r.chrome.runtime.id}).response;
  assert.ok(clock.received <= clock.sent);assert.equal(clock.clockOrigin,2000);
  capture.dispose();assert.equal(disposed,true);assert.equal(r.listeners.size,0);
});

test('native adapters: failed recording and bounded capacity stay unknown without affecting socket errors', t => {
  const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000,maxEntries:1});
  t.after(() => capture.dispose());
  const socket = new capture.WebSocketClass('ws://127.0.0.1:23333');
  socket.throwSend = true;
  assert.throws(() => socket.send(JSON.stringify(outbound())),/owned-send-failure/);
  assert.equal(capture.snapshot().missing,true);
  capture.sink.record('sample_valid');capture.sink.record('sample_valid');
  assert.ok(capture.snapshot().records.length <= 1);
  capture.dispose();assert.equal(socket.listeners.size,0);
  socket.throwSend = false;assert.equal(socket.send('unchanged-after-dispose'),71);
  assert.equal(capture.sink.linkSample({contentSequence:1,pageInstanceId:identity.pageInstanceId,generationToken:null},scope,[identity]),false);
});

function packet2(sequence,records,failures = []) {
  return {type:'mori.native.records',v:2,batchSequence:sequence,clockOrigin:2000,missing:failures.length > 0,records,failures};
}
test('native adapters: worker budget starts at first authenticated record and reconnect never extends it', t => {
  const r = runtime();let at = 0;
  const capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:() => at,timeOrigin:1000,maxDurationMs:100});
  t.after(() => capture.dispose());
  at = 700000;capture.sink.record('worker_received');
  assert.equal(capture.snapshot().capture.phase,'waiting');
  assert.equal(capture.snapshot().capture.startedAt,null);
  assert.equal(capture.snapshot().failures.expired.count,0);
  const waitingStage = {kind:'stage',at:2001,stage:'authenticated_ready',fields:{},recording:false};
  const before = r.request(packet2(1,[waitingStage]),sender).response;
  assert.equal(before.recording,false);assert.equal(capture.snapshot().capture.startedAt,null);
  assert.equal(capture.sink.record('authenticated_ready'),true);
  assert.equal(capture.snapshot().capture.startedAt,701000);
  at += 80;capture.sink.record('authenticated_ready');
  assert.equal(capture.snapshot().capture.startedAt,701000);
  assert.equal(capture.snapshot().capture.elapsedMs,80);
  at += 21;
  assert.equal(capture.snapshot().capture.phase,'unknown');
  assert.equal(capture.snapshot().failures.expired.count,1);
  assert.equal(capture.snapshot().failures.expired.firstAt,701101);
  assert.equal(capture.snapshot().failures.expired.count,1);
});

test('native adapters: content waits for recording:true and never relabels its waiting rows', async t => {
  const r = runtime();let at = 0, active = false;
  r.chrome.runtime.sendMessage = async message => {r.messages.push(structuredClone(message));return {ok:true,recording:active,acceptedRecords:message.records.length};};
  const capture = createContentCapture({chrome:r.chrome,document:{},readRoute:() => null,provider:'chatgpt',readerFactory:() => ({sample:dom}),
    now:() => at,timeOrigin:2000,maxDurationMs:100});
  t.after(() => capture.dispose());
  at = 700000;capture.sampleNow();assert.equal(await capture.flush(),true);
  assert.equal(capture.snapshot().capture.phase,'waiting');assert.equal(capture.snapshot().failures.expired.count,0);
  active = true;capture.sampleNow();await capture.flush();
  assert.equal(capture.snapshot().capture.startedAt,702000);
  assert.equal(r.messages.flatMap(m => m.records).every(row => row.recording === false),true);
  at += 50;capture.sampleNow();await capture.flush();
  assert.equal(r.messages.at(-1).records[0].recording,true);
  assert.equal(capture.snapshot().capture.elapsedMs,50);
  at += 30;capture.sink.record('sample_valid');await capture.flush();
  assert.equal(capture.snapshot().capture.startedAt,702000);
  at += 21;assert.equal(capture.snapshot().failures.expired.count,1);
  assert.equal(capture.snapshot().capture.phase,'unknown');
});

test('native adapters: v2 detects skipped/duplicate batches and strictly rejects mixed legacy envelopes', t => {
  const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => capture.dispose());
  const row = {kind:'stage',at:2001,stage:'registration_result',fields:{status:'failed',reason:'unclassified'},recording:false};
  assert.equal(r.request(packet2(1,[row]),sender).response.ok,true);
  assert.equal(r.request(packet2(3,[row]),sender).response.ok,true);
  assert.equal(r.request(packet2(3,[row]),sender).response.ok,false);
  assert.equal(r.request(packet([], {failures:[]}),sender).response.ok,false);
  const snapshot = capture.snapshot();
  assert.equal(snapshot.failures.batch_gap.count,1);assert.equal(snapshot.failures.batch_duplicate.count,1);
  assert.equal(snapshot.failures.invalid_schema.count,1);
  assert.deepEqual(snapshot.batches,{received:4,rejected:2,recordsAccepted:2});
});

test('native adapters: content failures are fixed categories, imported once by cumulative count', async t => {
  const r = runtime();
  const worker = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => worker.dispose());
  r.chrome.runtime.sendMessage = async m => {r.messages.push(structuredClone(m));return r.request(m,sender).response;};
  const content = createContentCapture({chrome:r.chrome,document:{},readRoute:() => null,provider:'chatgpt',
    readerFactory:() => ({sample(){throw new Error('private-exception-must-not-leak');}}),now:ticking(),timeOrigin:2000});
  t.after(() => content.dispose());
  await content.flush();
  assert.equal(worker.snapshot().failures.reader_failed.count,1);
  content.sampleNow();await content.flush();
  const snapshot = worker.snapshot();
  assert.equal(snapshot.failures.reader_failed.count,2);
  assert.equal(snapshot.contentFailures[0].failures.reader_failed.count,2);
  assert.ok(snapshot.contentFailures[0].failures.reader_failed.firstAt <= snapshot.contentFailures[0].failures.reader_failed.lastAt);
  assert.equal(JSON.stringify(snapshot).includes('private-exception-must-not-leak'),false);
  const forged = packet2(3,[],[{category:'arbitrary-text',count:1,firstAt:null,lastAt:null}]);
  assert.equal(r.request(forged,sender).response.ok,false);
});

test('native adapters: failed batches drop their original rows instead of replaying them as successful', async t => {
  const r = runtime();let attempt = 0;
  r.chrome.runtime.sendMessage = async m => {r.messages.push(structuredClone(m));if(!attempt++)throw new Error('private-transport-error');return {ok:true,recording:false,acceptedRecords:m.records.length};};
  const content = createContentCapture({chrome:r.chrome,document:{},readRoute:() => null,provider:'chatgpt',
    readerFactory:() => ({sample:dom}),now:ticking(),timeOrigin:2000});
  t.after(() => content.dispose());
  assert.equal(await content.flush(),false);assert.equal(await content.flush(),true);
  assert.deepEqual(r.messages.map(m => m.batchSequence),[1,2]);
  assert.equal(r.messages[0].records[0].kind,'dom');
  assert.equal(r.messages[1].records.some(row => row.kind === 'dom'),false);
  assert.equal(content.snapshot().failures.batch_send_failed.count,1);
  assert.deepEqual(content.snapshot().batches,{attempted:2,acked:1,failed:1,recordsDropped:1,recordsConfirmed:1});
  assert.equal(JSON.stringify(content.snapshot()).includes('private-transport-error'),false);
});

test('native adapters: clock/capacity/probe/schema failures have separate anonymous diagnostics', async t => {
  const r = runtime();let at = 10;
  const worker = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:() => at,timeOrigin:1000,maxEntries:1});
  t.after(() => worker.dispose());
  worker.sink.record('sample_valid');worker.sink.record('sample_valid');
  assert.equal(worker.snapshot().failures.capacity.count,1);assert.equal(worker.snapshot().capture.lastRecordAt,1010);
  const c = runtime(), reversed = createWorkerCapture({chrome:c.chrome,WebSocketClass:Socket,now:() => at,timeOrigin:1000});
  t.after(() => reversed.dispose());reversed.sink.record('sample_valid');at = 9;
  assert.equal(reversed.snapshot().failures.clock_reversed.count,1);
  assert.equal(reversed.snapshot().failures.clock_reversed.firstAt,null);
  const p = runtime();p.chrome.tabs = {sendMessage:async () => {throw new Error('private-probe');}};
  const probed = createWorkerCapture({chrome:p.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => probed.dispose());p.request(packet([]),sender);await probed.probeClocks();
  assert.ok(probed.snapshot().failures.clock_probe_failed.count >= 1);
  assert.equal(JSON.stringify(probed.snapshot()).includes('private-probe'),false);
});

test('native adapters: an explicit unknown DOM category is valid data, not a capture failure', async t => {
  const r = runtime();
  const content = createContentCapture({chrome:r.chrome,document:{},readRoute:() => null,provider:'chatgpt',
    readerFactory:() => ({sample:() => ({...dom(),scopeKind:'unknown',state:'unknown',reason:'main_not_unique',sameScope:false,uncertainty:'explicit_unknown'})}),
    now:ticking(),timeOrigin:2000});
  t.after(() => content.dispose());
  assert.equal(await content.flush(),true);
  assert.equal(content.snapshot().missing,false);
  assert.equal(Object.values(content.snapshot().failures).every(row => row.count === 0),true);
  assert.equal(r.messages[0].records[0].sample.state,'unknown');
  assert.equal(r.messages[0].records[0].recording,false);
});

test('native adapters: batch response timeout is explicit and failed original records are dropped', async t => {
  const r = runtime();r.chrome.runtime.sendMessage = () => new Promise(() => {});
  const content = createContentCapture({chrome:r.chrome,document:{},readRoute:() => null,provider:'chatgpt',
    readerFactory:() => ({sample:dom}),now:ticking(),timeOrigin:2000});
  t.after(() => content.dispose());
  assert.equal(await content.flush(),false);
  const snapshot = content.snapshot();
  assert.equal(snapshot.failures.batch_timeout.count,1);
  assert.equal(snapshot.batches.failed,1);assert.equal(snapshot.batches.recordsDropped,1);
});

test('native adapters: document clock timeout is distinct from schema and general probe failure', async t => {
  const r = runtime();r.chrome.tabs = {sendMessage:() => new Promise(() => {})};
  const capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => capture.dispose());
  r.request(packet([]),sender);
  await new Promise(resolve => setTimeout(resolve,1550));
  const snapshot = capture.snapshot();
  assert.equal(snapshot.failures.clock_probe_timeout.count,1);
  assert.equal(snapshot.failures.clock_probe_failed.count,0);
  assert.equal(snapshot.failures.invalid_schema.count,0);
});

test('native adapters: duplicate observations reject the whole batch before appending any row', t => {
  const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => capture.dispose());capture.sink.record('authenticated_ready');
  const row = {kind:'observation',at:2010,observation,recording:true};
  assert.equal(r.request(packet2(1,[row]),sender).response.acceptedRecords,1);
  const before = capture.snapshot().counts.records;
  const stage = {kind:'stage',at:2011,stage:'sample_valid',fields:{},recording:true};
  assert.deepEqual(r.request(packet2(2,[stage,row]),sender).response,{ok:false,recording:false,acceptedRecords:0});
  assert.equal(capture.snapshot().counts.records,before);
  const fresh = {...row,observation:{...observation,contentSequence:2}};
  assert.deepEqual(r.request(packet2(3,[fresh,fresh]),sender).response,{ok:false,recording:false,acceptedRecords:0});
  assert.equal(capture.snapshot().batches.recordsAccepted,1);
  assert.equal(capture.snapshot().failures.sample_duplicate.count,2);
});

test('native adapters: transport acceptance is separate from unknown capture health', t => {
  const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => capture.dispose());capture.sink.record('authenticated_ready');
  const row = {kind:'stage',at:2011,stage:'sample_valid',fields:{},recording:true};
  const response = r.request(packet2(2,[row]),sender).response;
  assert.deepEqual(response,{ok:true,recording:false,acceptedRecords:1});
  assert.equal(capture.snapshot().capture.phase,'unknown');
  assert.equal(capture.snapshot().records.find(r => r.kind === 'content_stage').recording,false);
});

test('native adapters: capacity consumed by sample links reports actual partial acceptance', t => {
  const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000,maxEntries:7});
  t.after(() => capture.dispose());capture.sink.record('authenticated_ready');
  const socket = new capture.WebSocketClass('ws://127.0.0.1:23333');
  const second = {...identity,eventId:'private-second-event',sequence:2};
  socket.send(JSON.stringify(outbound()));socket.send(JSON.stringify(outbound(second)));
  capture.sink.linkSample({contentSequence:1,pageInstanceId:identity.pageInstanceId,generationToken:observation.generationToken},scope,[identity,second]);
  const rows = [{kind:'observation',at:2010,observation,recording:true},
    {kind:'stage',at:2011,stage:'sample_valid',fields:{},recording:true}];
  assert.deepEqual(r.request(packet2(1,rows),sender).response,{ok:false,recording:false,acceptedRecords:1});
  assert.equal(capture.snapshot().batches.recordsAccepted,1);
  assert.equal(capture.snapshot().counts.records,7);
});

test('native adapters: partial confirmations count only confirmed rows and never replay dropped rows', async t => {
  const r = runtime();let attempt = 0;
  r.chrome.runtime.sendMessage = async m => {r.messages.push(structuredClone(m));return attempt++
    ? {ok:true,recording:false,acceptedRecords:m.records.length} : {ok:false,recording:false,acceptedRecords:1};};
  const content = createContentCapture({chrome:r.chrome,document:{},readRoute:() => null,provider:'chatgpt',
    readerFactory:() => ({sample:dom}),now:ticking(),timeOrigin:2000});
  t.after(() => content.dispose());content.sink.record('sample_valid');
  assert.equal(await content.flush(),false);
  assert.equal(content.snapshot().counts.sent,1);
  assert.equal(content.snapshot().batches.recordsConfirmed,1);
  assert.equal(content.snapshot().batches.recordsDropped,1);
  assert.equal(await content.flush(),true);
  assert.equal(r.messages[1].records.every(row => row.kind === 'capture_error'),true);
  assert.equal(content.snapshot().batches.recordsConfirmed,2);
});

test('native adapters: failure-clock reads also advance both monotonic high water marks', t => {
  const r = runtime();let at = 100;
  const capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:() => at,timeOrigin:1000});
  t.after(() => capture.dispose());capture.sink.record('sample_valid');
  at = 200;r.request(packet2(1,[]),{...sender,frameId:1});
  at = 150;assert.equal(capture.snapshot().failures.clock_reversed.count,1);
  const c = runtime();let script = null;
  const content = createContentCapture({chrome:c.chrome,document:{},readRoute:() => null,provider:'chatgpt',
    readerFactory:() => ({sample:dom}),now:() => script?.length ? script.shift() : 100,timeOrigin:2000});
  t.after(() => content.dispose());
  script = [100,200,150];content.sink.record('not_a_stage');
  assert.equal(content.snapshot().failures.clock_reversed.count,1);
  assert.equal(content.snapshot().failures.invalid_schema.firstAt,2200);
});

test('native adapters: final rejected reports stop after three failures even after expiry', async t => {
  const r = runtime();let at = 100, calls = 0, readerDisposed = 0;
  r.chrome.runtime.sendMessage = async m => ++calls === 1 ? {ok:true,recording:true,acceptedRecords:m.records.length}
    : {ok:false,recording:false,acceptedRecords:0};
  const content = createContentCapture({chrome:r.chrome,document:{},readRoute:() => null,provider:'chatgpt',
    readerFactory:() => ({sample:dom,dispose(){readerDisposed++;}}),now:() => at,timeOrigin:2000,maxDurationMs:1});
  t.after(() => content.dispose());await content.flush();
  at = 103;assert.equal(content.snapshot().failures.expired.count,1);
  for (let i = 0; i < 5; i++) await content.flush();
  await new Promise(resolve => setTimeout(resolve,300));
  const snapshot = content.snapshot();
  assert.equal(calls,4);assert.equal(readerDisposed,1);
  assert.equal(snapshot.failures.batch_retry_exhausted.count,1);
  assert.equal(snapshot.batches.failed,3);assert.equal(snapshot.counts.queued,0);
  assert.equal(snapshot.capture.maxConsecutiveBatchFailures,3);
});

const inventoryKeys = ['main','form','editable','textbox','prompt','stop','busy','streaming','assistantMarker','conversationTurn',
  'chatgptOwner','chatgptComposerOwner','chatgptMessageOwner','claudeHubRoot','claudeInput','conversationId','chatId','threadId','canonical'];
function structureInventory() {
  return {provider:'chatgpt',routeKind:'conversation',visible:true,counts:Object.fromEntries(inventoryKeys.map(k =>
    [k,{found:1,visible:1,matchesCurrentRoute:0,capped:false}]))};
}
function visibleDocument(state = 'visible') {
  const listeners = new Set();
  return {visibilityState:state,listeners,
    addEventListener(kind,f) {if(kind === 'visibilitychange')listeners.add(f);},
    removeEventListener(kind,f) {if(kind === 'visibilitychange')listeners.delete(f);},
    show() {this.visibilityState = 'visible';for(const f of [...listeners])f();}};
}
test('native inventory: fixed nested counters are captured only at first/5s/10s and never prove scope', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const r = runtime(), document = visibleDocument(), called = [];let at = 0;
  const capture = createContentCapture({chrome:r.chrome,document,readRoute:() => null,provider:'chatgpt',readerFactory:() => ({sample:dom}),
    structureInspector:args => {assert.equal(args.document,document);called.push(at);return structureInventory();},now:() => at,timeOrigin:2000});
  t.after(() => capture.dispose());await capture.flush();
  at = 5000;t.mock.timers.tick(5000);await capture.flush();
  at = 10000;t.mock.timers.tick(5000);await capture.flush();
  at = 20000;t.mock.timers.tick(10000);document.show();
  assert.deepEqual(called,[0,5000,10000]);
  assert.equal(capture.snapshot().counts.inventories,3);
  const rows = r.messages.flatMap(m => m.records).filter(row => row.kind === 'structure_inventory');
  assert.equal(rows.length,3);assert.equal(rows.every(row => row.recording === false),true);
  assert.equal(Object.keys(rows[0].inventory.counts).length,19);
  assert.equal(capture.snapshot().formalAcceptance,false);
});

test('native inventory: hidden documents wait for visibility and disposal cancels remaining inspections', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const r = runtime(), document = visibleDocument('hidden');let called = 0;
  const capture = createContentCapture({chrome:r.chrome,document,readRoute:() => null,provider:'chatgpt',readerFactory:() => ({sample:dom}),
    structureInspector:() => {called++;return structureInventory();},now:ticking(),timeOrigin:2000});
  t.after(() => capture.dispose());t.mock.timers.tick(5000);assert.equal(called,0);
  document.show();assert.equal(called,1);document.visibilityState = 'hidden';
  t.mock.timers.tick(5000);assert.equal(called,1);
  capture.dispose();document.show();t.mock.timers.tick(10000);
  assert.equal(called,1);assert.equal(document.listeners.size,0);
});

test('native inventory: repeated factories share the document inspection budget', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const r = runtime(), document = visibleDocument();let first = 0, second = 0;
  const base = {chrome:r.chrome,document,readRoute:() => null,provider:'chatgpt',readerFactory:() => ({sample:dom}),now:ticking(),timeOrigin:2000};
  const a = createContentCapture({...base,structureInspector:() => {first++;return structureInventory();}});
  const b = createContentCapture({...base,structureInspector:() => {second++;return structureInventory();}});
  t.after(() => {a.dispose();b.dispose();});t.mock.timers.tick(10000);
  assert.equal(first,3);assert.equal(second,0);
});

test('native inventory: malformed/throwing inspectors expose only a fixed failure category', async t => {
  const r = runtime(), document = visibleDocument();let accessed = false;
  const bad = structureInventory();Object.defineProperty(bad.counts.main,'found',{get(){accessed = true;return 1;}});
  const a = createContentCapture({chrome:r.chrome,document,readRoute:() => null,provider:'chatgpt',readerFactory:() => ({sample:dom}),
    structureInspector:() => bad,now:ticking(),timeOrigin:2000});
  t.after(() => a.dispose());assert.equal(accessed,false);
  assert.equal(a.snapshot().failures.structure_inventory_failed.count,1);await a.flush();
  assert.equal(r.messages.flatMap(m => m.records).some(row => row.kind === 'structure_inventory'),false);
  const b = createContentCapture({chrome:r.chrome,document:visibleDocument(),readRoute:() => null,provider:'chatgpt',readerFactory:() => ({sample:dom}),
    structureInspector:() => {throw new Error('private-owner-text');},now:ticking(),timeOrigin:2000});
  t.after(() => b.dispose());assert.equal(b.snapshot().failures.structure_inventory_failed.count,1);
  assert.equal(JSON.stringify(b.snapshot()).includes('private-owner-text'),false);
});

test('native inventory: worker strictly bounds schema/provider and accepts at most three per document', t => {
  const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => capture.dispose());
  const row = {kind:'structure_inventory',before:2001,after:2002,recording:false,inventory:structureInventory()};
  assert.deepEqual(r.request(packet2(1,[row,row,row]),sender).response,{ok:true,recording:false,acceptedRecords:3});
  assert.equal(capture.snapshot().counts.inventories,3);
  assert.equal(r.request(packet2(2,[row]),sender).response.ok,false);
  assert.equal(capture.snapshot().failures.structure_inventory_failed.count,1);
  const next = {...sender,documentId:'private-next-document'};
  assert.equal(r.request(packet2(1,[row]),next).response.ok,true);
  assert.equal(r.request(packet2(2,[row]),sender).response.ok,false);
  assert.equal(capture.snapshot().counts.inventories,4);
  assert.equal(JSON.stringify(capture.snapshot()).includes(sender.documentId),false);
  assert.equal(capture.snapshot().independentScopeVerified,false);
});

test('native inventory: unknown keys/getters/over-cap counts and legacy rows are rejected', t => {
  const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => capture.dispose());
  const row = {kind:'structure_inventory',before:2001,after:2002,recording:false,inventory:structureInventory()};
  const variants = [];
  let bad = structureInventory();bad.counts.main.found = 201;variants.push(bad);
  bad = structureInventory();delete bad.counts.canonical;variants.push(bad);
  bad = structureInventory();bad.counts.main.text = 'private-owner-text';variants.push(bad);
  bad = structureInventory();bad.provider = 'claude';variants.push(bad);
  let accessed = false;bad = structureInventory();Object.defineProperty(bad,'routeKind',{get(){accessed = true;return 'conversation';}});variants.push(bad);
  for (let i = 0; i < variants.length; i++) assert.equal(r.request(packet2(i + 1,[{...row,inventory:variants[i]}]),sender).response.ok,false);
  const claimedClaude = {...row,inventory:{...structureInventory(),provider:'claude'}};
  assert.equal(r.request(packet2(8,[claimedClaude]),{...sender,url:'https://claude.ai/chat/private-route'}).response.ok,false);
  assert.equal(accessed,false);
  const legacy = {...row};delete legacy.recording;
  assert.equal(r.request(packet([legacy]),sender).response.ok,false);
  assert.equal(capture.snapshot().counts.inventories,0);
  assert.equal(JSON.stringify(capture.snapshot()).includes('private-owner-text'),false);
});

test('native inventory: unregistered old document arrival never prevents later document samples', t => {
  const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => capture.dispose());
  const old = {...sender,documentId:'private-historical-document',documentLifecycle:'active'};
  const current = {...sender,documentId:'private-later-document',documentLifecycle:'active'};
  const row = {kind:'structure_inventory',before:2001,after:2002,recording:false,inventory:structureInventory()};
  assert.equal(r.request(packet2(1,[row]),current).response.ok,true);
  // Chrome's sender snapshot may still say active for a delayed old message.
  assert.equal(r.request(packet2(1,[row]),old).response.ok,true);
  assert.deepEqual(r.request(packet2(2,[row]),current).response,{ok:true,recording:false,acceptedRecords:1});
  const snapshot = capture.snapshot(), rows = snapshot.records.filter(row => row.kind === 'structure_inventory');
  assert.equal(rows.length,3);
  assert.equal(rows[0].documentOrdinal,rows[2].documentOrdinal);
  assert.notEqual(rows[0].documentOrdinal,rows[1].documentOrdinal);
  assert.equal(snapshot.failures.invalid_sender.count,0);
  assert.equal(snapshot.currentDocumentVerified,false);
  assert.equal(snapshot.independentScopeVerified,false);
  assert.equal(JSON.stringify(snapshot).includes(current.documentId),false);
});

test('native inventory: each endpoint rejects visible or route-match counts greater than found', async t => {
  for (const field of ['visible','matchesCurrentRoute']) {
    const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
    t.after(() => capture.dispose());
    const bad = structureInventory();bad.counts.main.found = 0;bad.counts.main.visible = 0;bad.counts.main[field] = 1;
    const row = {kind:'structure_inventory',before:2001,after:2002,recording:false,inventory:bad};
    assert.deepEqual(r.request(packet2(1,[row]),sender).response,{ok:false,recording:false,acceptedRecords:0});
    assert.equal(capture.snapshot().counts.inventories,0);
    const c = runtime(), content = createContentCapture({chrome:c.chrome,document:visibleDocument(),readRoute:() => null,provider:'chatgpt',
      readerFactory:() => ({sample:dom}),structureInspector:() => bad,now:ticking(),timeOrigin:2000});
    t.after(() => content.dispose());await content.flush();
    assert.equal(content.snapshot().failures.structure_inventory_failed.count,1);
    assert.equal(c.messages.flatMap(packet => packet.records).some(row => row.kind === 'structure_inventory'),false);
  }
});

test('native sockets: more than 65 sequential reconnects reclaim active slots and preserve native send', t => {
  const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => capture.dispose());
  for (let i = 0; i < 90; i++) {
    const socket = new capture.WebSocketClass('ws://127.0.0.1:23333');
    const bytes = JSON.stringify({type:'ping',at:1700000000000 + i});
    assert.equal(socket.send(bytes),71);assert.equal(socket.sent[0][0],bytes);
    socket.receive({type:'pong',at:1700000000000 + i});
    assert.equal(capture.snapshot().counts.activeConnections,1);
    assert.equal(socket.close(),83);
    assert.equal(socket.listeners.size,0);assert.equal(socket.closeListeners.size,0);
    assert.equal(capture.snapshot().counts.activeConnections,0);
  }
  const snapshot = capture.snapshot();
  assert.equal(snapshot.counts.connections,90);
  assert.equal(snapshot.counts.activeSocketLimitHits,0);
  assert.equal(snapshot.failures.capacity.count,0);
  assert.equal(snapshot.missing,false);
  assert.equal(snapshot.records.filter(row => row.kind === 'ping').length,90);
  assert.equal(snapshot.limits.maxActiveSockets,64);assert.equal(snapshot.limits.maxTotalConnections,null);
});

test('native sockets: simultaneous active cap marks missing and released slots do not reset history', t => {
  const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => capture.dispose());
  const sockets = Array.from({length:64},() => new capture.WebSocketClass('ws://127.0.0.1:23333'));
  const omitted = new capture.WebSocketClass('ws://127.0.0.1:23333');
  assert.equal(omitted.send('original-omitted-bytes'),71);assert.equal(omitted.sent[0][0],'original-omitted-bytes');
  assert.equal(omitted.listeners.size,0);assert.equal(omitted.closeListeners.size,0);
  assert.equal(capture.snapshot().counts.activeConnections,64);
  assert.equal(capture.snapshot().counts.activeSocketLimitHits,1);
  assert.equal(capture.snapshot().failures.capacity.count,1);
  sockets[0].close();
  const next = new capture.WebSocketClass('ws://127.0.0.1:23333');
  next.send(JSON.stringify({type:'ping',at:1700000000001}));next.receive({type:'pong',at:1700000000001});
  const snapshot = capture.snapshot();
  assert.equal(snapshot.counts.connections,66);assert.equal(snapshot.counts.activeConnections,64);
  assert.equal(snapshot.records.find(row => row.kind === 'ping').connectionOrdinal,66);
  assert.equal(snapshot.missing,true);
  capture.sink.record('authenticated_ready');assert.equal(capture.snapshot().missing,true);
  for (const socket of sockets)socket.close();next.close();omitted.close();
  assert.equal(capture.snapshot().counts.activeConnections,0);
});

test('native sockets: an old acknowledged connection cannot validate the new physical socket event', t => {
  const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => capture.dispose());
  const old = new capture.WebSocketClass('ws://127.0.0.1:23333');
  old.send(JSON.stringify(outbound()));old.receive(ack());old.close();
  const current = new capture.WebSocketClass('ws://127.0.0.1:23333');
  current.send(JSON.stringify(outbound()));
  assert.equal(capture.sink.currentAck(identity,{sameConnection:true}),false);
  old.receive(ack());
  assert.equal(capture.snapshot().records.filter(row => row.kind === 'raw_ack').length,1);
  current.receive(ack());assert.equal(capture.sink.currentAck(identity,{sameConnection:true}),true);
  const snapshot = capture.snapshot(), validated = snapshot.records.filter(row => row.kind === 'current_ack');
  assert.equal(validated.length,1);assert.equal(validated[0].connectionOrdinal,2);assert.equal(validated[0].eventOrdinal,1);
  assert.equal(snapshot.records.filter(row => row.kind === 'raw_ack').length,2);
  assert.equal(snapshot.missing,true);
});

test('native sockets: disposal removes only capture listeners and preserves anonymous evidence and socket behavior', t => {
  const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => capture.dispose());
  const socket = new capture.WebSocketClass('ws://127.0.0.1:23333');let messages = 0, closes = 0;
  socket.addEventListener('message',() => {messages++;});socket.addEventListener('close',() => {closes++;});
  socket.send(JSON.stringify(outbound()));socket.receive(ack());
  const before = capture.snapshot().counts.records;
  capture.dispose();assert.equal(r.listeners.size,0);
  assert.equal(socket.listeners.size,1);assert.equal(socket.closeListeners.size,1);
  assert.equal(capture.snapshot().counts.activeConnections,0);
  assert.equal(capture.snapshot().counts.records,before);
  assert.equal(socket.send('post-dispose-original'),71);socket.receive(ack());assert.equal(messages,2);
  socket.throwSend = true;assert.throws(() => socket.send('post-dispose-failure'),/owned-send-failure/);
  assert.equal(socket.close(),83);assert.equal(closes,1);
  assert.equal(capture.snapshot().counts.records,before);
});

test('native batches: document diagnostics distinguish legacy/v2 reporting and accepted/rejected versions', t => {
  const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => capture.dispose());
  const row = {kind:'stage',at:2011,stage:'sample_valid',fields:{}};
  r.request(packet([row]),sender);
  let doc = capture.snapshot().contentFailures[0];
  assert.equal(doc.failureReporting,'legacy_only');assert.deepEqual(doc.batchVersions,{v1:1,v2:0});
  assert.equal(Object.values(doc.failures).every(row => row.count === 0),true);
  r.request(packet([{...row,text:'not-accepted'}]),sender);
  r.request(packet2(1,[{...row,recording:false}]),sender);
  r.request(packet2(1,[{...row,recording:false}]),sender);
  doc = capture.snapshot().contentFailures[0];
  assert.equal(doc.failureReporting,'mixed');assert.deepEqual(doc.batchVersions,{v1:2,v2:2});
  assert.deepEqual(doc.batchResults,{v1:{accepted:1,rejected:1},v2:{accepted:1,rejected:1}});
  const next = {...sender,documentId:'private-v2-only-document'};
  r.request(packet2(1,[{...row,recording:false}]),next);
  const other = capture.snapshot().contentFailures[1];
  assert.equal(other.failureReporting,'v2_only');assert.deepEqual(other.batchVersions,{v1:0,v2:1});
  assert.equal(JSON.stringify(capture.snapshot()).includes('not-accepted'),false);
});

test('native socket close: unacknowledged event and ping leave anonymous incomplete evidence', t => {
  const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => capture.dispose());
  const socket = new capture.WebSocketClass('ws://127.0.0.1:23333');
  socket.send(JSON.stringify(outbound()));socket.send(JSON.stringify({type:'ping',at:1700000000000}));
  socket.close();socket.receive(ack());
  const snapshot = capture.snapshot(), row = snapshot.records.find(row => row.kind === 'socket_closed');
  assert.equal(snapshot.missing,true);assert.equal(snapshot.failures.socket_evidence_incomplete.count,1);
  assert.deepEqual(snapshot.socketClosures,{incomplete:1,pendingEvents:1,pendingCurrentAcks:0,pendingPings:1});
  assert.equal(row.connectionOrdinal,1);assert.equal(row.pendingEvents,1);assert.equal(row.pendingCurrentAcks,0);
  assert.equal(row.pendingPings,1);assert.equal(row.reason,'socket_evidence_incomplete');assert.equal(typeof row.at,'number');
  assert.equal(snapshot.records.some(row => row.kind === 'raw_ack'),false);
  assert.equal(JSON.stringify(snapshot).includes(identity.eventId),false);
  assert.equal(snapshot.counts.activeConnections,0);
});

test('native socket close: proof-bearing current ACK without individual validation remains pending', t => {
  const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => capture.dispose());
  const old = new capture.WebSocketClass('ws://127.0.0.1:23333');
  old.send(JSON.stringify(outbound()));old.receive(ack());old.close();
  assert.deepEqual(capture.snapshot().socketClosures,{incomplete:1,pendingEvents:0,pendingCurrentAcks:1,pendingPings:0});
  const next = new capture.WebSocketClass('ws://127.0.0.1:23333');next.send(JSON.stringify(outbound()));
  assert.equal(capture.sink.currentAck(identity,{sameConnection:true}),false);
  next.receive(ack());assert.equal(capture.sink.currentAck(identity,{sameConnection:true}),true);next.close();
  assert.equal(capture.snapshot().failures.socket_evidence_incomplete.count,1);
  assert.equal(capture.snapshot().missing,true);
  assert.equal(capture.snapshot().records.find(row => row.kind === 'current_ack').connectionOrdinal,2);
});

test('native socket close: verified current ACK, noncurrent ACK and empty close are not capture failures', t => {
  const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  t.after(() => capture.dispose());
  const current = new capture.WebSocketClass('ws://127.0.0.1:23333');
  current.send(JSON.stringify(outbound()));current.receive(ack());assert.equal(capture.sink.currentAck(identity),true);current.close();
  for (const disposition of ['committed_receipt','duplicate_durable','ignored_order','committed_current']) {
    const socket = new capture.WebSocketClass('ws://127.0.0.1:23333');socket.send(JSON.stringify(outbound()));
    socket.receive(ack(identity,{disposition,proof:null}));socket.close();
  }
  new capture.WebSocketClass('ws://127.0.0.1:23333').close();
  const snapshot = capture.snapshot();
  assert.equal(snapshot.missing,false);assert.equal(snapshot.failures.socket_evidence_incomplete.count,0);
  assert.deepEqual(snapshot.socketClosures,{incomplete:0,pendingEvents:0,pendingCurrentAcks:0,pendingPings:0});
  assert.equal(snapshot.records.some(row => row.kind === 'socket_closed'),false);
});

test('native socket close: capacity cause survives repeated cleanup without posthalt close failures', t => {
  const r = runtime(), capture = createWorkerCapture({chrome:r.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000,maxEntries:1});
  t.after(() => capture.dispose());
  const socket = new capture.WebSocketClass('ws://127.0.0.1:23333');socket.send(JSON.stringify(outbound()));
  const before = capture.snapshot();
  assert.equal(before.failures.capacity.count,1);assert.equal(before.missing,true);assert.equal(before.capture.phase,'unknown');
  socket.close();socket.close();capture.dispose();
  const snapshot = capture.snapshot();
  assert.equal(snapshot.counts.records,1);assert.deepEqual(snapshot.failures.capacity,before.failures.capacity);
  assert.equal(snapshot.status,'unknown');assert.equal(snapshot.missing,true);assert.equal(snapshot.capture.phase,'unknown');
  assert.deepEqual(snapshot.socketClosures,{incomplete:0,pendingEvents:0,pendingCurrentAcks:0,pendingPings:0});
  assert.equal(snapshot.failures.socket_evidence_incomplete.count,0);
  assert.equal(snapshot.counts.activeConnections,0);assert.equal(socket.listeners.size,0);assert.equal(socket.closeListeners.size,0);
});


test('native diagnostics: ACK proof/replay and gate bind one exact event without exposing values',()=>{
  const env=runtime(),capture=createWorkerCapture({chrome:env.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
  try {
    const socket=new capture.WebSocketClass('ws://owned');
    socket.send(JSON.stringify(outbound()));socket.receive(ack());
    assert.equal(capture.sink.ackDecision(identity,{gate:'sample_expired',proofPresent:true,replay:false,sameConnection:true}),true);
    let rows=capture.snapshot().records;
    assert.equal(rows.find(r=>r.kind==='raw_ack').proofPresent,true);
    assert.equal(rows.find(r=>r.kind==='raw_ack').replay,false);
    const decision=rows.find(r=>r.kind==='ack_decision');
    assert.equal(decision.gate,'sample_expired');assert.equal(decision.eventOrdinal,1);
    assert.equal(rows.some(r=>r.kind==='current_ack'),false);
    const next={...identity,eventId:'next',sequence:2};
    socket.send(JSON.stringify({...outbound(next),replay:true}));socket.receive(ack(next,{proof:null,disposition:'duplicate_durable'}));
    assert.equal(capture.sink.ackDecision(next,{gate:'proof_absent',proofPresent:false,replay:true,sameConnection:true}),true);
    rows=capture.snapshot().records;
    assert.equal(rows.filter(r=>r.kind==='raw_ack')[1].proofPresent,false);
    assert.equal(rows.filter(r=>r.kind==='raw_ack')[1].replay,true);
    assert.doesNotMatch(JSON.stringify(rows),/private-|owned|next|proof_bytes/);
  } finally {capture.dispose();}
});
test('native diagnostics: worker self identity and readonly preflight never assert artifact load',()=>{
  const env=runtime();let at=10;
  const capture=createWorkerCapture({chrome:env.chrome,WebSocketClass:Socket,now:()=>at,timeOrigin:1000,buildFingerprint:'a'.repeat(64)});
  try {
    const state={initialized:true,paired:false,enabled:true,pendingControl:false,fatal:false,transportReady:false};
    assert.equal(capture.sink.setWorkerStateReader(()=>({...state})),true);
    assert.equal(capture.sink.setWorkerStateReader(()=>({})),false);
    let s=capture.snapshot();assert.equal(s.preflight.reason,'unpaired');assert.equal(s.preflight.canRecord,false);
    assert.equal(s.runtime.buildFingerprint,'a'.repeat(64));assert.equal(s.runtime.bootstrappedAt,1010);
    assert.equal(s.runtime.loadedArtifactVerified,false);assert.equal(s.capture.remainingMs,600000);
    state.paired=true;state.transportReady=true;capture.sink.record('authenticated_ready');at=20;
    s=capture.snapshot();assert.equal(s.preflight.reason,'ready');assert.equal(s.preflight.canRecord,true);assert.equal(s.capture.remainingMs,599990);
    state.pendingControl=true;assert.equal(capture.snapshot().preflight.reason,'paused');
    state.pendingControl=false;state.fatal=true;assert.equal(capture.snapshot().preflight.reason,'storage_failed');
    assert.equal(capture.snapshot().formalAcceptance,false);
  } finally {capture.dispose();}
});
test('native diagnostics: registration reasons and real inspection stages survive strict content batch',async()=>{
  const env=runtime(),reader={sample:dom,dispose(){}};
  const capture=createContentCapture({chrome:env.chrome,document:{visibilityState:'visible'},provider:'chatgpt',readRoute:()=>'',
    readerFactory:()=>reader,now:ticking(),timeOrigin:2000});
  try {
    for(const reason of ['binding_unconfirmed','attempt_expired','runtime_unavailable','registration_replaced','observer_queue_full'])
      assert.equal(capture.sink.registrationResult({status:'failed',reason}),true);
    assert.equal(capture.sink.registrationResult({status:'failed',reason:'PRIVATE_EXCEPTION'}),true);
    for(const stage of ['observer_install_deferred','product_inspection_started','product_inspection_finished'])
      assert.equal(capture.sink.record(stage,stage==='observer_install_deferred'?{reason:'initializing'}:{}),true);
    await capture.flush();
    const records=env.messages.find(m=>m.type==='mori.native.records').records;
    assert.deepEqual(records.filter(r=>r.stage==='registration_result').map(r=>r.fields.reason),
      ['binding_unconfirmed','attempt_expired','runtime_unavailable','registration_replaced','observer_queue_full','unclassified']);
    const workerEnv=runtime();workerEnv.chrome.tabs={sendMessage:async (_tab,m)=>({type:'mori.native.clock',v:1,probeOrdinal:m.probeOrdinal,clockOrigin:2000,received:2020,sent:2021})};
    const worker=createWorkerCapture({chrome:workerEnv.chrome,WebSocketClass:Socket,now:ticking(),timeOrigin:1000});
    try {assert.equal(workerEnv.request(env.messages[0],sender).response.ok,true);
      assert.equal(worker.snapshot().missing,false);assert.doesNotMatch(JSON.stringify(worker.snapshot()),/PRIVATE_EXCEPTION/);
    } finally {worker.dispose();}
  } finally {capture.dispose();}
});
