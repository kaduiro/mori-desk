/* SPDX-License-Identifier: AGPL-3.0-only */
(function(root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('../../scripts/monitoring-independent-payload') : root.MoriIndependentPayload);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoriNativeMeasurementContent = api;
})(typeof globalThis === 'object' ? globalThis : this, function(payload) {
  'use strict';
  // Only the separate development bundle calls this factory. No page listener,
  // setting, normal manifest script or message can create a capture instance.
  const REGISTRATION_REASONS = ["none","unclassified","stopped","runtime_unavailable","message_failed","registration_replaced","page_changed","binding_changed","route_changed","paused","invalid_sender","old_document","invalid_observation","old_observation","duplicate_observation","capacity","outbox_full","storage_failed","local_data_invalid","tab_unavailable","observation_failed","binding_unconfirmed","lease_invalid","lease_expired","attempt_expired","observer_version","initialization_failed","registration_failed","observer_queue_full","ack_unavailable","peer_unsupported"];
  const ID = /^[A-Za-z0-9_-]{1,128}$/;
  const STAGES = ['content_observed','worker_received','worker_prepared','worker_verified','worker_committed',
    'desktop_received','desktop_committed','ack_received','proof_granted','health_projected','hud_rendered',
    'observer_installed','authenticated_ready','registration_requested','lease_received','sample_valid',
    'continuity_broken','queue_enter','wire_send','local_observation_accepted','durable_commit','ack_sent',
    'ack_validated_current','health_published','UI_applied','registration_result',
    'observer_install_deferred','product_inspection_started','product_inspection_finished'];
  const FAILURES = ['clock_unavailable','clock_invalid','clock_reversed','expired','capacity','invalid_schema','invalid_sender',
    'clock_probe_failed','clock_probe_timeout','clock_probe_capacity','batch_missing','batch_rejected','batch_timeout','batch_send_failed',
    'batch_gap','batch_duplicate','reader_failed','reader_dispose_failed','socket_send_failed','ack_unmatched','ack_ambiguous',
    'ping_duplicate','ping_unmatched','sample_duplicate','capture_failed','batch_retry_exhausted','structure_inventory_failed','socket_evidence_incomplete','disposed','b1_missing_hook','b1_input_conflict','b1_invocation_missing','b1_event_conflict',
    'b1_clone_unverified','b1_send_unverified','b1_pending_expired','b1_stale_capture'];
  const INVENTORY_KEYS = ['main','form','editable','textbox','prompt','stop','busy','streaming','assistantMarker','conversationTurn',
    'chatgptOwner','chatgptComposerOwner','chatgptMessageOwner','claudeHubRoot','claudeInput','conversationId','chatId','threadId','canonical'];
  const inventoryBudgets = new WeakMap();
  let nextReaderGeneration = 0;
  const COUNTS = ['main','display','composer','editor','form','stop','busy','root','shield','skeleton','streaming'];
  const REASONS = ['observed','main_not_unique','owner_not_unique','owner_mismatch','editor_not_unique','form_unconfirmed',
    'mixed_message_owner','generation_ambiguous','route_owner_mismatch','generation_marker_partial','loading_or_transition',
    'composer_not_unique','editor_unconfirmed','generation_marker_unknown','disposed','document_not_visible',
    'route_transition_unconfirmed','clock_discontinuity','structure_unavailable'];
  const UNCERTAINTIES = ['explicit_unknown','mutation_batch','visibility_changed','sample_gap','clock_discontinuity','observer_unavailable','disposed'];
  const FIELDS = ['status','reason','count','sameDocument','sameScope','sameConnection','missing'];
  const OBSERVATION = ['contentSequence','pageInstanceId','generationToken','samplingEpoch','workerEpoch','leaseId',
    'bindingEpoch','viewEpoch','scopeKind','startUnobserved'];
  const integer = n => Number.isSafeInteger(n) && n >= 0;
  const number = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER;
  const id = s => typeof s === 'string' && ID.test(s);
  function dictionary(value, allowed, required = allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if (keys.some(k => typeof k !== 'string' || !allowed.includes(k) || !Object.hasOwn(descriptors[k],'value'))
      || required.some(k => !Object.hasOwn(descriptors,k))) return null;
    return Object.fromEntries(keys.map(k => [k,descriptors[k].value]));
  }
  function observationOf(value) {
    const o = dictionary(value,OBSERVATION);
    return o && integer(o.contentSequence) && o.contentSequence > 0
      && OBSERVATION.filter(k => !['contentSequence','generationToken','scopeKind','startUnobserved'].includes(k)).every(k => id(o[k]))
      && (o.generationToken === null || id(o.generationToken)) && ['view','conversation'].includes(o.scopeKind)
      && typeof o.startUnobserved === 'boolean' ? o : null;
  }
  function fieldsOf(value) {
    const f = dictionary(value,FIELDS,[]);
    if (!f || Object.keys(f).some(k => k === 'status' ? !['ok','pending','failed','unknown','missing','stale','closed'].includes(f[k])
      : k === 'reason' ? !['none','unknown','scope_unconfirmed','unclassified','initializing',...REGISTRATION_REASONS,...REASONS,...UNCERTAINTIES].includes(f[k])
      : k === 'count' ? !integer(f[k]) || f[k] > 1000000 : typeof f[k] !== 'boolean')) return null;
    return f;
  }
  function sampleOf(value, provider) {
    const s = dictionary(value,['provider','scopeKind','state','reason','counts','sameScope','continuity','continuous1s','uncertainty','interval']);
    const counts = s && dictionary(s.counts,COUNTS,[]);
    let interval = null;
    if (s && s.interval !== null && Array.isArray(s.interval)) {
      const length=Object.getOwnPropertyDescriptor(s.interval,'length')?.value;
      if(length===2){const d = Object.getOwnPropertyDescriptors(s.interval);
        if (Reflect.ownKeys(d).length === 3 && Object.hasOwn(d[0] || {},'value') && Object.hasOwn(d[1] || {},'value')) interval = [d[0].value,d[1].value];}
    }
    if (!s || s.provider !== provider || !['unknown','view','conversation'].includes(s.scopeKind)
      || !['unknown','running','quiet'].includes(s.state) || !REASONS.includes(s.reason)
      || !counts || Object.values(counts).some(n => !integer(n) || n > 1000000)
      || typeof s.sameScope !== 'boolean' || s.continuity !== 'unknown' || s.continuous1s !== false
      || s.uncertainty !== null && !UNCERTAINTIES.includes(s.uncertainty)
      || s.interval !== null && (!interval || !interval.every(number) || interval[1] < interval[0])) return null;
    // Reader-local intervals do not become a calibrated cross-process clock.
    const {interval:_,...categories} = s;
    return {...categories,counts};
  }
  function inventoryOf(value, provider) {
    const inventory = dictionary(value,['provider','routeKind','visible','counts']);
    const counts = inventory && dictionary(inventory.counts,INVENTORY_KEYS);
    if (!inventory || inventory.provider !== provider || !['conversation','view'].includes(inventory.routeKind)
      || typeof inventory.visible !== 'boolean' || !counts) return null;
    const copied = {};
    for (const key of INVENTORY_KEYS) {
      const count = dictionary(counts[key],['found','visible','matchesCurrentRoute','capped']);
      if (!count || typeof count.capped !== 'boolean' || ['found','visible','matchesCurrentRoute'].some(k => !integer(count[k]) || count[k] > 200)
        || count.visible > count.found || count.matchesCurrentRoute > count.found) return null;
      copied[key] = count;
    }
    return {...inventory,counts:copied};
  }
  function createContentCapture({chrome,document,readRoute,provider,readerFactory,structureInspector,now = () => performance.now(),
    timeOrigin = globalThis.performance?.timeOrigin,maxEntries = 4096,maxDurationMs = 600000,enableSeries = false} = {}) {
    if (!chrome?.runtime?.onMessage?.addListener || typeof chrome.runtime.sendMessage !== 'function' || !document
      || typeof readRoute !== 'function' || !['chatgpt','claude'].includes(provider) || typeof readerFactory !== 'function'
      || structureInspector !== undefined && typeof structureInspector !== 'function'
      || typeof now !== 'function' || !number(timeOrigin) || !integer(maxEntries) || maxEntries < 1 || maxEntries > 16384
      || !number(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 600000) throw new Error('native_capture_configuration');
    let disposed = false, missing = false, missingSent = false, halted = false, sending = false, last = null, count = 0, sentCount = 0;
    let reader = null, readerDisposed = false, sampleTimer = null, flushTimer = null, pendingSend = null, criticalFlushScheduled = false;
    const inventoryTimers = new Set();
    let inventoryAttempts = 0, inventories = 0;
    let inventoryBudget = null;
    if (structureInspector) {
      inventoryBudget = inventoryBudgets.get(document);
      if (!inventoryBudget) { inventoryBudget = {started:false,attempts:0}; inventoryBudgets.set(document,inventoryBudget); }
    }
    const queue = [];
    const captureToken = enableSeries ? globalThis.crypto.randomUUID() : null;
    let workerCaptureToken = null, dispatchOrdinal = 0, observerInstallationOrdinal = null;
    const readerGenerationOrdinal = ++nextReaderGeneration, dispatches = new Map();
    let started = null, lastRecordAt = null, batchSequence = 0, consecutiveFailures = 0, retryExhausted = false;
    const failures = Object.fromEntries(FAILURES.map(category => [category,{count:0,firstAt:null,lastAt:null}]));
    const batches = {attempted:0,acked:0,failed:0,recordsDropped:0,recordsConfirmed:0};
    const increment = (name,count = 1) => { batches[name] = Math.min(1000000,batches[name] + count); };
    function failureTime() {
      let at; try { at = now(); } catch (_) { halted = true; fail('clock_unavailable',null); stopSampling(); return null; }
      if (!number(at) || !number(timeOrigin + at)) { halted = true; fail('clock_invalid',null); stopSampling(); return null; }
      if (last !== null && at < last) { halted = true; fail('clock_reversed',null); stopSampling(); return null; }
      last = at; return timeOrigin + at;
    }
    function fail(category = 'invalid_schema',at = failureTime()) {
      missing = true; missingSent = false;
      const row = failures[FAILURES.includes(category) ? category : 'capture_failed'];
      if (!row.count) row.firstAt = at;
      row.count = Math.min(1000000,row.count + 1); row.lastAt = at;
      return false;
    }
    function timestamp() {
      if (halted || disposed) return null;
      let at; try { at = now(); } catch (_) { halted = true; fail('clock_unavailable',null); stopSampling(); return null; }
      if (!number(at) || !number(timeOrigin + at)) { halted = true; fail('clock_invalid',null); stopSampling(); return null; }
      if (last !== null && at < last) { halted = true; fail('clock_reversed',null); stopSampling(); return null; }
      if (started !== null && at - started > maxDurationMs) { last = at; halted = true; fail('expired',timeOrigin + at); stopSampling(); return null; }
      last = at; return timeOrigin + at;
    }
    function push(row) {
      if (disposed || halted) return false;
      if (count >= maxEntries || queue.length >= 128) { halted = true; increment('recordsDropped'); stopSampling(); return fail('capacity'); }
      const at = timestamp(); if (at === null) { increment('recordsDropped'); return false; }
      count++; queue.push({...row,recording:started !== null && !missing}); lastRecordAt = at; return true;
    }
    function errorRecord(category = 'invalid_schema') { fail(category); const at = timestamp(); if (at !== null) push({kind:'capture_error',at}); return false; }
    function stopSampling() {
      clearInterval(sampleTimer);
      for (const timer of inventoryTimers) clearTimeout(timer);
      inventoryTimers.clear();
      document.removeEventListener?.('visibilitychange',startInventories);
      if (!readerDisposed && reader) { readerDisposed = true; try { reader.dispose?.(); } catch (_) { fail('reader_dispose_failed'); } }
    }
    try { reader = readerFactory({document,readRoute,provider,clock:now,observeMutations:true,maxSampleGapMs:250,privateAttestation:enableSeries}); }
    catch (_) { throw new Error('native_reader_unavailable'); }
    if (!reader || typeof reader.sample !== 'function') { try { reader?.dispose?.(); } catch (_) {} throw new Error('native_reader_unavailable'); }
    const sink = Object.freeze({
      seriesFailure() { if(enableSeries)return errorRecord('b1_missing_hook');return false; },
      record(stage,fields = {}) {
        try { const clean = fieldsOf(fields), at = timestamp();
          if (at === null) return false;
          if (clean && stage === 'observer_installed') observerInstallationOrdinal = (observerInstallationOrdinal || 0) + 1;
          return clean && STAGES.includes(stage) ? push({kind:'stage',stage,at,fields:clean}) : errorRecord();
        } catch (_) { return errorRecord(); }
      },
      registrationResult(value) {
        try { const row = dictionary(value,['status','reason']);
          if (!row || !['ok','failed'].includes(row.status)) return errorRecord();
          return sink.record('registration_result',{status:row.status,
            reason:REGISTRATION_REASONS.includes(row.reason) ? row.reason : 'unclassified'});
        } catch (_) { return errorRecord(); }
      },
      dispatchBegin(value, subject, routeValue) {
        if (!enableSeries || disposed || halted) return null;
        try {
          const sample = payload?.sampleOf(value), route = payload?.routeOf(routeValue), before = timestamp();
          if (!sample || !route || before === null || dispatches.size >= 256) { errorRecord('invalid_schema'); return null; }
          const handle = Object.freeze({});
          const witnessBefore = attestation(subject,sample);
          dispatches.set(handle,{sample,route,before,witnessBefore,dispatchOrdinal:++dispatchOrdinal,
            observerInstallationOrdinal,readerGenerationOrdinal});
          return handle;
        } catch (_) { errorRecord('capture_failed'); return null; }
      },
      dispatchEnd(handle, subject, status) {
        if (!enableSeries || disposed || halted) return false;
        const begun = dispatches.get(handle); dispatches.delete(handle);
        if (!begun || !['returned','threw'].includes(status)) return errorRecord('capture_failed');
        try {
          const witnessAfter = attestation(subject,begun.sample), after = timestamp();
          if (after === null) return false;
          const row = {kind:'b1_dispatch',...begun,after,status,witnessAfter};
          if (!payload.withinBytes(row,8192)) return errorRecord('capacity');
          const accepted = push(row);
          if (accepted) scheduleCriticalFlush();
          return accepted;
        } catch (_) { return errorRecord('capture_failed'); }
      },
      observation(value) {
        if(enableSeries)return true; // Full dispatch rows replace the legacy identity-only auxiliary row.
        try { const observation = observationOf(value), at = timestamp();
          if (at === null) return false;
          return observation ? push({kind:'observation',at,observation}) : errorRecord();
        } catch (_) { return errorRecord(); }
      }
    });
    function attestation(subject,sample) {
      // subject is used synchronously only. No DOM/facade reference is kept in
      // the handle, reader result or deferred runtime batch.
      if (typeof reader.attest !== 'function') throw new Error('native_attestation_unavailable');
      const raw = reader.attest(subject);
      const copied = dictionary(raw,['witnessSampleOrdinal','ownerOrdinal','signal','scopeKind','ownerKey','conversationRef',
        'ownerScopeMatch','uncertainty','reason','before','after']);
      if (!copied || !number(copied.before) || !number(copied.after) || copied.after < copied.before) throw new Error('native_attestation_invalid');
      copied.before += timeOrigin; copied.after += timeOrigin;
      if(copied.ownerScopeMatch===true && (!subject || sample.bindingEpoch!==subject.epoch
        || sample.viewEpoch!==subject.viewEpoch || sample.scopeKind!==subject.kind)){
        copied.ownerScopeMatch=false;copied.reason='owner_mismatch';
      }
      return copied;
    }
    function sampleNow() {
      if (disposed || halted) return false;
      const before = timestamp(); if (before === null) return false;
      let value; try { value = reader.sample(); } catch (_) { return errorRecord('reader_failed'); }
      const after = timestamp();
      if (after === null) return false;
      try { const sample = sampleOf(value,provider);
        return sample && after !== null ? push({kind:'dom',before,after,sample}) : errorRecord();
      } catch (_) { return errorRecord(); }
    }
    function inventoryNow() {
      if (disposed || halted || !structureInspector || document.visibilityState !== 'visible' || inventoryBudget.attempts >= 3) return false;
      inventoryAttempts++; inventoryBudget.attempts++;
      const before = timestamp(); if (before === null) return false;
      try {
        const value = structureInspector({provider,document,readRoute});
        const after = timestamp(); if (after === null) return false;
        const inventory = inventoryOf(value,provider);
        if (!inventory) return errorRecord('structure_inventory_failed');
        const accepted = push({kind:'structure_inventory',before,after,inventory});
        if (accepted) inventories++;
        return accepted;
      } catch (_) { return errorRecord('structure_inventory_failed'); }
    }
    function startInventories() {
      if (disposed || halted || !structureInspector) return;
      if (inventoryBudget.started) { document.removeEventListener?.('visibilitychange',startInventories); return; }
      if (document.visibilityState !== 'visible') return;
      inventoryBudget.started = true;
      document.removeEventListener?.('visibilitychange',startInventories);
      for (const delay of [5000,10000]) {
        const timer = setTimeout(() => { inventoryTimers.delete(timer); inventoryNow(); },delay);
        inventoryTimers.add(timer);
      }
      inventoryNow();
    }
    function scheduleCriticalFlush() {
      if (!enableSeries || criticalFlushScheduled || sending || disposed || halted || retryExhausted) return;
      criticalFlushScheduled = true;
      // Product send has already returned. Keep its result independent of
      // measurement ACKs, and avoid background timer latency for lineage rows.
      void Promise.resolve().then(() => {
        criticalFlushScheduled = false;
        if (disposed || halted || retryExhausted || timestamp() === null) return;
        if (queue.some(row => row.kind === 'b1_dispatch')) void flush();
      });
    }
    async function flush() {
      if (disposed || retryExhausted || sending || !queue.length && (!missing || missingSent)) return false;
      sending = true;
      const records = queue.splice(0,64);
      const pending = {records,timer:null,cancel:null,failed:false,timedOut:false,confirmed:0,accepted:false}; pendingSend = pending;
      function dropped() { if (!pending.failed) {
        pending.failed = true; increment('failed'); increment('recordsDropped',records.length - pending.confirmed);
        if (++consecutiveFailures >= 3 && !disposed) {
          retryExhausted = true; halted = true; fail('batch_retry_exhausted'); stopSampling(); clearInterval(flushTimer);
          increment('recordsDropped',queue.length); queue.length = 0;
        }
      } }
      const reportFailures = () => FAILURES.filter(category => failures[category].count).map(category => ({category,...failures[category]}));
      increment('attempted');
      try {
        const capturedMissing = missing;
        const sentFailures = reportFailures();
        const timeout = new Promise((_,reject) => { pending.cancel = reject; pending.timer = setTimeout(() => {pending.timedOut = true;reject(new Error('native_batch_timeout'));},1500); });
        const envelope = {type:'mori.native.records',v:enableSeries ? 3 : 2,batchSequence:++batchSequence,
          clockOrigin:timeOrigin,missing:capturedMissing,records,failures:sentFailures,
          ...(enableSeries ? {captureToken,workerCaptureToken} : {})};
        if (enableSeries && !payload.withinBytes(envelope,65536)) throw new Error('native_batch_capacity');
        const response = await Promise.race([chrome.runtime.sendMessage(envelope),timeout]);
        if (disposed) { dropped(); return false; }
        const r = dictionary(response,enableSeries ? ['ok','recording','acceptedRecords','workerCaptureToken','reason'] : ['ok','recording','acceptedRecords']);
        if (!r || typeof r.ok !== 'boolean' || typeof r.recording !== 'boolean' || !integer(r.acceptedRecords)
          || r.acceptedRecords > records.length || r.ok && r.acceptedRecords !== records.length || !r.ok && r.recording
          || enableSeries && (!id(r.workerCaptureToken) || !['none','invalid_schema','invalid_sender','stale_capture','batch_duplicate','batch_gap','capacity','expired','disposed'].includes(r.reason)
            || !r.ok && r.acceptedRecords !== 0 || workerCaptureToken && r.workerCaptureToken !== workerCaptureToken)) {
          dropped(); return errorRecord('invalid_schema');
        }
        pending.confirmed = r.acceptedRecords; increment('recordsConfirmed',r.acceptedRecords); sentCount += r.acceptedRecords;
        if (!r.ok) { dropped(); return errorRecord('batch_rejected'); }
        if (enableSeries) workerCaptureToken = r.workerCaptureToken;
        consecutiveFailures = 0;
        if (r.recording && started === null && !halted) { const at = timestamp(); if (at !== null) started = at - timeOrigin; }
        if (!r.recording && started !== null && !missing) fail('capture_failed');
        increment('acked');
        pending.accepted = true;
        missingSent = capturedMissing && JSON.stringify(sentFailures) === JSON.stringify(reportFailures());
        if (halted && !queue.length && missingSent) clearInterval(flushTimer);
        return true;
      } catch (_) { dropped(); if (!disposed) errorRecord(pending.timedOut ? 'batch_timeout' : 'batch_send_failed'); return false; }
      finally {
        clearTimeout(pending.timer); pending.records.length = 0; if (pendingSend === pending) pendingSend = null; sending = false;
        // A failed batch keeps the existing bounded periodic retry path.
        if (pending.accepted && queue.some(row => row.kind === 'b1_dispatch')) scheduleCriticalFlush();
      }
    }
    function listener(message,sender,respond) {
      try {
        const m = dictionary(message,['type','v','probeOrdinal']);
        if (disposed || halted || !m || m.type !== 'mori.native.clock' || m.v !== 1 || !integer(m.probeOrdinal)
          || m.probeOrdinal < 1 || m.probeOrdinal > 64 || sender?.id !== chrome.runtime.id || sender.tab) return false;
        const received = timestamp(), sent = timestamp();
        if (received !== null && sent !== null) respond({type:'mori.native.clock',v:1,probeOrdinal:m.probeOrdinal,clockOrigin:timeOrigin,received,sent});
      } catch (_) { errorRecord('clock_probe_failed'); }
      return false;
    }
    chrome.runtime.onMessage.addListener(listener);
    sampleTimer = setInterval(sampleNow,100); flushTimer = setInterval(() => { void flush(); },250);
    sampleNow();
    if (structureInspector && !inventoryBudget.started) { document.addEventListener?.('visibilitychange',startInventories); startInventories(); }
    return Object.freeze({sink,sampleNow,flush,
      snapshot:() => { timestamp(); return {v:1,status:missing || disposed || halted ? 'unknown' : 'capturing',missing,disposed,clockOrigin:timeOrigin,
        formalAcceptance:false,independentScopeVerified:false,currentDocumentVerified:false,
        capture:{phase:missing || disposed || halted ? 'unknown' : started === null ? 'waiting' : 'recording',startedAt:started === null ? null : timeOrigin + started,
          maxDurationMs,maxEntries,maxConsecutiveBatchFailures:3,elapsedMs:started === null || last === null || failures.clock_unavailable.count || failures.clock_invalid.count || failures.clock_reversed.count
            ? null : Math.max(0,last - started),lastRecordAt},
        failures:Object.fromEntries(FAILURES.map(category => [category,{...failures[category]}])),batches:{...batches},
        counts:{records:count,queued:queue.length,sent:sentCount,inventories,inventoryAttempts}};},
      dispose() {
        if (disposed) return;
        fail('disposed'); increment('recordsDropped',queue.length);
        disposed = true; stopSampling(); clearInterval(flushTimer);
        dispatches.clear(); workerCaptureToken = null;
        chrome.runtime.onMessage.removeListener(listener); queue.length = 0;
        if (pendingSend) { if (!pendingSend.failed) { pendingSend.failed = true; increment('failed'); increment('recordsDropped',pendingSend.records.length - pendingSend.confirmed); }
          pendingSend.records.length = 0; clearTimeout(pendingSend.timer); pendingSend.cancel?.(new Error('native_capture_disposed')); }
      }});
  }
  return Object.freeze({createContentCapture});
});
