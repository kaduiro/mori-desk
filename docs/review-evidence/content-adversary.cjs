'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const path = require('node:path');
const repoRoot = path.resolve(process.argv[2] || process.env.MORI_REVIEW_REPO || process.cwd());
const baselineRoot = process.argv[3] || process.env.MORI_REVIEW_BASELINE;
const outputDir = path.resolve(process.env.MORI_REVIEW_OUTPUT || path.join(require('node:os').tmpdir(), 'mori-independent-source-review'));
fs.mkdirSync(outputDir, { recursive: true });
const root = path.join(repoRoot, 'overlay/extensions/browser-bridge');
const source=fs.readFileSync(`${root}/content-script.js`,'utf8');
const utils=require(`${root}/provider-utils.js`),controller=require(`${root}/observation-controller.js`);
const coordinator=require(`${root}/session-coordinator.js`);
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{resolve,reject,promise};}
async function ticks(){for(let i=0;i<30;i++)await Promise.resolve();}
function eventTarget(){const all=new Map();return{addEventListener(type,fn){if(!all.has(type))all.set(type,new Set());all.get(type).add(fn);},removeEventListener(type,fn){all.get(type)?.delete(fn);},emit(type,value={}){for(const fn of all.get(type)||[])fn(value);}};}
async function harness({confirmed=false}={}){
  const messages=[],accepted=[],registrationQueue=[],listeners=new Set();let adapterReads=0,metadataReads=0;
  const page={generating:true,mode:'enabled',worker:'worker_1',bindingEpoch:'binding_A'};
  let now=1000000,jobId=0;const jobs=new Map();
  const document={...eventTarget(),body:{},prerendering:false,visibilityState:'visible',querySelectorAll:()=>[]};
  const windowEvents=eventTarget();const location={href:'https://chatgpt.com/c/A'};
  let productState={v:1,browserRunId:'review_run',tabs:{},sessions:{}};
  function automatic(message){
    if(message.type==='mori.observer.register'){
      if(page.mode!=='enabled')return {ok:false,reason:'paused'};
      return {ok:true,v:1,pageInstanceId:message.pageInstanceId,workerEpoch:page.worker,leaseId:`lease_${page.worker}`,bindingEpoch:page.bindingEpoch};
    }
    if(message.type==='mori.observation'){
      if(page.mode!=='enabled')return {ok:false,reason:'paused'};
      const result=coordinator.reduceObservation(productState,message,{tabId:11,documentId:'document_A',route:{provider:'chatgpt',path:'/c/A',conversationRef:'/c/A'}},{now});
      productState=result.state;accepted.push(...result.events);return{ok:true};
    }
    throw Error('unexpected message');
  }
  const chrome={runtime:{id:'review_extension',onMessage:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)},
    sendMessage:message=>{messages.push(structuredClone(message));
      if(message.type==='mori.observer.register'&&registrationQueue.length)return registrationQueue.shift()(message);
      return Promise.resolve(automatic(message));}}};
  const adapter={provider:'chatgpt',selectors:{STOP:[]},isStopTarget:()=>false,
    observe(){adapterReads++;return{supported:true,generating:page.generating,ready:true,hasAssistant:true};}};
  const context={crypto:crypto.webcrypto,URL,document,location,chrome,console,
    Date:class extends Date{static now(){return now;}},
    MutationObserver:class{observe(){}disconnect(){}},
    addEventListener:windowEvents.addEventListener,removeEventListener:windowEvents.removeEventListener,
    setTimeout:(fn,ms)=>{const id=++jobId;jobs.set(id,{fn,at:now+ms});return id;},clearTimeout:id=>jobs.delete(id),
    setInterval:(fn,ms)=>{const id=++jobId;jobs.set(id,{fn,at:now+ms,interval:ms});return id;},clearInterval:id=>jobs.delete(id),
    MoriProviderUtils:utils,MoriObservationController:controller,MoriChatgptAdapter:adapter,MoriClaudeAdapter:adapter,
    MoriConversationMetadata:{createReader:()=>({knownConversationKeys:()=>new Set(),sample(){metadataReads++;return{conversationTitle:'Ledger A',requestPreview:'Submitted A'};}})},
    MoriConversationBinding:confirmed?{createTracker:()=>({sample:()=>({state:'confirmed',epoch:page.bindingEpoch})})}:require(`${root}/conversation-binding.js`),
  };
  vm.createContext(context);vm.runInContext(source,context);
  const api={page,messages,accepted,registrationQueue,document,location,windowEvents,
    get adapterReads(){return adapterReads;},get metadataReads(){return metadataReads;},
    async start(attemptId=null){return context.MoriBrowserObserver.start({attemptId});},
    async message(message){return new Promise(resolve=>{for(const fn of listeners)fn(message,{id:'review_extension'},resolve);});},
    async advance(ms){now+=ms;for(const[id,job]of[...jobs])if(job.at<=now){if(job.interval)job.at=now+job.interval;else jobs.delete(id);job.fn();}await ticks();},
  };
  return api;
}
const results=[];async function check(name,fn){try{await fn();results.push({name,status:'PASS'});}catch(error){results.push({name,status:'FAIL',reason:error.message});}}
async function main(){
  await check('production binding remains unconfirmed at all entry paths',async()=>{
    const ui=await harness();await ui.start();
    for(const type of ['mori.observe.now','mori.health.check','mori.observer.identity'])await ui.message({type});
    ui.document.emit('visibilitychange');ui.windowEvents.emit('pageshow');ui.windowEvents.emit('popstate');
    await ui.advance(11000);
    const identity=await ui.message({type:'mori.observer.identity'});
    const focus=await ui.message({type:'mori.focus.check',pageInstanceId:identity.pageInstanceId,conversationRef:'/c/A'});
    assert.equal(identity.binding.state,'unconfirmed');assert.equal(focus.ok,false);
    assert.equal(ui.adapterReads,0);assert.equal(ui.metadataReads,0);
    assert.equal(ui.messages.filter(message=>message.type==='mori.observation').length,0);
  });
  await check('late registration for old route cannot publish or focus',async()=>{
    const ui=await harness({confirmed:true}),pending=deferred();let initial;
    ui.registrationQueue.push(message=>{initial=message;return pending.promise;});
    const start=ui.start('ticket_A');await ticks();
    ui.location.href='https://chatgpt.com/c/B';ui.page.bindingEpoch='binding_B';
    await ui.message({type:'mori.observer.identity'});
    pending.resolve({ok:true,v:1,pageInstanceId:initial.pageInstanceId,workerEpoch:'worker_1',leaseId:'lease_A',bindingEpoch:'binding_A'});
    assert.equal((await start).ok,false);assert.equal(ui.messages.filter(message=>message.type==='mori.observation').length,0);
  });
  await check('worker-only registration preserves an uninterrupted running generation',async()=>{
    const ui=await harness({confirmed:true});await ui.start();
    const running=ui.messages.find(message=>message.type==='mori.observation');assert.equal(running.status,'running');
    ui.page.worker='worker_2';await ui.start('ticket_2');
    ui.page.generating=false;await ui.message({type:'mori.observe.now'});await ui.advance(900);
    const terminal=ui.accepted.filter(event=>event.kind==='terminal');
    assert.equal(terminal.length,1);assert.equal(terminal[0].generation,1);
  });
  await check('no terminal may be inferred after a lease-gated unsampled pause',async()=>{
    const ui=await harness({confirmed:true});await ui.start();
    ui.page.mode='paused';await ui.message({type:'mori.observe.now'});await ticks();
    const reads=ui.adapterReads;ui.page.generating=false;
    await ui.message({type:'mori.observe.now'});await ui.advance(10001);
    assert.equal(ui.adapterReads,reads,'gap must actually withhold samples to exercise this case');
    ui.page.mode='enabled';await ui.start('ticket_after_pause');await ui.advance(900);
    const terminal=ui.accepted.filter(event=>event.kind==='terminal');
    assert.equal(terminal.length,0,'running before unsampled pause + idle after resume must not create terminal');
  });
  const output={scope:'Independent event ledger; actual content/controller/coordinator; controlled confirmed binding only to exercise protocol; production binding tested separately; not real provider evidence',sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),results};
  fs.writeFileSync(path.join(outputDir, 'content-results.json'),JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output,null,2));
  process.exitCode=results.every(result=>result.status==='PASS')?0:1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
