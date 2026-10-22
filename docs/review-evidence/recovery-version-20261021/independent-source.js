'use strict';

// Independent artifact fixtures. Only product source APIs are loaded; the
// repository's runtime-source.test.js was first read only after this fixture
// and its original 23 cases had been authored and executed; it is not reused.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const crypto=require('node:crypto'),assert=require('node:assert/strict');
const repo=process.env.MORI_INDEPENDENT_SOURCE_ROOT||'/workspace/scratch/71b181da6eca/mori-desk';
const files=['prepare-runtime.js','doctor.js','run.js'];
const source=Object.fromEntries(files.map(x=>[x,fs.readFileSync(path.join(repo,'scripts',x),'utf8')]));
const results=[];
let fifoNumber=0;
function preparedFifo(destination){fs.renameSync('/tmp/mori-next-independent-fifos/fifo-'+(++fifoNumber),destination);}
const forbiddenWrites=new Set(['writeFileSync','appendFileSync','truncateSync','ftruncateSync','mkdirSync','rmdirSync','rmSync','unlinkSync','renameSync','copyFileSync','cpSync','chmodSync','chownSync','symlinkSync','linkSync','utimesSync','writeFile','appendFile','mkdir','rm','unlink','rename','copyFile','cp']);
function sha(data){return crypto.createHash('sha256').update(data).digest('hex');}
function put(root,name,data){const target=path.join(root,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,typeof data==='string'?data:JSON.stringify(data));}
function inventory(root,base=''){
  const entries=[];
  for(const item of fs.readdirSync(path.join(root,base),{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:1)){
    const name=base?base+'/'+item.name:item.name,full=path.join(root,name),stat=fs.lstatSync(full);
    if(item.isDirectory())entries.push(...inventory(root,name));
    else entries.push({name,mode:stat.mode,bytes:stat.size,hash:item.isFile()?sha(fs.readFileSync(full)):fs.readlinkSync(full),mtime:stat.mtimeMs});
  }return entries;
}
function load(text,filename,requireFn){const m={exports:{}};const logs=[];
  const fn=vm.runInNewContext('(function(require,module,exports,__dirname,__filename,console,process){'+text+'\n})',{Buffer,Date},{filename});
  fn(requireFn,m,m.exports,path.dirname(filename),filename,{log:(...args)=>logs.push(args.join(' ')),warn:(...args)=>logs.push(args.join(' ')),error:(...args)=>logs.push(args.join(' '))},process);
  return {api:m.exports,logs};
}
function fixture({gitTop=null}={}){
  const root=fs.mkdtempSync('/tmp/mori-next-independent-tree-');
  const lock={schemaVersion:1,project:'mori-desk',repository:'https://github.com/rullerzhou-afk/clawd-on-desk.git',commit:'a'.repeat(40)};
  const app={name:'mori-desk',version:'0.1.3-preview.1',build:{appId:'com.kaduiro.moridesk',publish:null}};
  const extension={manifest_version:3,name:'Independent code fixture',version:'0.1.7',background:{service_worker:'worker.js'}};
  put(root,'scripts/.keep','');put(root,'upstream.lock.json',lock);put(root,'patches/mori.patch','independent patch bytes\n');put(root,'package.json',{name:'mori-desk-source',version:app.version});
  put(root,'overlay/extensions/browser-bridge/manifest.json',extension);
  put(root,'overlay/extensions/browser-bridge/worker.js','const CODE_REVISION = "candidate_A";\n');
  put(root,'overlay/extensions/browser-bridge/nested/observer.js','const OBSERVER_REVISION = "candidate_A";\n');
  put(root,'overlay/src/local.js','const LOCAL_SOURCE_REVISION = "candidate_A";\n');
  fs.cpSync(path.join(root,'overlay'),path.join(root,'.runtime'),{recursive:true});put(root,'.runtime/package.json',app);
  fs.cpSync(path.join(root,'overlay/extensions/browser-bridge'),path.join(root,'selected-extension'),{recursive:true});
  put(root,'user-profile/secret.txt','PRIVATE_CONTENT_SENTINEL_61f234');
  put(root,'.runtime/inherited.js','not part of overlay scope\n');
  const reads=[],runs=[],launches=[],writeAttempts=[],specialReads=[],fds=new Map();
  const roFs=new Proxy(fs,{get(target,key){
    if(forbiddenWrites.has(key))return(...args)=>{writeAttempts.push({method:key,path:args[0]});throw new Error('read_only_violation');};
    if(key==='openSync')return(file,flags,...rest)=>{
      assert.equal(typeof flags,'number');assert.equal(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND),0,'product open must be read-only');
      const fd=fs.openSync(file,flags,...rest);fds.set(fd,String(file));return fd;
    };
    if(key==='closeSync')return fd=>{fds.delete(fd);return fs.closeSync(fd);};
    if(key==='readFileSync')return(...args)=>{
      const target=typeof args[0]==='number'?fds.get(args[0]):String(args[0]);reads.push(target);
      const stat=typeof args[0]==='number'?fs.fstatSync(args[0]):fs.statSync(args[0]);
      if(!stat.isFile()){specialReads.push(target);throw new Error('Driver blocked a nonregular read to avoid hanging');}
      return fs.readFileSync(...args);
    };
    return target[key];
  }});
  const nativeRequire=id=>{if(id==='node:fs')return roFs;if(id==='node:child_process')return {spawn(){throw new Error('Subprocess execution forbidden in independent acceptance');}};return require(id);};
  const prepare=load(source['prepare-runtime.js'],path.join(root,'scripts/prepare-runtime.js'),nativeRequire).api;
  // This exported setup-format operation initializes a consistent marker only.
  // All expected outcomes are fixed external mutations and effects, never a
  // second invocation of the product comparison function as an oracle.
  const stamp={schemaVersion:1,project:'mori-desk',projectRoot:root,kind:'runtime',upstreamCommit:lock.commit,ready:true,version:app.version,inputFingerprint:prepare.inputFingerprint()};
  put(root,'.runtime/.mori-owned.json',stamp);
  const noGitRun=async(command,args)=>{runs.push({command,args});assert.equal(command,'git');assert.ok(args.includes('--no-optional-locks'));if(args.includes('--show-toplevel'))return Buffer.from((gitTop||root)+'\n');if(args.includes('rev-parse'))return Buffer.from('b'.repeat(40)+'\n');if(args.includes('status'))return Buffer.from('');throw new Error('Unexpected subprocess');};
  const doctor=load(source['doctor.js'],path.join(root,'scripts/doctor.js'),id=>id==='./prepare-runtime'?{...prepare,run:noGitRun}:nativeRequire(id));
  const launcher=load(source['run.js'],path.join(root,'scripts/run.js'),id=>id==='./prepare-runtime'?{...prepare,run:async(command,args,options)=>{launches.push({command,args,options});return Buffer.alloc(0);}}:id==='./setup'?{checkNodeVersion(){},runNpm(){throw new Error('Unexpected install/build');}}:nativeRequire(id));
  return {root,lock,stamp,prepare,doctor,launcher,reads,runs,launches,writeAttempts,specialReads,
    report:()=>doctor.api.collectReport({extensionDir:path.join(root,'selected-extension')}),
    updateStamp:value=>put(root,'.runtime/.mori-owned.json',{...stamp,...value})};
}
async function check(name,fn,options){let h;try{h=fixture(options);const details=await fn(h);results.push({name,result:'PASS',details});}catch(error){results.push({name,result:'FAIL',message:error.message,stack:error.stack});}finally{if(h)fs.rmSync(h.root,{recursive:true,force:true});}}
function requiredRefusal(h){assert.throws(()=>h.prepare.requireRuntime());assert.equal(h.launches.length,0);}

