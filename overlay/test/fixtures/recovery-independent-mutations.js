/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';

// Standalone sensitivity experiment. All edits are confined to owned temporary
// snapshots. This script does not change product files or generate an oracle
// from product logic. Run with Node 24.18+:
// node overlay/test/fixtures/recovery-independent-mutations.js [output-directory]
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { productRoot } = require('./recovery-independent-harness');

const output = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), 'mori-independent-mutations-'));
fs.mkdirSync(output, { recursive: true });
const testFile = path.resolve(__dirname, '../browser-recovery-independent.test.js');
const helperFile = path.join(__dirname, 'recovery-independent-harness.js');
const controlRoot = path.join(output, 'control');
if (fs.existsSync(controlRoot)) throw new Error('Use a fresh output directory; existing evidence will not be overwritten');
for (const directory of ['src', 'extensions/browser-bridge']) {
  fs.cpSync(path.join(productRoot, directory), path.join(controlRoot, 'overlay', directory), { recursive: true });
}
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function snapshotHashes(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? snapshotHashes(absolute, relative) : [{ file: relative, sha256: digest(fs.readFileSync(absolute)) }];
  });
}
const controlFiles = snapshotHashes(path.join(controlRoot, 'overlay'));
function run(root, pattern, destination) {
  // Real files also preserve complete child output in restricted runtimes
  // where capture pipes are unavailable. A process error is never a kill.
  const descriptor = fs.openSync(destination, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', `--test-name-pattern=${pattern}`, testFile],
      { env: { ...process.env, MORI_INDEPENDENT_ROOT: root }, stdio: ['ignore', descriptor, descriptor], timeout: 30000 });
  } finally { fs.closeSync(descriptor); }
  return { exitCode: result.status, signal: result.signal, output: fs.readFileSync(destination, 'utf8'), error: result.error?.message || null };
}
const definitions = [
  {
    id: 'query-as-storage', file: 'extensions/browser-bridge/service-worker.js', pattern: 'I-A1 independent query',
    from: "if (!fatalError) diagnostic = error?.message === 'tab_unavailable' ? 'tab_query_timeout' : 'tab_query_failed';",
    to: "failStorage('storage_failed');",
    expected: /a tab-enumeration failure must not disable transport as a storage failure/,
  },
  {
    id: 'storage-error-swallowed', file: 'extensions/browser-bridge/service-worker.js', pattern: 'I-A2 independent actual local.access',
    from: "async function requiredStorage(operation) {\n  try { return await operation(); }\n  catch (_) { failStorage(); throw new Error('storage_failed'); }\n}",
    to: "async function requiredStorage(operation) {\n  try { return await operation(); }\n  catch (_) { return undefined; }\n}",
    expected: /a real mandatory storage failure must not be masked as successful initialization/,
  },
  {
    id: 'automatic-alarm-disabled', file: 'extensions/browser-bridge/service-worker.js', pattern: 'I-A1 independent query',
    from: "chrome.alarms.onAlarm.addListener(alarm => {\n  if (alarm.name !== 'mori-reconnect') return;",
    to: "chrome.alarms.onAlarm.addListener(alarm => {\n  return; // independent mutant: manual diagnostics remain intact",
    expected: /a new current-document report must arrive by 45 seconds/,
  },
  {
    id: 'blind-binding-approval', file: 'extensions/browser-bridge/conversation-binding.js', pattern: 'I-B1 independent cold',
    from: "return { state: 'unconfirmed', epoch };",
    to: "return { state: 'confirmed', epoch };",
    expected: /route B must never acquire the submitted text belonging to central conversation A/,
  },
  {
    id: 'time-only-binding-approval', file: 'extensions/browser-bridge/conversation-binding.js', pattern: 'I-B1 independent cold',
    from: "return { state: 'unconfirmed', epoch };",
    to: "sample.firstSeenAt ??= Date.now(); return { state: Date.now() - sample.firstSeenAt >= 100 ? 'confirmed' : 'unconfirmed', epoch };",
    expected: /route B must never acquire the submitted text belonging to central conversation A/,
  },
  {
    id: 'focus-binding-gate-removed', file: 'extensions/browser-bridge/service-worker.js', pattern: 'I-B2 independent worker rejects focus',
    from: 'if (!identity || !admittedIdentity({ tabId: tab.id, route, identity })) return null;',
    to: 'if (!identity) return null;',
    expected: /the worker must reject the current granted observer after binding is lost/,
  },
  {
    id: 'ack-all-current-receipts', file: 'src/browser-bridge-server.js', pattern: 'I-U13 independent successful',
    from: 'store.ack(pending.target.id, pending.target.noticeSequence)',
    to: 'store.ack(pending.target.id)',
    expected: /focus must acknowledge its captured receipt only, never all receipts present at completion/,
  },
];

