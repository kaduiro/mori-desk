'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { atomicWrite } = require('../src/browser-bridge-persistence');

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mori-persistence-retry-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'owned.json');fs.writeFileSync(file,'previous');return {dir,file};
}
test('Windows atomic replacement retries a transient rename denial without deleting the destination', {skip:process.platform!=='win32'}, t=>{
  const {file}=fixture(t);let calls=0;
  const io={...fs,renameSync(from,to){assert.equal(fs.readFileSync(to,'utf8'),'previous');if(++calls<3)throw Object.assign(new Error('busy'),{code:'EPERM'});fs.renameSync(from,to);},
    unlinkSync(target){assert.notEqual(target,file);fs.unlinkSync(target);}};
  atomicWrite(file,'next',io);assert.equal(calls,3);assert.equal(fs.readFileSync(file,'utf8'),'next');
});
test('permanent rename denial is bounded and preserves the previous file', t=>{
  const {dir,file}=fixture(t);let calls=0;
  const io={...fs,renameSync(){calls++;throw Object.assign(new Error('denied'),{code:'EPERM'});}};
  assert.throws(()=>atomicWrite(file,'next',io),{code:'EPERM',moriPersistenceStage:'rename'});
  assert.equal(calls,process.platform==='win32'?4:1);assert.equal(fs.readFileSync(file,'utf8'),'previous');
  assert.deepEqual(fs.readdirSync(dir),['owned.json']);
});
test('unrelated rename errors are not retried and cannot replace the old file', t=>{
  const {file}=fixture(t);let calls=0;
  assert.throws(()=>atomicWrite(file,'next',{...fs,renameSync(){calls++;throw Object.assign(new Error('disk'),{code:'ENOSPC'});}}),{code:'ENOSPC'});
  assert.equal(calls,1);assert.equal(fs.readFileSync(file,'utf8'),'previous');
});
