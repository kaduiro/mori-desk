/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
// Isolated loopback instrumentation exercise. No browser, Electron userData,
// production credential or CLI integration is opened by this runner.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { fork } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createIsolatedDirectory, createCorrelationLedger } = require('./monitoring-measurement-dev');
const metrics = require('../extensions/browser-bridge/measurement-recorder');
const { Transport } = require('../extensions/browser-bridge/transport');
const { createBrowserBridge } = require('../src/browser-bridge-server');
const { EXTENSION_ID } = require('../src/browser-bridge-protocol');
const { WebSocket, Receiver } = require('ws');

async function exerciseClock() {
  const child = fork(__filename, ['--clock-child'], { stdio: ['ignore','ignore','ignore','ipc'], windowsHide: true });
  let timer;
  try {
    const calibration = await new Promise((resolve, reject) => {
      let sequence = 0, before, lower = -Infinity, upper = Infinity;
      timer = setTimeout(() => reject(new Error('measurement_clock_timeout')), 4000);
      child.once('error', reject);
      child.on('message', m => {
        const after = performance.now();
        if (!m || m.type !== 'clock.reply' || m.sequence !== sequence || !Number.isFinite(m.at) || m.at < 0) return reject(new Error('measurement_clock_schema'));
        // child-clock minus collector-clock lies in this interval. No RTT/2 assumption.
        lower = Math.max(lower, m.at - after); upper = Math.min(upper, m.at - before);
        if (lower > upper) return reject(new Error('measurement_clock_changed'));
        if (++sequence === 5) return resolve({status:'bounded', probes:5, uncertaintyMs:upper-lower});
        before = performance.now(); child.send({type:'clock.probe',sequence});
      });
      child.once('exit', () => reject(new Error('measurement_clock_exit')));
      before = performance.now(); child.send({type:'clock.probe',sequence});
    });
    return calibration;
  } finally { clearTimeout(timer); if(child.connected)child.disconnect(); if(child.exitCode===null)child.kill(); }
}

