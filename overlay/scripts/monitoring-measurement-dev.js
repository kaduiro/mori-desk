/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
// Development harness only. Never loaded by a manifest, startup or IPC route.
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const BINDING = 'const measurement = null; // MORI_MEASUREMENT_SINK';
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const validId = value => typeof value === 'string' && ID.test(value);
const SCOPE = ['kind','viewEpoch','bindingEpoch','samplingEpoch','workerEpoch','leaseId','documentId','startUnobserved'];
const EVENT = ['browserRunId','sessionId','eventId','sequence','tabId','pageInstanceId','routeRevision','turnId','generation'];
function compileWorker(source, context, measurement) {
  if (typeof source !== 'string' || source.split(BINDING).length !== 2) throw new Error('measurement_seam_mismatch');
  // Binding is a function argument, not a public global, setting or wire field.
  const wrapped = `(function(measurement){\n${source.replace(BINDING, '')}\n})`;
  const boot = new vm.Script(wrapped, { filename: 'measurement-worker.js' }).runInContext(context);
  const bridge = measurement ? {
    record(stage, fields = {}) {
      try {
        // Cross-VM dictionaries have a different Object.prototype. Copy only
        // own data descriptors; the recorder still enforces its whole schema.
        const copy = Object.create(null), descriptors = Object.getOwnPropertyDescriptors(fields);
        for (const key of Reflect.ownKeys(descriptors)) {
          if (typeof key !== 'string' || !Object.hasOwn(descriptors[key], 'value'))
            return measurement.record(stage, {missing:true,reason:'invalid_fields'});
          copy[key] = descriptors[key].value;
        }
        return measurement.record(stage, copy);
      } catch (_) { return false; }
    },
    linkSample(...args) { try { return measurement.linkSample?.(...args); } catch (_) {return false;} }
  } : null;
  return boot(bridge);
}
function createCorrelationLedger({ maxEntries = 256 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 4096) throw new Error('invalid_measurement_limit');
  let records = [], missing = false, stopped = false;
  function validScope(s) {
    return s && ['view','conversation'].includes(s.kind) && typeof s.startUnobserved === 'boolean'
      && SCOPE.filter(k => !['kind','startUnobserved'].includes(k)).every(k => validId(s[k]));
  }
  function linkSample(sample, scope, events) {
    if (stopped || missing) return false;
    try {
      if (!sample || !Number.isSafeInteger(sample.contentSequence) || sample.contentSequence < 1
        || !validId(sample.pageInstanceId) || sample.generationToken !== null && !validId(sample.generationToken)
        || !validScope(scope) || !Array.isArray(events) || events.length + records.length > maxEntries) {
        missing = true; records = []; return false;
      }
      const copied = events.map(e => {
        if (!e || !['observation','terminal','gap','closed'].includes(e.kind) || !validScope(e.scope)
          || !['browserRunId','sessionId','eventId','pageInstanceId'].every(k => validId(e[k]))
          || !['sequence','tabId','routeRevision','generation'].every(k => Number.isSafeInteger(e[k]) && e[k] >= 0)
          || e.turnId !== null && !validId(e.turnId)) throw new Error('invalid');
        return { sample: { contentSequence: sample.contentSequence, pageInstanceId: sample.pageInstanceId,
          generationToken: sample.generationToken }, scope: Object.fromEntries(SCOPE.map(k => [k, scope[k]])),
          event: { ...Object.fromEntries(EVENT.map(k => [k,e[k]])), kind: e.kind,
            scope: Object.fromEntries(SCOPE.map(k => [k,e.scope[k]])) } };
      });
      records.push(...copied); return true;
    } catch (_) { missing = true; records = []; return false; }
  }
  function compare(sample, event) {
    try {
      const found = records.filter(r => r.sample.contentSequence === sample?.contentSequence
        && r.sample.pageInstanceId === sample?.pageInstanceId && r.event.eventId === event?.eventId);
      if (missing || stopped || found.length !== 1) return { status: 'unknown', count: found.length, missing: true };
      const r = found[0];
      return { status: 'verified', count: 1, missing: false,
        sameSample: r.sample.generationToken === sample.generationToken,
        sameEvent: EVENT.every(k => r.event[k] === event[k]),
        sameScope: SCOPE.every(k => r.scope[k] === event.scope?.[k] && r.event.scope[k] === event.scope?.[k]) };
    } catch (_) { return { status: 'unknown', count: 0, missing: true }; }
  }
  return Object.freeze({ linkSample, compare, summary: () => ({ count: records.length, missing, stopped }),
    stop() { records = []; stopped = true; } });
}
function removeIsolatedDirectory(directory, ownerToken) {
  const root = fs.realpathSync(require('node:os').tmpdir());
  const absolute = path.resolve(directory);
  if (path.dirname(absolute) !== root || !/^mori-measurement-[a-f0-9-]{36}$/.test(path.basename(absolute))
    || fs.lstatSync(absolute).isSymbolicLink()) throw new Error('measurement_cleanup_owner');
  const marker = JSON.parse(fs.readFileSync(path.join(absolute,'.mori-measurement-owner.json'),'utf8'));
  if (marker.token !== ownerToken || marker.kind !== 'isolated-measurement') throw new Error('measurement_cleanup_owner');
  // This exact temporary directory was created by this runner and checked above.
  fs.rmSync(absolute, { recursive: true });
}
function createIsolatedDirectory() {
  const token = crypto.randomUUID();
  const directory = path.join(fs.realpathSync(require('node:os').tmpdir()), `mori-measurement-${crypto.randomUUID()}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(directory,'.mori-measurement-owner.json'), JSON.stringify({kind:'isolated-measurement',token}), {mode:0o600,flag:'wx'});
  return { directory, dispose: () => removeIsolatedDirectory(directory, token) };
}
module.exports = { compileWorker, createCorrelationLedger, createIsolatedDirectory };
