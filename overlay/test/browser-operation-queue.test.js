'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createQueue } = require('../extensions/browser-bridge/operation-queue');

test('read-only preparation runs in parallel, but later events cannot pass the same tab head', async () => {
  const q = createQueue(), calls = []; let release;
  const first = q.enqueue(() => calls.push('A-running'), { key:'A', prepare:()=>new Promise(r=>release=r) });
  const second = q.enqueue(() => calls.push('A-terminal'), { key:'A', priority:true });
  const other = q.enqueue(() => calls.push('B-register'), { key:'B', priority:true });
  await other; assert.deepEqual(calls,['B-register']);
  release(); await Promise.all([first,second,q.whenIdle()]);
  assert.deepEqual(calls,['B-register','A-running','A-terminal']);
});

test('priority bursts reserve normal work and rotate among all eligible tab heads', async () => {
  const q = createQueue({maxPriorityBurst:3}), calls=[], jobs=[];
  for(let i=0;i<8;i++) for(const key of ['A','B','C'])
    jobs.push(q.enqueue(()=>calls.push(key),{key,priority:true}));
  jobs.push(q.enqueue(()=>calls.push('ACK-cleanup'),{key:'mutation'}));
  jobs.push(q.enqueue(()=>calls.push('D-periodic'),{key:'D'}));
  await Promise.all(jobs); await q.whenIdle();
  assert.deepEqual(calls.slice(0,4),['A','B','C','ACK-cleanup']);
  assert.equal(calls.indexOf('D-periodic'),7);
  assert.deepEqual(calls.filter(x=>['A','B','C'].includes(x)).slice(0,12),['A','B','C','A','B','C','A','B','C','A','B','C']);
});

test('preparation failures and rejected operations release their position without committing', async () => {
  const q = createQueue(), calls=[];
  const a=q.enqueue(()=>calls.push('must-not-run'),{key:'A',prepare:()=>Promise.reject(undefined)});
  const b=q.enqueue(()=>{throw new Error('injected');},{key:'A'});
  const c=q.enqueue(()=>calls.push('after'),{key:'A'});
  const results=await Promise.allSettled([a,b,c]);await q.whenIdle();
  assert.deepEqual(results.map(r=>r.status),['rejected','rejected','fulfilled']);
  assert.deepEqual(calls,['after']);
});

test('idle waits for prepared and running work and can be reused for a later batch', async () => {
  const q=createQueue();let release,done=false;
  const job=q.enqueue(()=>{}, {prepare:()=>new Promise(r=>release=r)});
  const idle=q.whenIdle().then(()=>done=true);
  await new Promise(r=>setImmediate(r)); assert.equal(done,false);
  release();await Promise.all([job,idle]);assert.equal(done,true);
  let ran=false;await q.enqueue(()=>ran=true);await q.whenIdle();assert.equal(ran,true);
});

test('queue admission and external preparation concurrency are bounded', async () => {
  const q=createQueue({maxPending:3,maxPreparing:2}), releases=new Map();let active=0,peak=0;
  const jobs=['A','B','C'].map(key=>q.enqueue(()=>key,{key,prepare:()=>new Promise(resolve=>{
    active++;peak=Math.max(peak,active);releases.set(key,()=>{active--;resolve();});
  })}));
  await assert.rejects(q.enqueue(()=>assert.fail('must not run'),{key:'overflow'}),{code:'observer_queue_full'});
  await new Promise(r=>setImmediate(r));assert.equal(active,2);assert.equal(releases.has('C'),false);
  releases.get('A')();await new Promise(r=>setImmediate(r));assert.equal(releases.has('C'),true);
  releases.get('B')();releases.get('C')();await Promise.all(jobs);await q.whenIdle();assert.equal(peak,2);
  assert.equal(await q.enqueue(()=>42),42);
});