async function runMeasurement({ recording = true, sinkFailure = false } = {}) {
  if(typeof recording!=='boolean'||typeof sinkFailure!=='boolean')throw new Error('measurement_options');
  const owned = createIsolatedDirectory();
  const recorder = metrics.createRecorder({enabled:recording,now:()=>performance.now(),maxEntries:256,maxDurationMs:30000});
  const sink=sinkFailure?{record(){throw new Error('isolated_capture_failure');}}:recorder;
  const ledger = createCorrelationLedger();
  let expected = null, durable = null, durableInterval = null, received = null, ackInterval = null;
  let wireCount = 0, credential = null, connectionReady = false, ackSentInterval = null, sentCaptureMissing = false, readyRun = null;
  const sockets = [];
  const safeStorage = { isEncryptionAvailable:()=>true,
    encryptString:t=>Buffer.from(`ISOLATED-TEST-VAULT:${t}`),
    decryptString:b=>b.toString().slice('ISOLATED-TEST-VAULT:'.length) };
  const server = http.createServer((_req,res)=>{res.writeHead(404);res.end();});
  // Observe bytes at this owned server's public Socket.write boundary. Product
  // send()/record hooks do not supply the outbound ACK evidence. No bytes are
  // changed, suppressed or replayed, and this is never installed in the app.
  server.on('upgrade',(_request,socket)=>{
    const write=socket.write;
    const decoder=new Receiver({isServer:false,maxPayload:16384,maxBufferedChunks:64,maxFragments:64});
    let headers=Buffer.alloc(0), upgraded=false, frameStart=null, pendingAck=null;
    decoder.on('error',()=>{sentCaptureMissing=true;});
    decoder.on('message',data=>{
      try {
        const m=JSON.parse(data.toString('utf8'));
        if(m.type==='scope.event.ack')pendingAck={lower:frameStart,upper:null};
      } catch (_) {sentCaptureMissing=true;}
      frameStart=null;
    });
    socket.write=function(...args){
      const before=performance.now();
      try {
        let bytes=Buffer.isBuffer(args[0])?Buffer.from(args[0]):Buffer.from(args[0],typeof args[1]==='string'?args[1]:'utf8');
        if(!upgraded){
          headers=Buffer.concat([headers,bytes]);
          const end=headers.indexOf('\r\n\r\n');
          if(end>=0){bytes=headers.subarray(end+4);headers=Buffer.alloc(0);upgraded=true;}
          else {if(headers.length>8192)sentCaptureMissing=true;bytes=Buffer.alloc(0);}
        }
        if(bytes.length&&!sentCaptureMissing){if(frameStart===null)frameStart=before;decoder.write(bytes);}
      } catch (_) {sentCaptureMissing=true;}
      const written=Reflect.apply(write,this,args);
      if(pendingAck){ackSentInterval={lower:pendingAck.lower,upper:performance.now()};pendingAck=null;}
      return written;
    };
    socket.once('close',()=>{decoder.destroy();headers=Buffer.alloc(0);});
  });
  const bridge = createBrowserBridge({dataDir:owned.directory,safeStorage,measurement:sink,
    buildInfo:{desktopVersion:'0.1.3-preview.1',buildId:'e'.repeat(64),observerContract:1},
    onChange:()=>{
      if (!expected) return;
      const lower=performance.now();
      try {
        const d=JSON.parse(fs.readFileSync(path.join(owned.directory,'sessions.json'),'utf8'));
        if(d.sessions.some(r=>r.acceptedEventId===expected.eventId)) { durable=d; durableInterval={lower,upper:performance.now()}; }
      } catch (_) {}
    }});
  class WitnessSocket extends WebSocket {
    constructor(url) {
      super(url,{origin:`chrome-extension://${EXTENSION_ID}`}); sockets.push(this);
      this.on('message',data=>{
        const lower=performance.now();
        let m; try { m=JSON.parse(data.toString('utf8')); } catch (_) {return;}
        if(m.type==='ready')readyRun=m.serverRunId;
        if(m.type==='scope.event.ack') {received=Buffer.from(data);wireCount++;ackInterval={lower,upper:performance.now()};}
      });
    }
  }
  const transport = new Transport({clientId:'measurement-client',browserRunId:'measurement-run',
    getCredential:()=>credential,saveCredential:async c=>{credential=c;},WebSocketClass:WitnessSocket,
    measurement:sink,onReady:()=>{connectionReady=true;}});
  let result;
  try {
    bridge.attach(server);
    let listening=false;
    for(const candidate of [23337,23336,23335,23334,23333]) {
      const accepted=await new Promise((resolve,reject)=>{
        const failed=e=>{server.removeListener('listening',opened);if(e.code==='EADDRINUSE')resolve(false);else reject(e);};
        const opened=()=>{server.removeListener('error',failed);resolve(true);};
        server.once('error',failed);server.once('listening',opened);server.listen(candidate,'127.0.0.1');
      });
      if(accepted){listening=true;break;}
    }
    if(!listening)throw new Error('measurement_ports_busy');
    const port=server.address().port;
    // Connect only to the server just bound by this runner. Existing listeners
    // are skipped; the normal discovery-port and HMAC checks remain intact.
    await transport.pair(bridge.beginPairing(port).code);
    const scope={kind:'view',viewEpoch:'measurement-view',bindingEpoch:'measurement-binding',samplingEpoch:'measurement-sampling',
      workerEpoch:'measurement-worker',leaseId:'measurement-lease',documentId:'measurement-document',startUnobserved:true};
    expected={type:'scope.event',v:1,schema:2,eventId:'measurement-event',browserRunId:'measurement-run',sessionId:'measurement-session',
      sequence:1,kind:'terminal',provider:'chatgpt',tabId:1,pageInstanceId:'measurement-page',routeRevision:0,conversationRef:null,
      turnId:'measurement-turn',generation:1,phase:'settled',outcome:'unverified',observation:'fresh',observedAt:Date.now(),
      replay:false,scope,gap:null,conversationTitle:'',requestPreview:''};
    const sample={contentSequence:1,pageInstanceId:expected.pageInstanceId,generationToken:'measurement-token'};
    ledger.linkSample(sample,scope,[expected]);
    const sentAt=performance.now();
    const ack=await transport.sendEvent(expected);
    const validatedAt=performance.now();
    const correlation=ledger.compare(sample,expected);
    const witness=require('./monitoring-independent-witness');
    const point=p=>p?{clockGeneration:'collector-1',start:p.lower,end:p.upper}:null;
    const decoder=witness.createAckWitness();
    const evidence=decoder.inspect({wireAck:received,expectedEvent:expected,persistedSnapshot:durable,
      context:{authenticated:connectionReady,independentWire:!sentCaptureMissing,independentStore:!!durable,
        clientId:'measurement-client',browserRunId:'measurement-run',connectionId:'connection-1',currentConnectionId:'connection-1',
        serverRunId:readyRun,currentServerRunId:readyRun,scope},
      intervals:{durable:point(durableInterval),ackSent:point(ackSentInterval),ackFrame:point(ackInterval),
        ackValidated:{clockGeneration:'collector-1',start:validatedAt,end:validatedAt}}});
    decoder.dispose();
    const timing=metrics.judgeDelayInterval({lower:0,upper:validatedAt-sentAt},2000);
    result={environment:'isolated_node_loopback',safeStorage:'synthetic_test_vault',providerDOM:'not_observed',
      authenticated:connectionReady,wireAckCount:wireCount,exactAck:ack.eventId===expected.eventId,
      durableSnapshotBeforeAck:!!durableInterval&&durableInterval.upper<=ackInterval.lower,
      durableSnapshotBeforeWireWrite:!!durableInterval&&!!ackSentInterval&&durableInterval.upper<=ackSentInterval.lower,
      sentCaptureMissing,
      correlation,evidence,transportAckElapsedMs:validatedAt-sentAt,loopbackDelayClassification:timing,
      providerStartDeadline:'unverified',continuousOneSecond:'unverified',clock:await exerciseClock(),
      assessment:{measurement:evidence.pass?'loopback_evidence_available':'measurement_incomplete',
        providerProduct:'not_evaluated',productFixRequired:null,
        missing:['provider_signal_interval','continuous_owner_interval','external_t0','content_lease_interval','worker_current_ack_interval','native_ui']},
      recording:recorder.snapshot()};
  } finally {
    transport.setEnabled(false);
    for(const socket of sockets)socket.terminate();
    bridge.dispose();
    await new Promise(resolve=>server.close(resolve));
    ledger.stop(); recorder.stop(); owned.dispose();
  }
  return result;
}
module.exports={runMeasurement,exerciseClock};
if(require.main===module) {
  if(process.argv[2]==='--clock-child') {
    let n=0; const timer=setTimeout(()=>process.exit(1),5000);
    process.on('message',m=>{
      if(!m||m.type!=='clock.probe'||m.sequence!==n||n>=5)return;
      process.send({type:'clock.reply',sequence:n++,at:performance.now()});
    });
    process.on('disconnect',()=>{clearTimeout(timer);process.exit(0);});
  } else if(process.argv.length!==2) {process.stderr.write('Unknown measurement option.\n');process.exitCode=1;}
  else runMeasurement().then(r=>process.stdout.write(`${JSON.stringify(r,null,2)}\n`)).catch(()=>{
    process.stderr.write('Monitoring measurement failed; no provider verdict was produced.\n');process.exitCode=1;
  });
}
