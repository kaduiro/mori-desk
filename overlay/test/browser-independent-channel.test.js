'use strict';
// Author regression only. Synthetic vault, owner tokens and Node MessageEvent
// facade; real HMAC/loopback/store. Not independent Chrome/provider acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const http = require('node:http');
const {createChannelCapture} = require('../scripts/monitoring-independent-channel');
const {createNativeCollector} = require('../scripts/native-measurement-collector');
const {Transport} = require('../extensions/browser-bridge/transport');
const {createBrowserBridge} = require('../src/browser-bridge-server');
const codec = require('../scripts/monitoring-independent-payload');
const token = () => Object.freeze({});
const eventKeys = ['type','v','schema','eventId','browserRunId','sessionId','sequence','kind','provider','tabId','pageInstanceId',
  'routeRevision','conversationRef','turnId','generation','phase','outcome','observation','observedAt','replay','scope','gap'];
function event(sequence=1) { return {type:'scope.event',v:1,schema:2,eventId:`event-${sequence}`,browserRunId:'run',sessionId:'session',sequence,
  kind:'observation',provider:'chatgpt',tabId:1,pageInstanceId:'page',routeRevision:1,conversationRef:'/c/conversation',turnId:null,generation:0,
  phase:'idle',outcome:null,observation:'fresh',observedAt:Date.now(),replay:false,
  scope:{kind:'conversation',viewEpoch:'view',bindingEpoch:'binding',samplingEpoch:'sampling',workerEpoch:'worker',leaseId:'lease',documentId:'document',startUnobserved:false},gap:null}; }
