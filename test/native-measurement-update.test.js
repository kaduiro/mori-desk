/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ROOT, removeOwned } = require('../scripts/prepare-runtime');
const { replaceLoadedExtension, extensionIdentity } = require('../scripts/refresh-native-extension');
function stage(t) {
  const dir = path.join(ROOT, `.runtime-stage-${crypto.randomUUID()}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '.mori-owned.json'), JSON.stringify({ schemaVersion: 1, project: 'mori-desk', projectRoot: ROOT, kind: 'runtime-stage', ready: true }));
  t.after(() => removeOwned(dir, ['runtime-stage']));
  fs.mkdirSync(path.join(dir, 'native-measurement/extension'), { recursive: true });
  return dir;
}
function bundle(dir, key, text) {
  const extension = path.join(dir, 'native-measurement/extension');
  fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({ name: 'MORI 計測専用 fixture', key, background: { service_worker: 'native-worker-entry.js' } }));
  fs.writeFileSync(path.join(extension, 'native-worker-entry.js'), text);
  return extension;
}
function setup(t) {
  const oldStage = stage(t), newStage = stage(t);
  const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const extension = bundle(oldStage, key, 'previous'); bundle(newStage, key, 'next');
  const previous = { stage: oldStage, extension, extensionId: extensionIdentity(extension).id };
  return { previous, newStage, file: path.join(extension, 'native-worker-entry.js') };
}
test('native update retains loaded path and key with an owned backup and reversible commit', t => {
  const f = setup(t), result = replaceLoadedExtension(f);
  assert.equal(result.extension, f.previous.extension);
  assert.equal(result.extensionOwnerStage, f.previous.stage);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'next');
  assert.equal(fs.readFileSync(path.join(result.extensionBackup, 'native-worker-entry.js'), 'utf8'), 'previous');
  result.rollback(); result.rollback();
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'previous');
});
test('native update restores previous bytes when the replacement rename fails', t => {
  const f = setup(t); let calls = 0;
  assert.throws(() => replaceLoadedExtension({ ...f, rename(from, to) {
    if (++calls === 2) throw new Error('injected_owned_rename_failure'); fs.renameSync(from, to);
  } }), /injected_owned_rename_failure/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'previous');
});
test('native update rejects a target path or extension identity that differs', t => {
  const f = setup(t);
  assert.throws(() => replaceLoadedExtension({ ...f, previous: { ...f.previous, extension: path.join(ROOT, '.runtime/extensions/browser-bridge') } }), /native_extension_target/);
  assert.throws(() => replaceLoadedExtension({ ...f, previous: { ...f.previous, extensionId: 'a'.repeat(32) } }), /native_extension_key_changed/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'previous');
});
test('native update exposes a fixed restore-failure category and retains the previous backup', t => {
  const f = setup(t); let calls = 0;
  assert.throws(() => replaceLoadedExtension({ ...f, rename(from, to) {
    if (++calls > 1) throw new Error('injected_restore_failure'); fs.renameSync(from, to);
  } }), error => {
    assert.equal(error.code, 'native_extension_restore_failed_backup_preserved');
    assert.equal(error.loadedPath, f.previous.extension);
    assert.equal(path.dirname(error.backupPath), path.dirname(f.previous.extension));
    assert.equal(fs.readFileSync(path.join(error.backupPath, 'native-worker-entry.js'), 'utf8'), 'previous');
    return true;
  });
});
test('native update reports a rollback failure before moving the new loaded directory', t => {
  const f = setup(t); let calls = 0;
  const result = replaceLoadedExtension({ ...f, rename(from, to) {
    if (++calls > 2) throw new Error('injected_rollback_first_rename_failure'); fs.renameSync(from, to);
  } });
  assert.throws(() => result.rollback(), error => {
    assert.equal(error.code, 'native_extension_restore_failed_backup_preserved');
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'next');
    assert.equal(fs.readFileSync(path.join(error.backupPath, 'native-worker-entry.js'), 'utf8'), 'previous');
    return true;
  });
});
