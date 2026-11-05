/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { ROOT, prepareRuntime, acquireSetupLock, requireOwner, inputFingerprint, run, setStageReady, removeOwned, assertSafePath } = require('./prepare-runtime');
const { checkNodeVersion, reuseLockedDependencies } = require('./setup');
const { replaceLoadedExtension, extensionIdentity } = require('./refresh-native-extension');
const { printLaunchReadiness, requireDevelopmentWorkspace } = require('./prepare-development');
async function main(args = process.argv.slice(2)) {
  if (args.length > 1 || args.some(a => !['--prepare', '--smoke', '--refresh-smoke', '--open', '--open-existing'].includes(a))) throw new Error('Unknown native measurement option.');
  checkNodeVersion();
  requireDevelopmentWorkspace();
  if (args.includes('--open-existing')) {
    const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports/native-measurement-kit-latest.json'), 'utf8'));
    const owner = requireOwner(current.stage, ['runtime-stage']);
    if (owner.ready !== true || owner.inputFingerprint !== inputFingerprint() || current.sourceFingerprint !== inputFingerprint()
      || current.entry !== path.join(current.stage, 'scripts/native-measurement-main.js')
      || current.electron !== path.join(current.stage, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'))
      throw new Error('Prepared measurement source changed.');
    const child = spawn(current.electron, [current.entry], { cwd: current.stage, detached: true, stdio: 'ignore', windowsHide: false });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
    process.stdout.write('Prepared native collector opened.\n'); return;
  }
  const release = acquireSetupLock();
  let stage, preserved = false, rollbackExtension = null;
  try {
    const previous = args.includes('--refresh-smoke')
      ? JSON.parse(fs.readFileSync(path.join(ROOT, 'reports/native-measurement-kit-latest.json'), 'utf8')) : null;
    if (previous) requireOwner(previous.extensionOwnerStage || previous.stage, ['runtime-stage']);
    stage = await prepareRuntime();
    reuseLockedDependencies(stage);
    await run(process.execPath, ['scripts/verify-electron-install.js', '--context', 'verify'], { cwd: stage, capture: false });
    await run(process.execPath, ['scripts/generate-mori-assets.js', '--check'], { cwd: stage, capture: false });
    if (requireOwner(stage, ['runtime-stage']).inputFingerprint !== inputFingerprint()) throw new Error('Source changed during reconstruction.');
    setStageReady(stage);
    const kit = path.join(stage, 'native-measurement');
    fs.mkdirSync(kit);
    const { buildNativeBundle } = require(path.join(stage, 'scripts/native-measurement-bundle'));
    const bundle = buildNativeBundle({ runtime: stage, output: path.join(kit, 'extension'),
      ...(previous ? { publicKey: extensionIdentity(previous.extension).key } : {}) });
    const descriptor = { schema: 1, sourceFingerprint: inputFingerprint(), ...bundle };
    fs.writeFileSync(path.join(kit, 'kit.json'), JSON.stringify(descriptor, null, 2) + '\n');
    const electron = path.join(stage, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
    const entry = path.join(stage, 'scripts/native-measurement-main.js');
    if (args.includes('--smoke') || args.includes('--refresh-smoke')) {
      await run(electron, [entry, '--native-measurement-smoke'], { cwd: stage, capture: false });
    }
    if (requireOwner(stage, ['runtime-stage']).inputFingerprint !== inputFingerprint()) throw new Error('Source changed after reconstruction.');
    const replacement = previous ? replaceLoadedExtension({ previous, newStage: stage }) : { extension: path.join(kit, 'extension') };
    const { rollback, ...loadedExtension } = replacement;
    rollbackExtension = rollback || null;
    fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
    const pointerNext = path.join(ROOT, `reports/native-measurement-kit-next-${crypto.randomUUID()}.json`);
    fs.writeFileSync(pointerNext, JSON.stringify({
      schema: 1, stage, ...loadedExtension, electron, entry, ...descriptor,
      formalAcceptance: false, providerObserved: false,
    }, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(pointerNext, path.join(ROOT, 'reports/native-measurement-kit-latest.json'));
    preserved = true; rollbackExtension = null;
    if (args.includes('--open')) {
      const child = spawn(electron, [entry], { cwd: stage, detached: true, stdio: 'ignore', windowsHide: false });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    }
    process.stdout.write(`Native measurement kit prepared: ${kit}\nSource fingerprint: ${descriptor.sourceFingerprint}\nRuntime files were preserved; launch readiness is checked separately. Chrome has not been loaded or operated.\n`);
    printLaunchReadiness();
  } finally {
    try {
      if (!preserved && rollbackExtension) {
        try { rollbackExtension(); } catch (error) { preserved = true; throw error; }
      }
      if (stage && !preserved) removeOwned(stage, ['runtime-stage']);
    } finally { release(); }
  }
}
module.exports = { main };
if (require.main === module) main().catch(error => {
  if (error.code === 'development_workspace_required') {
    process.stderr.write('計測は開発専用コピーで実行してください。常用側で node scripts/prepare-development.js を実行し、表示された作業場所で計測コマンドを使ってください。\n');
  } else if (error.code === 'native_extension_restore_failed_backup_preserved') {
    process.stderr.write('native_extension_restore_failed_backup_preserved: manual restoration of the DEVELOPMENT extension directory is required.\n');
    try { process.stderr.write(`Preserved backup: ${assertSafePath(error.backupPath)}\nLoaded directory: ${assertSafePath(error.loadedPath)}\n`); } catch (_) {}
  } else process.stderr.write('Native measurement preparation failed. Runtime files and user data were preserved; startup readiness is not implied.\n');
  process.exitCode = 1;
});