function projection(value) {
  if (value.type === 'scope.event') return Object.fromEntries(eventKeys.map(k => [k,value[k]]));
  if (value.type === 'scope.event.ack') { const {proof,...body} = value; return {...body,proofPresent:proof!==null}; }
  if (['ping','pong','scope.event.nack'].includes(value.type)) return value;
  return null;
}
function unit(side='collector',maxMessages=100) {
  let at = 0; const capture=createChannelCapture({side,targetPingOrdinal:2,maxMessages,now:()=>at});
  const socket=token();capture.sink.socketOpened(socket);capture.sink.authenticated(socket,token());
  function message(type,body,direction='client_to_server') {
    const h=capture.sink.messageBegin(socket,{direction,type,projection:body,phase:'recording',before:at});
    if(h)capture.sink.messageEnd(h,{status:direction==='client_to_server'&&side==='collector'||direction==='server_to_client'&&side==='worker'?'received':'returned',after:at});
    return h;
  }
  return {capture,socket,message,advance:n=>{at+=n;}};
}
test('fixed ping cut excludes coalesced health suffix and preserves both direction suffix rows',()=>{
  const u=unit();
  u.message('ping',{type:'ping',at:100});u.message('pong',{type:'pong',at:100},'server_to_client');
  const k=u.message('ping',{type:'ping',at:200});
  u.message('client.health',null); // independent rx sees this before product pong
  u.message('pong',{type:'pong',at:200},'server_to_client');
  let s=u.capture.snapshot(); assert.equal(s.cut.clientMessageEnd,k.messageOrdinal);assert.equal(s.cut.serverMessageEnd,2);
  assert.equal(s.cut.state,'sealed');assert.equal(s.suffix.clientMessageCount,1);
  u.message('ping',{type:'ping',at:300});u.message('pong',{type:'pong',at:300},'server_to_client');
  s=u.capture.snapshot(); assert.equal(s.cut.clientMessageEnd,2); assert.equal(s.cut.serverMessageEnd,2);
  assert.equal(s.suffix.clientMessageCount,2);assert.equal(s.suffix.serverMessageCount,1);
  assert.equal(s.pings.length,3);assert.equal(s.pings[1].sendReturned,null);
  assert.equal(s.messages.find(r=>r.typeCategory==='client.health').membership,'suffix');
  assert.equal(s.messages[0].pingOrdinal,1);assert.equal(s.formalAcceptance,false);
});
test('raw pong alone cannot seal worker; later failures never recover a shorter cut',()=>{
  const u=unit('worker');
  for(const at of [100,200]) {u.message('ping',{type:'ping',at});u.message('pong',{type:'pong',at},'server_to_client');}
  let s=u.capture.snapshot();assert.equal(s.cut.state,'pending');
  u.capture.sink.failure('send_failed');s=u.capture.snapshot();assert.equal(s.cut.state,'invalid');assert.equal(s.run.eligibility,'unknown');
  u.message('ping',{type:'ping',at:300});u.message('pong',{type:'pong',at:300},'server_to_client');
  assert.equal(u.capture.snapshot().cut.pingAt,200);assert.equal(u.capture.snapshot().reason,'send_failed');
});
test('unknown schema/metadata, duplicate labels, bounds and timeout stay unknown',()=>{
  const a=unit();a.message('scope.event',{...event(),conversationTitle:'PRIVATE_METADATA'});
  assert.equal(a.capture.snapshot().status,'unknown');assert.equal(JSON.stringify(a.capture.snapshot()).includes('PRIVATE_METADATA'),false);
  const b=unit();b.message('ping',{type:'ping',at:100});b.message('ping',{type:'ping',at:100});assert.equal(b.capture.snapshot().reason,'ping_ambiguous');
  const c=unit('collector',1);c.message('client.health',null);c.message('client.health',null);assert.equal(c.capture.snapshot().reason,'capacity');
  const d=unit('worker');for(const at of [100,200]){d.message('ping',{type:'ping',at});d.message('pong',{type:'pong',at},'server_to_client');}
  d.advance(5001);assert.equal(d.capture.snapshot().reason,'ack_timeout');
});
test('collector ingress uses ordered exact head, not eventId search',()=>{
  const u=unit();const a=event(1),b=event(2);u.message('scope.event',a);u.message('scope.event',b);
  u.capture.sink.ingestInput(u.socket,b);assert.equal(u.capture.snapshot().reason,'prefix_mismatch');
});
async function until(fn){const deadline=performance.now()+3000;while(!fn()){if(performance.now()>deadline)throw new Error('test_timeout');await new Promise(r=>setImmediate(r));}}
async function loopback(t){
  const dataDir=fs.mkdtempSync(path.join(__dirname,'../../.tmp-channel-owner-test-'));
  const collector=createNativeCollector({dataDir,safeStorage:{isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'synthetic-test-only',
    encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
  const started=await collector.start();assert.equal(started.ok,true);
  const channel=createChannelCapture({side:'worker',now:()=>performance.now()});
  const sockets=new WeakMap(),rawRefs=new WeakMap(),eventRefs=new WeakMap();
  class Captured extends WebSocket {
    constructor(url){super(url,{origin:'chrome-extension://obooegdoanifidoffaodpobadpeiilcl'});
      const socketRef=token();sockets.set(this,{socketRef,authenticated:false});channel.sink.socketOpened(socketRef);
      let handler=null;Object.defineProperty(this,'onmessage',{configurable:true,get:()=>handler,set:fn=>{handler=fn;}});
      this.on('message',(bytes,binary)=>{const ev=Object.freeze({data:binary?bytes:bytes.toString()});
        const m=JSON.parse(ev.data),at=performance.now(),h=channel.sink.messageBegin(socketRef,{direction:'server_to_client',type:m.type,
          projection:projection(m),phase:sockets.get(this).authenticated?'recording':'waiting',before:at});
        if(h){channel.sink.messageEnd(h,{status:'received',after:performance.now()});rawRefs.set(ev,h);}handler?.(ev);});
      this.on('close',()=>channel.sink.socketClosed(socketRef));
    }
    send(data,...args){const m=JSON.parse(data),s=sockets.get(this),h=channel.sink.messageBegin(s.socketRef,{direction:'client_to_server',type:m.type,
      projection:projection(m),phase:s.authenticated?'recording':'waiting',before:performance.now()});
      let status='threw';try{const r=super.send(data,...args);status='returned';return r;}
      finally{if(h)channel.sink.messageEnd(h,{status,after:performance.now()});}}
  }
  let credential=null;
  const measurement={transportSocketRef:ws=>sockets.get(ws)?.socketRef,transportRawMessageRef:ev=>rawRefs.get(ev),
    transportAuthenticated:(ref,auth)=>{for(const ws of [transport.connection.ws])sockets.get(ws).authenticated=true;channel.sink.authenticated(ref,auth);},
    transportSendBegin:(...args)=>channel.sink.expectSend(...args),transportSendEnd:(...args)=>channel.sink.endExpectedSend(...args),
    transportAckValidated:data=>channel.sink.ackValidated(data),transportPongProcessed:data=>channel.sink.pongProcessed(data),failure:reason=>channel.sink.failure(reason)};
  const transport=new Transport({clientId:'client',browserRunId:'run',getCredential:()=>credential,saveCredential:async c=>{credential=c;},
    WebSocketClass:Captured,measurement,measurementCodec:codec,measurementReferenceFor:e=>eventRefs.get(e)});
  t.after(async()=>{transport.disconnect();await collector.dispose();channel.dispose();fs.rmSync(dataDir,{recursive:true,force:true});});
  await transport.pair(collector.beginPairing().code);
  return {collector,channel,transport,eventRefs};
}
test('real transport owner compares proof without giving proof to channel; current and suffix remain bounded partial evidence',async t=>{
  const f=await loopback(t),e=event();f.eventRefs.set(e,token());const ack=await f.transport.sendEvent(e);
  const consumed=f.transport.measurementAckConsumed(ack,e,f.transport.connection);assert.equal(consumed.proofExact,true);
  assert.equal(Object.hasOwn(consumed.ackProjection,'proof'),false);
  f.channel.sink.validationComplete({...consumed,gate:'accepted_current',at:performance.now()});
  for(const at of [100,200]){f.transport.connection.ws.send(JSON.stringify({type:'ping',at}));await until(()=>f.channel.snapshot().pings.some(p=>p.pingAt===at&&p.productPongProcessed));}
  const s=f.channel.snapshot();assert.equal(s.cut.state,'sealed');assert.equal(s.run.eligibility,'eligible');assert.equal(s.status,'pending');
  const desktop=f.collector.snapshot().channelEvidence;assert.equal(desktop.cut.state,'sealed');
  assert.equal(desktop.cut.localPongLabelMatched,true);assert.equal(desktop.cut.productPongProcessed,false);
  assert.ok(desktop.messages.filter(r=>r.typeCategory==='scope.event.ack').every(r=>r.localStateAttributionExact===true&&r.currentAccepted===null));
  assert.equal(s.formalAcceptance,false);assert.equal(s.strictDirectComparison,false);
  assert.equal(JSON.stringify(s).includes(ack.proof),false);
  f.transport.disconnect('paused');assert.equal(f.channel.snapshot().run.eligibility,'unknown','pause invalidates before async close');
  assert.equal(f.transport.measurementAckConsumed(ack,e,f.transport.connection),null,'consume once');
});
test('same proofPresent with changed proof is false, cloned ACK subject is unavailable',async t=>{
  const f=await loopback(t),e=event();f.eventRefs.set(e,token());const ack=await f.transport.sendEvent(e);
  ack.proof='DIFFERENT_PROOF';const changed=f.transport.measurementAckConsumed(ack,e,f.transport.connection);
  assert.equal(changed.proofExact,false);f.channel.sink.validationComplete({...changed,gate:'accepted_current',at:performance.now()});
  assert.equal(f.channel.snapshot().status,'unknown');
  const e2=event(2);f.eventRefs.set(e2,token());const ack2=await f.transport.sendEvent(e2);
  assert.equal(f.transport.measurementAckConsumed({...ack2},e2,f.transport.connection),null);
  assert.equal(f.transport.measurementAckConsumed(ack2,e2,f.transport.connection).proofExact,true);
});
test('null measurement constructs no dev codec/clock/subject state',()=>{
  let reads=0;const t=new Transport({clientId:'c',browserRunId:'r',getCredential:()=>null,saveCredential:async()=>{},
    measurement:null,measurementNow:()=>{reads++;throw new Error();}});
  assert.equal(reads,0);assert.equal(Object.hasOwn(t,'measurementProofs'),false);assert.equal(Object.hasOwn(t,'measurementCodec'),false);
});
test('normal replay finishes the channel decision but never becomes current acceptance',async t=>{
  const f=await loopback(t),e={...event(),replay:true};f.eventRefs.set(e,token());const ack=await f.transport.sendEvent(e);
  assert.equal(ack.proof,null);const consumed=f.transport.measurementAckConsumed(ack,e,f.transport.connection);
  assert.equal(consumed.proofExact,true);f.channel.sink.validationComplete({...consumed,gate:'proof_absent',at:performance.now()});
  for(const at of [100,200]){f.transport.connection.ws.send(JSON.stringify({type:'ping',at}));await until(()=>f.channel.snapshot().pings.some(p=>p.pingAt===at&&p.productPongProcessed));}
  const state=f.channel.snapshot();assert.equal(state.cut.state,'sealed');
  const row=state.messages.find(r=>r.typeCategory==='scope.event');assert.equal(row.decisionComplete,true);assert.equal(row.currentAccepted,false);
  assert.equal(f.collector.snapshot().channelEvidence.cut.state,'sealed');assert.equal(state.formalAcceptance,false);
});
test('a strict consumed superseded-sequence ACK completes the channel without becoming current',async t=>{
  const f=await loopback(t),e=event();f.eventRefs.set(e,token());
  const ack=await f.transport.sendEvent(e),consumed=f.transport.measurementAckConsumed(ack,e,f.transport.connection);
  assert.equal(consumed.proofExact,true);
  assert.equal(f.channel.sink.validationComplete({...consumed,gate:'sequence_changed',at:performance.now()}),true);
  for(const at of [100,200]){f.transport.connection.ws.send(JSON.stringify({type:'ping',at}));await until(()=>f.channel.snapshot().pings.some(p=>p.pingAt===at&&p.productPongProcessed));}
  const state=f.channel.snapshot(),row=state.messages.find(r=>r.typeCategory==='scope.event');
  assert.equal(state.run.failureRevision,0);assert.equal(state.cut.state,'sealed');
  assert.equal(row.decisionComplete,true);assert.equal(row.currentAccepted,false);
  assert.equal(state.formalAcceptance,false);
});
test('sequence completion rejects other gates, altered subjects/proofs and nonfresh ACK conditions',()=>{
  for(const change of [{gate:'connection_changed'},{gate:'document_changed'},{gate:'unclassified'},
    {proofExact:false},{proofExact:null},{eventChange:{replay:true}},{eventChange:{observation:'stale'}},
    {ackChange:{duplicate:true}},{ackChange:{proofPresent:false}},{ackChange:{reason:'desktop_capacity'}},
    {ackChange:{disposition:'duplicate_durable'}},{wrongSubject:true},{sticky:true},{side:'collector',proofExact:null}]){
    const u=unit(change.side||'worker');try{
      const e={...event(),...change.eventChange},ref=token(),ackRef=token();
      const expect=change.side==='collector'?null:u.capture.sink.expectSend(ref,e,u.socket);
      if(change.side!=='collector')assert.ok(expect);
      u.message('scope.event',e);
      if(expect)u.capture.sink.endExpectedSend(expect,'returned');
      else u.capture.sink.ingestInput(u.socket,e);
      const ack={type:'scope.event.ack',schema:2,eventId:e.eventId,browserRunId:e.browserRunId,sessionId:e.sessionId,
        sequence:e.sequence,disposition:'committed_current',duplicate:false,reason:null,proofPresent:true,...change.ackChange};
      const rawMessageRef=u.message('scope.event.ack',ack,'server_to_client');
      const proofExact=Object.hasOwn(change,'proofExact')?change.proofExact:true;
      u.capture.sink.ackValidated({rawMessageRef,ackSubjectRef:ackRef,eventSubjectRef:ref,socketRef:u.socket,ackProjection:ack,proofExact});
      if(change.sticky)u.capture.sink.failure('clock_unknown');
      const ok=u.capture.sink.validationComplete({ackSubjectRef:ackRef,eventSubjectRef:change.wrongSubject?token():ref,
        socketRef:u.socket,gate:change.gate||'sequence_changed',proofExact,at:0});
      assert.notEqual(ok,true);assert.equal(u.capture.snapshot().status,'unknown');
    }finally{u.capture.dispose();}
  }
});
test('owner subjects have a hard 64 limit, monotonic TTL and immediate cleanup without touching product proof',()=>{
  let at=100;const failures=[],connection={ws:{}};
  const t=new Transport({clientId:'c',browserRunId:'r',getCredential:()=>null,saveCredential:async()=>{},
    measurement:{failure:r=>failures.push(r)},measurementNow:()=>at,measurementCodec:codec});
  const ack={type:'scope.event.ack',schema:2,eventId:'e',browserRunId:'r',sessionId:'s',sequence:1,
    disposition:'committed_current',duplicate:false,reason:null,proof:'PRIVATE_PROOF'};
  const input={data:JSON.stringify(ack)},subjects=[];
  for(let i=0;i<64;i++)subjects.push(t.measurementIngress(input,connection,token()));
  assert.ok(subjects.every(Boolean));assert.equal(t.measurementIngress(input,connection,token()),null);assert.equal(t.measurementProofs.size,64);
  t.measurementClear(connection);assert.equal(t.measurementProofs.size,0);assert.ok(subjects.every(s=>s.proof===null&&s.projection===null));
  const subject=t.measurementIngress(input,connection,token());assert.ok(subject);at=99;
  assert.equal(t.measurementClock(),null);assert.equal(subject.proof,null);assert.equal(t.measurementProofs.size,0);
  assert.ok(failures.includes('proof_unavailable'));assert.equal(ack.proof,'PRIVATE_PROOF');
  at=200;const subject2=t.measurementIngress(input,connection,token());assert.ok(subject2);
  const outgoing=event(),eventRef=token(),socketRef=token();t.connection=connection;t.measurementReferenceFor=()=>eventRef;
  t.measurement.transportSocketRef=()=>socketRef;t.measurement.transportAckValidated=()=>{};
  t.measurementResolve(subject2,ack,outgoing,connection);at=5201;
  assert.equal(t.measurementAckConsumed(ack,outgoing,connection),null);assert.equal(subject2.proof,null);assert.equal(t.measurementProofs.size,0);
});
test('server diagnostic callbacks are metadata-free and throwing them cannot suppress durable ACK',async t=>{
  const dataDir=fs.mkdtempSync(path.join(__dirname,'../../.tmp-channel-owner-test-')),diagnostics=[];
  let inputSeen=false,ackSeen=false,transport;
  const bridge=createBrowserBridge({dataDir,safeStorage:{isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'synthetic-test-only',
    encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()},
    onIngestInput(socket,p){inputSeen=true;assert.ok(socket);assert.equal(Object.hasOwn(p,'conversationTitle'),false);assert.equal(Object.hasOwn(p,'requestPreview'),false);throw new Error('PRIVATE_INPUT_FAILURE');},
    onAckOutput(socket,p){ackSeen=true;assert.ok(socket);assert.equal(Object.hasOwn(p,'proof'),false);assert.equal(typeof p.proofPresent,'boolean');throw new Error('PRIVATE_ACK_FAILURE');},
    onMeasurementFailure:r=>diagnostics.push(r)});
  assert.equal((await bridge.ready).ok,true);
  let server,port;
  for(const candidate of [23337,23336,23335,23334,23333]){
    const attempt=http.createServer((q,r)=>r.end());
    const ok=await new Promise(resolve=>{attempt.once('error',()=>resolve(false));attempt.listen(candidate,'127.0.0.1',()=>resolve(true));});
    if(ok){server=attempt;port=candidate;bridge.attach(server);break;}
  }
  t.after(async()=>{transport?.disconnect();bridge.dispose();if(server)await new Promise(r=>server.close(r));fs.rmSync(dataDir,{recursive:true,force:true});});
  assert.ok(server);
  class Socket extends WebSocket{constructor(url){super(url,{origin:'chrome-extension://obooegdoanifidoffaodpobadpeiilcl'});}}
  let credential=null;transport=new Transport({clientId:'client',browserRunId:'run',getCredential:()=>credential,saveCredential:async c=>{credential=c;},WebSocketClass:Socket});
  await transport.pair(bridge.beginPairing(port).code);
  const e={...event(),conversationTitle:'PRIVATE_METADATA_TITLE',requestPreview:'PRIVATE_METADATA_PREVIEW'};
  assert.equal((await transport.sendEvent(e)).disposition,'committed_current');
  assert.equal(inputSeen,true);assert.equal(ackSeen,true);assert.deepEqual(diagnostics,['capture_failed','capture_failed']);
  assert.equal(fs.readFileSync(path.join(dataDir,'sessions.json'),'utf8').includes('PRIVATE_METADATA_TITLE'),true);
  assert.equal(JSON.stringify(diagnostics).includes('PRIVATE'),false);
});
test('unresolved raw projections expire; authenticated close and constructor overbudget cannot recover',()=>{
  const u=unit();u.message('scope.event',event());u.advance(4999);
  assert.notEqual(u.capture.snapshot().reason,'ack_timeout');
  u.advance(1);
  assert.equal(u.capture.snapshot().reason,'ack_timeout');
  assert.equal(u.capture.sink.ingestInput(u.socket,event()),null,'expired raw projection cannot be compared later');
  assert.equal(u.capture.snapshot().messages.length,1,'anonymous failure evidence remains');
  u.capture.sink.socketClosed(u.socket);assert.equal(u.capture.snapshot().run.eligibility,'unknown');
  assert.throws(()=>createChannelCapture({side:'collector',maxSockets:65}),/channel_configuration/);
  u.capture.dispose();assert.equal(u.capture.sink.socketOpened(token()),null);
});
test('transport owner rejects unknown fields and accessors before metadata-free codec projection',()=>{
  const failures=[];let reads=0;
  const t=new Transport({clientId:'c',browserRunId:'r',getCredential:()=>null,saveCredential:async()=>{},
    measurement:{failure:r=>failures.push(r)},measurementCodec:codec});
  const good={...event(),conversationTitle:{toString(){reads++;throw new Error();}},requestPreview:'PRIVATE'};
  assert.ok(t.measurementEvent(good));assert.equal(reads,0);
  const nil=Object.assign(Object.create(null),event());assert.ok(t.measurementEvent(nil));
  const getter=event();Object.defineProperty(getter,'conversationTitle',{get(){reads++;throw new Error();}});
  const fieldGetter=event();Object.defineProperty(fieldGetter,'eventId',{get(){reads++;throw new Error();}});
  const symbol=event();symbol[Symbol('unknown')]=1;
  for(const value of [getter,fieldGetter,symbol,{...event(),unknown:1},
    Object.assign(Object.create({}),event()),{...event(),scope:{...event().scope,unknown:1}},
    {...event(),gap:{turnId:'turn',reason:'sampling_gap',observedAt:Date.now(),unknown:1}}]) {
    assert.equal(t.measurementEvent(value),null);
  }
  const ack={type:'scope.event.ack',schema:2,eventId:'e',browserRunId:'r',sessionId:'s',sequence:1,
    disposition:'committed_current',duplicate:false,reason:null,proof:'VALID_PROOF'};
  assert.ok(t.measurementAck(ack));assert.equal(t.measurementAck({...ack,unknown:1}),null);
  assert.equal(t.measurementAck({...ack,proof:'bad proof'}),null);
  Object.defineProperty(ack,'proof',{get(){reads++;throw new Error();}});assert.equal(t.measurementAck(ack),null);
  assert.equal(reads,0);assert.ok(failures.every(r=>r==='invalid_schema'));
});
test('collector independently rejects unknown wire state fields before product rejection',async t=>{
  const f=await loopback(t);
  f.transport.connection.ws.send(JSON.stringify({...event(),scope:{...event().scope,unknown:1}}));
  await until(()=>f.collector.snapshot().channelEvidence.reason==='invalid_schema');
  const s=f.collector.snapshot().channelEvidence;assert.equal(s.run.eligibility,'unknown');assert.equal(s.formalAcceptance,false);
});
test('binary application frame makes canonical prefix unknown instead of disappearing',async t=>{
  const f=await loopback(t);
  WebSocket.prototype.send.call(f.transport.connection.ws,Buffer.from('binary application frame'),{binary:true});
  await until(()=>f.collector.snapshot().channelEvidence.reason==='decode_failed');
  const s=f.collector.snapshot().channelEvidence;assert.equal(s.run.eligibility,'unknown');assert.equal(s.formalAcceptance,false);
});
