/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
// Author plumbing tests only. No provider DOM / real Chrome / timing verdict.
const test=require('node:test'),assert=require('node:assert/strict');
const {createWorkerCapture}=require('../extensions/browser-bridge/native-measurement-worker');
const {createContentCapture}=require('../extensions/browser-bridge/native-measurement-content');
const {createStructureReader}=require('../scripts/monitoring-independent-witness');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const scope={kind:'view',viewEpoch:'view-private',bindingEpoch:'binding-private',samplingEpoch:'sampling-private',workerEpoch:'worker-private',leaseId:'lease-private',documentId:'document-private',startUnobserved:false};
const sample={type:'mori.observation',v:2,pageInstanceId:'page-private',contentSequence:1,observedAt:100000,status:'running',generationToken:'token-private',outcome:null,
  workerEpoch:scope.workerEpoch,leaseId:scope.leaseId,bindingEpoch:scope.bindingEpoch,scopeKind:'view',viewEpoch:scope.viewEpoch,samplingEpoch:scope.samplingEpoch,startUnobserved:false};
const event={type:'scope.event',v:1,schema:2,eventId:'event-private',browserRunId:'run-private',sessionId:'session-private',sequence:1,kind:'observation',provider:'chatgpt',tabId:7,
  pageInstanceId:sample.pageInstanceId,routeRevision:0,conversationRef:null,turnId:'turn-private',generation:1,phase:'running',outcome:null,observation:'fresh',observedAt:sample.observedAt,replay:false,scope,gap:null};
const sender={id:'owned',frameId:0,documentId:scope.documentId,documentLifecycle:'active',tab:{id:7},url:'https://chatgpt.com/'};
const route={provider:'chatgpt',kind:'view',conversationRef:null};
class Socket{
  constructor(){this.listeners=new Map();this.sent=[];}
  addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn);}
  removeEventListener(name,fn){this.listeners.get(name)?.delete(fn);}
  send(value){this.sent.push(value);this.onSend?.();if(this.throwSend)throw new Error('owned-send-failure');return 19;}
  receive(value){const frame={data:JSON.stringify(value)};for(const fn of this.listeners.get('message')||[])fn(frame);return frame;}
  close(){for(const fn of this.listeners.get('close')||[])fn({});}
}
function environment({maxEntries=16384}={}){
  let at=10;const listeners=new Set();
  const tabUpdated=new Set(),tabRemoved=new Set();
  const chrome={runtime:{id:'owned',getURL:path=>'chrome-extension://owned/'+path,onMessage:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)}},
    tabs:{onUpdated:{addListener:f=>tabUpdated.add(f),removeListener:f=>tabUpdated.delete(f)},
      onRemoved:{addListener:f=>tabRemoved.add(f),removeListener:f=>tabRemoved.delete(f)},
      sendMessage:async(_id,message)=>({type:'mori.native.clock',v:1,probeOrdinal:message.probeOrdinal,clockOrigin:2000,received:2010,sent:2011})}};
  const cap=createWorkerCapture({chrome,WebSocketClass:Socket,now:()=>at,timeOrigin:1000,enableSeries:true,buildFingerprint:'a'.repeat(64),maxEntries});
  cap.sink.record('authenticated_ready');
  function request(message,from=sender){let response;for(const fn of listeners)fn(message,from,r=>{response=r;});return response;}
  function packet(records,token=null,sequence=1,extra={}){return {type:'mori.native.records',v:3,captureToken:'capture-private',workerCaptureToken:token,clockOrigin:2000,batchSequence:sequence,missing:false,records,failures:[],...extra};}
  const handshake=request(packet([]));
  assert.equal(handshake.ok,true);
  return {chrome,cap,request,packet,token:handshake.workerCaptureToken,advance:ms=>{at+=ms;},at:()=>at,
    tabUpdated,tabRemoved,update:(id,change)=>{for(const f of tabUpdated)f(id,change);},remove:id=>{for(const f of tabRemoved)f(id);}};
}
function attestation(ordinal,signal='running',owner=1){return {witnessSampleOrdinal:ordinal,ownerOrdinal:owner,signal,scopeKind:'view',ownerKey:'local-chatgpt:owner-private',conversationRef:null,
  ownerScopeMatch:true,uncertainty:null,reason:'observed',before:2010+ordinal,after:2010+ordinal};}
function row(signal='running'){return {kind:'b1_dispatch',before:2010,after:2015,recording:true,dispatchOrdinal:1,observerInstallationOrdinal:1,readerGenerationOrdinal:1,status:'returned',sample,route,
  witnessBefore:attestation(1,signal),witnessAfter:attestation(2,signal)};}
