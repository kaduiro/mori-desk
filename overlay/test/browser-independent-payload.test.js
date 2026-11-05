/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
// Synthetic codec regression. No provider DOM, timing or independent acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const codec = require('../scripts/monitoring-independent-payload');
const scope = {kind:'conversation',viewEpoch:'view',bindingEpoch:'binding',samplingEpoch:'sampling',
  workerEpoch:'worker',leaseId:'lease',documentId:'document',startUnobserved:false};
const sample = {type:'mori.observation',v:2,pageInstanceId:'page',contentSequence:1,observedAt:10,
  status:'running',generationToken:'token',outcome:null,workerEpoch:'worker',leaseId:'lease',
  bindingEpoch:'binding',scopeKind:'conversation',viewEpoch:'view',samplingEpoch:'sampling',startUnobserved:false};
const event = {type:'scope.event',v:1,schema:2,eventId:'event',browserRunId:'run',sessionId:'session',sequence:1,
  kind:'observation',provider:'chatgpt',tabId:0,pageInstanceId:'page',routeRevision:0,conversationRef:'/c/conversation',
  turnId:'turn',generation:1,phase:'running',outcome:null,observation:'fresh',observedAt:10,replay:false,scope,gap:null};
test('independent payload strict copies retain all state/attribution fields without product helpers', () => {
  const result = codec.eventOf(event);
  assert.deepEqual(result,event);
  assert.notEqual(result,event);
  assert.notEqual(result.scope,scope);
  assert.equal(Object.isFrozen(result.scope),true);
  assert.deepEqual(codec.sampleOf(sample),sample);
  assert.equal(codec.equal(result,{...event,scope:{...scope}}),true);
  for (const [field,value] of [['replay',true],['observedAt',11],['outcome','error'],['routeRevision',1],['kind','gap']])
    assert.equal(codec.equal(result,{...event,[field]:value}),false,field);
  assert.equal(codec.equal(result,{...event,scope:{...scope,startUnobserved:true}}),false);
  assert.equal(codec.equal(null,null),false);
});
test('unknown keys, metadata, proof values and accessors never become codec inputs', () => {
  let reads = 0;
  const metadata = {...event};
  Object.defineProperty(metadata,'conversationTitle',{enumerable:true,get(){reads++;throw new Error();}});
  assert.equal(codec.eventOf(metadata),null);
  const accessor = {...sample};
  Object.defineProperty(accessor,'status',{enumerable:true,get(){reads++;return 'running';}});
  assert.equal(codec.sampleOf(accessor),null);
  assert.equal(reads,0);
  assert.equal(codec.eventOf({...event,other:1}),null);
  assert.equal(codec.eventOf(Object.assign(Object.create({inherited:1}),event)),null);
  assert.equal(codec.eventOf({...event,[Symbol('hidden')]:1}),null);
  const ack = {type:'scope.event.ack',schema:2,eventId:'event',browserRunId:'run',sessionId:'session',sequence:1,
    disposition:'committed_current',duplicate:false,proofPresent:true,reason:null};
  assert.deepEqual(codec.ackOf(ack),ack);
  assert.equal(codec.ackOf({...ack,proof:'do-not-retain'}),null);
  assert.equal(codec.ackOf({...ack,disposition:'duplicate_durable'}),null);
  assert.equal(codec.withinBytes({requestPreview:'do-not-retain'},65536),false);
});
test('schema constraints reject legacy, inconsistent gap, route, outcome and null identifiers', () => {
  assert.equal(codec.sampleOf({...sample,v:1}),null);
  assert.equal(codec.sampleOf({...sample,status:'settled'}),null);
  assert.equal(codec.sampleOf({...sample,status:'settled',outcome:'unverified'}).outcome,'unverified');
  assert.equal(codec.sampleOf({...sample,status:'idle',outcome:'unverified'}),null);
  assert.equal(codec.scopeOf({...scope,workerEpoch:null}),null);
  assert.equal(codec.eventOf({...event,provider:'claude'}),null);
  assert.equal(codec.eventOf({...event,kind:'terminal'}),null);
  const gap = {...event,kind:'gap',observation:'stale',gap:{turnId:'turn',reason:'scope_lost',observedAt:10}};
  assert.deepEqual(codec.eventOf(gap),gap);
  assert.equal(codec.eventOf({...gap,gap:{...gap.gap,observedAt:11}}),null);
  assert.equal(codec.eventOf({...event,turnId:null}),null);
  assert.equal(codec.eventOf({...event,sequence:0}),null);
  assert.equal(codec.eventOf({...event,eventId:'x'.repeat(129)}),null);
  assert.equal(codec.contextOf({tabId:0,documentId:'other',scope,
    route:{provider:'chatgpt',kind:'conversation',conversationRef:'/c/conversation'}}),null);
});
test('bounded descriptor preflight rejects holes, cycles and bytes without invoking getters', () => {
  assert.equal(codec.arrayOf([,1],2),null);
  assert.equal(codec.arrayOf(Object.assign([1],{other:2}),2),null);
  const cyclic = {};cyclic.loop=cyclic;
  assert.equal(codec.withinBytes(cyclic,65536),false);
  assert.equal(codec.withinBytes({x:'a'.repeat(513)},65536),false);
  assert.equal(codec.withinBytes({x:'あ'},10),false);
  assert.equal(codec.withinBytes({x:'あ'},11),true);
  let reads=0;
  const value={};Object.defineProperty(value,'x',{enumerable:true,get(){reads++;return 'x';}});
  assert.equal(codec.withinBytes(value,65536),false);
  assert.equal(reads,0);
});
