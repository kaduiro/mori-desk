/* SPDX-License-Identifier: AGPL-3.0-only */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoriMeasurementRecorder = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';

  // Capture completeness is not a monitoring/acceptance verdict. This module
  // never starts a recorder, installs hooks, writes files or sends messages.
  const STAGES = Object.freeze([
    'content_observed', 'worker_received', 'worker_prepared', 'worker_verified',
    'worker_committed', 'desktop_received', 'desktop_committed', 'ack_received',
    'proof_granted', 'health_projected', 'hud_rendered', 'observer_installed',
    'authenticated_ready', 'registration_requested', 'registration_result', 'lease_received',
    'sample_valid', 'continuity_broken', 'queue_enter', 'wire_send',
    'local_observation_accepted', 'durable_commit', 'ack_sent',
    'ack_validated_current', 'health_published', 'UI_applied',
    'observer_install_deferred', 'product_inspection_started', 'product_inspection_finished',
  ]);
  const STATUSES = Object.freeze([
    'ok', 'pending', 'failed', 'unknown', 'missing', 'stale', 'closed',
  ]);
  const REASONS = Object.freeze([
    'none', 'disabled', 'invalid_configuration', 'invalid_stage', 'invalid_fields',
    'clock_unavailable', 'clock_invalid', 'clock_changed', 'expired', 'overflow',
    'stopped', 'invalid_calibration', 'invalid_interval', 'missing',
    'storage_failed', 'data_invalid', 'authentication_failed', 'schema_invalid',
    'paused', 'unpaired', 'disconnected', 'permission_denied', 'discarded',
    'frozen', 'initializing', 'loading', 'navigation_pending', 'unsupported_route',
    'unsupported_layout', 'observer_version', 'peer_unsupported', 'extension_limit',
    'extension_record_limit', 'desktop_capacity', 'recovery_limit', 'session_limit',
    'receipt_limit', 'outbox_full', 'capacity_unclassified', 'conversation_id_pending',
    'scope_unconfirmed', 'ambiguous_scope', 'dom_unknown', 'observation_rejected',
    'lease_pending', 'observer_unavailable', 'initialization_unconfirmed',
    'retry_wait', 'retry_unavailable', 'observation_pending', 'delivery_pending',
    'observation_expired', 'observer_queue_full', 'ack_unavailable',
    'lease_invalid', 'lease_expired', 'attempt_expired', 'old_document',
    'old_observation', 'duplicate_observation', 'sampling_gap', 'scope_lost',
    'start_unobserved', 'ack_timeout', 'session_store_write_failed', 'unclassified',
  ]);
  const LIMITS = Object.freeze({ maxEntries: 4096, maxDurationMs: 600000, maxCount: 1000000 });
  const FIELD_KEYS = ['status', 'reason', 'count', 'sameDocument', 'sameScope', 'sameConnection', 'missing'];
  const BOOLEAN_KEYS = ['sameDocument', 'sameScope', 'sameConnection', 'missing'];
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const finite = value => typeof value === 'number' && Number.isFinite(value)
    && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  const timestamp = value => finite(value) && value >= 0;
  const generation = value => Number.isSafeInteger(value) && value >= 0 && value <= LIMITS.maxCount;
  const increment = value => Math.min(LIMITS.maxCount, value + 1);

  // Inspect data descriptors only: getters, symbols, inherited dictionaries,
  // functions, IDs and arbitrary metadata are not a diagnostics input format.
  function dataObject(value, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string' || !allowed.includes(key)
      || !own(descriptors[key], 'value'))) return null;
    const result = Object.create(null);
    for (const key of keys) result[key] = descriptors[key].value;
    return result;
  }

  function categoricalFields(value) {
    const fields = dataObject(value, FIELD_KEYS);
    if (!fields || own(fields, 'status') && !STATUSES.includes(fields.status)
      || own(fields, 'reason') && !REASONS.includes(fields.reason)
      || own(fields, 'count') && (!Number.isSafeInteger(fields.count) || fields.count < 0 || fields.count > LIMITS.maxCount)
      || BOOLEAN_KEYS.some(key => own(fields, key) && typeof fields[key] !== 'boolean')) return null;
    return fields;
  }

  function defaultNow() {
    return typeof performance === 'object' && performance !== null && typeof performance.now === 'function'
      ? performance.now() : NaN;
  }

  function createRecorder(options = {}) {
    let configuration;
    try { configuration = dataObject(options, ['enabled', 'now', 'maxEntries', 'maxDurationMs']); }
    catch (_) { configuration = null; }
    const validConfiguration = !!configuration
      && (!own(configuration, 'enabled') || typeof configuration.enabled === 'boolean')
      && (!own(configuration, 'now') || typeof configuration.now === 'function')
      && (!own(configuration, 'maxEntries') || Number.isSafeInteger(configuration.maxEntries)
        && configuration.maxEntries > 0 && configuration.maxEntries <= LIMITS.maxEntries)
      && (!own(configuration, 'maxDurationMs') || finite(configuration.maxDurationMs)
        && configuration.maxDurationMs > 0 && configuration.maxDurationMs <= LIMITS.maxDurationMs);
    const enabled = validConfiguration && configuration.enabled === true;
    const now = enabled ? configuration.now || defaultNow : defaultNow;
    const maxEntries = validConfiguration ? configuration.maxEntries ?? 512 : 512;
    const maxDurationMs = validConfiguration ? configuration.maxDurationMs ?? 120000 : 120000;
    let active = enabled, startedAt = null, lastAt = null, clockGeneration = 0;
    let rejected = 0, dropped = 0;
    const entries = [], issues = [], stageCounts = Object.fromEntries(STAGES.map(stage => [stage, 0]));

    function issue(reason, halt = false) {
      if (!issues.includes(reason)) issues.push(reason);
      if (halt) active = false;
    }
    if (!validConfiguration) issue('invalid_configuration');
    else if (!enabled) issue('disabled');

    function readClock() {
      if (!active) return null;
      let at;
      try { at = now(); } catch (_) { issue('clock_unavailable', true); return null; }
      if (!timestamp(at)) { issue('clock_invalid', true); return null; }
      if (lastAt !== null && at < lastAt) {
        clockGeneration = increment(clockGeneration); issue('clock_changed', true); return null;
      }
      if (startedAt === null) startedAt = at;
      lastAt = at;
      if (at - startedAt >= maxDurationMs) { issue('expired', true); return null; }
      return at;
    }
    if (enabled) readClock();

    function record(stage, fields = {}) {
      try {
        if (!active) return false;
        if (!STAGES.includes(stage)) { rejected = increment(rejected); issue('invalid_stage'); return false; }
        const safe = categoricalFields(fields);
        if (!safe) { rejected = increment(rejected); issue('invalid_fields'); return false; }
        const at = readClock();
        if (at === null) return false;
        if (entries.length >= maxEntries) { dropped = increment(dropped); issue('overflow', true); return false; }
        const entry = { stage, at, clockGeneration, status: safe.status ?? 'unknown',
          reason: safe.reason ?? 'none', count: safe.count ?? 1 };
        for (const key of BOOLEAN_KEYS) if (own(safe, key)) entry[key] = safe[key];
        entries.push(entry); stageCounts[stage] = increment(stageCounts[stage]);
        if (safe.missing === true || safe.status === 'missing') issue('missing');
        return true;
      } catch (_) {
        rejected = increment(rejected); issue('invalid_fields'); return false;
      }
    }

    function snapshot() {
      // Mutable copies deliberately avoid caller-side strict-mode assignment
      // exceptions. Mutation of these copies cannot alter retained evidence.
      try { readClock(); } catch (_) { issue('clock_unavailable', true); }
      return { enabled, active, status: enabled && !issues.length && entries.length ? 'ok' : 'unknown',
        reason: issues[0] || (entries.length ? 'none' : 'missing'), missing: !!issues.length || !entries.length,
        clockGeneration, startedAt, lastAt, maxEntries, maxDurationMs,
        counts: { recorded: entries.length, rejected, dropped },
        stages: { ...stageCounts }, issues: [...issues], entries: entries.map(entry => ({ ...entry })) };
    }

    function stop() {
      try { if (active) readClock(); } catch (_) { issue('clock_unavailable', true); }
      issue('stopped', true);
      return snapshot();
    }
    return { record, snapshot, stop };
  }

  const unknown = reason => ({ status: 'unknown', reason, lower: null, upper: null });

  // Offset convention: local clock = external clock + offset. A single
  // external read bracketed locally, or a request/response exchange, bounds
  // this offset without assuming zero transport delay. The caller owns the
  // external clock-generation evidence and any drift/recalibration policy.
  function calibrateExternalClock(input) {
    try {
      const value = dataObject(input, ['localBefore', 'localAfter', 'externalAt',
        'externalBefore', 'externalAfter', 'localGeneration', 'externalGeneration']);
      if (!value) return unknown('invalid_calibration');
      const single = own(value, 'externalAt');
      if (single && (own(value, 'externalBefore') || own(value, 'externalAfter'))) return unknown('invalid_calibration');
      const before = single ? value.externalAt : value.externalBefore;
      const after = single ? value.externalAt : value.externalAfter;
      const localGeneration = value.localGeneration ?? 0, externalGeneration = value.externalGeneration ?? 0;
      if (![value.localBefore, value.localAfter, before, after].every(timestamp)
        || value.localAfter < value.localBefore || after < before
        || !generation(localGeneration) || !generation(externalGeneration)) return unknown('invalid_calibration');
      const lower = value.localBefore - before, upper = value.localAfter - after;
      if (!finite(lower) || !finite(upper) || lower > upper) return unknown('invalid_calibration');
      return { status: 'ok', reason: 'none', lower, upper, localGeneration, externalGeneration };
    } catch (_) { return unknown('invalid_calibration'); }
  }

  function timeInterval(value) {
    if (timestamp(value)) return { lower: value, upper: value };
    const interval = dataObject(value, ['lower', 'upper']);
    return interval && timestamp(interval.lower) && timestamp(interval.upper) && interval.lower <= interval.upper ? interval : null;
  }

  // start is local; end is local unless an external calibration is supplied.
  // An interval wholly before its start is inconsistent, never a fast pass.
  function delayInterval(input) {
    try {
      const value = dataObject(input, ['start', 'end', 'calibration', 'startGeneration', 'endGeneration']);
      if (!value) return unknown('invalid_interval');
      const start = timeInterval(value.start), end = timeInterval(value.end);
      const startGeneration = value.startGeneration ?? 0, endGeneration = value.endGeneration ?? 0;
      if (!start || !end || !generation(startGeneration) || !generation(endGeneration)) return unknown('invalid_interval');
      let offset = { lower: 0, upper: 0 };
      if (own(value, 'calibration')) {
        offset = dataObject(value.calibration, ['status', 'reason', 'lower', 'upper', 'localGeneration', 'externalGeneration']);
        if (!offset || offset.status !== 'ok' || offset.reason !== 'none'
          || !finite(offset.lower) || !finite(offset.upper) || offset.lower > offset.upper) return unknown('invalid_calibration');
        if (offset.localGeneration !== startGeneration || offset.externalGeneration !== endGeneration) return unknown('clock_changed');
      } else if (startGeneration !== endGeneration) return unknown('clock_changed');
      const lower = end.lower + offset.lower - start.upper, upper = end.upper + offset.upper - start.lower;
      if (!finite(lower) || !finite(upper) || upper < 0 || lower > upper) return unknown('invalid_interval');
      return { status: 'ok', reason: 'none', lower: Math.max(0, lower), upper, clockGeneration: startGeneration };
    } catch (_) { return unknown('invalid_interval'); }
  }

  function judgeDelayInterval(input, deadlineMs) {
    try {
      const interval = dataObject(input, ['status', 'reason', 'lower', 'upper', 'clockGeneration']);
      if (!interval || !timestamp(deadlineMs) || own(interval, 'status') && interval.status !== 'ok'
        || own(interval, 'reason') && interval.reason !== 'none'
        || own(interval, 'clockGeneration') && !generation(interval.clockGeneration)
        || !timestamp(interval.lower) || !timestamp(interval.upper) || interval.lower > interval.upper) return 'unknown';
      if (interval.upper <= deadlineMs) return 'pass';
      if (interval.lower > deadlineMs) return 'fail';
      return 'unknown';
    } catch (_) { return 'unknown'; }
  }

  return { STAGES, STATUSES, REASONS, LIMITS, createRecorder, calibrateExternalClock, delayInterval, judgeDelayInterval };
});