function allocate(env,sampleValue=sample,eventValue=event){
  const ref={},result={},commit={},allocated={};
  assert.equal(env.cap.sink.ingress(ref,sampleValue,{tabId:7,documentId:scope.documentId,provider:'chatgpt',frameId:0,lifecycle:'active'}),true);
  const invocation=env.cap.sink.reductionBegin(ref,sampleValue,{tabId:7,documentId:scope.documentId,route,scope});
  assert.ok(invocation);
  assert.equal(env.cap.sink.reductionEnd(invocation,result,[{ref:allocated,event:eventValue}]),true);
  env.cap.sink.commitBegin(result,commit);env.cap.sink.queueAccepted(commit,allocated,eventValue,'fresh');
  return {allocated,commit};
}
function wireAndAck(env,allocated,{gate='accepted_current',currentHook=true,proofExact=true}={}){
  const socket=new env.cap.WebSocketClass('ws://127.0.0.1:1'),socketRef=env.cap.sink.transportSocketRef(socket),outgoing={};
  env.cap.sink.transportAuthenticated(socketRef,{});
  env.cap.sink.outgoingClone(allocated,outgoing,event,event,'none');
  const expectation=env.cap.sink.transportSendBegin(outgoing,event,socketRef);
  assert.ok(expectation);
  assert.equal(socket.send(JSON.stringify({...event,conversationTitle:'DO_NOT_EXPORT',requestPreview:'DO_NOT_EXPORT'})),19);
  env.cap.sink.transportSendEnd(expectation,'returned');
  const raw={type:'scope.event.ack',schema:2,eventId:event.eventId,browserRunId:event.browserRunId,sessionId:event.sessionId,sequence:event.sequence,
    disposition:'committed_current',duplicate:false,proof:'proof-private',reason:null};
  const frame=socket.receive(raw),rawMessageRef=env.cap.sink.transportRawMessageRef(frame,socket),ackSubjectRef={};
  const {proof,...header}=raw,ackProjection={...header,proofPresent:true};
  env.cap.sink.transportAckValidated({rawMessageRef,ackSubjectRef,eventSubjectRef:outgoing,socketRef,ackProjection,proofExact});
  env.cap.sink.validationComplete({ackSubjectRef,eventSubjectRef:outgoing,socketRef,ackProjection,proofExact,gate,at:1010});
  const identity=Object.fromEntries(['browserRunId','sessionId','eventId','sequence','tabId','pageInstanceId','routeRevision','turnId','generation','kind','scope'].map(k=>[k,event[k]]));
  if(currentHook)env.cap.sink.currentAck(identity);
  return {socket,rawMessageRef};
}
test('B1: real invocation/clone/wire lineage waits for late v3 evidence and keeps semantics separate',()=>{
  const env=environment();try{
    const {allocated}=allocate(env);const {rawMessageRef}=wireAndAck(env,allocated);
    assert.equal(rawMessageRef.connectionOrdinal,1);assert.equal(rawMessageRef.eventOrdinal,1);
    assert.equal(env.cap.snapshot().seriesEvidence.counts.causalVerified,0);
    assert.equal(env.request(env.packet([row('quiet')],env.token,2)).ok,true);
    const snapshot=env.cap.snapshot();
    assert.ok(snapshot.seriesEvidence.counts.causalVerified>=5);
    const edge=snapshot.records.find(r=>r.kind==='series_edge'&&r.edge==='wire_ack');
    assert.equal(edge.causalExact,true);assert.equal(edge.proofExact,true);
    const meaning=snapshot.records.find(r=>r.kind==='series_sample');
    assert.equal(meaning.semanticVerdict.state,'unknown');assert.equal(meaning.semanticVerdict.outcome,'unknown');
    assert.equal(snapshot.formalAcceptance,false);assert.equal(snapshot.independentScopeVerified,false);
    assert.doesNotMatch(JSON.stringify(snapshot),/private|DO_NOT_EXPORT|scopeKind.*lease-/);
  }finally{env.cap.dispose();}
});
test('B1: clone payload differences are explicit and missing input refs never become causal exact',()=>{
  const env=environment();try{
    const {allocated}=allocate(env),outgoing={};
    env.cap.sink.outgoingClone(allocated,outgoing,event,{...event,replay:true,observation:'stale'},'fresh_stale');
    env.request(env.packet([row()],env.token,2));
    const changed=env.cap.snapshot().records.find(r=>r.kind==='series_edge'&&r.edge==='outgoing_clone');
    assert.equal(changed.payloadExact,false);assert.equal(changed.causalExact,true);assert.equal(changed.reason,'transformed_payload');
    assert.equal(env.cap.sink.reductionBegin({},sample,{tabId:7,documentId:scope.documentId,route,scope}),null);
    assert.ok(env.cap.snapshot().failures.b1_input_conflict.count);
  }finally{env.cap.dispose();}
});
test('B1: retained clone permits replay only, never provider/phase/tab/scope changes',()=>{
  for(const changed of [{provider:'claude'},{phase:'idle'},{tabId:8},{scope:{...scope,leaseId:'different-lease'}}]){
    const env=environment();try{
      const {allocated}=allocate(env);
      assert.equal(env.cap.sink.queueClone(allocated,{},event,{...event,...changed},'outbox_retained'),null);
      assert.ok(env.cap.snapshot().failures.b1_event_conflict.count);
    }finally{env.cap.dispose();}
  }
  const env=environment();try{
    const {allocated}=allocate(env);
    assert.equal(env.cap.sink.queueClone(allocated,{},event,{...event,replay:true},'outbox_retained'),true);
    assert.equal(env.cap.snapshot().failures.b1_event_conflict.count,0);
  }finally{env.cap.dispose();}
});
test('B1: duplicate actual ingress candidates cannot become a unique independent sample',()=>{
  const env=environment();try{
    allocate(env);
    env.cap.sink.ingress({},sample,{tabId:7,documentId:scope.documentId,provider:'chatgpt',frameId:0,lifecycle:'active'});
    env.request(env.packet([row()],env.token,2));
    const snapshot=env.cap.snapshot();assert.equal(snapshot.seriesEvidence.counts.causalVerified,0);
    assert.equal(snapshot.seriesEvidence.status,'unknown');
  }finally{env.cap.dispose();}
});
test('B1: non-sample snapshot origins stay noncausal even when wire payload is identical',()=>{
  const env=environment();try{
    const commit={},allocated={};env.cap.sink.commitBegin({},commit);
    env.cap.sink.queueAccepted(commit,allocated,event,'fresh');wireAndAck(env,allocated);
    const snapshot=env.cap.snapshot();assert.equal(snapshot.seriesEvidence.counts.causalVerified,0);
    assert.ok(snapshot.records.some(r=>r.kind==='series_edge'&&r.reason==='non_sample_origin'));
  }finally{env.cap.dispose();}
});
test('B1: new documents handshake during recording, while old/null/repeated evidence cannot upgrade',()=>{
  const env=environment();try{
    const newer={...sender,documentId:'another-document-private'};
    assert.equal(env.request(env.packet([],null,1,{captureToken:'new-capture-private'}),newer).ok,true);
    const result=env.request(env.packet([row()],null,2));
    assert.equal(result.ok,false);assert.equal(result.reason,'stale_capture');
    assert.equal(env.cap.snapshot().seriesEvidence.counts.causalVerified,0);
  }finally{env.cap.dispose();}
});
test('B1: delayed batch after first endpoint deadline cannot resurrect old refs',()=>{
  const env=environment();try{
    allocate(env);env.advance(30001);
    env.request(env.packet([row()],env.token,2));
    const snapshot=env.cap.snapshot();assert.equal(snapshot.seriesEvidence.counts.causalVerified,0);
    assert.ok(snapshot.failures.b1_pending_expired.count);
  }finally{env.cap.dispose();}
});
test('B1: a known nonrecording dispatch is not an expired pending join',()=>{
  const env=environment();try{
    allocate(env);env.advance(721);
    assert.equal(env.request(env.packet([{...row(),recording:false}],env.token,2)).ok,true);
    const snapshot=env.cap.snapshot();
    assert.equal(snapshot.missing,false);assert.equal(snapshot.failures.b1_pending_expired.count,0);
    assert.equal(snapshot.seriesEvidence.counts.causalVerified,0);
    assert.ok(snapshot.records.some(r=>r.kind==='series_edge'&&r.reason==='capture_not_recording'));
    assert.ok(snapshot.records.filter(r=>r.kind==='series_edge').every(r=>r.recording===false&&r.causalExact===null));
  }finally{env.cap.dispose();}
});
test('B1: nonrecording cannot excuse a throwing sender or missing observer',()=>{
  for(const change of [{status:'threw'},{observerInstallationOrdinal:null}]){
    const env=environment();try{
      allocate(env);env.request(env.packet([{...row(),recording:false,...change}],env.token,2));
      const snapshot=env.cap.snapshot();assert.equal(snapshot.missing,true);
      assert.equal(snapshot.seriesEvidence.reasonCounts.capture_not_recording,0);
      assert.ok(snapshot.failures.b1_missing_hook.count);
    }finally{env.cap.dispose();}
  }
});
test('B1: early disposal of an unresolved join is disposed, not a 30 second expiry',()=>{
  const env=environment();allocate(env);env.cap.dispose();
  const snapshot=env.cap.snapshot();assert.equal(snapshot.failures.b1_pending_expired.count,0);
  assert.ok(snapshot.failures.disposed.count);assert.equal(snapshot.missing,true);
});
test('B1: strict sequence_changed completion survives retention and close without claiming current',()=>{
  for(const close of [false,true]){
    const env=environment();try{
      const {allocated}=allocate(env);
      const {socket}=wireAndAck(env,allocated,{gate:'sequence_changed',currentHook:false});
      env.request(env.packet([row()],env.token,2));
      let snapshot=env.cap.snapshot();
      const sent=snapshot.channelEvidence.messages.find(r=>r.typeCategory==='scope.event');
      assert.equal(sent.decisionComplete,true);assert.equal(sent.currentAccepted,false);
      if(close)socket.close();else env.advance(30001);
      snapshot=env.cap.snapshot();assert.equal(snapshot.failures.b1_pending_expired.count,0);
      assert.equal(snapshot.socketClosures.pendingCurrentAcks,0);
      assert.equal(snapshot.records.filter(r=>r.kind==='current_ack').length,0);
    }finally{env.cap.dispose();}
  }
});
test('B1: accepted_current still requires its separate current hook and false proof cannot excuse expiry',()=>{
  for(const change of [{gate:'accepted_current'},{gate:'sequence_changed',proofExact:false}]){
    const env=environment();try{
      const {allocated}=allocate(env);wireAndAck(env,allocated,{...change,currentHook:false});
      env.request(env.packet([row()],env.token,2));env.advance(30001);
      const snapshot=env.cap.snapshot();assert.ok(snapshot.failures.b1_pending_expired.count);
      assert.equal(snapshot.missing,true);
    }finally{env.cap.dispose();}
  }
});
test('B1: actual producer sample rows interoperate with the offline strict decoder',()=>{
  const {analyzeSeriesEvidence}=require('../scripts/monitoring-independent-analysis');
  const env=environment();try{
    allocate(env);env.request(env.packet([row()],env.token,2));
    const snapshot=env.cap.snapshot(),r=analyzeSeriesEvidence(snapshot.seriesEvidence,snapshot.records);
    assert.notEqual(r.reason,'invalid_schema');assert.equal(r.observed.samples,1);
    assert.equal(r.fullChainVerified,false);assert.equal(r.formalAcceptance,false);
  }finally{env.cap.dispose();}
});
test('probe retirement ignores historical batches until an actual registration selects the new document',async()=>{
  for(const change of [{status:'loading'},{discarded:true},{frozen:true},{url:'https://example.org/private'},null]){
    const env=environment();try{
      await env.cap.probeClocks();let calls=0;
      env.chrome.tabs.sendMessage=async(_id,m)=>{calls++;return {type:'mori.native.clock',v:1,probeOrdinal:m.probeOrdinal,clockOrigin:2000,received:2010,sent:2011};};
      if(change)env.update(7,change);else env.remove(7);
      env.request(env.packet([],env.token,2));await env.cap.probeClocks();assert.equal(calls,0);
      const next={...sender,documentId:'new-document-private'};
      env.request(env.packet([],env.token,1,{captureToken:'new-capture-private'}),next);
      await env.cap.probeClocks();assert.equal(calls,0);
      env.cap.sink.registeredDocument({tabId:7,documentId:next.documentId,provider:'chatgpt',frameId:0,lifecycle:'active'});
      await env.cap.probeClocks();assert.ok(calls>0);
      const snapshot=env.cap.snapshot();assert.equal(snapshot.missing,false);
      assert.ok(snapshot.records.some(r=>r.kind==='content_clock_gap'&&r.recording===false));
    }finally{env.cap.dispose();}
  }
});
test('obsolete in-flight probe success and failure are gaps, never successful clocks or global failures',async()=>{
  for(const outcome of ['success','reject','timeout']){
    const env=environment();try{
      await env.cap.probeClocks();const before=env.cap.snapshot().records.filter(r=>r.kind==='content_clock').length;
      let resolve,reject;env.chrome.tabs.sendMessage=()=>new Promise((a,b)=>{resolve=a;reject=b;});
      const pending=env.cap.probeClocks();env.update(7,{status:'loading'});
      if(outcome==='success')resolve({type:'mori.native.clock',v:1,probeOrdinal:3,clockOrigin:2000,received:2010,sent:2011});
      if(outcome==='reject')reject(new Error('receiver gone private error'));
      await pending;const snapshot=env.cap.snapshot();assert.equal(snapshot.missing,false);
      assert.equal(snapshot.records.filter(r=>r.kind==='content_clock').length,before);
      assert.ok(snapshot.records.some(r=>r.kind==='content_clock_gap'&&r.reason==='activation_changed'));
      assert.equal(snapshot.failures.clock_probe_failed.count+snapshot.failures.clock_probe_timeout.count,0);
      assert.doesNotMatch(JSON.stringify(snapshot),/receiver gone/);
    }finally{env.cap.dispose();}
  }
});
test('current unexplained probe failures retain their anonymous document and failure stage',async()=>{
  for(const mode of ['request','response','timeout']){
    const env=environment();try{
      await env.cap.probeClocks();env.chrome.tabs.sendMessage=mode==='request'?async()=>{throw new Error('PRIVATE_ERROR');}
        :mode==='response'?async()=>({wrong:true}):()=>new Promise(()=>{});
      await env.cap.probeClocks();const snapshot=env.cap.snapshot();assert.equal(snapshot.missing,true);
      const row=snapshot.records.find(r=>r.kind==='content_clock_failure');assert.equal(row.stage,mode);
      assert.equal(row.tabOrdinal,1);assert.equal(row.documentOrdinal,1);assert.equal(row.recording,false);
      assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_ERROR/);
    }finally{env.cap.dispose();}
  }
});
test('same candidate refresh does not obsolete a pending probe; unrelated tabs do not retire it',async()=>{
  const env=environment();try{
    await env.cap.probeClocks();let complete;
    env.chrome.tabs.sendMessage=(_id,m)=>new Promise(resolve=>{complete=()=>resolve({type:'mori.native.clock',v:1,probeOrdinal:m.probeOrdinal,clockOrigin:2000,received:2010,sent:2011});});
    const pending=env.cap.probeClocks();env.cap.sink.registeredDocument({tabId:7,documentId:sender.documentId,provider:'chatgpt',frameId:0,lifecycle:'active'});
    let reads=0;const unrelated={};for(const key of ['status','discarded','frozen','url'])Object.defineProperty(unrelated,key,{get(){reads++;throw new Error('unrelated private tab');}});
    for(let i=100;i<200;i++)env.update(i,unrelated);
    assert.equal(reads,0);
    complete();await pending;const snapshot=env.cap.snapshot();assert.equal(snapshot.missing,false);
    assert.equal(snapshot.records.filter(r=>r.kind==='content_clock_gap').length,0);
  }finally{env.cap.dispose();}
});
test('probe lifecycle listeners are removed at disposal and expiry',()=>{
  for(const expired of [false,true]){
    const env=environment();assert.equal(env.tabUpdated.size,1);assert.equal(env.tabRemoved.size,1);
    if(expired){env.advance(600001);env.cap.snapshot();}else env.cap.dispose();
    assert.equal(env.tabUpdated.size,0);assert.equal(env.tabRemoved.size,0);env.cap.dispose();
  }
});
test('expired registration hints cannot grow the persistent probe tombstone table beyond its cap',()=>{
  const env=environment();try{
    for(let tabId=100;tabId<163;tabId++)assert.equal(env.cap.sink.registeredDocument({tabId,documentId:'pending-'+tabId,provider:'chatgpt',frameId:0,lifecycle:'active'}),true);
    env.advance(30001);
    assert.equal(env.cap.sink.registeredDocument({tabId:999,documentId:'overflow',provider:'chatgpt',frameId:0,lifecycle:'active'}),false);
    const response=env.request(env.packet([],env.token,1),{...sender,tab:{id:999},documentId:'overflow'});
    assert.equal(response.ok,false);const snapshot=env.cap.snapshot();assert.ok(snapshot.failures.capacity.count);
    assert.equal(snapshot.counts.documents,1);assert.equal(snapshot.missing,true);
  }finally{env.cap.dispose();}
});
test('known worker capture failure does not relabel an intact matched hook chain as missing_hook',()=>{
  const env=environment();try{
    env.cap.sink.seriesFailure('input_conflict');allocate(env);
    env.request(env.packet([row()],env.token,2));const snapshot=env.cap.snapshot();
    assert.equal(snapshot.missing,true);assert.ok(snapshot.failures.b1_input_conflict.count);
    assert.equal(snapshot.failures.b1_missing_hook.count,0);
    assert.ok(snapshot.records.some(r=>r.kind==='series_edge'&&r.reason==='capture_not_recording'));
    assert.equal(snapshot.seriesEvidence.counts.causalVerified,0);
  }finally{env.cap.dispose();}
});
test('a failed earlier dispatch in the same batch prevents later dispatches from remaining eligible',()=>{
  const env=environment();try{
    allocate(env);const nextSample={...sample,contentSequence:2};allocate(env,nextSample,{...event,eventId:'event-next',sequence:2});
    const bad=row();bad.witnessBefore={...bad.witnessBefore,ownerScopeMatch:false};
    const next={...row(),dispatchOrdinal:2,sample:nextSample};
    env.request(env.packet([bad,next],env.token,2));const snapshot=env.cap.snapshot();
    assert.equal(snapshot.missing,true);assert.ok(snapshot.seriesEvidence.counts.contradictions);
    const edges=snapshot.records.filter(r=>r.kind==='series_edge'&&r.ingressOrdinal===2);assert.ok(edges.length);
    assert.ok(edges.every(r=>r.causalExact===null&&r.recording===false&&r.reason==='capture_not_recording'));
  }finally{env.cap.dispose();}
});
test('expired send bypasses measurement schema checks and preserves the original single send and throw',()=>{
  const env=environment();try{
    const socket=new env.cap.WebSocketClass('ws://127.0.0.1:1');env.advance(600001);
    assert.equal(socket.send('{invalid'),19);assert.equal(socket.sent.length,1);
    socket.throwSend=true;assert.throws(()=>socket.send('second'),/owned-send-failure/);assert.equal(socket.sent.length,2);
    const snapshot=env.cap.snapshot();assert.ok(snapshot.failures.expired.count);assert.equal(snapshot.failures.invalid_schema.count,0);
  }finally{env.cap.dispose();}
});
test('B1: v3 rejects extra fields/getters/duplicates as whole batches without reading them',()=>{
  const env=environment();try{
    let reads=0;const invalid=row();Object.defineProperty(invalid,'draft',{get(){reads++;return 'SECRET';},enumerable:true});
    const response=env.request(env.packet([invalid],env.token,2));
    assert.equal(response.ok,false);assert.equal(response.acceptedRecords,0);assert.equal(reads,0);
    assert.equal(env.cap.snapshot().seriesEvidence.counts.dispatches,0);
  }finally{env.cap.dispose();}
});
test('B1: raw wire unknown keys never disappear into a successful projection',()=>{
  for(const changed of [{unexpected:true},{scope:{...scope,unexpected:true}},
    {gap:{turnId:'t',reason:'sampling_gap',observedAt:1,unexpected:true}}]){
    const env=environment();try{
      const {allocated}=allocate(env),socket=new env.cap.WebSocketClass('ws://127.0.0.1:1'),socketRef=env.cap.sink.transportSocketRef(socket),outgoing={};
      env.cap.sink.transportAuthenticated(socketRef,{});env.cap.sink.outgoingClone(allocated,outgoing,event,event,'none');
      const expected=env.cap.sink.transportSendBegin(outgoing,event,socketRef),wire=JSON.stringify({...event,...changed});
      assert.equal(socket.send(wire),19);env.cap.sink.transportSendEnd(expected,'returned');
      assert.equal(socket.sent[0],wire);assert.equal(env.cap.snapshot().seriesEvidence.counts.wireEvents,0);assert.equal(env.cap.snapshot().missing,true);
    }finally{env.cap.dispose();}
  }
});

