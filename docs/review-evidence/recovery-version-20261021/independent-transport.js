'use strict';

// Independently authored after freezing the requirements, before reading any
// product tests. The peer uses node:crypto and the documented wire context;
// no product canonical/proof function, fixture or expected result is reused.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const repo = '/workspace/scratch/71b181da6eca/mori-desk';
const sourcePath = process.argv[2] || path.join(repo, 'overlay/extensions/browser-bridge/transport.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const results = [];
const nativeSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const secret = Buffer.alloc(32, 91).toString('base64url');
const clientId = 'independent_client_0001';
const instanceId = 'independent_instance_01';
const runId = 'independent_server_run_1';
function proof(label, c, key=secret) {
  const context = ['mori-desk/browser/v1', label, 1, c.mode, c.credentialId,
    c.clientId, c.productId, c.instanceId, c.serverRunId, c.port,
    c.clientNonce, c.serverNonce];
  return crypto.createHmac('sha256', Buffer.from(key,'base64url')).update(JSON.stringify(context)).digest('base64url');
}
async function until(check, description) {
  for (let i=0;i<100;i++) { if(check()) return; await nativeSleep(2); }
  throw new Error('Driver boundary was not reached: '+description);
}
async function settle() { for(let i=0;i<5;i++) await nativeSleep(2); }
function makeHarness({gateLabel=null, storageGate=null, onConnected=null, onFocus=null}={}) {
  const sockets=[], status=[], intervals=new Map(), timeouts=new Map(), actions=[];
  let serial=0, readyCalls=0, clock=100000, stopped=false, tr;
  let credential={clientId,instanceId,key:secret,port:23333};
  const gate=deferred(); let gated=false, arrived=false;
  class Socket {
    constructor(url) { this.url=url; this.sent=[]; this.closed=false; sockets.push(this); actions.push(['socket',sockets.length]); }
    send(text) { if(this.closed) throw new Error('closed socket'); const value=JSON.parse(text); this.sent.push(value); actions.push(['send',sockets.indexOf(this)+1,value.type]); }
    close() { this.closed=true; actions.push(['close',sockets.indexOf(this)+1]); }
    open() { this.onopen?.(); }
    deliver(value) { this.onmessage?.({data:JSON.stringify(value)}); }
  }
  const cryptoApi={
    getRandomValues: bytes => crypto.webcrypto.getRandomValues(bytes),
    subtle:{
      importKey:(...args)=>crypto.webcrypto.subtle.importKey(...args),
      sign:async(...args)=>{
        const label=JSON.parse(new TextDecoder().decode(args[2]))[1];
        if(!gated && label===gateLabel) { gated=true; arrived=true; await gate.promise; }
        return crypto.webcrypto.subtle.sign(...args);
      }
    }
  };
  const sandbox={module:{exports:{}},exports:{},TextEncoder,TextDecoder,Uint8Array,btoa,atob,console,
    require:id=>{assert.equal(id,'./provider-utils.js'); return require(path.join(repo,'overlay/extensions/browser-bridge/provider-utils.js'));},
    setTimeout:(fn,ms)=>{const id=++serial;timeouts.set(id,{fn,ms});return id;},
    clearTimeout:id=>timeouts.delete(id),
    setInterval:(fn,ms)=>{const id=++serial;intervals.set(id,{fn,ms});actions.push(['interval',ms]);return id;},
    clearInterval:id=>intervals.delete(id)};
  vm.runInNewContext(source,sandbox,{filename:sourcePath});
  tr=new sandbox.module.exports.Transport({clientId,browserRunId:'independent_browser_run_1',
    WebSocketClass:Socket,cryptoApi,now:()=>clock,getCredential:()=>credential,
    saveCredential:async value=>{actions.push(['save-start']);if(storageGate)await storageGate.promise;credential=value;actions.push(['save-end']);},
    onStatus:value=>{status.push({...value});actions.push(['status',value.state]);if(value.state==='connected'&&onConnected)onConnected(tr);},
    onReady:()=>{readyCalls++;actions.push(['ready']);},
    onFocus:onFocus|| (async()=>({ok:false}))});
  return {tr,sockets,status,intervals,timeouts,actions,gate,get arrived(){return arrived;},
    get readyCalls(){return readyCalls;},setCredential:v=>{credential=v;},
    advance:ms=>{clock+=ms;},stop:()=>{stopped=true;tr.setEnabled(false);},
    cleanup:()=>{tr.setEnabled(false);timeouts.clear();intervals.clear();},
    connect:(port=23333,pairCode=null)=>{const pending=tr.connectOne(port,pairCode);pending.catch(()=>{});return pending;}};
}
function challengeFor(ws, port=23333) {
  const hello=ws.sent.find(x=>x.type==='hello');
  assert.ok(hello,'peer received hello');
  const c={type:'challenge',v:1,mode:hello.mode,credentialId:hello.credentialId,
    clientId,productId:'mori-desk',instanceId,serverRunId:runId,port,
    clientNonce:hello.clientNonce,serverNonce:Buffer.alloc(32,33).toString('base64url')};
  c.proof=proof('server-proof',c);return c;
}
async function authenticate(h, ws, port=23333) {
  ws.open();const c=challengeFor(ws,port);ws.deliver(c);
  await until(()=>ws.sent.some(x=>x.type==='authenticate'),'authenticate');
  assert.equal(ws.sent.find(x=>x.type==='authenticate').proof,proof('client-proof',c),'independent peer verifies proof');
  return c;
}
function ready(ws,port=23333) {ws.deliver({type:'ready',v:1,clientId,instanceId,serverRunId:runId,port});}
async function record(name,fn) {
  try {const details=await fn();results.push({name,result:'PASS',details});}
  catch(error){results.push({name,result:'FAIL',message:error.message,stack:error.stack});}
}

(async()=>{
  await record('T10 current connection proves authentication and event ACK',async()=>{
    const h=makeHarness();try{const p=h.connect();const ws=h.sockets[0];await authenticate(h,ws);ready(ws);await p;await settle();
      assert.equal(h.readyCalls,1);assert.equal(h.intervals.size,1);
      const event={type:'event',eventId:'receipt_R1',sessionId:'external_tab_A',browserRunId:'independent_browser_run_1',sequence:7};
      const ack=h.tr.sendEvent(event);ws.deliver({type:'event.ack',eventId:'receipt_R1',sessionId:event.sessionId,browserRunId:event.browserRunId,sequence:7});
      const actual=await ack;assert.equal(actual.eventId,'receipt_R1');
      return {readyCalls:h.readyCalls,sent:ws.sent.map(x=>x.type)};
    }finally{h.cleanup();}
  });
  for(const label of ['server-proof','client-proof']) {
    for(const interrupt of ['pause','replace']) await record(`T01/T03 ${label} delayed across ${interrupt}`,async()=>{
      const h=makeHarness({gateLabel:label});try{const old=h.connect();const c1=h.sockets[0];c1.open();c1.deliver(challengeFor(c1));await until(()=>h.arrived,'crypto gate');
        if(interrupt==='pause')h.stop();else{const p2=h.connect();const c2=h.sockets[1];await authenticate(h,c2);ready(c2);await p2;}
        const oldCount=c1.sent.length;const statuses=h.status.length;h.gate.resolve();await settle();
        assert.equal(c1.sent.length,oldCount,'old socket must not send after authority changes');
        assert.equal(h.status.length,statuses,'stale continuation must not publish status');
        assert.equal(h.readyCalls,interrupt==='replace'?1:0);
        if(interrupt==='replace')assert.equal(h.sockets[1].closed,false,'current socket survives old completion');
        else assert.equal(h.intervals.size,0,'paused transport has no heartbeat');
        await old.catch(()=>{});return {oldSent:c1.sent.map(x=>x.type),readyCalls:h.readyCalls};
      }finally{h.cleanup();}
    });
  }
  await record('T07 delayed rejected cryptography cannot close current connection',async()=>{
    const h=makeHarness({gateLabel:'server-proof'});try{const old=h.connect();const c1=h.sockets[0];c1.open();c1.deliver(challengeFor(c1));await until(()=>h.arrived,'crypto gate');
      const current=h.connect();const c2=h.sockets[1];await authenticate(h,c2);ready(c2);await current;
      h.gate.reject(new Error('controlled_crypto_failure'));await settle();await old.catch(()=>{});
      assert.equal(c2.closed,false);assert.equal(h.readyCalls,1);assert.equal(h.status.at(-1).state,'connected');return {currentOpen:!c2.closed};
    }finally{h.cleanup();}
  });
  await record('T01 ready credential persistence delayed across pause',async()=>{
    const save=deferred(),h=makeHarness({storageGate:save});try{const p=h.connect(23334);const c=h.sockets[0];await authenticate(h,c,23334);ready(c,23334);await until(()=>h.actions.some(x=>x[0]==='save-start'),'storage gate');
      h.stop();save.resolve();await settle();await p.catch(()=>{});assert.equal(h.readyCalls,0);assert.equal(h.intervals.size,0);assert.equal(h.status.at(-1).state,'paused');return {readyCalls:h.readyCalls};
    }finally{h.cleanup();}
  });
  await record('T06 old close and error leave current socket usable',async()=>{
    const h=makeHarness();try{const p1=h.connect();const c1=h.sockets[0];await authenticate(h,c1);ready(c1);await p1;
      const p2=h.connect();const c2=h.sockets[1];await authenticate(h,c2);ready(c2);await p2;const n=h.status.length;
      c1.onclose();c1.onerror();await settle();assert.equal(c2.closed,false);assert.equal(h.status.length,n);assert.equal(h.readyCalls,2);
      c2.deliver({type:'ping',at:123});await settle();assert.equal(c2.sent.at(-1).type,'pong');return {currentOpen:!c2.closed};
    }finally{h.cleanup();}
  });
  await record('T04 old focus response cannot be sent on a replacement connection',async()=>{
    const focus=deferred(),h=makeHarness({onFocus:()=>focus.promise});try{const p1=h.connect();const c1=h.sockets[0];await authenticate(h,c1);ready(c1);await p1;
      c1.deliver({type:'focus.request',requestId:'request_A'});await settle();const p2=h.connect();const c2=h.sockets[1];await authenticate(h,c2);ready(c2);await p2;
      focus.resolve({ok:true});await settle();assert.equal(c1.sent.some(x=>x.type==='focus.result'),false);assert.equal(c2.sent.some(x=>x.type==='focus.result'),false);assert.equal(c2.closed,false);
      return {currentOpen:!c2.closed};
    }finally{h.cleanup();}
  });
  await record('T09 connected status callback pauses transport before readiness continuation',async()=>{
    const h=makeHarness({onConnected:tr=>tr.setEnabled(false)});try{const p=h.connect();const c=h.sockets[0];await authenticate(h,c);ready(c);await p.catch(()=>{});await settle();
      const details={readyCalls:h.readyCalls,intervals:h.intervals.size,actions:h.actions};
      assert.equal(h.readyCalls,0,'onReady must not execute after onStatus synchronously paused the transport');
      assert.equal(h.intervals.size,0,'heartbeat must not be created after pause');return details;
    }finally{h.cleanup();}
  });
  await record('T08 stopped old crypto does not regain authority after explicit resume',async()=>{
    const h=makeHarness({gateLabel:'server-proof'});try{const old=h.connect();const c1=h.sockets[0];c1.open();c1.deliver(challengeFor(c1));await until(()=>h.arrived,'crypto gate');h.stop();h.tr.setEnabled(true);
      const c2=h.sockets[1];await authenticate(h,c2);ready(c2);await settle();h.gate.resolve();await settle();await old.catch(()=>{});
      assert.equal(c1.sent.length,1);assert.equal(h.readyCalls,1);assert.equal(c2.closed,false);return {readyCalls:h.readyCalls};
    }finally{h.cleanup();}
  });
  await record('T02/T06 superseded pair completion must not enable resume during new pairing',async()=>{
    const h=makeHarness();const code=pairingId=>'mori1:'+Buffer.from(JSON.stringify({v:1,productId:'mori-desk',instanceId,pairingId,port:23333,secret,expiresAt:110000})).toString('base64url');
    try{const old=h.tr.pair(code('pairing_attempt_one'));old.catch(()=>{});const p2=h.tr.pair(code('pairing_attempt_two'));p2.catch(()=>{});await settle();
      await old.catch(()=>{});const before=h.sockets.length;const unexpected=h.tr.ensureConnected({immediate:true});unexpected?.catch(()=>{});await settle();
      assert.equal(h.sockets.length,before,'old pair finally must not release the current pairing exclusion');
      return {socketCount:h.sockets.length};
    }finally{h.cleanup();}
  });
  const output={sourcePath,sourceHash:crypto.createHash('sha256').update(source).digest('hex'),criteriaHash:'3879ccaa0d1f952e23decbfa22ebc1f62cfdbe5bfacbfa29a28861f163b21fcc',node:process.version,
    method:'Independent VM socket/clock/crypto gates; real HMAC peer; no product test fixtures',results};
  fs.writeFileSync('/tmp/mori-next-independent-transport-results.json',JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify(output,null,2));
  process.exitCode=results.some(x=>x.result==='FAIL')?1:0;
})().catch(error=>{console.error(error.stack);process.exitCode=2;});