const results = [];
for (const definition of definitions) {
  const root = path.join(output, definition.id);
  fs.cpSync(controlRoot, root, { recursive: true });
  const target = path.join(root, 'overlay', definition.file);
  const before = fs.readFileSync(target, 'utf8');
  const count = before.split(definition.from).length - 1;
  if (count !== 1) throw new Error(`${definition.id}: expected one mutation site, got ${count}`);
  const after = before.replace(definition.from, definition.to);
  fs.writeFileSync(target, after);
  const control = run(controlRoot, definition.pattern, path.join(output, `${definition.id}-control.tap`));
  const mutant = run(root, definition.pattern, path.join(output, `${definition.id}-mutant.tap`));
  const controlTests = Number(control.output.match(/^# tests (\d+)$/m)?.[1] || 0);
  const mutantFailures = Number(mutant.output.match(/^# fail (\d+)$/m)?.[1] || 0);
  const result = { id: definition.id, changedFile: definition.file, replacementCount: count,
    originalSha256: digest(before), mutantSha256: digest(after), controlExitCode: control.exitCode,
    mutantExitCode: mutant.exitCode, controlTests, mutantFailures,
    controlPassed: control.exitCode === 0 && !control.error && controlTests > 0 && /# fail 0\b/.test(control.output),
    failedForIntendedRequirement: mutant.exitCode === 1 && !mutant.error && mutantFailures > 0 && definition.expected.test(mutant.output),
    signal: mutant.signal, processError: mutant.error };
  if (definition.id === 'automatic-alarm-disabled') {
    // Fix the automatic verdict before requesting health. The second interval
    // demonstrates that the mutation retained manual recovery and did not
    // merely break permissions, pairing or observation acceptance globally.
    const manualCode = `const {createWorkerBoundary,ledger}=require(${JSON.stringify(helperFile)});
      (async()=>{const b=createWorkerBoundary({queryFault:'reject'});b.addProtocolPage(31,ledger.conversations.A);b.start();
      await b.clock.advance(2000);const releasedAt=b.clock.now;b.releaseQuery();await b.clock.advance(45000);
      const automatic=b.log.deliveries.filter(x=>x.event.observedAt>=releasedAt&&!x.event.replay).length;
      const diagnostic=await b.options('mori.options.health');await b.clock.drain();
      const manual=b.log.deliveries.filter(x=>x.event.observedAt>=releasedAt&&!x.event.replay).length;
      console.log(JSON.stringify({automatic,manual,diagnosticAccepted:diagnostic.observationDelivery?.accepted}));
      if(automatic!==0||manual<1||diagnostic.observationDelivery?.accepted!==1)process.exitCode=1;})().catch(e=>{console.error(e);process.exitCode=1;});`;
    const destination = path.join(output, `${definition.id}-manual-control.txt`);
    const descriptor = fs.openSync(destination, 'w');
    let manual;
    try {
      manual = spawnSync(process.execPath, ['-e', manualCode], { env: { ...process.env, MORI_INDEPENDENT_ROOT: root },
        stdio: ['ignore', descriptor, descriptor], timeout: 30000 });
    } finally { fs.closeSync(descriptor); }
    result.manualRecoveryRetained = manual.status === 0 && !manual.error;
  }
  results.push(result);
  console.log(JSON.stringify(result));
}
const report = { createdAt: new Date().toISOString(), nodeVersion: process.version, platform: process.platform,
  sourceProductRoot: productRoot, controlFiles, frozenLedgerSha256: digest(fs.readFileSync(path.join(__dirname, 'recovery-independent-ledger-v1.json'))),
  testFileSha256: digest(fs.readFileSync(testFile)), harnessSha256: digest(fs.readFileSync(helperFile)),
  scope: 'Synthetic API/DOM and actual server/store modules. No real Chrome, provider binding, OS safeStorage or IME claim.', results };
fs.writeFileSync(path.join(output, 'mutation-results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Evidence: ${output}`);
if (results.some(result => !result.controlPassed || !result.failedForIntendedRequirement || result.manualRecoveryRetained === false)) process.exitCode = 1;
