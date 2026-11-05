/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
// Instrumentation checks, not native provider acceptance.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const fs=require('node:fs'),path=require('node:path');
const {compileWorker,createCorrelationLedger,createIsolatedDirectory}=require('../scripts/monitoring-measurement-dev');
const scope={kind:'view',viewEpoch:'v',bindingEpoch:'b',samplingEpoch:'s',workerEpoch:'w',leaseId:'l',documentId:'d',startUnobserved:true};
const event={browserRunId:'r',sessionId:'x',eventId:'e',sequence:1,tabId:1,pageInstanceId:'p',routeRevision:0,turnId:'t',generation:1,kind:'terminal',scope};
const sample={contentSequence:1,pageInstanceId:'p',generationToken:'g'};
function proofHelpers(source){return 'function measurementFailure() {}\n'+source.slice(source.indexOf('function measurementProjection('),source.indexOf('function measurementSender('));}
function realmEvent(context,value){return vm.runInContext('('+JSON.stringify({v:1,schema:2,provider:'chatgpt',conversationRef:null,phase:'settled',outcome:'unverified',observation:'fresh',gap:null,...value})+')',context);}
test('worker current-ACK trace requires the actual connection/document and 15-second sample age',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../extensions/browser-bridge/service-worker.js'),'utf8');
  const body=source.slice(source.indexOf('function recordProof('),source.indexOf('\nfunction desktopWriteFailed('));
  const contract=require('../extensions/browser-bridge/monitoring-contract');
  for(const [sampleAge,documentId,currentConnection,expectedCount] of [[15000,'d',true,1],[15001,'d',true,0],[0,'other',true,0],[0,'d',false,0]]){
    const stages=[],connection={},credential={},at=20000;
    const outgoing={...event,type:'scope.event',observedAt:at-sampleAge,replay:false};
    const context=vm.createContext({monitoring:contract,measurement:{},Date:{now:()=>at},performance:{now:()=>at},
      controlGeneration:0,credential,desktopFault:null,diagnostic:null,deliveryFailures:new Map(),savedProofs:new Map(),revokedProofs:new Map(),
      transport:{connection,isReady:()=>true},coordinator:{MAX_TABS:20},
      sessions:{tabs:{1:'x'},sessions:{x:{sessionId:'x',scope,observation:'fresh',sequence:1,lastObservationAt:outgoing.observedAt}}},
      observerLeases:new Map([[1,{generation:0,pageInstanceId:'p',documentId,workerEpoch:'w',leaseId:'l',bindingEpoch:'b'}]]),
      leaseFieldsMatch:(a,b)=>['workerEpoch','leaseId','bindingEpoch'].every(k=>a[k]===b[k]),
      currentEvent:()=>true,measure:s=>stages.push(s),publishHealth:()=>{}});
    vm.runInContext(proofHelpers(source)+body,context);
    context.recordProof(realmEvent(context,outgoing),{disposition:'committed_current',proof:'opaque-test-proof',reason:null},
      {generation:0,credential,connection:currentConnection?connection:{}});
    assert.equal(stages.filter(s=>s==='ack_validated_current').length,expectedCount);
  }
});
test('worker capture injection is lexical and rejects missing/duplicate build seam',()=>{
  const source='const measurement = null; // MORI_MEASUREMENT_SINK\nmeasurement.record("worker_received");';
  const stages=[], context=vm.createContext({measurement:{record(){throw new Error('public global used');}}});
  compileWorker(source,context,{record:s=>stages.push(s)});
  assert.deepEqual(stages,['worker_received']);
  assert.throws(()=>compileWorker('',context,{}),/seam/);
  assert.throws(()=>compileWorker(source+source,context,{}),/seam/);
});
test('normal content entry exposes no measurement start option and has no recording side effect',()=>{
  const context=vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../extensions/browser-bridge/content-script.js'),'utf8'),context);
  assert.deepEqual(Object.keys(context.MoriBrowserObserver),['start']);
  assert.equal(Object.hasOwn(context,'measurement'),false);
  assert.equal(Object.hasOwn(context,'MoriMeasurementRecorder'),false);
});
test('cross-VM categorical records are copied without invoking metadata getters',()=>{
  const {createRecorder}=require('../extensions/browser-bridge/measurement-recorder');
  const recorder=createRecorder({enabled:true,now:()=>10});
  compileWorker('const measurement = null; // MORI_MEASUREMENT_SINK\nmeasurement.record("worker_committed",{count:2});',vm.createContext({}),recorder);
  assert.equal(recorder.snapshot().stages.worker_committed,1);
  assert.equal(recorder.snapshot().missing,false);
});
test('one sample can correlate multiple emitted events without exporting identities or text',()=>{
  const ledger=createCorrelationLedger();
  assert.equal(ledger.linkSample(sample,scope,[event,{...event,eventId:'e2',kind:'gap'}]),true);
  assert.deepEqual(ledger.summary(),{count:2,missing:false,stopped:false});
  const r=ledger.compare(sample,event);
  assert.equal(r.sameSample,true);assert.equal(r.sameEvent,true);assert.equal(r.sameScope,true);
  assert.equal(ledger.compare(sample,{...event,scope:{...scope,samplingEpoch:'other'}}).sameScope,false);
  assert.equal(ledger.compare({...sample,generationToken:'other'},event).sameSample,false);
  assert.equal(Object.keys(r).some(k=>/Id|Sequence|Token/.test(k)),false);
  ledger.stop();assert.equal(ledger.compare(sample,event).status,'unknown');
});
test('correlation loss/overflow is unknown and retained identity state is bounded',()=>{
  const ledger=createCorrelationLedger({maxEntries:1});
  assert.equal(ledger.linkSample(sample,scope,[event,event]),false);
  assert.deepEqual(ledger.summary(),{count:0,missing:true,stopped:false});
  assert.equal(ledger.compare(sample,event).status,'unknown');
  const other=createCorrelationLedger();
  assert.equal(other.linkSample(sample,scope,[event,event]),true);
  assert.equal(other.compare(sample,event).status,'unknown');
  assert.equal(createCorrelationLedger().linkSample(sample,scope,[{...event,eventId:12}]),false);
});
test('isolated store cleanup checks its own marker and never opens the production store',()=>{
  const owned=createIsolatedDirectory();
  const marker=JSON.parse(fs.readFileSync(path.join(owned.directory,'.mori-measurement-owner.json')));
  assert.equal(marker.kind,'isolated-measurement');
  assert.match(path.basename(owned.directory),/^mori-measurement-/);
  fs.writeFileSync(path.join(owned.directory,'test.json'),'{}');
  owned.dispose();assert.equal(fs.existsSync(owned.directory),false);
});
test('real Node loopback records durable/ACK categories with no provider verdict or identity export',async()=>{
  const {runMeasurement}=require('../scripts/run-monitoring-measurement');
  const result=await runMeasurement();
  assert.equal(result.environment,'isolated_node_loopback');
  assert.equal(result.authenticated,true);assert.equal(result.wireAckCount,1);
  assert.equal(result.durableSnapshotBeforeAck,true);
  assert.equal(result.durableSnapshotBeforeWireWrite,true);
  assert.equal(result.evidence.pass,true);assert.equal(result.evidence.formalAcceptance,false);
  assert.equal(result.correlation.sameScope,true);assert.equal(result.exactAck,true);
  assert.equal(result.providerStartDeadline,'unverified');
  assert.equal(result.clock.status,'bounded');assert.equal(result.clock.probes,5);
  assert.ok(result.recording.stages.durable_commit>=1);
  const text=JSON.stringify(result);
  for(const privateValue of ['measurement-client','measurement-session','measurement-token','measurement-turn','chrome-extension://'])assert.equal(text.includes(privateValue),false);
});
test('disabled and throwing capture cannot change actual loopback durable ACK outcome',async()=>{
  const {runMeasurement}=require('../scripts/run-monitoring-measurement');
  for(const options of [{recording:false},{sinkFailure:true}]){
    const result=await runMeasurement(options);
    assert.equal(result.exactAck,true);assert.equal(result.evidence.pass,true);
    assert.equal(result.recording.status,'unknown');
    assert.equal(result.recording.counts.recorded,0);
  }
});