test('B1: unsupported wire attempts stay transparent and make the prefix unknown',()=>{
  for(const bytes of [new Uint8Array([1,2,3]),'x'.repeat(16385),'{broken']){
    const env=environment();try{
      const socket=new env.cap.WebSocketClass('ws://127.0.0.1:1');
      assert.equal(socket.send(bytes),19);
      assert.equal(socket.sent[0],bytes);
      const snapshot=env.cap.snapshot();
      assert.equal(snapshot.missing,true);
      assert.equal(snapshot.channelEvidence.status,'unknown');
      assert.ok(snapshot.failures.invalid_schema.count);
    }finally{env.cap.dispose();}
  }
});

test('B1: a known displaced document remains historical after a late batch',async()=>{
  const env=environment();try{
    const calls=[];
    env.chrome.tabs.sendMessage=async(_tab,message,options)=>{
      calls.push(options.documentId);
      return {type:'mori.native.clock',v:1,probeOrdinal:message.probeOrdinal,clockOrigin:2000,received:2010,sent:2011};
    };
    const next={...sender,documentId:'later-document-private'};
    env.cap.sink.registeredDocument({tabId:7,documentId:next.documentId,provider:'chatgpt',frameId:0,lifecycle:'active'});
    assert.equal(env.request(env.packet([],null,1,{captureToken:'later-capture-private'}),next).ok,true);
    await env.cap.probeClocks();calls.length=0;
    assert.equal(env.request(env.packet([],env.token,2)).ok,true);
    await env.cap.probeClocks();
    assert.deepEqual(calls,['later-document-private']);
    assert.equal(env.request(env.packet([],env.token,3)).ok,true);
  }finally{env.cap.dispose();}
});

