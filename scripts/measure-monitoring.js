/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
// Reconstruct an isolated, owned runtime for measurement. Never promotes it,
// starts Electron, loads Chrome, or opens existing Mori userData.
const path=require('node:path');
const {ROOT,prepareRuntime,acquireSetupLock,requireOwner,inputFingerprint,run,setStageReady,removeOwned}=require('./prepare-runtime');
const {checkNodeVersion,reuseLockedDependencies}=require('./setup');
const {testFiles}=require('./run');
async function main(args=process.argv.slice(2)){
  if(args.some(a=>a!=='--regression')||args.length>1)throw new Error('Unknown measurement option.');
  checkNodeVersion();
  const release=acquireSetupLock();let stage;
  try{
    stage=await prepareRuntime();
    reuseLockedDependencies(stage);
    await run(process.execPath,['scripts/verify-electron-install.js','--context','verify'],{cwd:stage,capture:false});
    await run(process.execPath,['scripts/generate-mori-assets.js','--check'],{cwd:stage,capture:false});
    if(requireOwner(stage,['runtime-stage']).inputFingerprint!==inputFingerprint())throw new Error('Measurement source changed during reconstruction.');
    setStageReady(stage);
    process.stdout.write(`Measurement source fingerprint: ${inputFingerprint()}\n`);
    const files=args.includes('--regression')
      ? [...testFiles(stage),...['runtime-source.test.js','startup-guard.test.js','prepare-publication.test.js','windows-process.test.js','native-measurement-update.test.js'].map(n=>path.join(ROOT,'test',n))]
      : ['browser-measurement-recorder.test.js','browser-measurement-witness.test.js','browser-measurement-integration.test.js'].map(n=>path.join(stage,'test',n));
    await run(process.execPath,['--test',...(process.platform==='win32'?['--test-isolation=none']:[]),...files],{cwd:stage,capture:false});
    await run(process.execPath,['scripts/run-monitoring-measurement.js'],{cwd:stage,capture:false});
    if(requireOwner(stage,['runtime-stage']).inputFingerprint!==inputFingerprint())throw new Error('Measurement source changed after validation.');
    process.stdout.write('Measurement reconstruction and execution completed. Active runtime was preserved.\n');
  } finally {
    try{if(stage)removeOwned(stage,['runtime-stage']);}finally{release();}
  }
}
module.exports={main};
if(require.main===module)main().catch(()=>{process.stderr.write('Isolated measurement failed. Active runtime and user data were preserved.\n');process.exitCode=1;});