test('ACK diagnostic reports actual suppressing gates without changing proof storage decisions',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../extensions/browser-bridge/service-worker.js'),'utf8');
  const body=source.slice(source.indexOf('function recordProof('),source.indexOf('\nfunction desktopWriteFailed('));
  const gates=['accepted_current','control_generation_changed','credential_changed','proof_absent','disposition_not_current','replay',
    'session_not_current','transport_not_ready','connection_changed','lease_missing','lease_generation_changed','page_changed',
    'document_changed','lease_scope_changed','observation_not_fresh','sequence_changed','event_time_invalid','event_expired','sample_time_invalid','sample_expired'];
  for(const expected of gates){
    const connection={},credential={},at=20000,decisions=[],stages=[];
    const outgoing={...event,type:'scope.event',observedAt:at,replay:false};
    const record={observation:'fresh',sequence:1,lastObservationAt:at};
    const lease={generation:0,pageInstanceId:'p',documentId:'d',workerEpoch:'w',leaseId:'l',bindingEpoch:'b'};
    const owner={generation:0,credential,connection},ack={disposition:'committed_current',proof:'opaque',reason:null};
    const c={monitoring:require('../extensions/browser-bridge/monitoring-contract'),measurement:{ackDecision:(e,d)=>decisions.push(d)},
      Date:{now:()=>at},performance:{now:()=>at},controlGeneration:0,credential,desktopFault:null,diagnostic:null,
      deliveryFailures:new Map(),savedProofs:new Map(),revokedProofs:new Map(),transport:{connection,isReady:()=>true},coordinator:{MAX_TABS:20},
      sessions:{tabs:{1:'x'},sessions:{x:record}},observerLeases:new Map([[1,lease]]),leaseFieldsMatch:()=>true,
      currentEvent:()=>true,measure:s=>stages.push(s),publishHealth:()=>{}};
    if(expected==='control_generation_changed')owner.generation=1;
    if(expected==='credential_changed')owner.credential={};
    if(expected==='proof_absent')ack.proof=null;
    if(expected==='disposition_not_current')ack.disposition='committed_receipt';
    if(expected==='replay')outgoing.replay=true;
    if(expected==='session_not_current')c.currentEvent=()=>false;
    if(expected==='transport_not_ready')c.transport.isReady=()=>false;
    if(expected==='connection_changed')owner.connection={};
    if(expected==='lease_missing')c.observerLeases.clear();
    if(expected==='lease_generation_changed')lease.generation=1;
    if(expected==='page_changed')lease.pageInstanceId='other';
    if(expected==='document_changed')lease.documentId='other';
    if(expected==='lease_scope_changed')c.leaseFieldsMatch=()=>false;
    if(expected==='observation_not_fresh')record.observation='stale';
    if(expected==='sequence_changed')record.sequence=2;
    if(expected==='event_time_invalid')outgoing.observedAt=at+1;
    if(expected==='event_expired')outgoing.observedAt=at-c.monitoring.PROOF_MS;
    if(expected==='sample_time_invalid')record.lastObservationAt=at+1;
    if(expected==='sample_expired')record.lastObservationAt=at-c.monitoring.MAX_SAMPLE_GAP_MS-1;
    const realm=vm.createContext(c);
    vm.runInContext(proofHelpers(source)+body,realm);c.recordProof(realmEvent(realm,outgoing),ack,owner);
    assert.equal(decisions[0].gate,expected,expected);
    assert.equal(stages.includes('ack_validated_current'),expected==='accepted_current',expected);
    assert.equal(c.savedProofs.size,['control_generation_changed','credential_changed','proof_absent','disposition_not_current','replay'].includes(expected)?0:1,expected);
  }
});
test('observer installed requires successful DOM attachment, inspection finish encloses early unknown and errors',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../extensions/browser-bridge/content-script.js'),'utf8');
  const bind=source.slice(source.indexOf('    function bindObserver('),source.indexOf('    function schedule('));
  const stages=[],doc={body:null},observer={disconnect(){},observe(){}};
  const c=vm.createContext({document:doc,observer,observerRoot:null,measure:(s,f)=>stages.push([s,f])});
  vm.runInContext(bind,c);c.bindObserver();assert.equal(stages[0][0],'observer_install_deferred');
  doc.body={};c.bindObserver();assert.equal(stages.filter(r=>r[0]==='observer_installed').length,1);
  c.bindObserver();assert.equal(stages.filter(r=>r[0]==='observer_installed').length,1);
  doc.body={};observer.observe=()=>{throw Error('controlled');};assert.throws(()=>c.bindObserver());
  assert.equal(stages.filter(r=>r[0]==='observer_installed').length,1);
  const observe=source.slice(source.indexOf('    function observe(force)'),source.indexOf('    function onPageClick('));
  const records=[],context=vm.createContext({stopped:false,runtimeId:()=>true,measure:s=>records.push(s),refreshIdentity(){},bindObserver(){},
    performance:{now:()=>10},lastSampleMono:null,lease:null,binding:{state:'unconfirmed'},route:{},breakSamplingContinuity(){},identity:()=>({})});
  vm.runInContext(observe,context);context.observe(false);
  assert.deepEqual(records,['product_inspection_started','product_inspection_finished']);
  records.length=0;context.refreshIdentity=()=>{throw Error('controlled');};assert.throws(()=>context.observe(false));
  assert.deepEqual(records,['product_inspection_started','product_inspection_finished']);
});


