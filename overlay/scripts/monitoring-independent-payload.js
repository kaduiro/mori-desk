/* SPDX-License-Identifier: AGPL-3.0-only */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoriIndependentPayload = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  // Development only. Callers must project in the existing owner first. This
  // codec neither imports a product validator nor accepts metadata/proof text.
  const limits = Object.freeze({ sample: 4096, event: 4096, row: 8192, envelope: 65536, depth: 8 });
  const SCOPE = Object.freeze(['kind','viewEpoch','bindingEpoch','samplingEpoch','workerEpoch','leaseId','documentId','startUnobserved']);
  const SAMPLE = Object.freeze(['type','v','pageInstanceId','contentSequence','observedAt','status','generationToken','outcome',
    'workerEpoch','leaseId','bindingEpoch','scopeKind','viewEpoch','samplingEpoch','startUnobserved']);
  const EVENT = Object.freeze(['type','v','schema','eventId','browserRunId','sessionId','sequence','kind','provider','tabId',
    'pageInstanceId','routeRevision','conversationRef','turnId','generation','phase','outcome','observation','observedAt','replay','scope','gap']);
  const ACK = Object.freeze(['type','schema','eventId','browserRunId','sessionId','sequence','disposition','duplicate','proofPresent','reason']);
  const NACK = Object.freeze(['type','schema','eventId','browserRunId','sessionId','sequence','reason']);
  const forbidden = new Set(['conversationTitle','requestPreview','proof','__proto__','constructor','prototype']);
  const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  const uint = value => Number.isSafeInteger(value) && value >= 0;
  const positive = value => uint(value) && value > 0;
  const one = (value, values) => values.includes(value);
  const provider = value => one(value, ['chatgpt','claude']);
  const kind = value => one(value, ['view','conversation']);
  const outcome = value => one(value, [null,'unverified','interrupted','error']);
  function dictionary(value, keys, required = keys) {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const proto = Object.getPrototypeOf(value);
      if (proto !== null && proto !== Object.prototype) return null;
      const names = Reflect.ownKeys(value);
      if (names.length > 64 || names.some(k => typeof k !== 'string' || k.length > 64 || forbidden.has(k) || !keys.includes(k))) return null;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (required.some(k => !Object.hasOwn(descriptors,k)) || names.some(k => !Object.hasOwn(descriptors[k],'value'))) return null;
      return Object.fromEntries(names.map(k => [k,descriptors[k].value]));
    } catch (_) { return null; }
  }
  function arrayOf(value, cap) {
    try {
      if (!Array.isArray(value) || !uint(cap) || cap > 16384) return null;
      const length = Object.getOwnPropertyDescriptor(value,'length')?.value;
      if (!uint(length) || length > cap || Reflect.ownKeys(value).length !== length + 1) return null;
      const d = Object.getOwnPropertyDescriptors(value);
      const out = [];
      for (let i=0;i<length;i++) {
        if (!d[i] || !Object.hasOwn(d[i],'value')) return null;
        out.push(d[i].value);
      }
      return out;
    } catch (_) { return null; }
  }
  function safeClone(value) {
    let nodes = 0;
    const active = new Set();
    function visit(v, depth) {
      if (++nodes > 8192 || depth > limits.depth) throw new Error();
      if (v === null || typeof v === 'boolean') return v;
      if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) return v;
      if (typeof v === 'string' && v.length <= 512) return v;
      if (!v || typeof v !== 'object' || active.has(v)) throw new Error();
      active.add(v);
      let result;
      if (Array.isArray(v)) {
        const a = arrayOf(v, 16384); if (!a) throw new Error();
        result = a.map(atom => visit(atom,depth+1));
      } else {
        const names = Reflect.ownKeys(v);
        const d = dictionary(v,names);
        if (!d) throw new Error();
        result = Object.fromEntries(Object.keys(d).sort().map(k => [k,visit(d[k],depth+1)]));
      }
      active.delete(v);
      return Object.freeze(result);
    }
    try { return visit(value,0); } catch (_) { return undefined; }
  }
  function withinBytes(value, cap) {
    if (!positive(cap) || cap > limits.envelope) return false;
    const clone = safeClone(value);
    if (clone === undefined) return false;
    try { return new TextEncoder().encode(JSON.stringify(clone)).byteLength <= cap; } catch (_) { return false; }
  }
  // null is not a validated payload. Callers must not turn two parse failures
  // into a successful comparison.
  function equal(a,b) {
    if (a === null || b === null || a === undefined || b === undefined) return false;
    const left = safeClone(a), right = safeClone(b);
    return left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right);
  }
  function finish(value, cap = limits.event) {
    if (!value || !withinBytes(value,cap)) return null;
    return safeClone(value) ?? null;
  }
  function scopeOf(value) {
    const s = dictionary(value,SCOPE);
    return s && kind(s.kind) && typeof s.startUnobserved === 'boolean'
      && SCOPE.filter(k => !['kind','startUnobserved'].includes(k)).every(k => id(s[k])) ? finish(s) : null;
  }
  function sampleOf(value) {
    const s = dictionary(value,SAMPLE);
    if (!s || s.type !== 'mori.observation' || s.v !== 2
      || !['pageInstanceId','workerEpoch','leaseId','bindingEpoch','viewEpoch','samplingEpoch'].every(k => id(s[k]))
      || !positive(s.contentSequence) || !positive(s.observedAt) || !kind(s.scopeKind)
      || typeof s.startUnobserved !== 'boolean' || !one(s.status,['idle','running','settled','unknown'])
      || s.generationToken !== null && !id(s.generationToken) || !outcome(s.outcome)
      || ['running','settled'].includes(s.status) && s.generationToken === null
      || (s.status === 'settled' ? s.outcome === null : s.outcome !== null)) return null;
    return finish(s,limits.sample);
  }
  function reference(value,p) {
    return value === null || typeof value === 'string' && (p === 'chatgpt'
      ? /^\/c\/[A-Za-z0-9-]{1,128}$/ : /^\/chat\/[A-Za-z0-9-]{1,128}$/).test(value);
  }
  function routeOf(value) {
    const r = dictionary(value,['provider','kind','conversationRef']);
    return r && provider(r.provider) && kind(r.kind) && reference(r.conversationRef,r.provider)
      && (r.kind === 'view' ? r.conversationRef === null : r.conversationRef !== null) ? finish(r) : null;
  }
  function contextOf(value) {
    const c = dictionary(value,['tabId','documentId','route','scope']);
    const r = c && routeOf(c.route), s = c && scopeOf(c.scope);
    return c && uint(c.tabId) && id(c.documentId) && r && s && c.documentId === s.documentId && r.kind === s.kind
      ? finish({...c,route:r,scope:s}) : null;
  }
  function senderOf(value) {
    const s = dictionary(value,['tabId','documentId','provider','frameId','lifecycle']);
    return s && uint(s.tabId) && id(s.documentId) && provider(s.provider) && s.frameId === 0
      && one(s.lifecycle,['active','unknown']) ? finish(s) : null;
  }
  function eventOf(value) {
    const e = dictionary(value,EVENT), s = e && scopeOf(e.scope);
    if (!e || !s || e.type !== 'scope.event' || e.v !== 1 || e.schema !== 2
      || !['eventId','browserRunId','sessionId','pageInstanceId'].every(k => id(e[k]))
      || !positive(e.sequence) || !positive(e.observedAt) || !['tabId','routeRevision','generation'].every(k => uint(e[k]))
      || !one(e.kind,['observation','terminal','gap','closed']) || !provider(e.provider)
      || !reference(e.conversationRef,e.provider) || (s.kind === 'view' ? e.conversationRef !== null : e.conversationRef === null)
      || e.turnId !== null && !id(e.turnId) || !one(e.phase,['idle','running','settled']) || !outcome(e.outcome)
      || !one(e.observation,['fresh','stale','closed','unsupported']) || typeof e.replay !== 'boolean'
      || e.phase === 'running' && (e.turnId === null || e.generation < 1 || e.outcome !== null)
      || e.kind === 'terminal' && (e.phase !== 'settled' || e.turnId === null || e.generation < 1 || e.outcome === null)
      || e.kind === 'closed' && e.observation !== 'closed') return null;
    let gap = null;
    if (e.kind === 'gap') {
      gap = dictionary(e.gap,['turnId','reason','observedAt']);
      if (!gap || !id(gap.turnId) || gap.turnId !== e.turnId || !one(gap.reason,['start_unobserved','sampling_gap','scope_lost'])
        || !positive(gap.observedAt) || gap.observedAt !== e.observedAt || e.observation === 'fresh') return null;
    } else if (e.gap !== null) return null;
    return finish({...e,scope:s,gap});
  }
  function ackOf(value) {
    const a = dictionary(value,ACK);
    return a && a.type === 'scope.event.ack' && a.schema === 2
      && ['eventId','browserRunId','sessionId'].every(k => id(a[k])) && positive(a.sequence)
      && one(a.disposition,['committed_current','committed_receipt','duplicate_durable','ignored_order'])
      && typeof a.duplicate === 'boolean' && typeof a.proofPresent === 'boolean'
      && one(a.reason,[null,'desktop_capacity']) && (!a.proofPresent || a.disposition === 'committed_current') ? finish(a) : null;
  }
  function nackOf(value) {
    const n = dictionary(value,NACK);
    return n && n.type === 'scope.event.nack' && n.schema === 2
      && ['eventId','browserRunId','sessionId'].every(k => id(n[k])) && positive(n.sequence)
      && one(n.reason,['session_limit','receipt_limit','active_session_limit','session_store_write_failed']) ? finish(n) : null;
  }
  return Object.freeze({ limits, dictionary, arrayOf, scopeOf, sampleOf, eventOf, routeOf, contextOf, senderOf, ackOf, nackOf, equal, withinBytes });
});
