/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
// Hand-written anonymous export examples, not physical Chrome acceptance.
const test=require('node:test');
const assert=require('node:assert/strict');
const {analyzeChannelEvidence,analyzeSeriesEvidence}=require('../scripts/monitoring-independent-analysis');
const {createChannelCapture}=require('../scripts/monitoring-independent-channel');
function evidence(worker=true) {
  const connectionOrdinal=worker?1:9;
  const row=(direction,typeCategory,messageOrdinal)=>({connectionOrdinal,direction,messageOrdinal,typeCategory,
    membership:messageOrdinal<=5?'prefix':'suffix',phase:messageOrdinal<=3?'waiting':'recording',
    eventOrdinal:null,pingOrdinal:['ping','pong'].includes(typeCategory)?messageOrdinal-3:null,
    interval:[messageOrdinal,messageOrdinal+0.1],localStateAttributionExact:null,channelProofExact:null,
    decisionComplete:null,currentAccepted:null,
    sendReturned:(worker?direction==='client_to_server':direction==='server_to_client')?true:null});
  const messages=[...['hello','authenticate','pair.confirm','ping','ping'].map((t,i)=>row('client_to_server',t,i+1)),
    ...['challenge','pair.ready','ready','pong','pong'].map((t,i)=>row('server_to_client',t,i+1)),row('client_to_server','client.health',6)];
  function summary(rows) {
    const typed=direction=>Object.fromEntries([...new Set(rows.filter(r=>r.direction===direction).map(r=>r.typeCategory))]
      .map(t=>[t,rows.filter(r=>r.direction===direction&&r.typeCategory===t).length]));
    return {clientMessageCount:rows.filter(r=>r.direction==='client_to_server').length,
      serverMessageCount:rows.filter(r=>r.direction==='server_to_client').length,
      clientTypeCounts:typed('client_to_server'),serverTypeCounts:typed('server_to_client'),eventCount:0,ackCount:0,pendingCount:0,
      phaseCounts:{waiting:rows.filter(r=>r.phase==='waiting').length,recording:rows.filter(r=>r.phase==='recording').length,unknown:0},
      complete:true,localStateAttributionExact:null,observedThrough:50};
  }
  return {contract:'conditional-fifo-prefix-v2',status:'pending',reason:'comparison_pending',
    strictDirectComparison:false,fullWireBytesVerified:false,formalAcceptance:false,independentScopeVerified:false,
    selection:{strategy:'precommitted-authenticated-ping-ordinal-v1',targetPingOrdinal:2,frozenBeforeAuthentication:true},
    localConnectionOrdinal:connectionOrdinal,authenticationGenerationOrdinal:1,capturedFromSocketStart:true,
    locallyAuthenticated:true,singletonAuthenticated:true,
    cut:{pingOrdinal:2,pingAt:20,clientMessageEnd:5,serverMessageEnd:5,rawPongComplete:true,
      productPongProcessed:worker?true:null,localPongLabelMatched:true,prefixValidationComplete:true,
      prefixEventCount:0,prefixAckCount:0,prefixPendingCount:0,state:'sealed',boundaryAt:20,sealedAt:21},
    prefix:summary(messages.filter(r=>r.membership==='prefix')),suffix:summary(messages.filter(r=>r.membership==='suffix')),
    run:{failureRevision:0,failureAfterCut:false,eligibility:'eligible',exportSequence:1,exportAt:51,observedThrough:50,capturePhase:'recording'},
    messages,pings:[1,2].map(i=>({connectionOrdinal,pingOrdinal:i,pingAt:i*10,clientMessageOrdinal:i+3,
      serverMessageOrdinal:i+3,sendReturned:worker?true:null,pongRawComplete:true,
      productPongProcessed:worker?true:null,localPongLabelMatched:true}))};
}
test('precommitted cut tolerates recorded normal suffix and different local connection ordinals',()=>{
  const w=evidence(),d=evidence(false),r=analyzeChannelEvidence(w,d);
  assert.equal(r.status,'conditional_match');
  assert.equal(r.strictDirectComparison,false);
  assert.equal(r.fullWireBytesVerified,false);
  assert.equal(r.formalAcceptance,false);
  assert.equal(r.independentScopeVerified,false);
  assert.equal(r.futureFailuresExcluded,false);
  assert.equal(r.suffixCounts.workerClient,1);
});
test('the actual anonymous channel exporter and offline parser interoperate without wire identifiers',()=>{
  function capture(side) {
    let at=0;
    const c=createChannelCapture({side,targetPingOrdinal:2,now:()=>++at}),socket=Object.freeze({});
    c.sink.socketOpened(socket);
    const message=(direction,type,projection=null,phase='waiting')=>{
      const handle=c.sink.messageBegin(socket,{direction,type,projection,phase,before:at+=10});
      c.sink.messageEnd(handle,{status:(side==='worker'?direction==='client_to_server':direction==='server_to_client')?'returned':'received',after:++at});
      if(side==='worker'&&type==='pong')c.sink.pongProcessed({rawMessageRef:handle,socketRef:socket,pingAt:projection.at,at:++at});
    };
    message('client_to_server','hello');message('server_to_client','challenge');
    message('client_to_server','authenticate');message('server_to_client','pair.ready');
    message('client_to_server','pair.confirm');message('server_to_client','ready');
    c.sink.authenticated(socket,Object.freeze({}));
    for(const label of [100,200]) {
      message('client_to_server','ping',{type:'ping',at:label},'recording');
      message('server_to_client','pong',{type:'pong',at:label},'recording');
      message('client_to_server','client.health',null,'recording');
    }
    return c;
  }
  const w=capture('worker'),d=capture('collector');
  try {const worker=w.snapshot(),desktop=d.snapshot(),result=analyzeChannelEvidence(worker,desktop);
    assert.equal(result.status,'conditional_match',JSON.stringify({result,workerCut:worker.cut,desktopCut:desktop.cut}));}
  finally {w.dispose();d.dispose();}
});
test('raw pong, missing prefix, target mismatch and later failures cannot qualify a run',()=>{
  for(const mutate of [w=>{w.cut.productPongProcessed=false;},w=>{w.run.failureRevision=1;},
    w=>{w.run.failureAfterCut=true;},w=>{w.suffix.complete=false;},w=>{w.messages.splice(1,1);},
    w=>{w.pings[0].pingAt=20;},w=>{w.cut.prefixValidationComplete=false;},w=>{w.selection.frozenBeforeAuthentication=false;}]) {
    const w=evidence();mutate(w);assert.equal(analyzeChannelEvidence(w,evidence(false)).status,'unknown');
  }
  const d=evidence(false);d.cut.pingAt=21;d.pings[1].pingAt=21;
  assert.equal(analyzeChannelEvidence(evidence(),d).reason,'cut_mismatch');
  assert.equal(analyzeChannelEvidence({},{}).reason,'invalid_schema');
  assert.equal(analyzeChannelEvidence(null,null).reason,'evidence_unavailable');
});
test('all pre-target ping labels and all message positions matter',()=>{
  const d=evidence(false);d.pings[0].pingAt=11;
  assert.equal(analyzeChannelEvidence(evidence(),d).reason,'prefix_mismatch');
  const d2=evidence(false);d2.messages[0].typeCategory='focus.result';
  d2.prefix.clientTypeCounts={'focus.result':1,authenticate:1,'pair.confirm':1,ping:2};
  assert.equal(analyzeChannelEvidence(evidence(),d2).reason,'prefix_mismatch');
  const invalid=evidence();invalid.messages[0].conversationTitle='must not reach output';
  assert.equal(analyzeChannelEvidence(invalid,evidence(false)).status,'unknown');
});
test('known suffix failure contradicts eligible flags while normal suffix pending remains visible',()=>{
  for (const mutate of [w=>{w.messages.at(-1).typeCategory='scope.event.nack';},
    w=>{w.messages.at(-1).typeCategory='unknown';},w=>{w.messages.at(-1).localStateAttributionExact=false;},
    w=>{w.messages.at(-1).phase='unknown';}]) {
    const w=evidence();mutate(w);assert.equal(analyzeChannelEvidence(w,evidence(false)).status,'unknown');
  }
  const addPending=w=>{
    w.messages.push({...w.messages.at(-1),typeCategory:'scope.event',messageOrdinal:7,eventOrdinal:1,
      localStateAttributionExact:true,channelProofExact:null,interval:[7,7.1]});
    w.suffix.clientMessageCount++;w.suffix.clientTypeCounts['scope.event']=1;
    w.suffix.eventCount=1;w.suffix.pendingCount=1;w.suffix.phaseCounts.recording++;
  };
  const w=evidence(),d=evidence(false);addPending(w);addPending(d);
  assert.equal(analyzeChannelEvidence(w,d).status,'conditional_match');
  w.suffix.pendingCount=0;
  assert.equal(analyzeChannelEvidence(w,d).status,'unknown');
  w.suffix.pendingCount=1;w.run.observedThrough=6000;w.run.exportAt=6001;
  w.prefix.observedThrough=6000;w.suffix.observedThrough=6000;
  assert.equal(analyzeChannelEvidence(w,d).status,'unknown');
});
test('a prefix event without its unique ACK cannot be rescued by claimed completed validation',()=>{
  const addUnackedPrefix=w=>{
    const template=w.messages[3];
    w.messages.filter(m=>m.direction==='client_to_server'&&m.messageOrdinal>=4).forEach(m=>m.messageOrdinal++);
    w.messages.splice(3,0,{...template,typeCategory:'scope.event',messageOrdinal:4,pingOrdinal:null,eventOrdinal:1,
      localStateAttributionExact:true,channelProofExact:true,decisionComplete:true,currentAccepted:false});
    w.pings.forEach(p=>p.clientMessageOrdinal++);w.cut.clientMessageEnd++;
    w.cut.prefixEventCount=1;w.prefix.eventCount=1;w.prefix.clientMessageCount++;
    w.prefix.clientTypeCounts['scope.event']=1;w.prefix.phaseCounts.recording++;
  };
  const w=evidence(),d=evidence(false);addUnackedPrefix(w);addUnackedPrefix(d);
  assert.equal(analyzeChannelEvidence(w,d).status,'unknown');
});
test('series summary labels individual edges and leaves outcome/full chain unverified',()=>{
  const counts=Object.fromEntries(['dispatches','ingresses','invocations','allocations','cloneEdges','wireEvents','acks',
    'causalVerified','payloadVerified','contradictions','pending'].map(k=>[k,0]));
  const s={v:1,contract:'independent-series-v3',status:'collecting',formalAcceptance:false,
    semanticCompleteness:'unverified',counts,reasonCounts:{matched:1}};
  const e={kind:'series_edge',edgeOrdinal:1,at:1,recording:true,edge:'ingress_reduction',dispatchOrdinal:null,
    ingressOrdinal:1,invocationOrdinal:1,allocationOrdinal:null,connectionOrdinal:null,eventOrdinal:null,
    ownerScopeMatch:null,payloadExact:true,causalExact:true,proofExact:null,reason:'matched'};
  const r=analyzeSeriesEvidence(s,[e]);
  assert.equal(r.observed.causalTrue,1);assert.equal(r.fullChainVerified,false);assert.equal(r.edgeCountsArePartial,true);
  assert.equal(analyzeSeriesEvidence(s,[e,e]).status,'unknown');
  assert.equal(analyzeSeriesEvidence(null,[]).status,'unavailable');
  assert.equal(analyzeSeriesEvidence(s,[{...e,rawID:'no'}]).reason,'invalid_schema');
  const transformed=analyzeSeriesEvidence(s,[{...e,payloadExact:false,reason:'transformed_payload'}]);
  assert.equal(transformed.status,'partial');assert.equal(transformed.observed.contradictions,0);
  assert.equal(transformed.observed.transformedPayloadDifferences,1);
  assert.equal(analyzeSeriesEvidence(s,[{...e,causalExact:false}]).status,'unknown');
  assert.equal(analyzeSeriesEvidence(s,[{...e,reason:'missing_hook'}]).status,'unknown');
  const contradiction={kind:'series_sample',dispatchOrdinal:1,at:1,recording:true,witnessBeforeOrdinal:1,
    witnessAfterOrdinal:2,ownerOrdinal:1,semanticVerdict:{signal:'running_observed',state:'contradicted',outcome:'unknown'}};
  const semantics=analyzeSeriesEvidence(s,[contradiction]);
  assert.equal(semantics.status,'unknown');assert.equal(semantics.observed.semanticContradictions,1);
  const namespaced={...contradiction,tabOrdinal:2,documentOrdinal:7};
  assert.equal(analyzeSeriesEvidence(s,[namespaced]).observed.samples,1);
  for(const invalid of [{...contradiction,tabOrdinal:1},{...contradiction,documentOrdinal:1},
    {...namespaced,tabOrdinal:0},{...namespaced,documentOrdinal:null},{...namespaced,unexpected:1}]){
    assert.equal(analyzeSeriesEvidence(s,[invalid]).reason,'invalid_schema');
  }
});