test('B1: a first-seen old batch cannot displace an existing clock candidate',async()=>{
  const env=environment();try{
    const calls=[];
    env.chrome.tabs.sendMessage=async(_tab,message,options)=>{
      calls.push(options.documentId);
      return {type:'mori.native.clock',v:1,probeOrdinal:message.probeOrdinal,clockOrigin:2000,received:2010,sent:2011};
    };
    const old={...sender,documentId:'first-seen-old-private'};
    assert.equal(env.request(env.packet([],null,1,{captureToken:'old-capture-private'}),old).ok,true);
    await env.cap.probeClocks();calls.length=0;
    await env.cap.probeClocks();assert.deepEqual(calls,[sender.documentId]);
    // Only a subsequent successful owner registration fact may select it.
    assert.equal(env.cap.sink.registeredDocument({tabId:7,documentId:old.documentId,provider:'chatgpt',frameId:0,lifecycle:'active'}),true);
    calls.length=0;await env.cap.probeClocks();assert.deepEqual(calls,[old.documentId]);
    assert.equal(env.cap.snapshot().currentDocumentVerified,false);
  }finally{env.cap.dispose();}
});

test('B1: an expired registration hint cannot select a later arriving document',async()=>{
  const env=environment();try{
    const calls=[];
    env.chrome.tabs.sendMessage=async(_tab,message,options)=>{
      calls.push(options.documentId);
      return {type:'mori.native.clock',v:1,probeOrdinal:message.probeOrdinal,clockOrigin:2000,received:2010,sent:2011};
    };
    const old={...sender,documentId:'late-registration-private'};
    env.cap.sink.registeredDocument({tabId:7,documentId:old.documentId,provider:'chatgpt',frameId:0,lifecycle:'active'});
    env.advance(30001);
    assert.equal(env.request(env.packet([],null,1,{captureToken:'late-registration-capture-private'}),old).ok,true);
    await env.cap.probeClocks();assert.deepEqual(calls,[]);
    // A fresh actual registration can choose the previous document again.
    env.cap.sink.registeredDocument({tabId:7,documentId:sender.documentId,provider:'chatgpt',frameId:0,lifecycle:'active'});
    await env.cap.probeClocks();assert.deepEqual(calls,[sender.documentId]);
  }finally{env.cap.dispose();}
});
test('B1: owner projection rejects unknown/accessor fields without reading metadata values',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../extensions/browser-bridge/service-worker.js'),'utf8');
  const helpers=source.slice(source.indexOf('function measurementProjection('),source.indexOf('function measurementSender('));
  const result=vm.runInNewContext(helpers+`
    let reads=0;const clean=${JSON.stringify(event)};
    const unknown=measurementEvent({...clean,unknown:'not permitted'});
    const child=measurementEvent({...clean,scope:{...clean.scope,unknown:true}});
    const gap=measurementEvent({...clean,gap:{turnId:'t',reason:'sampling_gap',observedAt:1,unknown:true}});
    const prototype=measurementEvent(Object.assign(Object.create({}),clean));
    Object.defineProperty(clean,'conversationTitle',{enumerable:true,get(){reads++;throw Error('must not read');}});
    const accessor=measurementEvent(clean);
    const valid=measurementEvent({...${JSON.stringify(event)},conversationTitle:'excluded',requestPreview:'excluded'});
    ({unknown,child,gap,prototype,accessor,valid,reads});`);
  assert.equal(result.reads,0);for(const key of ['unknown','child','gap','prototype','accessor'])assert.equal(result[key],null);
  assert.equal(Object.hasOwn(result.valid,'conversationTitle'),false);assert.equal(Object.hasOwn(result.valid,'requestPreview'),false);
});