(async()=>{
  await check('S01/L01 consistent disk fixture permits launch without claiming live acceptance',async h=>{
    assert.equal(h.prepare.requireRuntime(),path.join(h.root,'.runtime'));await h.launcher.api.main(['start']);assert.equal(h.launches.length,1);
    const r=await h.report();assert.equal(r.diskChecksPassed,true);assert.equal(r.browserLoadedExtension,'NOT_CHECKED');assert.equal(r.runtime.runningDesktop,'NOT_CHECKED');assert.equal(r.providerAcceptance,'NOT_CHECKED');assert.equal(r.automaticRecovery,'NOT_CHECKED');
    assert.equal(r.runtime.extension.fingerprint,r.selectedExtension.fingerprint);return {diskChecksPassed:r.diskChecksPassed,live:r.browserLoadedExtension};
  });
  for(const kind of ['pin','patch','overlay-modify','overlay-add','overlay-delete'])await check('S02/S03 changed '+kind+' is refused before launch',async h=>{
    const original=inventory(path.join(h.root,'.runtime'));
    if(kind==='pin')put(h.root,'upstream.lock.json',{...h.lock,commit:'c'.repeat(40)});
    if(kind==='patch')put(h.root,'patches/mori.patch','independent patch changed\n');
    if(kind==='overlay-modify')put(h.root,'overlay/extensions/browser-bridge/worker.js','const CODE_REVISION = "candidate_B";\n');
    if(kind==='overlay-add')put(h.root,'overlay/src/added.js','new code\n');
    if(kind==='overlay-delete')fs.unlinkSync(path.join(h.root,'overlay/src/local.js'));
    await assert.rejects(()=>h.launcher.api.main(['start']));assert.equal(h.launches.length,0);
    assert.deepEqual(inventory(path.join(h.root,'.runtime')),original,'rejected start must preserve runtime');
    const r=await h.report();assert.equal(r.diskChecksPassed,false);return {diskChecksPassed:r.diskChecksPassed};
  });
  for(const invalid of [undefined,'invalid',123])await check('S04 invalid fingerprint '+String(invalid)+' fails closed',async h=>{
    h.updateStamp({inputFingerprint:invalid});requiredRefusal(h);assert.equal((await h.report()).diskChecksPassed,false);
  });
  await check('S04 unreadable ownership/invalid JSON fails closed',async h=>{
    put(h.root,'.runtime/.mori-owned.json','{invalid-json');requiredRefusal(h);const r=await h.report();assert.equal(r.runtime.source.status,'unavailable');assert.equal(r.diskChecksPassed,false);
  });
  await check('S05 documentation-only changes preserve startup eligibility',async h=>{
    put(h.root,'docs/review.md','independent documentation only\n');assert.equal(h.prepare.requireRuntime(),path.join(h.root,'.runtime'));assert.equal((await h.report()).diskChecksPassed,true);
  });
  await check('S07/L05 runtime extension byte change is detected despite a matching stamp',async h=>{
    put(h.root,'.runtime/extensions/browser-bridge/worker.js','const CODE_REVISION = "tampered";\n');requiredRefusal(h);const r=await h.report();assert.equal(r.runtime.source.inputMatches,true);assert.equal(r.runtime.sourceMatches,false);assert.equal(r.runtime.extension.status,'mismatch');assert.equal(r.diskChecksPassed,false);
    return {changed:r.runtime.extension.changed};
  });
  await check('S07 inherited runtime mutation remains explicitly outside reported coverage',async h=>{
    put(h.root,'.runtime/inherited.js','changed inherited bytes\n');const r=await h.report();assert.equal(r.runtime.inheritedRuntimeFiles,'NOT_CHECKED');assert.equal(r.browserLoadedExtension,'NOT_CHECKED');return {diskChecksPassed:r.diskChecksPassed,scope:r.runtime.inheritedRuntimeFiles};
  });
  await check('L02 same extension version with different bytes is mismatch',async h=>{
    put(h.root,'selected-extension/worker.js','const CODE_REVISION = "old_same_semver";\n');const r=await h.report();assert.equal(r.checkout.extensionVersion,r.selectedExtension.version);assert.equal(r.selectedExtension.status,'mismatch');assert.equal(r.diskChecksPassed,false);assert.notEqual(r.runtime.extension.fingerprint,r.selectedExtension.fingerprint);return {changed:r.selectedExtension.changed};
  });
  await check('L04 missing selected file is not silently accepted',async h=>{
    fs.unlinkSync(path.join(h.root,'selected-extension/nested/observer.js'));const r=await h.report();assert.equal(r.selectedExtension.status,'mismatch');assert.deepEqual(Array.from(r.selectedExtension.missing),['nested/observer.js']);assert.equal(r.selectedExtension.fingerprint,null);assert.equal(r.diskChecksPassed,false);
  });
  await check('L04 missing selected directory is unavailable',async h=>{
    fs.rmSync(path.join(h.root,'selected-extension'),{recursive:true});const r=await h.report();assert.equal(r.selectedExtension.status,'unavailable');assert.equal(r.diskChecksPassed,false);
  });
  await check('L04 omitted selected directory cannot imply it was inspected',async h=>{
    const r=await h.doctor.api.collectReport();assert.equal(r.selectedExtension,null);assert.equal(r.browserLoadedExtension,'NOT_CHECKED');return {diskChecksPassed:r.diskChecksPassed,selected:r.selectedExtension};
  });
  await check('L06 matching different folder is disk-only identity',async h=>{
    const r=await h.report();assert.notEqual(r.selectedExtension.path,r.runtime.extension.path);assert.equal(r.selectedExtension.status,'matches_source');assert.equal(r.selectedExtension.liveBrowser,'NOT_CHECKED');
  });
  await check('L08/L09 doctor does not mutate files, execute git, or read profile content',async h=>{
    const before=inventory(h.root);const r=await h.report();assert.deepEqual(inventory(h.root),before);assert.equal(h.writeAttempts.length,0);assert.equal(h.reads.some(x=>x.includes('/user-profile/')),false);assert.equal(JSON.stringify(r).includes('PRIVATE_CONTENT_SENTINEL_61f234'),false);assert.equal(h.launches.length,0);
    return {capturedReadOnlyGitRequests:h.runs.length,actualSubprocesses:0,writeAttempts:0};
  });
  await check('L10 JSON status and CLI exit agree on same-version mismatch',async h=>{
    put(h.root,'selected-extension/worker.js','same version changed byte');const exit=await h.doctor.api.main(['--json','--extension-dir',path.join(h.root,'selected-extension')]);const r=JSON.parse(h.doctor.logs.at(-1));assert.equal(exit,2);assert.equal(r.diskChecksPassed,false);assert.equal(r.browserLoadedExtension,'NOT_CHECKED');
  });
  await check('L10 human report preserves live and inherited-code limitations',async h=>{
    const exit=await h.doctor.api.main(['--extension-dir',path.join(h.root,'selected-extension')]);assert.equal(exit,0);const text=h.doctor.logs.join('\n');assert.match(text,/実際に実行中の版.*未確認/);assert.match(text,/継承コード全体の検証でもありません/);assert.equal(h.writeAttempts.length,0);
  });
  await check('A07 target extras are outside fingerprint coverage and must be disclosed',async h=>{
    put(h.root,'selected-extension/unexpected.js','unexpected executable bytes');const r=await h.report();assert.equal(r.selectedExtension.coverage,'expected_source_files_only');return {status:r.selectedExtension.status,fingerprintEquals:r.selectedExtension.fingerprint===r.runtime.extension.fingerprint,coverage:r.selectedExtension.coverage};
  });
  await check('L09 symlink to unrelated content is not read as a code file',async h=>{
    fs.unlinkSync(path.join(h.root,'selected-extension/worker.js'));fs.symlinkSync(path.join(h.root,'user-profile/secret.txt'),path.join(h.root,'selected-extension/worker.js'));const r=await h.report();assert.equal(r.diskChecksPassed,false);assert.ok(r.selectedExtension.unreadable.includes('worker.js'));assert.equal(JSON.stringify(r).includes('PRIVATE_CONTENT_SENTINEL_61f234'),false);
  });
  for(const relative of ['selected-extension/manifest.json','.runtime/package.json','upstream.lock.json','patches/mori.patch'])await check('L04 nonregular '+relative+' is rejected before reading',async h=>{
    const file=path.join(h.root,relative);fs.unlinkSync(file);preparedFifo(file);
    const r=await h.report();assert.equal(r.diskChecksPassed,false);assert.equal(h.specialReads.length,0,'special files must be rejected before readFileSync');return {specialReads:h.specialReads.length};
  });
  await check('L04 manifest symlink to a FIFO is not dereferenced',async h=>{
    const fifo=path.join(h.root,'fifo-target');preparedFifo(fifo);const file=path.join(h.root,'selected-extension/manifest.json');fs.unlinkSync(file);fs.symlinkSync(fifo,file);
    const r=await h.report();assert.equal(r.diskChecksPassed,false);assert.equal(h.specialReads.length,0);assert.ok(r.selectedExtension.unreadable.includes('manifest.json'));
  });
  for(const violation of ['name','appId','publish'])await check('L10 runtime product identity violation '+violation+' cannot pass doctor',async h=>{
    const pkg=JSON.parse(fs.readFileSync(path.join(h.root,'.runtime/package.json')));if(violation==='name')pkg.name='different-product';if(violation==='appId')pkg.build.appId='com.other.app';if(violation==='publish')pkg.build.publish={provider:'unexpected'};
    put(h.root,'.runtime/package.json',pkg);requiredRefusal(h);const r=await h.report();assert.equal(r.diskChecksPassed,false);assert.equal(r.runtime.productIdentityMatches,false);
  });
  await check('A02 Git identity belongs to the actual root only',async h=>{
    const r=await h.report();assert.equal(r.checkout.commit,'b'.repeat(40));assert.equal(r.checkout.trackedChanges,false);
  });
  await check('A02 parent Git identity cannot be attributed to a nested ZIP checkout',async h=>{
    const r=await h.report();assert.equal(r.checkout.commit,null);assert.equal(r.checkout.trackedChanges,null);assert.equal(h.runs.some(x=>x.args.includes('HEAD')),false,'do not read parent HEAD after detecting a different root');
  },{gitTop:'/tmp'});
  const output={node:process.version,criteriaHash:'3879ccaa0d1f952e23decbfa22ebc1f62cfdbe5bfacbfa29a28861f163b21fcc',sourceHashes:Object.fromEntries(files.map(x=>[x,sha(source[x])])),method:'Independent temporary source trees; real filesystem comparisons; read-only fs enforcement; Git commands captured and never executed; launch intercepted',results};
  fs.writeFileSync(process.env.MORI_INDEPENDENT_RESULT_PATH||'/tmp/mori-next-independent-source-results.json',JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output,null,2));process.exitCode=results.some(x=>x.result==='FAIL')?1:0;
})().catch(error=>{console.error(error.stack);process.exitCode=2;});
