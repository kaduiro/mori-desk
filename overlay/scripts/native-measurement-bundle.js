/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
// Build a separate, user-loaded development extension. No production file or
// Chrome profile is modified. The ordinary protocol and permissions stay fixed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function replaceOne(source, needle, replacement) {
  if (source.split(needle).length !== 2) throw new Error('native_bundle_seam_changed');
  return source.replace(needle, replacement);
}
function buildNativeBundle({ runtime, output, publicKey, targetPingOrdinal = 2 } = {}) {
  if (!path.isAbsolute(runtime || '') || !path.isAbsolute(output || '') || fs.existsSync(output))
    throw new Error('native_bundle_directory');
  if (!Number.isSafeInteger(targetPingOrdinal) || targetPingOrdinal < 2 || targetPingOrdinal > 60)
    throw new Error('native_bundle_cut_selection');
  // Hash the original kit inputs, before generated wrappers introduce their
  // own hash. This is self-reported build agreement, not Chrome load proof.
  const inputRoot = path.join(runtime, 'extensions/browser-bridge');
  const inputs = [];
  function collect(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const relative = prefix + entry.name, absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(absolute, relative + '/');
      else if (entry.isFile()) inputs.push([relative, crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')]);
      else throw new Error('native_bundle_input_type');
    }
  }
  collect(inputRoot);
  for (const [name, absolute] of [['independent-reader', path.join(runtime, 'scripts/monitoring-independent-witness.js')],
    ['independent-payload', path.join(runtime, 'scripts/monitoring-independent-payload.js')],
    ['independent-channel', path.join(runtime, 'scripts/monitoring-independent-channel.js')],
    ['bundle-builder', __filename]]) inputs.push([name, crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')]);
  inputs.push(['precommitted-target-ping-ordinal', targetPingOrdinal]);
  const measurementBuildFingerprint = crypto.createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
  const key = publicKey || crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey
    .export({ type: 'spki', format: 'der' }).toString('base64');
  const der = Buffer.from(key, 'base64');
  crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  const extensionId = [...crypto.createHash('sha256').update(der).digest().subarray(0, 16)]
    .map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
  fs.cpSync(path.join(runtime, 'extensions/browser-bridge'), output, { recursive: true, errorOnExist: true });
  const manifestPath = path.join(output, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.key === key) throw new Error('native_bundle_identity_conflict');
  manifest.key = key;
  manifest.name = 'MORI 計測専用（開発用・通常版とは別接続）';
  manifest.description = '実 DOM とローカル ACK の匿名時刻を計測します。正式受入の完了を意味しません。';
  manifest.background.service_worker = 'native-worker-entry.js';
  const extraContent = ['native-payload.js', 'native-independent-witness.js', 'native-measurement-content.js'];
  for (const script of manifest.content_scripts) {
    const index = script.js.indexOf('content-script.js');
    if (index < 0) throw new Error('native_bundle_content_seam');
    script.js.splice(index, 0, ...extraContent);
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  fs.copyFileSync(path.join(runtime, 'scripts/monitoring-independent-witness.js'), path.join(output, 'native-independent-witness.js'));
  fs.copyFileSync(path.join(runtime, 'scripts/monitoring-independent-payload.js'), path.join(output, 'native-payload.js'));
  fs.copyFileSync(path.join(runtime, 'scripts/monitoring-independent-channel.js'), path.join(output, 'native-channel.js'));
  let content = fs.readFileSync(path.join(output, 'content-script.js'), 'utf8');
  content = replaceOne(content, 'else factory();', 'else factory(nativeContentCapture.sink);');
  content = `(function () {\n'use strict';\nconst nativeContentCapture = globalThis.__moriNativeMeasurementContent || (globalThis.__moriNativeMeasurementContent = MoriNativeMeasurementContent.createContentCapture({
    chrome, document, readRoute: () => location.href,
    enableSeries: true,
    provider: location.hostname === 'chatgpt.com' ? 'chatgpt' : 'claude',
    readerFactory: MoriIndependentWitness.createStructureReader,
    structureInspector: MoriIndependentWitness.inspectStructureInventory,
    now: () => performance.now(), timeOrigin: performance.timeOrigin, maxEntries: 16384 }));\n${content}\n})();\n`;
  fs.writeFileSync(path.join(output, 'content-script.js'), content);
  let recovery = fs.readFileSync(path.join(output, 'observer-recovery.js'), 'utf8');
  recovery = replaceOne(recovery, "'conversation-binding.js', 'content-script.js'",
    "'conversation-binding.js', 'native-payload.js', 'native-independent-witness.js', 'native-measurement-content.js', 'content-script.js'");
  fs.writeFileSync(path.join(output, 'observer-recovery.js'), recovery);
  let worker = fs.readFileSync(path.join(output, 'service-worker.js'), 'utf8');
  worker = replaceOne(worker, 'const measurement = null; // MORI_MEASUREMENT_SINK', '');
  worker = replaceOne(worker, 'new MoriTransport.Transport({',
    'new MoriTransport.Transport({ WebSocketClass: nativeWorkerCapture.WebSocketClass,');
  fs.writeFileSync(path.join(output, 'native-worker-entry.js'), `importScripts('native-payload.js', 'native-channel.js', 'native-measurement-worker.js');
const nativeWorkerCapture = MoriNativeMeasurementWorker.createWorkerCapture({
  chrome, WebSocketClass: WebSocket, now: () => performance.now(), timeOrigin: performance.timeOrigin, maxEntries: 16384, enableSeries: true,
  targetPingOrdinal: ${targetPingOrdinal},
  buildFingerprint: ${JSON.stringify(measurementBuildFingerprint)} });
(function (measurement) {\n${worker}\n})(nativeWorkerCapture.sink);\n`);
  const optionPath = path.join(output, 'options.html');
  let html = fs.readFileSync(optionPath, 'utf8');
  html = replaceOne(html, '</main>', `<section><h2>計測専用</h2><p>この拡張は通常版と別接続です。時刻の未確認区間は未確認のまま出力します。</p>
<button id="native-export" type="button">計測 JSON を保存</button><p id="native-export-status" role="status"></p></section></main>`);
  html = replaceOne(html, '</body>', '<script src="native-options.js"></script>\n</body>');
  fs.writeFileSync(optionPath, html);
  fs.writeFileSync(path.join(output, 'native-options.js'), `'use strict';
document.getElementById('native-export').addEventListener('click', async () => {
  const status = document.getElementById('native-export-status');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'mori.native.export', v: 1 });
    if (!result || result.v !== 1 || result.environment !== 'native_chrome_capture') throw new Error();
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'mori-native-chrome.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); status.textContent = '匿名の計測 JSON を保存しました。';
  } catch (_) { status.textContent = '計測 JSON を保存できませんでした。'; }
});\n`);
  const hashes = {};
  for (const name of ['manifest.json', 'native-worker-entry.js', 'content-script.js', 'native-measurement-worker.js',
    'native-measurement-content.js', 'native-independent-witness.js', 'native-payload.js', 'native-channel.js', 'native-options.js']) {
    hashes[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(output, name))).digest('hex');
  }
  return { extensionId, hashes, measurementBuildFingerprint, targetPingOrdinal };
}
module.exports = { buildNativeBundle, replaceOne };
