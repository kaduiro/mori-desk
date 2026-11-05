/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
// Transactional replacement of an explicitly owned DEVELOPMENT bundle only.
// Chrome still requires the user's reload. Retain the previous bundle for audit.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { requireOwner, assertSafePath } = require('./prepare-runtime');
function treeIsRegular(dir) {
  assertSafePath(dir);
  if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw new Error('native_extension_directory');
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = assertSafePath(path.join(dir, item.name));
    if (item.isDirectory()) treeIsRegular(file);
    else if (!item.isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('native_extension_nonregular');
  }
}
function extensionIdentity(dir) {
  const manifest = JSON.parse(fs.readFileSync(assertSafePath(path.join(dir, 'manifest.json')), 'utf8'));
  if (!manifest.name?.startsWith('MORI 計測専用') || manifest.background?.service_worker !== 'native-worker-entry.js'
    || typeof manifest.key !== 'string') throw new Error('native_extension_identity');
  const der = Buffer.from(manifest.key, 'base64');
  crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  return { key: manifest.key, id: [...crypto.createHash('sha256').update(der).digest().subarray(0, 16)]
    .map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('') };
}
function replaceLoadedExtension({ previous, newStage, rename = fs.renameSync } = {}) {
  const ownerStage = previous?.extensionOwnerStage || previous?.stage;
  if (requireOwner(ownerStage, ['runtime-stage']).ready !== true || requireOwner(newStage, ['runtime-stage']).ready !== true)
    throw new Error('native_extension_stage_not_ready');
  const kit = assertSafePath(path.join(ownerStage, 'native-measurement'));
  const current = assertSafePath(path.join(kit, 'extension'));
  const source = assertSafePath(path.join(newStage, 'native-measurement/extension'));
  if (previous.extension !== current || current === source) throw new Error('native_extension_target');
  treeIsRegular(current); treeIsRegular(source);
  const oldIdentity = extensionIdentity(current), newIdentity = extensionIdentity(source);
  if (oldIdentity.id !== previous.extensionId || oldIdentity.key !== newIdentity.key || oldIdentity.id !== newIdentity.id)
    throw new Error('native_extension_key_changed');
  const next = assertSafePath(path.join(kit, `.extension-next-${crypto.randomUUID()}`));
  const backup = assertSafePath(path.join(kit, `.extension-backup-${crypto.randomUUID()}`));
  fs.cpSync(source, next, { recursive: true, errorOnExist: true, force: false });
  treeIsRegular(next);
  // Every resolved move endpoint must remain an immediate child of the owned
  // kit. No shell-built commands, arbitrary recursive moves or deletes.
  function move(from, to) {
    if ([from, to].some(p => path.dirname(assertSafePath(p)) !== kit)) throw new Error('native_extension_move_outside_kit');
    rename(from, to);
  }
  function restoreFailure() {
    const error = new Error('native_extension_restore_failed_backup_preserved');
    error.code = 'native_extension_restore_failed_backup_preserved';
    error.backupPath = backup; error.loadedPath = current;
    return error;
  }
  move(current, backup);
  try { move(next, current); }
  catch (error) {
    try { move(backup, current); }
    catch { throw restoreFailure(); }
    throw error;
  }
  let rolledBack = false;
  return { extension: current, extensionOwnerStage: ownerStage, extensionBackup: backup,
    rollback() {
      if (rolledBack) return;
      const failed = assertSafePath(path.join(kit, `.extension-failed-${crypto.randomUUID()}`));
      try { move(current, failed); move(backup, current); }
      catch { throw restoreFailure(); }
      rolledBack = true;
    } };
}
module.exports = { replaceLoadedExtension, extensionIdentity };