test('content registration hook preserves worker negatives and classifies stale local gates separately',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../extensions/browser-bridge/content-script.js'),'utf8');
  const helper=source.slice(source.indexOf('    function registrationMeasured('),source.indexOf('    const utils ='));
  const request=source.slice(source.indexOf('    function requestRegistration('),source.indexOf('    function sendObservation('));
  async function run({reply={ok:false,reason:'attempt_expired'},mutate=null,reject=false}={}){
    const diagnostics=[],stages=[];let release;
    const c={measurement:{registrationResult:v=>diagnostics.push({...v})},measure:s=>stages.push(s),stopped:false,runtimeId:()=>true,
      attemptId:'a',refreshIdentity(){},registrationPending:null,canRetryRegistrationQuickly:()=>false,REGISTRATION_RETRY_MS:500,
      lastRegistrationAt:-Infinity,registrationSerial:0,pageInstanceId:'p',route:null,binding:{epoch:'b',state:'unconfirmed'},
      observerVersion:'0.1.15',utils:{sameRoute:(a,b)=>a===b,safeObservationAck:r=>r,safeLease:()=>null},
      fastRegistrationFailures:0,admittedDomUnknown:false,lease:null,lastRegistrationResult:{ok:false,reason:'binding_unconfirmed'},
      handleRuntimeFailure(){},breakSamplingContinuity(){},chrome:{runtime:{sendMessage:()=>new Promise((resolve,rejecter)=>{release=()=>reject?rejecter(Error('PRIVATE_EXCEPTION')):resolve(reply);})}}};
    const context=vm.createContext(c);vm.runInContext(helper+request,context);
    const promise=context.requestRegistration('a',true);if(mutate)mutate(context);release();
    const result=await promise;return {result,diagnostics,stages};
  }
  let r=await run();assert.equal(r.result.reason,'attempt_expired');assert.equal(r.diagnostics[0].reason,'attempt_expired');
  r=await run({reply:{ok:false,reason:'binding_unconfirmed'},mutate:c=>{c.registrationSerial++;}});
  assert.equal(r.result.reason,'binding_unconfirmed');assert.equal(r.diagnostics[0].reason,'registration_replaced');
  r=await run({reject:true});assert.equal(r.result.reason,'registration_failed');assert.equal(r.diagnostics[0].reason,'message_failed');
  assert.doesNotMatch(JSON.stringify(r.diagnostics),/PRIVATE_EXCEPTION/);
});
