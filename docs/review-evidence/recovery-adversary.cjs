'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const path = require('node:path');
const repoRoot = path.resolve(process.argv[2] || process.env.MORI_REVIEW_REPO || process.cwd());
const baselineRoot = process.argv[3] || process.env.MORI_REVIEW_BASELINE;
const outputDir = path.resolve(process.env.MORI_REVIEW_OUTPUT || path.join(require('node:os').tmpdir(), 'mori-independent-source-review'));
fs.mkdirSync(outputDir, { recursive: true });
const root = path.join(repoRoot, 'overlay/extensions/browser-bridge');
const recovery=require(`${root}/observer-recovery.js`);
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
async function ticks(){for(let i=0;i<50;i++)await Promise.resolve();}
async function testTimeoutRevocation(){
  let now=1000000,id=0,getCalls=0,startCalls=0;const timers=new Map(),activeTickets=new Set(),endEvents=[];
  const heldFiles=deferred(),diagnosticGet=deferred();let fileInvocation=false,diagnosticBlocked=false;
  const tab={id:11,url:'https://chatgpt.com/c/A',status:'complete'};
  function within(promise,ms=1500){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=++id;timers.set(timer,{at:now+ms,reject});})]).finally(()=>timers.delete(timer));}
  const chrome={runtime:{getManifest:()=>({version:'0.1.7'})},tabs:{
    get:async()=>{getCalls++;if(getCalls===4){diagnosticBlocked=true;return diagnosticGet.promise;}return {...tab};},
    sendMessage:async()=>{throw Error('no observer');}},permissions:{contains:async()=>true},scripting:{
      executeScript:async args=>{
        if(args.files){fileInvocation=true;return heldFiles.promise;}
        if(args.func.name==='startObserver'){startCalls++;return[{frameId:0,documentId:'document_A',result:{ok:false}}];}
        return[{frameId:0,documentId:'document_A',result:{url:tab.url,readyState:'complete',active:true}}];
      }} };
  const owner=recovery.createRecovery({chrome,within,getBlockReason:()=>null,now:()=>now,
    beginAttempt:()=>{activeTickets.add('ticket_A');return 'ticket_A';},
    endAttempt:(attempt,options)=>{activeTickets.delete(attempt);endEvents.push({attempt,options,at:now});},isAdmitted:()=>false});
  const pending=owner.ensure(tab);await ticks();assert.equal(fileInvocation,true);assert.equal(activeTickets.size,1);
  now+=4000;for(const[timer,entry]of[...timers])if(entry.at<=now){timers.delete(timer);entry.reject(Error('tab_unavailable'));}await ticks();
  assert.equal(diagnosticBlocked,true,'failure classification must actually be waiting on a browser lookup');
  assert.equal(activeTickets.size,0,'the timed-out attempt must be invalid before awaiting failure classification');
  heldFiles.resolve([{frameId:0,documentId:'document_A'}]);await ticks();assert.equal(startCalls,0,'late installer completion must never continue to start');
  diagnosticGet.resolve({...tab});await ticks();const result=await pending;
  assert.equal(result.ok,false);assert.equal(result.reason,'recovery_timeout');assert.ok(endEvents.length>=1);
  return {endEvents,startCalls};
}
async function main(){
  const result={scope:'Actual recovery module, reviewer-owned Chrome API schedule; delayed installation and separately held failure-classification lookup; not installed Chrome',sourceSha256:crypto.createHash('sha256').update(fs.readFileSync(`${root}/observer-recovery.js`)).digest('hex'),results:[]};
  try{const evidence=await testTimeoutRevocation();result.results.push({name:'timeout revokes ticket before slow failure classification and ignores late installer return',status:'PASS',evidence});}
  catch(error){result.results.push({name:'timeout revokes ticket before slow failure classification and ignores late installer return',status:'FAIL',reason:error.message});}
  fs.writeFileSync(path.join(outputDir, 'recovery-results.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
  process.exitCode=result.results.every(item=>item.status==='PASS')?0:1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
