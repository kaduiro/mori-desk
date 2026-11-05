/*
 * Independent P0 measurement component. No product module or fixture is used.
 * DOM rules: docs/provider-dom-2026-10-25-ja.md and fixed plan v4.
 * ACK/storage grammar: the separately supplied normative v2 contract.
 * This is measurement-component implementation, not final independent product
 * acceptance. Polls/MO callbacks NEVER certify uninterrupted physical DOM state.
 * Route contract: HTTPS, no URL credentials, default HTTPS port only; exact hosts
 * chatgpt.com/www.chatgpt.com/chat.openai.com or claude.ai/www.claude.ai.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MoriIndependentWitness = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCOPE_KEYS = Object.freeze(['kind', 'viewEpoch', 'bindingEpoch',
    'samplingEpoch', 'workerEpoch', 'leaseId', 'documentId', 'startUnobserved']);
  const UNKNOWN = new Set(['explicit_unknown', 'mutation_batch', 'visibility_changed',
    'sample_gap', 'clock_discontinuity', 'observer_unavailable', 'disposed']);
  const STOP_LABELS = new Set(['stop', 'stop generating', 'stop streaming',
    '停止', '生成を停止', '応答を停止', '回答を停止']);

  function plain(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  }
  function own(value, key) {
    if (!plain(value)) throw new Error('invalid_record');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('invalid_record');
    return descriptor.value;
  }
  function atom(value) {
    return (typeof value === 'string' && value.length > 0 && value.length <= 2048) ||
      (Number.isSafeInteger(value) && value >= 0);
  }
  function id(value) { return typeof value === 'string' && value.length > 0 && value.length <= 2048; }
  function wireId(value) {
    return typeof value === 'string' && value.length >= 1 && value.length <= 128 && !/[^A-Za-z0-9_-]/.test(value);
  }
  function positive(value) { return Number.isSafeInteger(value) && value > 0; }
  function nonnegative(value) { return Number.isSafeInteger(value) && value >= 0; }
  function exactKeys(value, keys) {
    return plain(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
  }
  function validScope(scope) {
    if (!exactKeys(scope, SCOPE_KEYS)) return false;
    const kind = own(scope, 'kind');
    if (kind !== 'view' && kind !== 'conversation') return false;
    if (typeof own(scope, 'startUnobserved') !== 'boolean') return false;
    for (const key of SCOPE_KEYS.slice(1, -1)) {
      const value = own(scope, key);
      if (!wireId(value)) return false;
    }
    return true;
  }
  function sameScope(a, b) {
    return validScope(a) && validScope(b) && SCOPE_KEYS.every(k => own(a, k) === own(b, k));
  }

  function all(node, selector) { return Array.from(node.querySelectorAll(selector)); }
  function attribute(node, name) { return node.getAttribute(name); }
  function visible(node, document, contents) {
    if (!node || node.isConnected === false || attribute(node, 'hidden') !== null) return false;
    for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
      const ancestorStyle = document.defaultView.getComputedStyle(ancestor);
      if (attribute(ancestor, 'hidden') !== null || attribute(ancestor, 'aria-hidden') === 'true' ||
        ancestorStyle.display === 'none' || ancestorStyle.visibility === 'hidden' ||
        ancestorStyle.visibility === 'collapse' || ancestorStyle.contentVisibility === 'hidden' ||
        (ancestorStyle.opacity !== undefined && Number(ancestorStyle.opacity) === 0)) return false;
    }
    const style = document.defaultView.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (node.getClientRects().length > 0) return true;
    return Boolean(contents && style.display === 'contents' &&
      Array.from(node.children).some(child => visible(child, document, true)));
  }
  function visibleAll(node, selector, document, contents = false) {
    return all(node, selector).filter(e => visible(e, document, contents));
  }
  function within(node, container) { return node === container || container.contains(node); }
  function nestedPanel(node, owner) {
    for (let p = node; p && p !== owner; p = p.parentElement) {
      if (p.localName === 'aside' || attribute(p, 'role') === 'dialog') return true;
    }
    return false;
  }
  function stops(node, owner, document) {
    return visibleAll(node, 'button', document).filter(button =>
      !nestedPanel(button, owner) && STOP_LABELS.has((attribute(button, 'aria-label') || '').trim().toLowerCase()));
  }
  function route(provider, url) {
    const parsed = new URL(url);
    // URL normalizes explicit :443 to an empty port. No raw URL is exported.
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.port !== '') {
      throw new Error('unsupported_route');
    }
    const host = parsed.hostname.toLowerCase();
    if (provider === 'chatgpt' && (host === 'chatgpt.com' || host === 'www.chatgpt.com' || host === 'chat.openai.com')) {
      return { raw: parsed.href, conversation: parsed.pathname.match(/(?:^|\/)c\/([A-Za-z0-9_-]+)\/?$/)?.[1] || null };
    }
    if (provider === 'claude' && (host === 'claude.ai' || host === 'www.claude.ai')) {
      return { raw: parsed.href, conversation: parsed.pathname.match(/^\/chat\/([A-Za-z0-9_-]+)\/?$/)?.[1] || null };
    }
    throw new Error('unsupported_route');
  }
  function structuralUnknown(reason, counts = {}) {
    return { reason, counts, scopeKind: 'unknown', state: 'unknown', identity: null };
  }

  function inspectChatGPT(document, currentRoute) {
    const mains = visibleAll(document, 'main,[role="main"]', document);
    const counts = { main: mains.length, display: 0, composer: 0, editor: 0, form: 0, stop: 0, busy: 0 };
    if (mains.length !== 1) return structuralUnknown('main_not_unique', counts);
    const main = mains[0];
    const displays = visibleAll(main, '[data-chatgpt-conversation-selection-target]', document, true);
    if (attribute(main, 'data-chatgpt-conversation-selection-target') !== null) displays.unshift(main);
    const composers = visibleAll(main, '[data-map-composer-conversation]', document, true);
    counts.display = displays.length; counts.composer = composers.length;
    if (displays.length !== 1 || composers.length !== 1) return structuralUnknown('owner_not_unique', counts);
    const display = displays[0]; const composer = composers[0];
    const owner = attribute(display, 'data-chatgpt-conversation-selection-target');
    const composerOwner = attribute(composer, 'data-map-composer-conversation');
    if (!owner || owner !== composerOwner || nestedPanel(display, main) || nestedPanel(composer, main)) {
      return structuralUnknown('owner_mismatch', counts);
    }
    const editors = visibleAll(composer, '[contenteditable="true"],textarea', document);
    counts.editor = editors.length;
    if (editors.length !== 1) return structuralUnknown('editor_not_unique', counts);
    let form = editors[0].parentElement;
    while (form && form !== main && form.localName !== 'form') form = form.parentElement;
    counts.form = form && form.localName === 'form' && within(form, main) ? 1 : 0;
    if (!counts.form || nestedPanel(editors[0], main)) return structuralUnknown('form_unconfirmed', counts);
    const messages = visibleAll(main, '[data-chatgpt-selection-conversation-id]', document, true);
    if (messages.some(message => attribute(message, 'data-chatgpt-selection-conversation-id') !== owner)) {
      return structuralUnknown('mixed_message_owner', counts);
    }
    const stop = stops(form, main, document);
    const busyCandidates = visibleAll(display, '[aria-busy="true"]', document);
    if (attribute(display, 'aria-busy') === 'true' && visible(display, document, false)) busyCandidates.unshift(display);
    const busy = busyCandidates.filter(e => !nestedPanel(e, main) && !within(e, form));
    counts.stop = stop.length; counts.busy = busy.length;
    if (stop.length > 1 || busy.length > 1) return structuralUnknown('generation_ambiguous', counts);
    const state = stop.length === 1 && busy.length === 1 ? 'running' :
      stop.length === 0 && busy.length === 0 ? 'quiet' : 'unknown';
    const canonical = currentRoute.conversation !== null && currentRoute.conversation === owner;
    if (!canonical && !owner.startsWith('local-chatgpt:')) return structuralUnknown('route_owner_mismatch', counts);
    return { reason: state === 'unknown' ? 'generation_marker_partial' : 'observed', counts,
      scopeKind: canonical ? 'conversation' : 'view', state,
      identity: [document, main, display, composer, editors[0], form, owner, currentRoute.raw] };
  }

  function inspectClaude(document, currentRoute) {
    const roots = visibleAll(document, '[data-testid="bardhub-claudechat-root"]', document);
    const counts = { root: roots.length, composer: 0, editor: 0, shield: 0, skeleton: 0, stop: 0, streaming: 0 };
    if (roots.length !== 1) return structuralUnknown('owner_not_unique', counts);
    const root = roots[0];
    counts.shield = visibleAll(document, '[data-testid="chat-stale-nav-shield"]', document).length;
    counts.skeleton = visibleAll(document, '[data-testid="chat-message-skeleton"]', document).length;
    if (counts.shield || counts.skeleton || attribute(root, 'data-hub-ready') !== '1' ||
      attribute(root, 'data-hub-awaiting-creation') !== '0') return structuralUnknown('loading_or_transition', counts);
    const composers = visibleAll(root, '[data-testid="chat-input"]', document);
    counts.composer = composers.length;
    if (composers.length !== 1) return structuralUnknown('composer_not_unique', counts);
    const composer = composers[0];
    counts.editor = attribute(composer, 'contenteditable') === 'true' && attribute(composer, 'role') === 'textbox' ? 1 : 0;
    if (!counts.editor || nestedPanel(composer, root)) return structuralUnknown('editor_unconfirmed', counts);
    const owner = attribute(root, 'data-conv-id');
    if (!owner || owner !== currentRoute.conversation) return structuralUnknown('route_owner_mismatch', counts);
    const stop = stops(root, root, document);
    const markers = visibleAll(root, '[data-is-streaming]', document).filter(e => !nestedPanel(e, root) && !within(e, composer));
    if (markers.some(e => !['true', 'false'].includes(attribute(e, 'data-is-streaming')))) {
      return structuralUnknown('generation_marker_unknown', counts);
    }
    counts.stop = stop.length;
    counts.streaming = markers.filter(e => attribute(e, 'data-is-streaming') === 'true').length;
    if (counts.stop > 1 || counts.streaming > 1) return structuralUnknown('generation_ambiguous', counts);
    const state = counts.stop === 1 && counts.streaming === 1 ? 'running' :
      counts.stop === 0 && counts.streaming === 0 ? 'quiet' : 'unknown';
    return { reason: state === 'unknown' ? 'generation_marker_partial' : 'observed', counts,
      scopeKind: 'conversation', state, identity: [document, root, composer, owner, currentRoute.raw] };
  }

  function createStructureReader(options) {
    const { provider, document, readRoute, clock } = options || {};
    if (!['chatgpt', 'claude'].includes(provider) || !document || typeof readRoute !== 'function' || typeof clock !== 'function') {
      throw new TypeError('witness_options_invalid');
    }
    const maxGap = options.maxSampleGapMs === undefined ? 15000 : options.maxSampleGapMs;
    if (!Number.isFinite(maxGap) || maxGap <= 0) throw new TypeError('witness_options_invalid');
    let previous = null; let previousTime = null; let origin = null; let lastClock = null;
    let lastStructure = null; let routeFence = null;
    let pending = null; let disposed = false; let observer = null;
    const listeners = [];
    const nodeOrdinals = new WeakMap(), attestedOwners = new Map();
    let nextNodeOrdinal = 0, attestationOrdinal = 0;
    let lastAttestedOwner = null, attestedRouteFence = null;
    const nodeOrdinal = node => {
      if (!node || typeof node !== 'object') return null;
      if (!nodeOrdinals.has(node)) nodeOrdinals.set(node, ++nextNodeOrdinal);
      return nodeOrdinals.get(node);
    };
    const identityProjection = identity => options.privateAttestation === true && identity
      ? identity.map(value => value && typeof value === 'object' ? nodeOrdinal(value) : value) : identity;
    function markUnknown(category) {
      pending = UNKNOWN.has(category) ? category : 'explicit_unknown';
      previous = null;
    }
    function listen(target, name, fn) {
      if (target && typeof target.addEventListener === 'function') {
        target.addEventListener(name, fn); listeners.push([target, name, fn]);
      }
    }
    if (options.observeMutations !== false) {
      const Observer = document.defaultView?.MutationObserver;
      if (typeof Observer === 'function') {
        try {
          observer = new Observer(() => markUnknown('mutation_batch'));
          observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
        } catch { markUnknown('observer_unavailable'); }
      } else markUnknown('observer_unavailable');
      listen(document, 'visibilitychange', () => markUnknown('visibility_changed'));
      listen(document.defaultView, 'resize', () => markUnknown('visibility_changed'));
    }
    function readClock() {
      let value;
      try { value = clock(); } catch {
        markUnknown('clock_discontinuity'); throw new Error('clock');
      }
      if (!Number.isFinite(value) || value < 0 || (lastClock !== null && value < lastClock) ||
        (origin !== null && value < origin)) {
        markUnknown('clock_discontinuity'); throw new Error('clock');
      }
      // Keep every successful boundary, even if DOM inspection or the end clock
      // later throws. A failed sample cannot erase the monotonic high-water mark.
      lastClock = value;
      return value;
    }
    function sample() {
      let start; let end; let result;
      try {
        start = readClock();
        if (origin === null) origin = start;
        if (previousTime !== null && start - previousTime > maxGap) markUnknown('sample_gap');
        if (disposed) result = structuralUnknown('disposed');
        else if (document.visibilityState !== 'visible') {
          markUnknown('visibility_changed'); result = structuralUnknown('document_not_visible');
        } else {
          const currentRoute = route(provider, readRoute());
          result = provider === 'chatgpt' ? inspectChatGPT(document, currentRoute) : inspectClaude(document, currentRoute);
          if (result.identity) result.identity = identityProjection(result.identity);
          if (result.identity) {
            const identity = result.identity;
            const ownerPart = identity.slice(0, -1);
            const equalOwner = other => other && ownerPart.length === other.length && ownerPart.every((v, i) => v === other[i]);
            if (lastStructure && lastStructure.at(-1) !== identity.at(-1) && equalOwner(lastStructure.slice(0, -1))) {
              routeFence = ownerPart;
            }
            lastStructure = identity;
            if (routeFence && equalOwner(routeFence)) result = structuralUnknown('route_transition_unconfirmed', result.counts);
            else routeFence = null;
          }
        }
        end = readClock();
      } catch {
        result = structuralUnknown(pending === 'clock_discontinuity' ? 'clock_discontinuity' : 'structure_unavailable');
        previous = null;
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) { start = null; end = null; }
      }
      const same = Boolean(!pending && previous && result.identity &&
        previous.length === result.identity.length && previous.every((v, i) => v === result.identity[i]));
      const uncertainty = pending;
      // Each sample is a snapshot. Neither repeated positives nor MutationObserver
      // callbacks establish the absence of intermediate/CSS-only transitions.
      previous = result.state === 'unknown' ? null : result.identity;
      if (Number.isFinite(end)) previousTime = end;
      pending = null;
      return Object.freeze({ provider, scopeKind: result.scopeKind, state: result.state,
        reason: result.reason, counts: Object.freeze(result.counts), sameScope: same,
        continuity: 'unknown', continuous1s: false, uncertainty,
        interval: start === null ? null : Object.freeze([start - origin, end - origin]) });
    }
    function attest(subject) {
      let before = null, after = null;
      const ordinal = ++attestationOrdinal;
      function unknown(reason = 'structure_unavailable', uncertainty = 'explicit_unknown') {
        return Object.freeze({ witnessSampleOrdinal: ordinal, ownerOrdinal: null, signal: 'unknown', scopeKind: 'unknown',
          ownerKey: null, conversationRef: null, ownerScopeMatch: null, uncertainty, reason, before, after });
      }
      try {
        if(!exactKeys(subject,['document','main','roots','form','key','kind','epoch','viewEpoch']))return unknown();
        subject=Object.fromEntries(Object.keys(subject).map(key=>[key,own(subject,key)]));
        if(!Array.isArray(subject.roots)||subject.roots.length>2)return unknown();
        const descriptors=Object.getOwnPropertyDescriptors(subject.roots);
        if(Reflect.ownKeys(descriptors).length!==subject.roots.length+1)return unknown();
        const copiedRoots=[];
        for(let index=0;index<subject.roots.length;index++){
          if(!descriptors[index]||!Object.hasOwn(descriptors[index],'value'))return unknown();
          copiedRoots.push(descriptors[index].value);
        }
        subject.roots=copiedRoots;
        before = readClock();
        if (disposed || document.visibilityState !== 'visible' || !subject || subject.document !== document) {
          after = readClock(); return unknown(disposed ? 'disposed' : 'document_not_visible', disposed ? 'disposed' : 'visibility_changed');
        }
        const current = route(provider, readRoute());
        const result = provider === 'chatgpt' ? inspectChatGPT(document, current) : inspectClaude(document, current);
        if (!result.identity || result.state === 'unknown') { after = readClock(); return unknown(result.reason, pending); }
        const identity = result.identity;
        const independentRoots = provider === 'chatgpt' ? [identity[2], identity[3]] : [identity[1]];
        const independentForm = provider === 'chatgpt' ? identity[5] : null;
        const claudeMains=provider==='claude'?visibleAll(document,'main',document):null;
        if(claudeMains && claudeMains.length!==1){after=readClock();return unknown('main_not_unique');}
        const independentMain = provider === 'chatgpt' ? identity[1] : claudeMains[0];
        const owner = provider === 'chatgpt' ? identity[6] : identity[3];
        const rawOwner = [...independentRoots.map(nodeOrdinal),nodeOrdinal(independentMain),nodeOrdinal(independentForm),owner];
        const ownerSignature = JSON.stringify(rawOwner);
        if (lastAttestedOwner && lastAttestedOwner.route !== current.raw && lastAttestedOwner.owner === ownerSignature) attestedRouteFence = ownerSignature;
        lastAttestedOwner = { route: current.raw, owner: ownerSignature };
        if (attestedRouteFence && attestedRouteFence !== ownerSignature) attestedRouteFence = null;
        after = readClock();
        if (pending || attestedRouteFence) return unknown(attestedRouteFence ? 'route_transition_unconfirmed' : result.reason, pending || 'explicit_unknown');
        const matches = subject.main === independentMain && subject.form === independentForm && subject.key === owner
          && subject.kind === result.scopeKind && Array.isArray(subject.roots) && subject.roots.length === independentRoots.length
          && independentRoots.every((node, index) => node === subject.roots[index]);
        if (!attestedOwners.has(ownerSignature)) {
          if (attestedOwners.size >= 256) return unknown();
          attestedOwners.set(ownerSignature, attestedOwners.size + 1);
        }
        return Object.freeze({ witnessSampleOrdinal: ordinal, ownerOrdinal: attestedOwners.get(ownerSignature), signal: result.state,
          scopeKind: result.scopeKind, ownerKey: owner, conversationRef: result.scopeKind === 'view' ? null
            : (provider === 'chatgpt' ? '/c/' : '/chat/') + current.conversation,
          ownerScopeMatch: matches, uncertainty: null, reason: result.reason, before, after });
      } catch { return unknown('structure_unavailable'); }
      // Neither a returned attestation nor deferred batch captures DOM nodes.
    }
    function dispose() {
      disposed = true; previous = null; previousTime = null; lastStructure = null; routeFence = null;
      attestedOwners.clear(); lastAttestedOwner = null; attestedRouteFence = null;
      if (observer) observer.disconnect(); observer = null;
      for (const [target, name, fn] of listeners.splice(0)) target.removeEventListener(name, fn);
    }
    return Object.freeze({ sample, attest, markUnknown, dispose });
  }

  function decodeAck(raw) {
    if (raw instanceof Uint8Array) {
      if (raw.byteLength > 16384) throw new Error('ack_schema_invalid');
      raw = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    }
    if (typeof raw !== 'string' || raw.length > 16384) throw new Error('ack_schema_invalid');
    const ack = JSON.parse(raw);
    const common = ['type', 'schema', 'eventId', 'browserRunId', 'sessionId', 'sequence'];
    const type = own(ack, 'type');
    if (type === 'scope.event.nack') {
      if (!exactKeys(ack, [...common, 'reason']) || typeof own(ack, 'reason') !== 'string') throw new Error('ack_schema_invalid');
    } else if (type === 'scope.event.ack') {
      if (!exactKeys(ack, [...common, 'disposition', 'duplicate', 'proof', 'reason'])) throw new Error('ack_schema_invalid');
      if (!['committed_current', 'committed_receipt', 'duplicate_durable', 'ignored_order'].includes(own(ack, 'disposition')) ||
        typeof own(ack, 'duplicate') !== 'boolean' ||
        (own(ack, 'proof') !== null && !wireId(own(ack, 'proof'))) ||
        ![null, 'desktop_capacity'].includes(own(ack, 'reason'))) throw new Error('ack_schema_invalid');
    } else throw new Error('ack_schema_invalid');
    if (own(ack, 'schema') !== 2 || !['eventId', 'browserRunId', 'sessionId'].every(k => wireId(own(ack, k))) ||
      !positive(own(ack, 'sequence'))) throw new Error('ack_schema_invalid');
    return ack;
  }
  function parseSnapshot(value) {
    if (typeof value === 'string') {
      if (value.length > 8 * 1024 * 1024) throw new Error('snapshot_invalid');
      value = JSON.parse(value);
    }
    if (own(value, 'version') !== 2 || !Array.isArray(own(value, 'sessions')) || !Array.isArray(own(value, 'receipts')) ||
      own(value, 'sessions').length > 200 || own(value, 'receipts').length > 4096) throw new Error('snapshot_invalid');
    return value;
  }
  function validEvent(event) {
    if (own(event, 'type') !== 'scope.event' || own(event, 'v') !== 1 || own(event, 'schema') !== 2) return false;
    const strings = ['eventId', 'browserRunId', 'sessionId', 'pageInstanceId'];
    if (!strings.every(k => wireId(own(event, k))) || !['chatgpt', 'claude'].includes(own(event, 'provider')) ||
      !atom(own(event, 'tabId')) || !nonnegative(own(event, 'routeRevision')) ||
      !positive(own(event, 'sequence')) || !nonnegative(own(event, 'generation')) ||
      !nonnegative(own(event, 'observedAt')) || typeof own(event, 'replay') !== 'boolean' ||
      !validScope(own(event, 'scope'))) return false;
    if (!['observation', 'terminal', 'gap', 'closed'].includes(own(event, 'kind'))) return false;
    if (!['idle', 'running', 'settled'].includes(own(event, 'phase'))) return false;
    const turn = own(event, 'turnId'); const ref = own(event, 'conversationRef');
    if (turn !== null && !wireId(turn)) return false;
    if (own(own(event, 'scope'), 'kind') === 'view' ? ref !== null : !id(ref)) return false;
    return own(event, 'outcome') === null || ['unverified', 'interrupted', 'error'].includes(own(event, 'outcome'));
  }
  function intervalOrder(intervals) {
    const points = ['durable', 'ackSent', 'ackFrame', 'ackValidated'].map(k => own(intervals, k));
    if (!points.every(p => id(own(p, 'clockGeneration')) && Number.isFinite(own(p, 'start')) &&
      Number.isFinite(own(p, 'end')) && own(p, 'start') >= 0 && own(p, 'end') >= own(p, 'start'))) return null;
    if (!points.every(p => own(p, 'clockGeneration') === own(points[0], 'clockGeneration'))) return null;
    if (points.some((p, i) => i > 0 && own(points[i - 1], 'end') > own(p, 'start'))) return null;
    return Object.freeze([own(points[3], 'start') - own(points[0], 'end'),
      own(points[3], 'end') - own(points[0], 'start')]);
  }

  /* The caller supplies independently authenticated capture/context and independent
   * read-only durable evidence. This decoder does NOT authenticate a connection,
   * perform IO, inspect arbitrary files, or make product hooks into true evidence.
   * intervals.durable must enclose independently witnessed durability, not a later
   * snapshot timestamp relabelled as commit. ackSent must independently bound the
   * actual send, not the later receive: delayed delivery can hide a premature ACK.
   * Missing send evidence makes pass/current false even if the row matches.
   * A receipt-only record lacks a binding for the full historical event payload;
   * committed_receipt stays receipt_identity_unverified, never durable/store true.
   * All identifiers remain in memory. `pass` is only this ACK-evidence contract;
   * formalAcceptance is ALWAYS false (no provider deadline/DOM/UI acceptance).
   */
  function createAckWitness(options = {}) {
    const limit = options.maxEntries === undefined ? 4096 : options.maxEntries;
    if (!positive(limit) || limit > 65536) throw new TypeError('witness_options_invalid');
    const seen = new Set(); let disposed = false;
    function answer(category, extra = {}) {
      return Object.freeze({ category, current: false, pass: false, terminalDurable: false,
        eventMatched: false, connectionMatched: false, scopeMatched: false,
        storeMatched: false, orderProven: false, formalAcceptance: false, ...extra });
    }
    function inspect(input) {
      if (disposed) return answer('disposed');
      let ack; let event; let context; let snapshot;
      try { ack = decodeAck(input.wireAck); } catch { return answer('ack_schema_invalid'); }
      try {
        event = input.expectedEvent; context = input.context;
        if (!validEvent(event)) return answer('expected_event_invalid');
        if (own(context, 'authenticated') !== true || own(context, 'independentWire') !== true ||
          own(context, 'independentStore') !== true) return answer('independent_evidence_unavailable');
        if (!id(own(context, 'clientId')) || !id(own(context, 'connectionId')) ||
          own(context, 'connectionId') !== own(context, 'currentConnectionId') ||
          !id(own(context, 'serverRunId')) || own(context, 'serverRunId') !== own(context, 'currentServerRunId') ||
          own(context, 'browserRunId') !== own(event, 'browserRunId')) return answer('connection_mismatch');
      } catch { return answer('expected_context_invalid'); }
      const matched = ['eventId', 'browserRunId', 'sessionId', 'sequence'].every(k => own(ack, k) === own(event, k));
      if (!matched) return answer('event_mismatch', { connectionMatched: true });
      const base = { eventMatched: true, connectionMatched: true };
      if (own(ack, 'type') === 'scope.event.nack') return answer('nack', base);
      const key = JSON.stringify([own(context, 'clientId'), own(event, 'browserRunId'),
        own(event, 'sessionId'), own(event, 'eventId'), own(event, 'sequence')]);
      if (seen.has(key)) return answer('repeated_wire_ack', base);
      if (seen.size >= limit) return answer('witness_capacity', base);
      // A first ACK with insufficient evidence must not become a new successful
      // observation when the same frame is seen again after storage catches up.
      // Assemble evidence before inspect; offline re-analysis uses a fresh witness.
      seen.add(key);
      if (own(event, 'replay') || own(ack, 'duplicate') ||
        ['duplicate_durable', 'ignored_order'].includes(own(ack, 'disposition'))) return answer('noncurrent_ack', base);
      try { snapshot = parseSnapshot(input.persistedSnapshot); } catch { return answer('snapshot_invalid', base); }
      try {
        const rows = own(snapshot, 'sessions').filter(row => own(row, 'clientId') === own(context, 'clientId') &&
          own(row, 'browserRunId') === own(event, 'browserRunId') && own(row, 'sessionId') === own(event, 'sessionId'));
        if (rows.length !== 1 || !id(own(rows[0], 'id'))) return answer('row_not_unique', base);
        const row = rows[0];
        const terminal = own(event, 'kind') === 'terminal';
        const eventReceipts = own(snapshot, 'receipts').filter(r => own(r, 'eventId') === own(event, 'eventId'));
        // Rows do not store event kind. A terminal receipt is contradictory
        // evidence for a claimed observation, even when all row fields match.
        if (!terminal && eventReceipts.length !== 0) return answer('event_kind_conflict', base);
        let receipt = false;
        if (terminal) {
          const receipts = eventReceipts.filter(r => own(r, 'id') === own(row, 'id'));
          receipt = receipts.length === 1 && ['turnId', 'generation', 'observedAt', 'outcome'].every(k =>
            own(receipts[0], k) === own(event, k)) && positive(own(receipts[0], 'noticeSequence')) &&
            own(event, 'phase') === 'settled' && own(event, 'outcome') !== null;
          if (!receipt) return answer('terminal_receipt_missing', base);
        }
        let order = null;
        try { order = intervalOrder(input.intervals); } catch { /* Missing endpoints stay unverified. */ }
        if (own(ack, 'disposition') === 'committed_receipt') {
          if (!terminal || own(ack, 'proof') !== null || own(ack, 'reason') !== null) return answer('receipt_ack_invalid', base);
          // EventId + receipt turn/time/outcome do not bind provider/tab/scope or
          // the remaining historical payload. Do not infer these from today's row.
          return answer('receipt_identity_unverified', base);
        }
        if (own(event, 'kind') !== 'observation' && !terminal) return answer('event_not_current_observation', base);
        const scope = own(event, 'scope');
        const scopesMatch = sameScope(scope, own(context, 'scope')) && sameScope(scope, own(row, 'scope'));
        if (!scopesMatch) return answer('scope_mismatch', base);
        const rowFields = [['provider', 'provider'], ['tabId', 'tabId'], ['pageInstanceId', 'pageInstanceId'], ['routeRevision', 'routeRevision'],
          ['conversationRef', 'conversationRef'], ['currentTurnId', 'turnId'], ['generation', 'generation'],
          ['lastSequence', 'sequence'], ['lastObservationAt', 'observedAt'], ['phase', 'phase'],
          ['outcome', 'outcome'], ['observation', 'observation'], ['acceptedEventId', 'eventId']];
        const stored = own(row, 'retired') === false && rowFields.every(([a, b]) => own(row, a) === own(event, b));
        const checked = { ...base, scopeMatched: true };
        if (!stored) return answer('store_mismatch', checked);
        if (own(event, 'observedAt') === 0 || own(event, 'observation') !== 'fresh' ||
          !wireId(own(ack, 'proof')) || own(ack, 'reason') !== null) return answer('current_proof_unavailable', checked);
        if (!order) return answer('order_unverified', { ...checked, storeMatched: true, terminalDurable: receipt });
        return answer('current', { ...checked, current: true, pass: true, terminalDurable: receipt,
          storeMatched: true, orderProven: true, durableToValidationInterval: order });
      } catch { return answer('snapshot_or_interval_invalid', base); }
    }
    return Object.freeze({ inspect, dispose() { disposed = true; seen.clear(); } });
  }
  // Supplemental inventory only. These candidate structures do not establish
  // conversation ownership and never change the reader's state/continuity.
  function inspectStructureInventory({ provider, document, readRoute } = {}) {
    if (!['chatgpt', 'claude'].includes(provider) || !document || typeof readRoute !== 'function')
      throw new Error('structure_inventory_configuration');
    const href = readRoute(), current = route(provider, href), url = new URL(href);
    const candidates = {
      main: ['main,[role="main"]'], form: ['form'], editable: ['[contenteditable="true"],textarea'],
      textbox: ['[role="textbox"]'], prompt: ['#prompt-textarea,[data-testid="prompt-textarea"]'],
      stop: ['button[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop response"],button[aria-label="停止"],button[aria-label="生成を停止"]'],
      busy: ['[aria-busy="true"]'], streaming: ['[data-is-streaming="true"]'],
      assistantMarker: ['[data-message-author-role="assistant"],[data-testid="assistant-message"]'],
      conversationTurn: ['[data-testid^="conversation-turn-"]'],
      chatgptOwner: ['[data-chatgpt-conversation-selection-target]', 'data-chatgpt-conversation-selection-target'],
      chatgptComposerOwner: ['[data-map-composer-conversation]', 'data-map-composer-conversation'],
      chatgptMessageOwner: ['[data-chatgpt-selection-conversation-id]', 'data-chatgpt-selection-conversation-id'],
      claudeHubRoot: ['[data-testid="bardhub-claudechat-root"]', 'data-conv-id'],
      claudeInput: ['[data-testid="chat-input"]'],
      conversationId: ['[data-conversation-id]', 'data-conversation-id'],
      chatId: ['[data-chat-id]', 'data-chat-id'], threadId: ['[data-thread-id]', 'data-thread-id'],
      canonical: ['link[rel="canonical"]'],
    };
    const counts = {};
    for (const [name, [selector, ownerAttribute]] of Object.entries(candidates)) {
      const found = all(document, selector), sample = found.slice(0, 200);
      let matching = 0;
      if (ownerAttribute && current.conversation)
        matching = sample.filter(node => attribute(node, ownerAttribute) === current.conversation).length;
      if (name === 'canonical') matching = sample.filter(node => {
        try {
          const target = new URL(attribute(node, 'href'), url);
          return !target.username && !target.password && target.origin === url.origin && target.pathname === url.pathname;
        } catch (_) { return false; }
      }).length;
      counts[name] = { found: sample.length, visible: sample.filter(node => visible(node, document, true)).length,
        matchesCurrentRoute: matching, capped: found.length > 200 };
    }
    return Object.freeze({ provider, routeKind: current.conversation ? 'conversation' : 'view',
      visible: document.visibilityState === 'visible', counts });
  }
  const defaultAckWitness = createAckWitness();
  return Object.freeze({ createStructureReader, createAckWitness, inspectStructureInventory,
    inspectAckEvidence: input => defaultAckWitness.inspect(input) });
});
