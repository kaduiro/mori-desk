/* SPDX-License-Identifier: AGPL-3.0-only */
(function(root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./monitoring-independent-payload') : root.MoriIndependentPayload);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoriIndependentChannel = api;
})(typeof globalThis === 'object' ? globalThis : this, function(codec) {
  'use strict';
  const TYPES = ['hello','challenge','authenticate','pair.ready','pair.confirm','ready','ping','pong','scope.event',
    'scope.event.ack','scope.event.nack','client.health','focus.request','focus.result','error'];
  const REASONS = new Set(['capture_failed','invalid_schema','capacity','clock_unknown','expired','disposed','send_failed',
    'connection_replaced','reconnected','multiple_authenticated_channels','prefix_incomplete','prefix_mismatch','ping_ambiguous',
    'pending_ack','ack_timeout','duplicate_event','local_comparison_unavailable','proof_unavailable','post_cut_failure',
    'disconnected','control_changed','credential_changed','store_projection_only','prefix_validation_pending','decode_failed']);
  const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const object = o => o !== null && typeof o === 'object';
  const tri = v => v === true || v === false ? v : null;
  function createChannelCapture({ side, targetPingOrdinal = 2, now = () => performance.now(), maxMessages = 4096,
    maxSockets = 64, maxDurationMs = 600000 } = {}) {
    if (!['worker','collector'].includes(side) || !Number.isSafeInteger(targetPingOrdinal) || targetPingOrdinal < 2 || targetPingOrdinal > 60
      || !Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 16384
      || !Number.isSafeInteger(maxSockets) || maxSockets < 1 || maxSockets > 64
      || !finite(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 600000 || typeof now !== 'function') throw new Error('channel_configuration');
    const sockets = new Map(), handles = new WeakMap(), acknowledgments = new Map();
    let expectations = new WeakMap();
    const rows = [], pings = [], events = [], pingLabels = new Set();
    let last = null, started = null, failureRevision = 0, reason = null, disposed = false, connectionCount = 0;
    let authenticatedSocket = null, cut = null, exportSequence = 0, observedThrough = null, expiryTimer = null;
    function scheduleExpiry() {
      clearTimeout(expiryTimer); expiryTimer = null;
      if (disposed || reason || last === null) return;
      const deadlines = events.filter(e => e.projection).map(e => e.ack
        ? Math.min(e.row.before+30000,e.ack.before+5000) : e.row.before+5000);
      for (const s of sockets.values()) if (s.expectation) deadlines.push(s.expectation.startedAt+5000);
      if (!deadlines.length) return;
      expiryTimer = setTimeout(() => { expiryTimer = null; clock(); scheduleExpiry(); },Math.max(1,Math.min(30000,Math.min(...deadlines)-last)));
      expiryTimer.unref?.();
    }
    function releaseRaw(e) {
      e.projection = null; e.subjectRef = null; e.row.projection = null;
      if (e.ack) e.ack.projection = null;
      for (const [ref,a] of acknowledgments) if (a.e === e) acknowledgments.delete(ref);
    }
    function fail(value = 'capture_failed') {
      failureRevision = Math.min(1000000,failureRevision+1); if (!reason) reason = REASONS.has(value) ? value : 'capture_failed';
      for (const e of events) releaseRaw(e);
      for (const s of sockets.values()) s.expectation = null;
      expectations = new WeakMap(); clearTimeout(expiryTimer); expiryTimer = null; return null;
    }
    function clock() {
      if (disposed) return null;
      let at; try { at = now(); } catch { return fail('clock_unknown'); }
      if (!finite(at) || last !== null && at < last) return fail('clock_unknown');
      last = at; observedThrough = at;
      if (started !== null && at - started > maxDurationMs) { fail('expired'); return null; }
      if (cut?.boundaryAt !== null && cut?.boundaryAt !== undefined && cut.sealedAt === null && at - cut.boundaryAt > 5000) fail('ack_timeout');
      for (const e of events) if (e.projection && (at - e.row.before >= (e.ack ? 30000 : 5000) || e.ack && !e.validated && at - e.ack.before >= 5000)) {
        fail('ack_timeout'); break;
      }
      for (const s of sockets.values()) if (s.expectation && at - s.expectation.startedAt >= 5000) { fail('ack_timeout'); break; }
      return at;
    }
    function socketFor(ref) { return sockets.get(ref) || null; }
    function clean(type, projection) {
      if (type === 'scope.event') return codec.eventOf(projection);
      if (type === 'scope.event.ack') return codec.ackOf(projection);
      if (type === 'scope.event.nack') return codec.nackOf(projection);
      if (type === 'ping' || type === 'pong') {
        const p = codec.dictionary(projection,['type','at']);
        return p && p.type === type && Number.isSafeInteger(p.at) && p.at >= 0 ? Object.freeze(p) : null;
      }
      // Authentication/health/focus bodies do not enter this helper.
      return projection === null || projection === undefined ? null : false;
    }
    const eventKey = e => JSON.stringify([e.browserRunId,e.sessionId,e.eventId,e.sequence]);
    function findEvent(socket, ack) { const found = socket.events.filter(e => e.projection && eventKey(e.projection) === eventKey(ack));
      if (found.length !== 1) { fail(found.length ? 'duplicate_event' : 'local_comparison_unavailable'); return null; } return found[0]; }
    function trySeal() {
      if (!cut || cut.sealedAt !== null || reason) return;
      const ping = cut.ping;
      if (!(side === 'worker' ? ping.sendReturned : ping.row.complete) || !ping.pongRawComplete || side === 'worker' && (!ping.productPongProcessed || !ping.localPongLabelMatched)) return;
      const prefix = events.filter(e => e.socket === cut.socket && e.row.ordinal <= cut.clientEnd);
      if (prefix.some(e => !e.row.complete || !e.ack || !e.ack.complete || e.ack.ordinal > cut.serverEnd || !e.validated)) return;
      if (side === 'worker' && prefix.some(e => e.proofExact !== true)) return;
      if (side === 'collector' && prefix.some(e => e.ingestExact !== true)) return;
      const at = clock(); if (at === null || reason) return;
      cut.sealedAt = at;
    }
    const sink = {
      socketOpened(socketRef) {
        if (!object(socketRef) || sockets.has(socketRef) || disposed) return fail('invalid_schema');
        if ([...sockets.values()].filter(s => !s.closed).length >= maxSockets || sockets.size >= maxMessages) return fail('capacity');
        const socket = { ref:socketRef, ordinal:++connectionCount, client:0, server:0, nextEvent:0, events:[],
          authenticated:false, closed:false, authRef:null, pingCount:0, lastPingAt:null, expectation:null };
        sockets.set(socketRef,socket); clock(); return Object.freeze({connectionOrdinal:socket.ordinal});
      },
      authenticated(socketRef,authRef) {
        const s = socketFor(socketRef); if (!s || !object(authRef) || s.closed || s.authenticated) return fail('invalid_schema');
        if (authenticatedSocket && authenticatedSocket !== s) fail('multiple_authenticated_channels');
        s.authenticated = true; s.authRef = authRef; authenticatedSocket = s;
        const at = clock(); if (started === null && at !== null) started = at;
      },
      messageBegin(socketRef,{direction,type,projection=null,phase='unknown',before} = {}) {
        const s = socketFor(socketRef);
        if (!s || s.closed || disposed || !['client_to_server','server_to_client'].includes(direction)
          || !TYPES.includes(type) || !['waiting','recording','unknown'].includes(phase) || !finite(before)) return fail('invalid_schema');
        if (rows.length >= maxMessages) return fail('capacity');
        const observed = clock(); if (observed === null || before > observed) fail('clock_unknown');
        // After any known failure, retain anonymous type/ordinal only. Do not
        // even clone a new state/identity payload into the diagnostic helper.
        const projected = reason ? null : clean(type,projection);
        if (!reason && (projected === false || ['scope.event','scope.event.ack','scope.event.nack','ping','pong'].includes(type) && !projected)) fail('invalid_schema');
        const isClient = direction === 'client_to_server';
        const row = { socket:s,direction,type,ordinal:isClient ? ++s.client : ++s.server,eventOrdinal:null,
          projection:projected || null,phase:reason ? 'unknown' : phase,before,after:null,complete:false,localExact:null,ping:null };
        if (type === 'scope.event' && isClient) {
          row.eventOrdinal = ++s.nextEvent;
          if (projected) {
            if (s.events.some(e => e.projection && eventKey(e.projection) === eventKey(projected))) fail('duplicate_event');
            const e = {socket:s,row,projection:projected,ack:null,validated:false,currentAccepted:false,proofExact:null,ingestExact:null,subjectRef:null};
            s.events.push(e); events.push(e); row.event = e;
            if (!s.authenticated) fail('local_comparison_unavailable');
            if (side === 'worker') {
              const x = s.expectation;
              if (!x || x.used || !codec.equal(x.projection,projected)) fail('local_comparison_unavailable');
              else { x.used = true; x.row = row; e.subjectRef = x.subjectRef; row.localExact = true; }
            }
          }
        } else if (['scope.event.ack','scope.event.nack'].includes(type) && !isClient && projected) {
          const e = findEvent(s,projected);
          if (e) { if (e.ack) fail('duplicate_event'); else { e.ack = row; row.event = e; row.eventOrdinal = e.row.eventOrdinal; }
            if (type === 'scope.event.nack') fail('post_cut_failure'); }
        } else if (type === 'ping' && isClient && projected && s.authenticated) {
          if (pingLabels.has(projected.at) || s.lastPingAt !== null && projected.at <= s.lastPingAt) fail('ping_ambiguous');
          pingLabels.add(projected.at); s.lastPingAt = projected.at;
          const ping = {socket:s,row,pingOrdinal:++s.pingCount,pingAt:projected.at,sendReturned:side === 'worker' ? false : null,
            pong:null,pongRawComplete:false,productPongProcessed:false,localPongLabelMatched:false};
          pings.push(ping); row.ping = ping;
          if (ping.pingOrdinal === targetPingOrdinal) {
            if (cut) fail('ping_ambiguous');
            else cut = {socket:s,ping,clientEnd:row.ordinal,serverEnd:null,boundaryAt:null,sealedAt:null};
          }
        } else if (type === 'pong' && !isClient && projected) {
          const candidates = pings.filter(p => p.socket === s && p.pingAt === projected.at && !p.pong);
          if (candidates.length !== 1) fail('ping_ambiguous');
          else { const p = candidates[0]; p.pong = row; row.ping = p;
            if (cut?.ping === p) cut.serverEnd = row.ordinal; }
        } else if (type === 'error') fail('post_cut_failure');
        const handle = Object.freeze({connectionOrdinal:s.ordinal,messageOrdinal:row.ordinal,eventOrdinal:row.eventOrdinal,direction,typeCategory:type});
        handles.set(handle,row); row.handle = handle; rows.push(row);
        if (reason) { row.projection = null; if (row.event) releaseRaw(row.event); } scheduleExpiry(); return handle;
      },
      messageEnd(handle,{status,after} = {}) {
        const row = handles.get(handle);
        if (!row || row.complete || row.after !== null || !finite(after) || after < row.before || !['returned','received','threw'].includes(status)) return fail('invalid_schema');
        row.after = after; row.complete = status !== 'threw';
        if (status === 'threw') fail('send_failed');
        if (row.ping) {
          if (row.type === 'ping') row.ping.sendReturned = side === 'worker' ? row.complete : null;
          else { row.ping.pongRawComplete = row.complete;
            if (side === 'collector') row.ping.localPongLabelMatched = row.complete;
            if (cut?.ping === row.ping) cut.boundaryAt = after; }
        }
        trySeal(); return true;
      },
      expectSend(subjectRef,eventProjection,socketRef) {
        if (reason) return null;
        const s = socketFor(socketRef), projection = codec.eventOf(eventProjection);
        if (!s || !object(subjectRef) || !projection || s.expectation || disposed) return fail('local_comparison_unavailable');
        const at = clock(); if (at === null || reason) return null;
        const ref = Object.freeze({}); const value = {socket:s,subjectRef,projection,used:false,row:null,startedAt:at};
        expectations.set(ref,value); s.expectation = value; scheduleExpiry(); return ref;
      },
      endExpectedSend(ref,status) {
        const x = expectations.get(ref); if (!x || x.socket.expectation !== x) return fail('local_comparison_unavailable');
        x.socket.expectation = null; expectations.delete(ref);
        scheduleExpiry();
        if (!x.used || !x.row?.complete || status !== 'returned') return fail(status === 'threw' ? 'send_failed' : 'local_comparison_unavailable');
        return true;
      },
      ingestInput(socketRef,eventProjection) {
        const s = socketFor(socketRef), projection = codec.eventOf(eventProjection);
        const e = s?.events.find(item => item.projection && item.ingestExact === null);
        if (!e || !projection) return fail('local_comparison_unavailable');
        e.ingestExact = codec.equal(e.projection,projection); e.row.localExact = e.ingestExact;
        if (!e.ingestExact) fail('prefix_mismatch'); return e.row.handle;
      },
      ackValidated({rawMessageRef,ackSubjectRef,eventSubjectRef,socketRef,ackProjection,proofExact} = {}) {
        if (reason) return null;
        const row = handles.get(rawMessageRef), s = socketFor(socketRef), projection = codec.ackOf(ackProjection);
        if (!row || row.socket !== s || !row.event || row.type !== 'scope.event.ack' || !object(ackSubjectRef)
          || !object(eventSubjectRef) || !projection || !codec.equal(row.projection,projection)) return fail('local_comparison_unavailable');
        const e = row.event;
        if (side === 'worker' && e.subjectRef !== eventSubjectRef || acknowledgments.has(ackSubjectRef)) return fail('local_comparison_unavailable');
        acknowledgments.set(ackSubjectRef,{e,eventSubjectRef,socketRef,proofExact:tri(proofExact)});
        row.localExact = true;
        return true;
      },
      validationComplete({ackSubjectRef,eventSubjectRef,socketRef,gate,proofExact,at} = {}) {
        const a = acknowledgments.get(ackSubjectRef);
        if (!a || a.eventSubjectRef !== eventSubjectRef || a.socketRef !== socketRef || !finite(at)) return fail('local_comparison_unavailable');
        acknowledgments.delete(ackSubjectRef);
        a.e.proofExact = a.proofExact === false || proofExact === false ? false
          : a.proofExact === true && proofExact === true ? true : null;
        const ack = a.e.ack.projection, event = a.e.projection;
        const current = gate === 'accepted_current' && ack.disposition === 'committed_current' && !ack.duplicate && ack.reason === null
          && ack.proofPresent && !event.replay && event.observation === 'fresh';
        // Actual product gate precedence: proof_absent precedes disposition and replay.
        const noncurrent = gate === 'proof_absent' && !ack.proofPresent && ack.reason === null
          && (ack.disposition !== 'committed_current' || event.replay);
        // A consumed ACK may describe a preceding sequence on the same owner.
        // Completing its channel decision never grants current proof, nor does
        // this earlier product gate attest to the later time/freshness gates.
        const supersededSequence = side === 'worker' && a.e.proofExact === true && gate === 'sequence_changed' && ack.disposition === 'committed_current'
          && !ack.duplicate && ack.reason === null && ack.proofPresent && !event.replay && event.observation === 'fresh';
        a.e.validated = current || noncurrent || supersededSequence; a.e.currentAccepted = current;
        const complete = a.e.validated && (side !== 'worker' || a.e.proofExact === true) && !reason;
        if (!complete) fail('local_comparison_unavailable');
        releaseRaw(a.e);
        scheduleExpiry(); trySeal(); return complete && !reason ? true : null;
      },
      pongProcessed({rawMessageRef,socketRef,pingAt,at} = {}) {
        const row = handles.get(rawMessageRef);
        if (!row || row.socket !== socketFor(socketRef) || row.type !== 'pong' || !row.ping || row.ping.pingAt !== pingAt || !finite(at)) return fail('ping_ambiguous');
        row.ping.productPongProcessed = true; row.ping.localPongLabelMatched = true; trySeal(); return true;
      },
      socketClosed(socketRef,value='disconnected') { const s = socketFor(socketRef); if (!s) return null;
        s.closed = true; s.expectation = null; if (s.authenticated) fail(value);
        for (const row of rows) if (row.socket === s) row.projection = null;
        for (const e of s.events) { e.projection = null; e.subjectRef = null; }
        for (const [ref,a] of acknowledgments) if (a.socketRef === socketRef) acknowledgments.delete(ref);
        s.events.length = 0; return true; },
      failure:fail,
    };
    const guarded = Object.freeze(Object.fromEntries(Object.entries(sink).map(([name,fn]) => [name,(...args) => {
      if (disposed) return null;
      try { return fn(...args); } catch { return fail('capture_failed'); }
    }])));
    function snapshot() {
      clock(); trySeal();
      const membership = row => !cut || cut.serverEnd === null ? 'boundary_pending'
        : row.socket !== cut.socket ? 'boundary_pending' : row.ordinal <= (row.direction === 'client_to_server' ? cut.clientEnd : cut.serverEnd) ? 'prefix' : 'suffix';
      const summarize = member => {
        const selected = rows.filter(r => membership(r) === member), c = selected.filter(r => r.direction === 'client_to_server'), s = selected.filter(r => r.direction === 'server_to_client');
        const counts = list => Object.fromEntries(TYPES.map(t => [t,list.filter(r => r.type === t).length]));
        const es = selected.filter(r => r.type === 'scope.event');
        return {clientMessageCount:c.length,serverMessageCount:s.length,clientTypeCounts:counts(c),serverTypeCounts:counts(s),
          eventCount:es.length,ackCount:selected.filter(r => r.type === 'scope.event.ack').length,pendingCount:es.filter(r => !r.event?.ack?.complete || !r.event?.validated).length,
          phaseCounts:Object.fromEntries(['waiting','recording','unknown'].map(p => [p,selected.filter(r => r.phase === p).length])),
          complete:!reason && selected.every(r => r.complete),localStateAttributionExact:es.length ? es.every(r => r.localExact === true) : null,observedThrough};
      };
      const prefix = summarize('prefix'), suffix = summarize('suffix');
      return {contract:'conditional-fifo-prefix-v2',status:reason ? 'unknown' : 'pending',
        reason:reason || (cut?.sealedAt !== null && cut?.sealedAt !== undefined ? 'comparison_pending' : cut ? 'prefix_validation_pending' : 'target_not_reached'),
        strictDirectComparison:false,fullWireBytesVerified:false,formalAcceptance:false,independentScopeVerified:false,
        selection:{strategy:'precommitted-authenticated-ping-ordinal-v1',targetPingOrdinal,frozenBeforeAuthentication:true},
        localConnectionOrdinal:authenticatedSocket?.ordinal ?? null,authenticationGenerationOrdinal:authenticatedSocket ? 1 : null,
        capturedFromSocketStart:true,locallyAuthenticated:!!authenticatedSocket,singletonAuthenticated:[...sockets.values()].filter(s => s.authenticated).length === 1,
        cut:cut ? {pingOrdinal:cut.ping.pingOrdinal,pingAt:cut.ping.pingAt,clientMessageEnd:cut.clientEnd,serverMessageEnd:cut.serverEnd,
          rawPongComplete:cut.ping.pongRawComplete,productPongProcessed:cut.ping.productPongProcessed,localPongLabelMatched:cut.ping.localPongLabelMatched,
          prefixValidationComplete:prefix.pendingCount === 0,prefixEventCount:prefix.eventCount,prefixAckCount:prefix.ackCount,prefixPendingCount:prefix.pendingCount,
          state:reason ? 'invalid' : cut.sealedAt === null ? 'pending' : 'sealed',boundaryAt:cut.boundaryAt,sealedAt:cut.sealedAt} : null,
        prefix,suffix,run:{failureRevision,failureAfterCut:!!reason && !!cut,eligibility:!reason && cut?.sealedAt !== null && cut?.sealedAt !== undefined ? 'eligible' : 'unknown',
          exportSequence:++exportSequence,exportAt:last,observedThrough,capturePhase:reason ? 'unknown' : started === null ? 'waiting' : 'recording'},
        messages:rows.map(r => ({connectionOrdinal:r.socket.ordinal,direction:r.direction,messageOrdinal:r.ordinal,eventOrdinal:r.eventOrdinal,typeCategory:r.type,
          pingOrdinal:r.ping?.pingOrdinal ?? null,
          membership:membership(r),phase:r.phase,interval:r.after === null ? null : [r.before,r.after],localStateAttributionExact:r.localExact,
          sendReturned:side === 'worker' && r.direction === 'client_to_server' || side === 'collector' && r.direction === 'server_to_client' ? r.complete : null,
          channelProofExact:r.event?.proofExact ?? null,
          decisionComplete:r.event ? r.event.validated : null,currentAccepted:side === 'worker' && r.event ? r.event.currentAccepted : null})),
        pings:pings.map(p => ({connectionOrdinal:p.socket.ordinal,pingOrdinal:p.pingOrdinal,pingAt:p.pingAt,clientMessageOrdinal:p.row.ordinal,
          serverMessageOrdinal:p.pong?.ordinal ?? null,sendReturned:p.sendReturned,pongRawComplete:p.pongRawComplete,
          productPongProcessed:p.productPongProcessed,localPongLabelMatched:p.localPongLabelMatched}))};
    }
    return Object.freeze({sink:guarded,snapshot,dispose() { if (disposed) return; fail('disposed'); disposed = true;
      for (const r of rows) { r.projection = null; r.event = null; }
      for (const s of sockets.values()) { s.events.length = 0; s.expectation = null; s.ref = s.authRef = null; }
      events.length = 0; acknowledgments.clear(); expectations = new WeakMap(); sockets.clear(); pingLabels.clear(); }});
  }
  return Object.freeze({createChannelCapture});
});