test('B1: oversized batch arrays fail before descriptor enumeration',()=>{
  const env=environment();try{
    let enumerated=0;
    const records=new Proxy(new Array(1000000),{ownKeys(){enumerated++;throw Error('must not enumerate');}});
    assert.equal(env.request(env.packet(records,env.token,2)).ok,false);
    assert.equal(enumerated,0);assert.ok(env.cap.snapshot().failures.invalid_schema.count);
  }finally{env.cap.dispose();}
});

test('B1: ACK owner rejects invalid scope before either native consumer',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../extensions/browser-bridge/service-worker.js'),'utf8');
  const helpers=source.slice(source.indexOf('function measurementProjection('),source.indexOf('function measurementSender('));
  const proof=source.slice(source.indexOf('function recordProof('),source.indexOf('\nfunction desktopWriteFailed('));
  const result=vm.runInNewContext(helpers+proof+`
    let reads=0,failures=0,calls=0;
    const measurement={ackDecision(){calls++;},currentAck(){calls++;},seriesFailure(){failures++;}};
    function measurementFailure(){failures++;}
    const observerLeases=new Map(),sessions=null,controlGeneration=0,credential={},owner={generation:0,credential,connection:{}};
    const transport={connection:owner.connection,isReady:()=>true},coordinator={MAX_TABS:20},monitoring={};
    const deliveryFailures=new Map(),savedProofs=new Map(),revokedProofs=new Map();
    const performance={now:()=>1};
    let desktopFault=null,diagnostic=null;
    function currentEvent(){return true;}function publishHealth(){}function measure(){}
    const event=${JSON.stringify(event)};
    Object.defineProperty(event.scope,'secret',{enumerable:true,get(){reads++;throw Error('never read');}});
    recordProof(event,{proof:'opaque',disposition:'committed_current',reason:null},owner);
    ({reads,failures,calls});`);
  assert.equal(result.reads,0);assert.equal(result.calls,0);assert.ok(result.failures>0);
});
test('B1: throwing dispatch taps mark missing hooks and preserve the real observation acknowledgement',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../extensions/browser-bridge/content-script.js'),'utf8');
  const send=source.slice(source.indexOf('    function sendObservation('),source.indexOf('    function generationNodes('));
  const failures=[];
  const context=vm.createContext({measurement:{dispatchBegin(){throw Error('owned failure');},dispatchEnd(){throw Error('owned failure');},seriesFailure:r=>failures.push(r)},
    measurementFailure(){failures.push('missing_hook');},lease:{},route:{provider:'chatgpt',conversationRef:null},binding:{kind:'view'},
    chrome:{runtime:{sendMessage:()=>Promise.resolve({ok:true})}},utils:{safeObservationAck:v=>v},handleRuntimeFailure(){}});
  vm.runInContext(send,context);
  const response=await context.sendObservation(JSON.parse(JSON.stringify(sample)),{});
  assert.equal(response.ok,true);assert.ok(failures.length>=1);
});
test('B1 content: adopted subject is consumed synchronously and v3 starts after handshake',async()=>{
  let now=10;const messages=[],listeners=new Set();
  const chrome={runtime:{id:'owned',onMessage:{addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f)},sendMessage:async m=>{
    messages.push(structuredClone(m));return {ok:true,recording:true,acceptedRecords:m.records.length,workerCaptureToken:'worker-capture-private',reason:'none'};}}};
  const publicSample={provider:'chatgpt',scopeKind:'view',state:'quiet',reason:'observed',counts:{main:1},sameScope:true,continuity:'unknown',continuous1s:false,uncertainty:null,interval:null};
  let seen=0;
  const content=createContentCapture({chrome,document:{visibilityState:'visible'},readRoute:()=>'',provider:'chatgpt',readerFactory:()=>({sample:()=>publicSample,dispose(){},attest(subject){seen++;assert.equal(subject.key,'owner');return {...attestation(seen),before:now,after:now};}}),
    now:()=>now,timeOrigin:2000,enableSeries:true});
  try{
    await content.flush();content.sink.record('observer_installed');
    const subject={key:'owner',epoch:sample.bindingEpoch,viewEpoch:sample.viewEpoch,kind:'view'};
    const handle=content.sink.dispatchBegin(sample,subject,route);content.sink.dispatchEnd(handle,subject,'returned');
    assert.equal(seen,2);await content.flush();
    const dispatched=messages[1].records.find(r=>r.kind==='b1_dispatch');
    assert.ok(dispatched);assert.equal(dispatched.recording,true);assert.equal(messages[1].workerCaptureToken,'worker-capture-private');
    assert.equal(Object.hasOwn(dispatched,'subject'),false);
  }finally{content.dispose();}
});

