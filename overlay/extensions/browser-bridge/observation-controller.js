/* SPDX-License-Identifier: AGPL-3.0-only */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoriObservationController = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  function createController({ uuid = () => crypto.randomUUID(), settleMs = 800 } = {}) {
    let status = 'idle';
    let outcome = null;
    let generationToken = null;
    let absentSince = null;
    let stoppedByUser = false;
    let shortStopCycle = false;
    function reset() {
      status = 'idle'; outcome = null; generationToken = null;
      absentSince = null; stoppedByUser = false; shortStopCycle = false;
    }
    function stopRequested() { if (status === 'running') stoppedByUser = true; }
    function sample(observation, now) {
      if (!observation.supported) {
        absentSince = null;
        return { status: 'unknown', generationToken, outcome: null };
      }
      if (observation.generating) {
        if (status !== 'running') {
          generationToken = uuid();
          shortStopCycle = observation.generationSignal === 'short_stop_busy';
        }
        status = 'running'; outcome = null; absentSince = null;
      } else if (status === 'running') {
        if (observation.error) {
          status = 'settled'; outcome = 'error'; absentSince = null;
        } else if (observation.ready && (shortStopCycle
          ? observation.controlsIdle === true : observation.hasAssistant)) {
          if (absentSince === null) absentSince = now;
          if (now - absentSince >= settleMs) {
            status = 'settled';
            // Absence is not proof of normal completion. This preview never
            // produces "completed" for either provider. The alternate path
            // requires a prior short-stop + busy cycle and both signals quiet;
            // it does not pretend that an assistant message was found.
            outcome = stoppedByUser ? 'interrupted' : 'unverified';
            absentSince = null;
          }
        } else {
          absentSince = null;
          return { status: 'unknown', generationToken, outcome: null };
        }
      }
      if (status !== 'running') stoppedByUser = false;
      return { status, generationToken, outcome };
    }
    return { sample, reset, stopRequested, isRunning: () => status === 'running' };
  }
  return { createController };
});