function pumpingContent(t,sendMessage,{maxDurationMs=600000}={}){
  t.mock.timers.enable({apis:['setInterval','setTimeout']});
  let at=10, witness=0;
  const publicSample={provider:'chatgpt',scopeKind:'view',state:'quiet',reason:'observed',counts:{main:1},sameScope:true,
    continuity:'unknown',continuous1s:false,uncertainty:null,interval:null};
  const content=createContentCapture({chrome:{runtime:{id:'owned',onMessage:{addListener(){},removeListener(){}},sendMessage}},
    document:{visibilityState:'visible'},readRoute:()=>'',provider:'chatgpt',readerFactory:()=>({sample:()=>publicSample,dispose(){},
      attest:()=>({...attestation(++witness),before:at,after:at})}),now:()=>at,timeOrigin:2000,enableSeries:true,maxDurationMs});
  t.after(()=>content.dispose());
  const subject={key:'owner',epoch:sample.bindingEpoch,viewEpoch:sample.viewEpoch,kind:'view'};
  return {content,advance:ms=>{at+=ms;},dispatch(){const h=content.sink.dispatchBegin(sample,subject,route);return content.sink.dispatchEnd(h,subject,'returned');}};
}
const settledMicrotasks=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const acceptedBatch=m=>({ok:true,recording:true,acceptedRecords:m.records.length,workerCaptureToken:'worker-capture-private',reason:'none'});

test('B1 content pump: timer-free FIFO drains critical rows behind 64 entries with one in-flight batch',async t=>{
  const messages=[],pending=[];let active=0,maxActive=0;
  const env=pumpingContent(t,m=>{messages.push(structuredClone(m));active++;maxActive=Math.max(maxActive,active);
    return new Promise(resolve=>pending.push(()=>{active--;resolve(acceptedBatch(m));}));});
  for(let i=0;i<90;i++)env.content.sampleNow();
  assert.equal(env.dispatch(),true);assert.equal(messages.length,0,'product send stack is not blocked by capture');
  await settledMicrotasks();assert.equal(messages.length,1);assert.equal(messages[0].records.length,64);
  assert.equal(messages[0].records.some(r=>r.kind==='b1_dispatch'),false);
  env.dispatch();await settledMicrotasks();assert.equal(messages.length,1,'new dispatch shares in-flight gate');
  pending.shift()();await settledMicrotasks();assert.equal(messages.length,2);
  assert.deepEqual(messages[1].records.filter(r=>r.kind==='b1_dispatch').map(r=>r.dispatchOrdinal),[1,2]);
  assert.equal(messages[1].workerCaptureToken,'worker-capture-private');
  assert.deepEqual(messages.map(m=>m.batchSequence),[1,2]);assert.equal(maxActive,1);
  pending.shift()();await settledMicrotasks();assert.equal(env.content.snapshot().counts.queued,0);
  assert.equal(env.content.snapshot().batches.failed,0);
});

test('B1 content pump: failure does not recursively consume retry budget; periodic path stays bounded',async t=>{
  let calls=0;const env=pumpingContent(t,async()=>{calls++;throw Error('synthetic failed batch');});
  env.dispatch();await settledMicrotasks();assert.equal(calls,1);assert.equal(env.content.snapshot().batches.failed,1);
  await settledMicrotasks();assert.equal(calls,1);
  t.mock.timers.tick(250);await settledMicrotasks();assert.equal(calls,2);
  t.mock.timers.tick(250);await settledMicrotasks();assert.equal(calls,3);
  t.mock.timers.tick(1000);await settledMicrotasks();assert.equal(calls,3);
  assert.equal(env.content.snapshot().failures.batch_retry_exhausted.count,1);
  assert.equal(env.content.snapshot().missing,true);
});

test('B1 content pump: reserved microtask cannot send after dispose or capture expiry',async t=>{
  for(const terminal of ['dispose','expired']){
    let calls=0;const env=pumpingContent(t,async m=>{calls++;return acceptedBatch(m);},{maxDurationMs:20});
    if(terminal==='expired')await env.content.flush();
    const before=calls;env.dispatch();
    if(terminal==='dispose')env.content.dispose();else env.advance(21);
    await settledMicrotasks();assert.equal(calls,before,terminal);
    assert.equal(env.content.snapshot().missing,true);env.content.dispose();t.mock.timers.reset();
  }
});

test('B1 terminal: expiry stops late validation/failure/pong callbacks without erasing earlier failures',()=>{
  const env=environment();try{
    const socket=new env.cap.WebSocketClass();
    env.cap.sink.transportAuthenticated(env.cap.sink.transportSocketRef(socket),{});
    env.cap.sink.seriesFailure('input_conflict');env.advance(600001);
    const before=env.cap.snapshot();
    for(let i=0;i<10;i++){
      env.cap.sink.transportPongProcessed({});env.cap.sink.transportAckValidated({});env.cap.sink.validationComplete({});
      env.cap.sink.seriesFailure('proof_unavailable');env.cap.sink.failure('capture_failed');env.cap.sink.record('authenticated_ready');
      env.cap.sink.transportSendEnd({},'returned');
    }
    const after=env.cap.snapshot();assert.deepEqual(after.failures,before.failures);
    assert.equal(after.failures.expired.count,1);assert.equal(after.failures.b1_input_conflict.count,1);
    assert.equal(after.failures.invalid_schema.count,0);assert.equal(after.channelEvidence.reason,'capture_failed','first failure is preserved');
    assert.equal(socket.send('untouched-after-expiry'),19);assert.equal(socket.sent.at(-1),'untouched-after-expiry');
  }finally{env.cap.dispose();}
});

test('B1 terminal: send return and throw crossing expiry keep incomplete row unknown, not invalid_schema',()=>{
  for(const throwing of [false,true]){
    const env=environment();try{
      const socket=new env.cap.WebSocketClass();
      env.cap.sink.transportAuthenticated(env.cap.sink.transportSocketRef(socket),{});
      socket.onSend=()=>env.advance(600001);socket.throwSend=throwing;
      const raw=JSON.stringify({type:'ping',at:1700000000000});
      if(throwing)assert.throws(()=>socket.send(raw),/owned-send-failure/);else assert.equal(socket.send(raw),19);
      assert.deepEqual(socket.sent,[raw]);
      const snapshot=env.cap.snapshot();assert.equal(snapshot.failures.expired.count,1);
      assert.equal(snapshot.failures.invalid_schema.count,0);assert.equal(snapshot.channelEvidence.reason,'expired');
      assert.equal(snapshot.failures.socket_evidence_incomplete.count,0);assert.equal(snapshot.counts.activeConnections,0);
      assert.equal(socket.listeners.get('message').size,0);assert.equal(socket.listeners.get('close').size,0);
      assert.equal(snapshot.channelEvidence.messages[0].sendReturned,false);assert.equal(snapshot.channelEvidence.messages[0].interval,null);
      assert.equal(snapshot.formalAcceptance,false);
    }finally{env.cap.dispose();}
  }
});

test('B1 terminal: explicit dispose releases pending sockets without a new disconnect diagnosis',()=>{
  const env=environment();const socket=new env.cap.WebSocketClass();
  env.cap.sink.transportAuthenticated(env.cap.sink.transportSocketRef(socket),{});
  socket.send(JSON.stringify({type:'ping',at:1700000000000}));env.cap.dispose();
  const snapshot=env.cap.snapshot();assert.equal(snapshot.failures.socket_evidence_incomplete.count,0);
  assert.equal(snapshot.failures.disposed.count,1);assert.equal(snapshot.channelEvidence.reason,'disposed');
  assert.equal(socket.listeners.get('message').size,0);assert.equal(socket.listeners.get('close').size,0);
  assert.equal(socket.send('post-dispose'),19);
});

test('B1 terminal: capacity stops even an already sealed channel; batch admission also propagates capacity',()=>{
  const env=environment({maxEntries:32});try{
    const socket=new env.cap.WebSocketClass(),socketRef=env.cap.sink.transportSocketRef(socket);
    env.cap.sink.transportAuthenticated(socketRef,{});
    for(let i=0;i<2;i++){
      const pingAt=1700000000000+i;socket.send(JSON.stringify({type:'ping',at:pingAt}));
      const frame=socket.receive({type:'pong',at:pingAt});
      env.cap.sink.transportPongProcessed({rawMessageRef:env.cap.sink.transportRawMessageRef(frame,socket),socketRef,pingAt,at:1010});
    }
    assert.equal(env.cap.snapshot().channelEvidence.run.eligibility,'eligible');
    for(let i=0;i<33;i++)env.cap.sink.record('worker_received');
    const snapshot=env.cap.snapshot();assert.equal(snapshot.failures.capacity.count,1);
    assert.equal(snapshot.channelEvidence.reason,'capacity');assert.equal(snapshot.channelEvidence.run.eligibility,'unknown');
    assert.equal(snapshot.channelEvidence.run.capturePhase,'unknown');assert.equal(snapshot.failures.socket_evidence_incomplete.count,0);
  }finally{env.cap.dispose();}
  const batch=environment({maxEntries:2});try{
    assert.equal(batch.request(batch.packet([row()],batch.token,2)).reason,'capacity');
    assert.equal(batch.cap.snapshot().channelEvidence.reason,'capacity');
  }finally{batch.cap.dispose();}
});

test('B1 reader: actual adopted form is compared even with identical owner and roots',()=>{
  function node(localName,attrs={}){return {localName,parentElement:null,children:[],getAttribute:k=>Object.hasOwn(attrs,k)?attrs[k]:null,getClientRects:()=>[{}],
    querySelectorAll(selector){return this.select?.[selector]||[];},contains(other){for(let n=other;n;n=n.parentElement)if(n===this)return true;return false;}};}
  const main=node('main'),display=node('div',{'data-chatgpt-conversation-selection-target':'local-chatgpt:owner'}),composer=node('div',{'data-map-composer-conversation':'local-chatgpt:owner'}),form=node('form'),editor=node('div');
  display.parentElement=main;composer.parentElement=main;form.parentElement=composer;editor.parentElement=form;
  main.select={'[data-chatgpt-conversation-selection-target]':[display],'[data-map-composer-conversation]':[composer],'[data-chatgpt-selection-conversation-id]':[]};
  composer.select={'[contenteditable="true"],textarea':[editor]};
  const doc={visibilityState:'visible',defaultView:{getComputedStyle:()=>({display:'block',visibility:'visible'})},querySelectorAll:s=>s==='main,[role="main"]'?[main]:[]};
  let at=0;const reader=createStructureReader({provider:'chatgpt',document:doc,readRoute:()=> 'https://chatgpt.com/',clock:()=>++at,observeMutations:false,privateAttestation:true});
  const subject={document:doc,main,roots:[display,composer],form,key:'local-chatgpt:owner',kind:'view',epoch:'b',viewEpoch:'v'};
  try{
    const first=reader.attest(subject);assert.equal(first.ownerScopeMatch,true);
    const replacement=node('form');replacement.parentElement=composer;editor.parentElement=replacement;
    const second=reader.attest(subject);assert.equal(second.ownerScopeMatch,false);assert.notEqual(second.ownerOrdinal,first.ownerOrdinal);
    const fresh=reader.attest({...subject,form:replacement});assert.equal(fresh.ownerScopeMatch,true);
    assert.equal(Object.values(fresh).some(v=>v===main||v===form||v===replacement),false);
  }finally{reader.dispose();}
});
