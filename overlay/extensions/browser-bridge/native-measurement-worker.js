/* SPDX-License-Identifier: AGPL-3.0-only */
(function(root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('../../scripts/monitoring-independent-payload') : root.MoriIndependentPayload,
    typeof module === 'object' && module.exports ? require('../../scripts/monitoring-independent-channel') : root.MoriIndependentChannel);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoriNativeMeasurementWorker = api;
})(typeof globalThis === 'object' ? globalThis : this, function(payload, channelApi) {
  'use strict';
  let nextCaptureGeneration = 0;
  const ACK_GATES = ['control_generation_changed','credential_changed','proof_absent','disposition_not_current','replay',
    'session_not_current','transport_not_ready','connection_changed','lease_missing','lease_generation_changed','page_changed',
    'document_changed','lease_scope_changed','observation_not_fresh','sequence_changed','event_time_invalid','event_expired',
    'sample_time_invalid','sample_expired','accepted_current','unclassified'];
  // Development bundle only. This module is absent from the normal manifest.
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
  const SCOPE = ['kind','viewEpoch','bindingEpoch','samplingEpoch','workerEpoch','leaseId','documentId','startUnobserved'];
  const EVENT = ['browserRunId','sessionId','eventId','sequence','tabId','pageInstanceId','routeRevision','turnId','generation'];
  const OBSERVATION = ['contentSequence','pageInstanceId','generationToken','samplingEpoch','workerEpoch','leaseId',
    'bindingEpoch','viewEpoch','scopeKind','startUnobserved'];
  const COUNTS = ['main','display','composer','editor','form','stop','busy','root','shield','skeleton','streaming'];
  const DOM_REASONS = ['observed','main_not_unique','owner_not_unique','owner_mismatch','editor_not_unique','form_unconfirmed',
    'mixed_message_owner','generation_ambiguous','route_owner_mismatch','generation_marker_partial','loading_or_transition',
    'composer_not_unique','editor_unconfirmed','generation_marker_unknown','disposed','document_not_visible',
    'route_transition_unconfirmed','clock_discontinuity','structure_unavailable'];
  const UNCERTAINTIES = ['explicit_unknown','mutation_batch','visibility_changed','sample_gap','clock_discontinuity','observer_unavailable','disposed'];
  const REASONS = ['none','unknown',...DOM_REASONS,...UNCERTAINTIES,'scope_unconfirmed','ambiguous_scope','unsupported_route','unsupported_layout',
    'navigation_pending','initializing','loading','dom_unknown','running','quiet','scope_lost','sampling_gap',
    'reader_failed','capture_failed','invalid_fields','overflow','expired','clock_invalid','clock_changed','unclassified',...REGISTRATION_REASONS];
  function dictionary(value, keys, required = keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
    if (names.some(k => typeof k !== 'string' || !keys.includes(k) || !Object.hasOwn(descriptors[k], 'value'))
      || required.some(k => !Object.hasOwn(descriptors, k))) return null;
    return Object.fromEntries(names.map(k => [k, descriptors[k].value]));
  }
  function arrayOf(value, cap) {
    if (!Array.isArray(value)) return null;
    const length = Object.getOwnPropertyDescriptor(value,'length')?.value;
    if (!Number.isSafeInteger(length) || length > cap || length < 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== length + 1) return null;
    const copied = [];
    for (let i = 0; i < length; i++) {
      const d = descriptors[i]; if (!d || !Object.hasOwn(d,'value')) return null;
      copied.push(d.value);
    }
    return copied;
  }
  const number = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER;
  const integer = n => Number.isSafeInteger(n) && n >= 0;
  const id = n => typeof n === 'string' && ID.test(n);
  const key = value => JSON.stringify(value);
  function ownerProjection(value,fields,extras=[]) {
    if(!value||typeof value!=='object'||Array.isArray(value))return null;
    const prototype=Object.getPrototypeOf(value),descriptors=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(descriptors);
    if(prototype!==null&&prototype!==Object.prototype||fields.some(k=>!Object.hasOwn(descriptors,k))
      ||names.some(k=>typeof k!=='string'||![...fields,...extras].includes(k)||!Object.hasOwn(descriptors[k],'value')))return null;
    return Object.fromEntries(fields.map(k=>[k,descriptors[k].value]));
  }
  function scopeOf(value) {
    const s = dictionary(value, SCOPE);
    return s && ['view','conversation'].includes(s.kind) && typeof s.startUnobserved === 'boolean'
      && SCOPE.filter(k => !['kind','startUnobserved'].includes(k)).every(k => id(s[k])) ? s : null;
  }
  function eventOf(value, wire = false) {
    // Wire JSON is parsed into an ordinary dictionary. Copy only identity and
    // scope; identification text, proof bytes and URLs are never retained.
    const allowed = wire ? [...EVENT,'type','v','schema','kind','provider','conversationRef','phase','outcome',
      'observation','observedAt','replay','scope','gap','conversationTitle','requestPreview'] : [...EVENT,'kind','scope'];
    const safe=wire?ownerProjection(value,allowed.filter(k=>!['conversationTitle','requestPreview'].includes(k)),['conversationTitle','requestPreview']):value;
    const e = dictionary(safe, allowed, [...EVENT,'scope']);
    if (!e || !['browserRunId','sessionId','eventId','pageInstanceId'].every(k => id(e[k]))
      || !['sequence','tabId','routeRevision','generation'].every(k => integer(e[k]))
      || e.turnId !== null && !id(e.turnId)) return null;
    const scope = scopeOf(e.scope);
    if (!scope || wire && (e.type !== 'scope.event' || e.schema !== 2 || e.v !== 1)
      || e.kind !== undefined && !['observation','terminal','gap','closed'].includes(e.kind)) return null;
    return { ...Object.fromEntries(EVENT.map(k => [k,e[k]])), kind: e.kind || 'observation', scope };
  }
  function observationOf(value) {
    const o = dictionary(value, OBSERVATION);
    return o && integer(o.contentSequence) && o.contentSequence > 0
      && OBSERVATION.filter(k => !['contentSequence','generationToken','scopeKind','startUnobserved'].includes(k)).every(k => id(o[k]))
      && (o.generationToken === null || id(o.generationToken)) && ['view','conversation'].includes(o.scopeKind)
      && typeof o.startUnobserved === 'boolean' ? o : null;
  }
  function fieldsOf(value = {}) {
    const f = dictionary(value, ['status','reason','count','sameDocument','sameScope','sameConnection','missing'], []);
    if (!f || Object.keys(f).some(k => k === 'status' ? !['ok','pending','failed','unknown','missing','stale','closed'].includes(f[k])
      : k === 'reason' ? !REASONS.includes(f[k]) : k === 'count' ? !integer(f[k]) || f[k] > 1000000 : typeof f[k] !== 'boolean')) return null;
    return f;
  }
  function domOf(value) {
    const d = dictionary(value, ['provider','scopeKind','state','reason','counts','sameScope','continuity','continuous1s','uncertainty']);
    const counts = d && dictionary(d.counts, COUNTS, []);
    if (!d || !['chatgpt','claude'].includes(d.provider) || !['unknown','view','conversation'].includes(d.scopeKind)
      || !['unknown','running','quiet'].includes(d.state) || !DOM_REASONS.includes(d.reason)
      || !counts || Object.values(counts).some(n => !integer(n) || n > 1000000)
      || typeof d.sameScope !== 'boolean' || d.continuity !== 'unknown' || d.continuous1s !== false
      || d.uncertainty !== null && !UNCERTAINTIES.includes(d.uncertainty)) return null;
    return { ...d, counts };
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
  function attestationOf(value,provider) {
    const r=dictionary(value,['witnessSampleOrdinal','ownerOrdinal','signal','scopeKind','ownerKey','conversationRef','ownerScopeMatch','uncertainty','reason','before','after']);
    if(!r || !integer(r.witnessSampleOrdinal)||r.witnessSampleOrdinal<1||r.witnessSampleOrdinal>1000000
      || r.ownerOrdinal!==null&&(!integer(r.ownerOrdinal)||r.ownerOrdinal<1||r.ownerOrdinal>1000000)
      || !['running','quiet','unknown'].includes(r.signal)||!['conversation','view','unknown'].includes(r.scopeKind)
      || ![true,false,null].includes(r.ownerScopeMatch)||r.uncertainty!==null&&!UNCERTAINTIES.includes(r.uncertainty)
      || !DOM_REASONS.includes(r.reason)||!number(r.before)||!number(r.after)||r.after<r.before)return null;
    if(r.scopeKind==='unknown')return r.ownerKey===null&&r.conversationRef===null&&r.ownerOrdinal===null&&r.ownerScopeMatch===null?r:null;
    if(typeof r.ownerKey!=='string'||!r.ownerOrdinal)return null;
    if(r.scopeKind==='view')return provider==='chatgpt'&&/^local-chatgpt:[A-Za-z0-9-]{1,128}$/.test(r.ownerKey)&&r.conversationRef===null?r:null;
    return /^[A-Za-z0-9-]{1,128}$/.test(r.ownerKey)&&r.conversationRef===(provider==='chatgpt'?'/c/':'/chat/')+r.ownerKey?r:null;
  }
  const SERIES_REASONS = ['none','pending','matched','mismatch','missing_hook','input_conflict','invocation_missing','event_conflict',
    'clone_unverified','send_unverified','pending_expired','stale_capture','ambiguous','namespace_changed','invalid_schema','capacity',
    'expired','disposed','metadata_excluded','non_sample_origin','transformed_payload','semantic_unavailable','proof_unavailable','proof_mismatch','capture_not_recording'];
  function createSeriesLedger({append,clock,onFailure}) {
    const ingresses = new Map(), dispatches = new Map(), invocations = new Map(), results = new Map(), commits = new Map(), events = new Map();
    const tokenTurns = new Map(), turnTokens = new Map(), pending = [];
    const counts = Object.fromEntries(['dispatches','ingresses','invocations','allocations','cloneEdges','wireEvents','acks','causalVerified','payloadVerified','contradictions'].map(k=>[k,0]));
    const reasons = Object.fromEntries(SERIES_REASONS.map(k=>[k,0]));
    let edgeOrdinal = 0, unknown = false, disposed = false;
    const inc = name => { counts[name] = Math.min(1000000,counts[name]+1); return counts[name]; };
    function failure(reason) { unknown = true; const key=SERIES_REASONS.includes(reason) ? reason : 'invalid_schema';
      reasons[key]=Math.min(1000000,reasons[key]+1);
      onFailure(reason); return null; }
    function reserve(map) { return map.size < 2048 || !!failure('capacity'); }
    const fullScope = scope => JSON.stringify(SCOPE.map(k=>scope[k]));
    function edge(kind,node,exact,reason='matched',wire=null) {
      if (pending.length >= 2048) return failure('capacity');
      const at = clock(); if (at === null) return null;
      pending.push({kind,node,exact,reason,wire,at}); resolve(); return true;
    }
    function resolve(force=false) {
      const now = clock(); if (now === null) return;
      for(let i=pending.length-1;i>=0;i--){
        const e=pending[i], input=e.node?.input, dispatch=input?.dispatch;
        if (input && !dispatch && !force && now-input.at<30000) continue;
        pending.splice(i,1);
        const available=!!dispatch && dispatch.eligible && input.matches === true;
        const owner = available ? dispatch.owner : null;
        const causal = e.node?.cause === true && available ? true : null;
        const outsideCapture = dispatch && input.matches === true && !dispatch.eligible
          && (dispatch.row.recording === false || dispatch.nonrecordingCause !== null)
          && dispatch.row.status === 'returned' && !!dispatch.row.observerInstallationOrdinal;
        const reason = !input ? 'non_sample_origin' : available ? e.reason : outsideCapture ? 'capture_not_recording'
          : dispatch ? 'missing_hook' : force && now-input.at<30000 ? 'disposed' : 'pending_expired';
        if(['pending_expired','disposed','missing_hook'].includes(reason))failure(reason);
        if(causal===true)inc('causalVerified');if(e.exact===true)inc('payloadVerified');
        if(e.exact===false && e.reason!=='transformed_payload'){inc('contradictions');failure('mismatch');}
        append({kind:'series_edge',edgeOrdinal:++edgeOrdinal,at:now,recording:available,
          edge:e.kind,dispatchOrdinal:dispatch?.row.dispatchOrdinal || null,ingressOrdinal:input?.ordinal || null,
          invocationOrdinal:e.node?.invocationOrdinal || null,allocationOrdinal:e.node?.allocationOrdinal || null,
          connectionOrdinal:e.wire?.connectionOrdinal || null,eventOrdinal:e.wire?.eventOrdinal || null,
          ownerScopeMatch:e.node?.subjectContradicted ? false : e.node?.sameScope === false ? null : owner,payloadExact:e.exact,causalExact:causal,
          proofExact:e.wire?.proofExact ?? null,reason});
      }
    }
    function match(input) {
      const matches=[...dispatches.values()].filter(d=>d.doc.tabId===input.sender.tabId && d.doc.documentId===input.sender.documentId
        && payload.equal(d.row.sample,input.sample));
      if(matches.length>1){failure('ambiguous');input.matches=null;return;}
      if(matches.length===1){const d=matches[0];
        const inputs=[...ingresses.values()].filter(other=>other.sender.tabId===input.sender.tabId&&other.sender.documentId===input.sender.documentId&&payload.equal(other.sample,input.sample));
        if(inputs.length!==1){for(const other of inputs)other.matches=null;failure('ambiguous');return;}
        if(input.dispatch===d)return;
        if(d.ingress && d.ingress!==input){failure('ambiguous');input.matches=null;return;}
        d.ingress=input;input.dispatch=d;input.matches=true;
        edge('dispatch_ingress',{input,cause:true},true);
      }
    }
    function preview(row) {
      const a=row.witnessBefore,b=row.witnessAfter;
      const owner = a.ownerScopeMatch===false || b.ownerScopeMatch===false ? false
        : a.ownerScopeMatch===true && b.ownerScopeMatch===true && a.ownerOrdinal===b.ownerOrdinal
          && a.ownerKey===b.ownerKey && a.conversationRef===b.conversationRef && a.scopeKind===b.scopeKind
          && row.route.kind===a.scopeKind && row.route.conversationRef===a.conversationRef
          && !a.uncertainty && !b.uncertainty ? true : null;
      const signal=a.signal===b.signal&&!a.uncertainty&&!b.uncertainty?a.signal==='running'?'running_observed':a.signal==='quiet'?'quiet_observed':'unknown':'unknown';
      return {kind:'series_sample',dispatchOrdinal:row.dispatchOrdinal,at:row.after,recording:row.recording,
        witnessBeforeOrdinal:a.witnessSampleOrdinal,witnessAfterOrdinal:b.witnessSampleOrdinal,ownerOrdinal:owner===true?a.ownerOrdinal:null,
        semanticVerdict:{signal,state:owner===true&&signal==='running_observed'&&row.sample.status==='running'?'compatible':'unknown',outcome:'unknown'}};
    }
    function dispatch(row,doc,eligible,alreadyAppended=false,nonrecordingCause=null) {
      sweep();
      if(disposed || !reserve(dispatches))return false;
      const id=JSON.stringify([doc.tabId,doc.documentId,doc.captureToken,row.dispatchOrdinal]);
      if(dispatches.has(id))return !!failure('input_conflict');
      const a=row.witnessBefore,b=row.witnessAfter;
      const owner = a.ownerScopeMatch===false || b.ownerScopeMatch===false ? false
        : a.ownerScopeMatch===true && b.ownerScopeMatch===true && a.ownerOrdinal===b.ownerOrdinal
          && a.ownerKey===b.ownerKey && a.conversationRef===b.conversationRef && a.scopeKind===b.scopeKind
          && row.route.kind===a.scopeKind && row.route.conversationRef===a.conversationRef
          && !a.uncertainty && !b.uncertainty ? true : null;
      const d={row,doc:{tabId:doc.tabId,documentId:doc.documentId,captureToken:doc.captureToken},at:clock(),owner,
        nonrecordingCause:!eligible&&['waiting','unbound','capture_unknown'].includes(nonrecordingCause)?nonrecordingCause:null,
        eligible:eligible && row.recording && row.status==='returned' && !!row.observerInstallationOrdinal,ingress:null};
      dispatches.set(id,d);inc('dispatches');
      if(owner===false){inc('contradictions');failure('mismatch');}
      const signal = a.signal===b.signal && !a.uncertainty && !b.uncertainty
        ? a.signal==='running'?'running_observed':a.signal==='quiet'?'quiet_observed':'unknown' : 'unknown';
      if(!alreadyAppended)append({kind:'series_sample',dispatchOrdinal:row.dispatchOrdinal,at:clock(),recording:d.eligible,
        witnessBeforeOrdinal:a.witnessSampleOrdinal,witnessAfterOrdinal:b.witnessSampleOrdinal,ownerOrdinal:owner===true?a.ownerOrdinal:null,
        semanticVerdict:{signal,state:owner===true && signal==='running_observed' && row.sample.status==='running'?'compatible':'unknown',outcome:'unknown'}});
      for(const input of ingresses.values())match(input);
      resolve(); return true;
    }
    function ingress(ref,sampleValue,senderValue) {
      const sample=payload.sampleOf(sampleValue),sender=payload.senderOf(senderValue);
      if(disposed || !ref || !sample || !sender)return failure('invalid_schema');
      if(ingresses.has(ref) || !reserve(ingresses))return failure('input_conflict');
      const input={ordinal:inc('ingresses'),sample,sender,at:clock(),dispatch:null,matches:null};
      ingresses.set(ref,input);match(input);return true;
    }
    function reductionBegin(ref,sampleValue,contextValue) {
      const input=ingresses.get(ref),sample=payload.sampleOf(sampleValue),context=payload.contextOf(contextValue);
      if(!input || !sample || !context || !payload.equal(sample,input.sample)
        || context.tabId!==input.sender.tabId || context.documentId!==input.sender.documentId
        || context.route.provider!==input.sender.provider || context.scope.documentId!==input.sender.documentId
        || !['workerEpoch','leaseId','bindingEpoch','viewEpoch','samplingEpoch'].every(k=>sample[k]===context.scope[k])
        || sample.scopeKind!==context.scope.kind || sample.startUnobserved!==context.scope.startUnobserved)return failure('input_conflict');
      if(!reserve(invocations))return null;
      const handle=Object.freeze({}), invocation={input,context,ordinal:inc('invocations'),at:clock(),deadline:input.at+30000,ended:false};
      invocations.set(handle,invocation);edge('ingress_reduction',{input,cause:true,invocationOrdinal:invocation.ordinal},true);return handle;
    }
    function reductionEnd(handle,resultRef,subjects) {
      const invocation=invocations.get(handle), list=payload.arrayOf(subjects,64);
      if(!invocation || invocation.ended || !resultRef || !list || !reserve(results))return failure('invocation_missing');
      const copied=list.map(value=>{const r=payload.dictionary(value,['ref','event']);return r && r.ref && payload.eventOf(r.event)?{ref:r.ref,event:payload.eventOf(r.event)}:null;});
      if(copied.some(v=>!v) || events.size+copied.length>2048)return failure('invalid_schema');
      invocation.ended=true;results.set(resultRef,invocation);
      for(const {ref,event}of copied){
        if(events.has(ref))return failure('event_conflict');
        const sameScope=fullScope(event.scope)===fullScope(invocation.context.scope);
        const subjectContradicted=sameScope&&(event.tabId!==invocation.context.tabId||event.provider!==invocation.context.route.provider
          ||event.pageInstanceId!==invocation.input.sample.pageInstanceId||event.conversationRef!==invocation.context.route.conversationRef);
        if(subjectContradicted){inc('contradictions');failure('mismatch');}
        const node={input:invocation.input,event,at:clock(),deadline:invocation.deadline,cause:true,invocationOrdinal:invocation.ordinal,
          allocationOrdinal:inc('allocations'),sameScope,subjectContradicted,accepted:false};
        events.set(ref,node);edge('reduction_assignment',node,null);
        if(sameScope && invocation.input.sample.status==='running' && event.kind==='observation' && event.phase==='running'){
          const namespace=JSON.stringify([event.tabId,event.pageInstanceId,fullScope(event.scope),invocation.input.sample.generationToken]);
          const turn=JSON.stringify([event.turnId,event.generation]);
          const reverse=JSON.stringify([event.tabId,event.pageInstanceId,fullScope(event.scope),event.turnId,event.generation]);
          if(event.turnId===null||event.generation<1||turnTokens.has(reverse)&&turnTokens.get(reverse).value!==invocation.input.sample.generationToken)failure('namespace_changed');
          else if(turnTokens.size<2048)turnTokens.set(reverse,{value:invocation.input.sample.generationToken,at:clock()});else failure('capacity');
          if(tokenTurns.has(namespace) && tokenTurns.get(namespace).value!==turn)failure('namespace_changed');
          else if(tokenTurns.size<2048)tokenTurns.set(namespace,{value:turn,at:clock()});else failure('capacity');
        }
      }return true;
    }
    function queueClone(sourceRef,targetRef,a,b,kind) {
      let source=events.get(sourceRef);const left=payload.eventOf(a),right=payload.eventOf(b);
      if(!source && left){source={input:null,event:left,at:clock(),deadline:clock()+30000,cause:false,accepted:false,sameScope:false};}
      if(!left || !right || !payload.equal(left,source.event) || !reserve(events))return failure('event_conflict');
      const exact=payload.equal(left,right);
      const changes=Object.keys(left).filter(key=>!payload.equal({value:left[key]},{value:right[key]}));
      if(!['outbox_append','outbox_retained'].includes(kind)||kind==='outbox_append'&&!exact
        ||kind==='outbox_retained'&&changes.some(key=>key!=='replay')){
        inc('contradictions');return failure('event_conflict');
      }
      const node={...source,event:right,at:clock(),accepted:false,cause:kind==='outbox_retained'&&sourceRef!==targetRef?false:source.cause};
      if(events.has(targetRef) && targetRef!==sourceRef && !payload.equal(events.get(targetRef).event,right))return failure('event_conflict');
      events.set(targetRef,node);inc('cloneEdges');edge('queue_clone',node,exact,exact?'matched':kind==='outbox_retained'?'transformed_payload':'mismatch');return true;
    }
    function queueAccepted(commitRef,eventRef,value) {
      const invocation=commits.get(commitRef),node=events.get(eventRef),event=payload.eventOf(value);
      if(!event)return failure('invalid_schema');
      if(!node && invocation?.input===null && reserve(events)){
        const created={input:null,event,at:clock(),deadline:clock()+30000,cause:false,accepted:true,sameScope:false};events.set(eventRef,created);edge('queue_accept',created,true);return true;
      }
      if(!node || !invocation || invocation.input!==node.input || !payload.equal(event,node.event))return failure('clone_unverified');
      node.accepted=true;edge('queue_accept',node,true);return true;
    }
    function outgoingClone(sourceRef,targetRef,a,b,kind) {
      const source=events.get(sourceRef),left=payload.eventOf(a),right=payload.eventOf(b);
      if(!source || !source.accepted || !left || !right || !payload.equal(left,source.event) || !reserve(events))return failure('clone_unverified');
      const changes=Object.keys(left).filter(k=>!payload.equal({value:left[k]},{value:right[k]}));
      const allowed=kind==='none'?changes.length===0:kind==='receipt_replay'?changes.every(k=>k==='replay')
        :kind==='fresh_stale'&&right.replay===true&&right.observation==='stale'&&changes.every(k=>['replay','observation'].includes(k));
      if(!allowed)return failure('event_conflict');
      const node={...source,event:right,at:clock()};events.set(targetRef,node);inc('cloneEdges');
      edge('outgoing_clone',node,payload.equal(left,right),changes.length?'transformed_payload':'matched');return true;
    }
    function wire(ref,value,handle) {
      sweep();
      const node=events.get(ref),event=payload.eventOf(value);
      if(!node || !node.accepted || !event || !handle || !payload.equal(event,node.event))return failure('send_unverified');
      inc('wireEvents');edge('transport_send',node,true,'matched',handle);return node;
    }
    function ack(node,handle,proofExact=null) { sweep();if(!node||clock()>=node.deadline)return failure('send_unverified');inc('acks');return edge('wire_ack',node,true,'matched',{...handle,proofExact}); }
    function sweep() {
      resolve();const at=clock();
      if(at===null){for(const map of [ingresses,dispatches,invocations,results,commits,events,tokenTurns,turnTokens])map.clear();pending.length=0;return;}
      for(const map of [ingresses,dispatches,invocations,results,commits,events,tokenTurns,turnTokens])for(const [key,value]of map){
        if(number(value.at) && at>=(value.deadline || value.at+30000)){map.delete(key);}
      }
      if(commits.size>2048)failure('capacity');
    }
    return {dispatch,preview,ingress,reductionBegin,reductionEnd,queueClone,queueAccepted,outgoingClone,wire,ack,failure,sweep,
      capacityRequired:dispatchCount=>pending.length+dispatchCount*(ingresses.size*2+2),
      reductionThrow(handle){if(invocations.has(handle)){invocations.delete(handle);failure('invocation_missing');}},
      commitBegin(resultRef,commitRef){const v=results.get(resultRef)||{input:null,at:clock(),deadline:clock()+30000};if(reserve(commits))commits.set(commitRef,v);},
      commitFailed(ref){commits.delete(ref);failure('clone_unverified');},queueSuperseded(){},
      summary(){sweep();return {v:1,contract:'independent-series-v3',status:unknown?'unknown':'collecting',formalAcceptance:false,
        semanticCompleteness:'unverified',counts:{...counts,pending:pending.length},reasonCounts:{...reasons}};},
      dispose(){disposed=true;resolve(true);for(const map of [ingresses,dispatches,invocations,results,commits,events,tokenTurns,turnTokens])map.clear();pending.length=0;}};
  }
  function createWorkerCapture({ chrome, WebSocketClass: BaseSocket, now = () => performance.now(),
    timeOrigin = globalThis.performance?.timeOrigin, maxEntries = 4096, maxDurationMs = 600000, buildFingerprint = null,
    enableSeries = false, targetPingOrdinal = 2 } = {}) {
    if (!chrome?.runtime?.onMessage?.addListener || typeof BaseSocket !== 'function' || typeof now !== 'function'
      || !number(timeOrigin) || !integer(maxEntries) || maxEntries < 1 || maxEntries > 16384
      || !number(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 600000) throw new Error('native_capture_configuration');
    let disposed = false, missing = false, halted = false, last = null, connectionCount = 0, sampleCount = 0, domCount = 0, inventories = 0, activeSocketLimitHits = 0;
    const entries = [], documents = new Map(), releasedContentFailures = [], tabs = new Map(), sockets = new Set(), links = [], observations = new Map();
    const scopes = new Map(), turns = new Map(), pages = new Map(), probes = new Map(), socketOwners = new WeakMap();
    const ordinalCounters=new WeakMap(),ordinalTimes=new WeakMap();
    const eventsByIdentity = new Map(), linksBySample = new Map(), linksByEvent = new Map(), pendingProbes = new Map(), currentDocuments = new Map();
    let probingAll = null, started = null, lastRecordAt = null;
    const lifecycleListeners = [];
    const failures = Object.fromEntries(FAILURES.map(category => [category,{count:0,firstAt:null,lastAt:null}]));
    const batches = {received:0,rejected:0,recordsAccepted:0};
    const socketClosures = {incomplete:0,pendingEvents:0,pendingCurrentAcks:0,pendingPings:0};
    const fingerprint = typeof buildFingerprint === 'string' && /^[a-f0-9]{64}$/.test(buildFingerprint) ? buildFingerprint : null;
    const generationOrdinal = ++nextCaptureGeneration;
    let workerStateReader = null;
    let referenceProvider = null;
    const rawMessages = new WeakMap(), expectedSends = new Map(), socketReferences = new WeakMap(), wireRecords = new Map();
    const registeredDocuments = new Map();
    const workerCaptureToken = enableSeries ? globalThis.crypto.randomUUID() : null;
    let channel = null;
    function haltCapture(reason) {
      if (halted) return;
      halted = true;
      channel?.sink.failure(reason);
    }
    function failureTime() {
      let at; try { at = now(); } catch (_) { haltCapture('clock_unknown'); fail('clock_unavailable',null); return null; }
      if (!number(at) || !number(timeOrigin + at)) { haltCapture('clock_unknown'); fail('clock_invalid',null); return null; }
      if (last !== null && at < last) { haltCapture('clock_unknown'); fail('clock_reversed',null); return null; }
      last = at; return timeOrigin + at;
    }
    function fail(category = 'invalid_schema', at = failureTime(), count = 1, firstAt = at) {
      missing = true;
      const row = failures[FAILURES.includes(category) ? category : 'capture_failed'];
      if (!row.count) row.firstAt = firstAt;
      row.count = Math.min(1000000,row.count + count); row.lastAt = at;
      return false;
    }
    function timestamp() {
      if (halted || disposed) return null;
      let at; try { at = now(); } catch (_) { haltCapture('clock_unknown'); fail('clock_unavailable',null); return null; }
      if (!number(at) || !number(timeOrigin + at)) { haltCapture('clock_unknown'); fail('clock_invalid',null); return null; }
      if (last !== null && at < last) { haltCapture('clock_unknown'); fail('clock_reversed',null); return null; }
      if (started !== null && at - started > maxDurationMs) {
        last = at; haltCapture('expired'); fail('expired',timeOrigin + at); return null;
      }
      last = at; return timeOrigin + at;
    }
    function append(row) {
      if (disposed || halted) return false;
      if (entries.length >= maxEntries) { haltCapture('capacity'); return fail('capacity'); }
      const at = timestamp(); if (at === null) return false;
      entries.push({...row,recording:started !== null && !missing && row.recording !== false}); lastRecordAt = at; return true;
    }
    function ordinal(map, raw) {
      if(enableSeries){
        if(!ordinalTimes.has(map))ordinalTimes.set(map,new Map());
        const times=ordinalTimes.get(map),at=failureTime();
        for(const [key,when]of times)if(at===null||at-when>=30000){times.delete(key);map.delete(key);}
        if(!map.has(raw)){
          const next=(ordinalCounters.get(map)||0)+1;
          if(map.size>=maxEntries||next>1000000){fail('capacity');return null;}
          ordinalCounters.set(map,next);map.set(raw,next);
        }
        times.set(raw,at);
      }else if (!map.has(raw)) { if (map.size >= maxEntries) { fail('capacity'); return null; } map.set(raw, map.size + 1); }
      return map.get(raw);
    }
    channel = enableSeries ? channelApi.createChannelCapture({ side:'worker',targetPingOrdinal,now:failureTime,
      maxMessages:maxEntries,maxSockets:64,maxDurationMs }) : null;
    const series = enableSeries ? createSeriesLedger({append,clock:failureTime,onFailure:reason=>{
      if (halted || disposed) return;
      const category = ({input_conflict:'b1_input_conflict',invocation_missing:'b1_invocation_missing',event_conflict:'b1_event_conflict',
        clone_unverified:'b1_clone_unverified',send_unverified:'b1_send_unverified',pending_expired:'b1_pending_expired',
        stale_capture:'b1_stale_capture',capacity:'capacity',expired:'expired'})[reason] || 'b1_missing_hook';
      fail(category);
    }}) : null;
    function seriesTap(name,args){if(!series)return null;if(halted||disposed){series.dispose();return null;}series.sweep();return series[name](...args);}
    function socketRef(instance) {
      if(!socketReferences.has(instance))socketReferences.set(instance,Object.freeze({}));
      return socketReferences.get(instance);
    }
    function projectWire(message) {
      if(!message || typeof message!=='object')return null;
      const type=Object.getOwnPropertyDescriptor(message,'type');if(!type||!Object.hasOwn(type,'value'))return null;
      if(type.value==='scope.event'){
        const e=ownerProjection(message,['type','v','schema','eventId','browserRunId','sessionId','sequence','kind','provider','tabId',
          'pageInstanceId','routeRevision','conversationRef','turnId','generation','phase','outcome','observation','observedAt','replay','scope','gap'],['conversationTitle','requestPreview']);
        if(!e)return null;
        e.scope=ownerProjection(e.scope,SCOPE);
        if(e.gap!==null){e.gap=ownerProjection(e.gap,['turnId','reason','observedAt']);if(!e.gap)return null;}
        return payload.eventOf(e);
      }
      if(type.value==='scope.event.ack'){
        const a=ownerProjection(message,['type','schema','eventId','browserRunId','sessionId','sequence','disposition','duplicate','reason'],['proof']);
        const proof=Object.getOwnPropertyDescriptor(message,'proof');
        return a&&proof&&Object.hasOwn(proof,'value')?payload.ackOf({...a,proofPresent:proof.value!==null}):null;
      }
      if(type.value==='scope.event.nack')return payload.nackOf(ownerProjection(message,['type','schema','eventId','browserRunId','sessionId','sequence','reason']));
      return ['ping','pong'].includes(type.value)?ownerProjection(message,['type','at']):null;
    }
    const scopeKey = s => key(SCOPE.map(k => s[k]));
    const eventKey = e => key([...EVENT.map(k => e[k]),e.kind]);
    const sampleKey = s => key([s.pageInstanceId,s.contentSequence]);
    const identityKey = e => key([eventKey(e),scopeKey(e.scope)]);
    function index(map, raw, value) {
      if (!map.has(raw)) map.set(raw,[]);
      map.get(raw).push(value);
    }
    function releaseSocket(socket) {
      if (socket.closed) return;
      const capturing = !halted && !disposed && timestamp() !== null;
      socket.closed = true;
      socket.instance.removeEventListener('message',socket.listener);
      socket.instance.removeEventListener('close',socket.closeListener);
      socketOwners.delete(socket.instance); sockets.delete(socket);
      if(channel){if(capturing)channel.sink.socketClosed(socket.ref,'disconnected');expectedSends.delete(socket.ref);
        for(const [ref,record]of wireRecords)if(record.socketRef===socket.ref)wireRecords.delete(ref);}
      const pendingEvents = socket.events.filter(sent => sent.ack === null).length;
      // A proof-bearing current ACK needs its own product-current hook unless
      // the exact consumed sequence_changed decision completed separately.
      const pendingCurrentAcks = socket.events.filter(sent => sent.ack !== null
        && sent.ackDisposition === 'committed_current' && sent.ackProof && !sent.current && !sent.strictNonCurrentComplete).length;
      const pendingPings = socket.pings.size;
      if (capturing && (pendingEvents || pendingCurrentAcks || pendingPings)) {
        for (const [key,count] of Object.entries({incomplete:1,pendingEvents,pendingCurrentAcks,pendingPings}))
          socketClosures[key] = Math.min(1000000,socketClosures[key] + count);
        const at = failureTime(); fail('socket_evidence_incomplete',at);
        append({kind:'socket_closed',connectionOrdinal:socket.ordinal,at,pendingEvents,pendingCurrentAcks,pendingPings,
          reason:'socket_evidence_incomplete'});
      }
      // Anonymous history survives close. Raw ACK candidates and socket
      // references do not survive into another physical connection.
      const identities = new Set(socket.events.map(sent => identityKey(sent.event)));
      for (const raw of identities) {
        const remaining = (eventsByIdentity.get(raw) || []).filter(candidate => candidate.socket !== socket);
        if (remaining.length) eventsByIdentity.set(raw,remaining); else eventsByIdentity.delete(raw);
      }
      socket.events.length = 0; socket.pings.clear(); socket.seenPings.clear();
    }
    function canTrackProbeTab(tabId){
      if(!currentDocuments.has(tabId)&&currentDocuments.size>=64){fail('capacity');return false;}return true;
    }
    function documentFor(sender, origin, captureToken = null) {
      if (sender?.id !== chrome.runtime.id || sender.frameId !== 0 || !integer(sender.tab?.id) || !id(sender.documentId)
        || sender.documentLifecycle && sender.documentLifecycle !== 'active') return null;
      let url; try { url = new URL(sender.url); } catch (_) { return null; }
      if (url.protocol !== 'https:' || url.username || url.password || url.port
        || !['chatgpt.com','claude.ai'].includes(url.hostname)) return null;
      if(enableSeries&&!canTrackProbeTab(sender.tab.id))return null;
      const raw = key([sender.tab.id,sender.documentId,captureToken]);
      let doc = documents.get(raw);
      if (doc && doc.provider !== (url.hostname === 'chatgpt.com' ? 'chatgpt' : 'claude')) return null;
      if (doc && doc.clockOrigin !== origin) { fail('clock_invalid'); return null; }
      const newlySeen = !doc;
      if (!doc) {
        if (documents.size >= 64) { fail('capacity'); return null; }
        doc = { tabId: sender.tab.id, documentId: sender.documentId, tabOrdinal: ordinal(tabs,sender.tab.id),
          documentOrdinal: documents.size + 1, clockOrigin: origin, provider: url.hostname === 'chatgpt.com' ? 'chatgpt' : 'claude', probeCount: 0, probing: false, active:false,
          captureToken,workerBound:false,lastDispatchOrdinal:0,readerGeneration:null,seriesPage:null,lastSeriesSequence:0,activation:Object.freeze({}),
          lastBatchSequence:0,inventories:0,batchVersions:{v1:0,v2:0,v3:0},
          batchResults:{v1:{accepted:0,rejected:0},v2:{accepted:0,rejected:0},v3:{accepted:0,rejected:0}},
          failures:Object.fromEntries(FAILURES.map(category => [category,{count:0,firstAt:null,lastAt:null}])) };
        documents.set(raw,doc);
      }
      // An initial batch is a fallback probe heuristic only. Once a candidate
      // exists, neither first-seen nor known historical batches can replace it.
      // A later owner registration fact may choose another document, but never
      // serves as independent live-current/series evidence.
      const registered=registrationFor(sender.tab.id);
      if(newlySeen && !currentDocuments.has(sender.tab.id) && (!registered || matchesRegistration(doc,registered)))selectProbeDocument(doc);
      else if(registered && matchesRegistration(doc,registered)
        && !matchesRegistration(currentDocuments.get(sender.tab.id),registered))selectProbeDocument(doc);
      return doc;
    }
    function matchesRegistration(doc,facts){return !!doc&&doc.documentId===facts.documentId&&doc.provider===facts.provider;}
    function registrationFor(tabId){const value=registeredDocuments.get(tabId),at=failureTime();
      if(value&&(at===null||at>=value.deadline)){registeredDocuments.delete(tabId);return null;}return value||null;}
    function selectProbeDocument(doc){const previous=currentDocuments.get(doc.tabId);
      if(previous&&previous!==doc){previous.active=false;previous.activation=Object.freeze({});}
      if(previous!==doc||!doc.active)doc.activation=Object.freeze({});
      doc.active=true;currentDocuments.set(doc.tabId,doc);}
    function removeLifecycleListeners(){for(const [event,callback]of lifecycleListeners)event.removeListener(callback);lifecycleListeners.length=0;}
    function retireProbeTab(tabId,reason){
      if(disposed||halted||!integer(tabId)||!currentDocuments.has(tabId)&&!registeredDocuments.has(tabId))return;
      const at=timestamp();if(at===null)return;
      for(const doc of documents.values())if(doc.tabId===tabId&&doc.active){
        doc.active=false;doc.activation=Object.freeze({});
        append({kind:'content_clock_gap',tabOrdinal:doc.tabOrdinal,documentOrdinal:doc.documentOrdinal,
          probeOrdinal:null,before:at,after:at,reason,recording:false});
      }
      registeredDocuments.delete(tabId);currentDocuments.set(tabId,null);
    }
    function correlateLink(link) {
        const sample = observations.get(sampleKey(link.sample));
        if (!sample) return;
        for (const {socket,sent} of eventsByIdentity.get(identityKey(link.event)) || []) {
          if (socket.closed || !sockets.has(socket) || sent.linked) continue;
          sent.linked = true;
          const own = sample.observation;
          append({ kind:'sample_link', sampleOrdinal:sample.sampleOrdinal, eventOrdinal:sent.ordinal,
            connectionOrdinal:socket.ordinal, tabOrdinal:sample.doc.tabOrdinal, documentOrdinal:sample.doc.documentOrdinal,
            sameDocument:sample.doc.documentId === link.scope.documentId && sample.doc.documentId === link.event.scope.documentId,
            sameScope:scopeKey(link.scope) === scopeKey(link.event.scope) && own.viewEpoch === link.scope.viewEpoch && own.scopeKind === link.scope.kind
              && own.startUnobserved === link.scope.startUnobserved,
            sameSampling:own.samplingEpoch === link.scope.samplingEpoch && own.samplingEpoch === link.event.scope.samplingEpoch,
            generationMatched:own.generationToken === link.sample.generationToken,
            samePage:own.pageInstanceId === link.event.pageInstanceId,
            sameLease:own.leaseId === link.scope.leaseId && own.workerEpoch === link.scope.workerEpoch && own.bindingEpoch === link.scope.bindingEpoch
              && own.leaseId === link.event.scope.leaseId && own.workerEpoch === link.event.scope.workerEpoch && own.bindingEpoch === link.event.scope.bindingEpoch,
            scopeOrdinal:ordinal(scopes,scopeKey(link.event.scope)),
            turnOrdinal:link.event.turnId === null ? 0 : ordinal(turns,key([link.event.browserRunId,link.event.sessionId,link.event.turnId,link.event.generation])) });
        }
    }
    const sink = Object.freeze({
      registeredDocument(value){
        if(!enableSeries||disposed||halted)return false;
        const facts=payload.senderOf(value),at=failureTime();
        if(!facts||at===null){series.failure('invalid_schema');return false;}
        if(!canTrackProbeTab(facts.tabId))return false;
        for(const tabId of registeredDocuments.keys())registrationFor(tabId);
        if(!registeredDocuments.has(facts.tabId)&&registeredDocuments.size>=64)return !!series.failure('capacity');
        registeredDocuments.set(facts.tabId,{...facts,deadline:at+30000});
        const candidates=[...documents.values()].filter(doc=>doc.tabId===facts.tabId&&matchesRegistration(doc,facts));
        if(candidates.length)selectProbeDocument(candidates.at(-1));
        else {const previous=currentDocuments.get(facts.tabId);if(previous){previous.active=false;previous.activation=Object.freeze({});}
          // Preserve an empty candidate slot: expiry of a pending hint must
          // not re-enable first-arrival fallback for a historical document.
          currentDocuments.set(facts.tabId,null);}
        return true;
      },
      setReferenceProvider(provider) { if(referenceProvider || typeof provider!=='function')return false;referenceProvider=provider;return true; },
      ingress:(...args)=>seriesTap('ingress',args),reductionBegin:(...args)=>seriesTap('reductionBegin',args),
      reductionEnd:(...args)=>seriesTap('reductionEnd',args),reductionThrow:(...args)=>seriesTap('reductionThrow',args),
      commitBegin:(...args)=>seriesTap('commitBegin',args),commitFailed:(...args)=>seriesTap('commitFailed',args),
      queueClone:(...args)=>seriesTap('queueClone',args),queueAccepted:(...args)=>seriesTap('queueAccepted',args),
      queueSuperseded:(...args)=>seriesTap('queueSuperseded',args),outgoingClone:(...args)=>seriesTap('outgoingClone',args),
      seriesFailure:reason=>{if(!halted&&!disposed){series?.failure(reason);channel?.sink.failure(reason);}},
      failure:reason=>{if(!halted&&!disposed){series?.failure(reason);channel?.sink.failure(reason);}},
      transportSocketRef:instance=>socketOwners.get(instance)?.ref || null,
      transportRawMessageRef:(message,instance)=>socketOwners.get(instance)?rawMessages.get(message)||null:null,
      transportAuthenticated:(...args)=>!halted&&!disposed?channel?.sink.authenticated(...args):null,
      transportSendBegin(ref,event,refSocket) {
        if(!channel||halted||disposed)return null;
        const clean=payload.eventOf(event);
        if(!clean || expectedSends.has(refSocket)){series.failure('send_unverified');return null;}
        const expectation=channel.sink.expectSend(ref,clean,refSocket);
        if(expectation)expectedSends.set(refSocket,{expectation,ref,event:clean,at:failureTime()});
        return expectation;
      },
      transportSendEnd(expectation,status) {
        if(!halted&&!disposed && timestamp()!==null)channel?.sink.endExpectedSend(expectation,status);
        for(const [ref,item]of expectedSends)if(item.expectation===expectation)expectedSends.delete(ref);
      },
      transportAckValidated:value=>!halted&&!disposed&&timestamp()!==null?channel?.sink.ackValidated(value):null,
      transportPongProcessed:value=>!halted&&!disposed&&timestamp()!==null?channel?.sink.pongProcessed(value):null,
      validationComplete(value) {
        if(!channel||halted||disposed||timestamp()===null)return false;
        sweepPrivate();
        const clean=dictionary(value,['ackSubjectRef','eventSubjectRef','socketRef','ackProjection','proofExact','gate','at']);
        if(!clean || !payload.ackOf(clean.ackProjection))return series.failure('invalid_schema');
        const {ackProjection,...decision}=clean;
        const channelComplete=channel.sink.validationComplete(decision);
        const wire=wireRecords.get(clean.eventSubjectRef);
        if(!wire || wire.socketRef!==clean.socketRef || !wire.sent?.ackProjection || !payload.equal(wire.sent.ackProjection,ackProjection))return series.failure('proof_unavailable');
        wireRecords.delete(clean.eventSubjectRef);
        const linked=series.ack(wire.node,wire.handle,clean.proofExact);
        // Only this strictly consumed noncurrent terminal may omit the
        // currentAck hook. A missing accepted_current hook remains a failure.
        if(channelComplete===true && linked===true && clean.proofExact===true && clean.gate==='sequence_changed')wire.sent.strictNonCurrentComplete=true;
        return linked;
      },
      setWorkerStateReader(reader) {
        // Closure-owned injection only. Neither runtime messages nor page data
        // can supply this callback or turn recording on in a normal build.
        if (workerStateReader || typeof reader !== 'function') return false;
        workerStateReader = reader; return true;
      },
      record(stage, fields = {}) {
        if(halted||disposed)return false;
        try { const clean = fieldsOf(fields), at = timestamp();
          if (!clean || !STAGES.includes(stage)) return fail();
          if (at === null) return false;
          if (stage === 'authenticated_ready' && started === null) started = at - timeOrigin;
          return append({kind:'stage',stage,at,...clean});
        } catch (_) { return fail(); }
      },
      linkSample(sample, scope, events) {
        try {
          if(enableSeries)return false; // The product-derived auxiliary join is not B1 evidence.
          if (disposed || halted) return false;
          const s = dictionary(sample,['contentSequence','pageInstanceId','generationToken']);
          const cleanScope = scopeOf(scope), eventList = arrayOf(events,64);
          if (!s || !integer(s.contentSequence) || s.contentSequence < 1 || !id(s.pageInstanceId)
            || s.generationToken !== null && !id(s.generationToken) || !cleanScope || !eventList) return fail();
          if (links.length + eventList.length > maxEntries) return fail('capacity');
          const copied = eventList.map(e => eventOf(e));
          if (copied.some(e => !e)) return fail();
          for (const event of copied) {
            const link = { sample:s,scope:cleanScope,event };
            links.push(link); index(linksBySample,sampleKey(s),link); index(linksByEvent,identityKey(event),link); correlateLink(link);
          }
          return true;
        } catch (_) { return fail(); }
      },
      ackDecision(event, details) {
        try {
          if (disposed || halted) return false;
          const e = eventOf(event), d = dictionary(details,['gate','proofPresent','replay','sameConnection']), at = timestamp();
          if (at === null) return false;
          if (!e || !d || !ACK_GATES.includes(d.gate)
            || ['proofPresent','replay','sameConnection'].some(k => typeof d[k] !== 'boolean')) return fail();
          const candidates = (eventsByIdentity.get(identityKey(e)) || []).filter(({socket,sent}) => !socket.closed
            && sockets.has(socket) && sent.ack !== null && !sent.decision
            && sent.ackProof === d.proofPresent && sent.replay === d.replay);
          if (candidates.length !== 1) return fail(candidates.length ? 'ack_ambiguous' : 'ack_unmatched');
          const {socket,sent} = candidates[0]; sent.decision = true;
          return append({kind:'ack_decision',connectionOrdinal:socket.ordinal,eventOrdinal:sent.ordinal,at,...d});
        } catch (_) { return fail(); }
      },
      currentAck(event, details = {}) {
        try {
          if (disposed || halted) return false;
          const e = eventOf(event), d = dictionary(details,['sameConnection'],[]), at = timestamp();
          if (at === null) return false;
          if (!e || !d || d.sameConnection !== undefined && d.sameConnection !== true) return fail();
          const candidates = [];
          for (const {socket,sent} of eventsByIdentity.get(identityKey(e)) || [])
            if (!socket.closed && sockets.has(socket) && sent.ack !== null && sent.ackDisposition === 'committed_current' && sent.ackProof && !sent.current) candidates.push({socket,sent});
          if (candidates.length !== 1) return fail(candidates.length ? 'ack_ambiguous' : 'ack_unmatched');
          const {socket,sent} = candidates[0]; sent.current = true;
          return append({kind:'current_ack',connectionOrdinal:socket.ordinal,eventOrdinal:sent.ordinal,at});
        } catch (_) { return fail(); }
      }
    });
    class CapturedSocket extends BaseSocket {
      constructor(...args) {
        super(...args);
        if (disposed || halted) return;
        const ref=socketRef(this), opened=channel?.sink.socketOpened(ref);
        const socket = { instance:this, ref, ordinal:channel ? opened?.connectionOrdinal : ++connectionCount,
          events:[], pings:new Map(), seenPings:new Set(), next:0, listener:null,closeListener:null,closed:false };
        if(channel){if(!opened)return;connectionCount=Math.max(connectionCount,opened.connectionOrdinal);}
        // Bound only sockets carrying capture listeners. The anonymous total
        // ordinal is monotonic and is never a lifetime admission limit.
        if (sockets.size >= 64) { activeSocketLimitHits = Math.min(1000000,activeSocketLimitHits + 1); fail('capacity'); return; }
        sockets.add(socket);
        socket.listener = message => {
          if (disposed || halted || socket.closed || !sockets.has(socket)) return;
          const at = timestamp(); if (at === null) return;
          try {
            if (typeof message.data !== 'string' || message.data.length > 16384) {
              channel?.sink.failure('invalid_schema'); return fail();
            }
            const m = JSON.parse(message.data);
            if(channel){const handle=channel.sink.messageBegin(socket.ref,{direction:'server_to_client',type:m.type,
              projection:projectWire(m),phase:missing||halted?'unknown':started===null?'waiting':'recording',before:at});
              if(handle){const after=timestamp();if(after===null)return;
                rawMessages.set(message,handle);channel.sink.messageEnd(handle,{status:'received',after});}}
            if (m?.type === 'pong') {
              if (!dictionary(m,['type','at']) || !number(m.at)) return fail();
              if (!socket.pings.has(m.at)) return fail('ping_unmatched');
              const before = socket.pings.get(m.at); socket.pings.delete(m.at);
              append({kind:'ping',connectionOrdinal:socket.ordinal,pingAt:m.at,before,after:at}); return;
            }
            if (m?.type !== 'scope.event.ack') return;
            if (!dictionary(m,['type','schema','eventId','browserRunId','sessionId','sequence','disposition','duplicate','proof','reason'],
              ['type','schema','eventId','browserRunId','sessionId','sequence','disposition','duplicate','proof','reason'])
              || m.schema !== 2 || !['eventId','browserRunId','sessionId'].every(k => id(m[k])) || !integer(m.sequence)
              || !['committed_current','committed_receipt','duplicate_durable','ignored_order'].includes(m.disposition) || typeof m.duplicate !== 'boolean'
              || m.proof !== null && !id(m.proof) || ![null,'desktop_capacity'].includes(m.reason)
              || m.proof && m.disposition !== 'committed_current') return fail();
            const found = socket.events.filter(e => e.ack === null && e.event.eventId === m.eventId
              && e.event.browserRunId === m.browserRunId && e.event.sessionId === m.sessionId && e.event.sequence === m.sequence);
            if (found.length !== 1) return fail(found.length ? 'ack_ambiguous' : 'ack_unmatched');
            found[0].ack = at;
            found[0].ackDisposition = m.disposition;
            found[0].ackProof = m.proof !== null;
            if(channel)found[0].ackProjection=projectWire(m);
            append({kind:'raw_ack',connectionOrdinal:socket.ordinal,eventOrdinal:found[0].ordinal,at,
              disposition:m.disposition,duplicate:m.duplicate,proofPresent:m.proof !== null,replay:found[0].replay});
          } catch (_) { channel?.sink.failure('invalid_schema'); fail(); }
        };
        socket.closeListener = () => releaseSocket(socket);
        this.addEventListener('message',socket.listener);
        this.addEventListener('close',socket.closeListener);
        socketOwners.set(this,socket);
      }
      send(...args) {
        const socket = socketOwners.get(this);
        if (disposed || halted || !socket) return super.send(...args);
        let sent = null, channelHandle = null;
        try {
          const before = timestamp(), raw = args[0];
          if (typeof raw === 'string' && raw.length <= 16384 && before !== null) {
            const message = JSON.parse(raw);
            const projected = channel ? projectWire(message) : null;
            if(channel)channelHandle=channel.sink.messageBegin(socket.ref,{direction:'client_to_server',type:message.type,
              projection:projected,phase:missing||halted?'unknown':started===null?'waiting':'recording',before});
            if (message?.type === 'scope.event') {
              const event = eventOf(message,true);
              if (!event) fail();
              else if (socket.events.length >= maxEntries) fail('capacity');
              else { sent = {event,ordinal:channel?channelHandle?.eventOrdinal:++socket.next,ack:null,ackDisposition:null,ackProof:false,current:false,linked:false,
                replay:message.replay === true,decision:false,strictNonCurrentComplete:false,before}; socket.events.push(sent); index(eventsByIdentity,identityKey(event),{socket,sent});
                if(series){const expected=expectedSends.get(socket.ref);
                  const node=expected && projected && payload.equal(expected.event,projected)?series.wire(expected.ref,projected,channelHandle):null;
                  if(node && expected){if(wireRecords.size<2048)wireRecords.set(expected.ref,{node,handle:channelHandle,socketRef:socket.ref,sent,at:before,deadline:node.deadline});else series.failure('capacity');}
                  else series.failure('send_unverified');}
                append({kind:'event_sent',connectionOrdinal:socket.ordinal,eventOrdinal:sent.ordinal,before,
                  replay:sent.replay,scopeKind:event.scope.kind,eventKind:event.kind,scopeOrdinal:ordinal(scopes,scopeKey(event.scope)),
                  pageOrdinal:ordinal(pages,event.pageInstanceId),turnOrdinal:event.turnId === null ? 0 : ordinal(turns,key([event.browserRunId,event.sessionId,event.turnId,event.generation]))}); }
            } else if (message?.type === 'ping') {
              if (dictionary(message,['type','at']) && number(message.at) && !socket.seenPings.has(message.at)
                && socket.pings.size < 64 && socket.seenPings.size < maxEntries) {
                socket.seenPings.add(message.at); socket.pings.set(message.at,before);
              } else { socket.pings.delete(message.at); fail('ping_duplicate'); }
            }
          } else if(before!==null) { channel?.sink.failure('invalid_schema'); fail(); }
        } catch (_) { channel?.sink.failure('invalid_schema'); fail(); }
        // Return value, thrown errors and original bytes belong to the socket.
        let result;
        try { result = super.send(...args); } catch (error) {
          const after=timestamp();
          if(channelHandle&&after!==null)channel.sink.messageEnd(channelHandle,{status:'threw',after});
          if(after!==null)fail('socket_send_failed'); throw error;
        }
        if(channelHandle){const after=timestamp();if(after!==null)channel.sink.messageEnd(channelHandle,{status:'returned',after});}
        if (sent) { const after = timestamp(); if (after !== null) append({kind:'event_send_returned',connectionOrdinal:socket.ordinal,eventOrdinal:sent.ordinal,at:after});
          for (const link of linksByEvent.get(identityKey(sent.event)) || []) correlateLink(link); }
        return result;
      }
    }
    async function performProbe(doc) {
      if (disposed || halted || !doc.active) return false;
      const activation=doc.activation;
      const obsolete=()=>!doc.active||doc.activation!==activation||currentDocuments.get(doc.tabId)!==doc;
      const diagnostic=(kind,reason,before,after,probeOrdinal,stage=null)=>append({kind,tabOrdinal:doc.tabOrdinal,
        documentOrdinal:doc.documentOrdinal,probeOrdinal,before,after,reason,recording:false,...(stage?{stage}:{})});
      const failure=(category,stage,before,after,probeOrdinal)=>{
        diagnostic('content_clock_failure',category,before,after,probeOrdinal,stage);return fail(category,after);
      };
      const initial=timestamp();if(initial===null)return false;
      if (doc.probeCount >= 64) return failure('clock_probe_capacity','capacity',initial,initial,null);
      if (!chrome.tabs?.sendMessage) return failure('clock_probe_failed','unavailable',initial,initial,null);
      doc.probing = true;
      const probeOrdinal = ++doc.probeCount, before = timestamp();
      if (before === null) { doc.probing = false; return false; }
      let timer, timedOut = false;
      try {
        const response = await Promise.race([
          chrome.tabs.sendMessage(doc.tabId,{type:'mori.native.clock',v:1,probeOrdinal},{documentId:doc.documentId}),
          new Promise((_,reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error('native_clock_timeout')); },1500); probes.set(timer,reject); })
        ]);
        const after = timestamp(), r = dictionary(response,['type','v','probeOrdinal','clockOrigin','received','sent']);
        if(after===null)return false;
        if(obsolete()){diagnostic('content_clock_gap','activation_changed',before,after,probeOrdinal);return false;}
        if (!r || r.type !== 'mori.native.clock' || r.v !== 1 || r.probeOrdinal !== probeOrdinal
          || r.clockOrigin !== doc.clockOrigin || !number(r.received) || !number(r.sent) || r.sent < r.received) return failure('clock_probe_failed','response',before,after,probeOrdinal);
        return append({kind:'content_clock',tabOrdinal:doc.tabOrdinal,documentOrdinal:doc.documentOrdinal,
          probeOrdinal,before,received:r.received,sent:r.sent,after,clockOrigin:r.clockOrigin});
      } catch (_) {
        if(disposed||halted)return false;
        const after=timestamp();if(after===null)return false;
        if(obsolete()){diagnostic('content_clock_gap','activation_changed',before,after,probeOrdinal);return false;}
        return failure(timedOut?'clock_probe_timeout':'clock_probe_failed',timedOut?'timeout':'request',before,after,probeOrdinal);
      }
      finally { clearTimeout(timer); probes.delete(timer); doc.probing = false; }
    }
    function probeDocument(doc, force = false) {
      if (pendingProbes.has(doc)) return force ? pendingProbes.get(doc).then(() => probeDocument(doc,false)) : pendingProbes.get(doc);
      const pending = performProbe(doc).finally(() => pendingProbes.delete(doc));
      pendingProbes.set(doc,pending); return pending;
    }
    function probeClocks(force = false) {
      if (probingAll) return force ? probingAll.then(() => probeClocks(true)) : probingAll;
      const pending = (async () => {
        const active = [...documents.values()].filter(d => d.active), results = [];
        for (let i = 0; i < active.length && !disposed && !halted; i += 4)
          results.push(...await Promise.all(active.slice(i,i + 4).map(doc => probeDocument(doc,force))));
        return results;
      })();
      probingAll = pending;
      void pending.finally(() => { if (probingAll === pending) probingAll = null; });
      return pending;
    }
    function listener(message,sender,respond) {
      if (disposed) return false;
      try {
        const type = message && Object.getOwnPropertyDescriptor(message,'type');
        if (!type || !Object.hasOwn(type,'value')) return false;
        if (type.value === 'mori.native.export') {
          if (sender?.id !== chrome.runtime.id || sender.frameId !== undefined && sender.frameId !== 0 || sender.url !== chrome.runtime.getURL('options.html')
            || !dictionary(message,['type','v']) || message.v !== 1) return false;
          void probeClocks(true).then(() => respond(snapshot()),() => { fail(); respond(snapshot()); }); return true;
        }
        if (type.value !== 'mori.native.records') return false;
        batches.received = Math.min(1000000,batches.received + 1);
        const version = Object.getOwnPropertyDescriptor(message,'v');
        const v3 = version && Object.hasOwn(version,'value') && version.value === 3;
        const modern = v3 || version && Object.hasOwn(version,'value') && version.value === 2;
        const versionKey = v3 ? 'v3' : modern ? 'v2' : 'v1';
        let doc = null;
        function reject(category) { batches.rejected = Math.min(1000000,batches.rejected + 1); fail(category);
          if (doc) doc.batchResults[versionKey].rejected = Math.min(1000000,doc.batchResults[versionKey].rejected + 1);
          respond(v3 ? {ok:false,recording:false,acceptedRecords:0,workerCaptureToken,
            reason:['invalid_schema','invalid_sender','stale_capture','batch_duplicate','batch_gap','capacity','expired','disposed'].includes(category)?category:'invalid_schema'}
            : modern ? {ok:false,recording:false,acceptedRecords:0} : {ok:false}); return false; }
        if (halted) return reject('batch_rejected');
        const m = dictionary(message,modern ? ['type','v','clockOrigin','missing','records','failures','batchSequence',...(v3?['captureToken','workerCaptureToken']:[])] : ['type','v','clockOrigin','missing','records']);
        const records = m && arrayOf(m.records,64);
        if (!m || ![1,2,3].includes(m.v) || !number(m.clockOrigin) || typeof m.missing !== 'boolean' || !records
          || modern && (!integer(m.batchSequence) || m.batchSequence < 1)) return reject('invalid_schema');
        if(v3 && (!enableSeries || !id(m.captureToken) || m.workerCaptureToken!==null&&!id(m.workerCaptureToken)
          || !payload.withinBytes(m,65536)))return reject('invalid_schema');
        doc = documentFor(sender,m.clockOrigin,v3?m.captureToken:null); if (!doc) return reject('invalid_sender');
        doc.batchVersions[versionKey] = Math.min(1000000,doc.batchVersions[versionKey] + 1);
        if (modern && m.batchSequence <= doc.lastBatchSequence) return reject('batch_duplicate');
        if(v3 && (m.workerCaptureToken===null?doc.workerBound:m.workerCaptureToken!==workerCaptureToken))return reject('stale_capture');
        const reports = modern ? arrayOf(m.failures,FAILURES.length) : [];
        if (!reports) return reject('invalid_schema');
        const seenReports = new Set(), cleanReports = [];
        for (const value of reports) {
          const r = dictionary(value,['category','count','firstAt','lastAt']);
          if (!r || !FAILURES.includes(r.category) || seenReports.has(r.category) || !integer(r.count) || r.count < 1 || r.count > 1000000
            || r.firstAt !== null && !number(r.firstAt) || r.lastAt !== null && !number(r.lastAt)
            || r.firstAt !== null && r.lastAt !== null && r.lastAt < r.firstAt) return reject('invalid_schema');
          const previous = doc.failures[r.category];
          if (r.count < previous.count || previous.count && r.firstAt !== previous.firstAt
            || r.count === previous.count && r.lastAt !== previous.lastAt) return reject('invalid_schema');
          seenReports.add(r.category); cleanReports.push(r);
        }
        if (modern && FAILURES.some(category => doc.failures[category].count && !seenReports.has(category))) return reject('invalid_schema');
        const copied = records.map(value => {
          const r = dictionary(value,['kind','before','after','stage','fields','sample','observation','at',...(modern ? ['recording','inventory'] : []),
            ...(v3?['dispatchOrdinal','observerInstallationOrdinal','readerGenerationOrdinal','status','route','witnessBefore','witnessAfter']:[])],modern ? ['kind','recording'] : ['kind']);
          if (!r) return null;
          if (modern && typeof r.recording !== 'boolean') return null;
          const body = {...r}; delete body.recording;
          const recording = modern && r.recording && (!v3 || m.workerCaptureToken!==null);
          if(v3 && !payload.withinBytes(r,8192))return null;
          if(r.kind==='b1_dispatch'){
            if(!v3 || !dictionary(r,['kind','before','after','recording','dispatchOrdinal','observerInstallationOrdinal','readerGenerationOrdinal',
              'status','sample','route','witnessBefore','witnessAfter']) || !number(r.before)||!number(r.after)||r.after<r.before
              || !Number.isSafeInteger(r.dispatchOrdinal)||r.dispatchOrdinal<1||r.dispatchOrdinal>1000000
              || r.observerInstallationOrdinal!==null&&(!integer(r.observerInstallationOrdinal)||r.observerInstallationOrdinal<1||r.observerInstallationOrdinal>1000000)
              || !integer(r.readerGenerationOrdinal)||r.readerGenerationOrdinal<1||r.readerGenerationOrdinal>1000000
              || !['returned','threw'].includes(r.status))return null;
            const sample=payload.sampleOf(r.sample),route=payload.routeOf(r.route),a=attestationOf(r.witnessBefore,doc.provider),b=attestationOf(r.witnessAfter,doc.provider);
            return sample&&route&&route.provider===doc.provider&&a&&b&&r.before<=a.before&&a.after<=b.before&&b.after<=r.after
              && route.kind===sample.scopeKind ? {...r,sample,route,witnessBefore:a,witnessAfter:b,recording}:null;
          }
          if (r.kind === 'structure_inventory') {
            if (!modern || !dictionary(body,['kind','before','after','inventory']) || !number(r.before) || !number(r.after) || r.after < r.before) return null;
            const inventory = inventoryOf(r.inventory,doc.provider);
            return inventory ? {kind:'structure_inventory',before:r.before,after:r.after,inventory,recording} : null;
          }
          if (r.kind === 'dom') {
            if (!dictionary(body,['kind','before','after','sample']) || !number(r.before) || !number(r.after) || r.after < r.before) return null;
            const sample = domOf(r.sample); return sample && sample.provider === doc.provider && (!v3 || Object.values(sample.counts).every(n=>n<=200)) ? {kind:'dom',before:r.before,after:r.after,sample,recording} : null;
          }
          if (r.kind === 'stage') {
            const fields = fieldsOf(r.fields);
            return dictionary(body,['kind','at','stage','fields']) && number(r.at) && STAGES.includes(r.stage) && fields
              ? {kind:'stage',at:r.at,stage:r.stage,fields,recording} : null;
          }
          if (r.kind === 'observation') {
            const observation = observationOf(r.observation);
            return dictionary(body,['kind','at','observation']) && number(r.at) && observation ? {kind:'observation',at:r.at,observation,recording} : null;
          }
          return r.kind === 'capture_error' && dictionary(body,['kind','at']) && number(r.at) ? {kind:'capture_error',at:r.at,recording} : null;
        });
        if (copied.some(r => !r)) return reject('invalid_schema');
        let finalDispatchOrdinal=doc.lastDispatchOrdinal,finalPage=doc.seriesPage,finalSeriesSequence=doc.lastSeriesSequence;
        for(const row of copied)if(row.kind==='b1_dispatch'){
          if(row.dispatchOrdinal<=finalDispatchOrdinal || doc.readerGeneration!==null && row.readerGenerationOrdinal!==doc.readerGeneration)return reject('batch_duplicate');
          if(finalPage===row.sample.pageInstanceId && row.sample.contentSequence<=finalSeriesSequence)return reject('batch_duplicate');
          if(finalPage && finalPage!==row.sample.pageInstanceId)series.failure('namespace_changed');
          finalPage=row.sample.pageInstanceId;finalSeriesSequence=row.sample.contentSequence;
          finalDispatchOrdinal=row.dispatchOrdinal;
        }
        if (doc.inventories + copied.filter(r => r.kind === 'structure_inventory').length > 3) return reject('structure_inventory_failed');
        if (entries.length + copied.length > maxEntries) { haltCapture('capacity'); return reject('capacity'); }
        if(v3 && entries.length+copied.length+links.length+series.capacityRequired(copied.filter(r=>r.kind==='b1_dispatch').length)>maxEntries){haltCapture('capacity');return reject('capacity');}
        const sampleKeys = new Set();
        for (const r of copied) if (r.kind === 'observation') {
          const raw = sampleKey(r.observation);
          if (sampleKeys.has(raw) || observations.has(raw)) return reject('sample_duplicate');
          sampleKeys.add(raw);
        }
        if (observations.size + sampleKeys.size > maxEntries) return reject('capacity');
        if (modern) {
          if (m.batchSequence !== doc.lastBatchSequence + 1) fail('batch_gap');
          doc.lastBatchSequence = m.batchSequence;
          for (const r of cleanReports) { const delta = r.count - doc.failures[r.category].count;
            if (delta) fail(r.category,failureTime(),delta);
            doc.failures[r.category] = {count:r.count,firstAt:r.firstAt,lastAt:r.lastAt}; }
        }
        if (m.missing && !cleanReports.length) fail('batch_missing');
        if(v3){
          const rows=[],updates=[];
          for(const r of copied){
            const common={tabOrdinal:doc.tabOrdinal,documentOrdinal:doc.documentOrdinal,recording:r.recording};
            if(r.kind==='b1_dispatch')rows.push({...series.preview(r),...common});
            else if(r.kind==='observation'){
              const sampleOrdinal=++sampleCount,raw=sampleKey(r.observation);
              rows.push({kind:'observation',...common,at:r.at,sampleOrdinal,pageOrdinal:ordinal(pages,r.observation.pageInstanceId),contentSequence:r.observation.contentSequence});
              updates.push(()=>{observations.set(raw,{observation:r.observation,doc,sampleOrdinal});for(const link of linksBySample.get(raw)||[])correlateLink(link);});
            }else if(r.kind==='dom')rows.push({kind:'dom',...common,domSampleOrdinal:++domCount,before:r.before,after:r.after,...r.sample});
            else if(r.kind==='structure_inventory'){rows.push({kind:'structure_inventory',...common,before:r.before,after:r.after,inventory:r.inventory});updates.push(()=>{inventories++;doc.inventories++;});}
            else if(r.kind==='stage')rows.push({kind:'content_stage',...common,at:r.at,stage:r.stage,...r.fields});
            else rows.push({kind:'capture_error',...common,at:r.at});
          }
          const committedAt=timestamp();if(committedAt===null)return reject('expired');
          for(const row of rows)entries.push({...row,recording:row.recording&&!missing&&started!==null});
          if(rows.length)lastRecordAt=committedAt;
          for(const update of updates)update();
          for(const row of copied)if(row.kind==='b1_dispatch'){
            const nonrecordingCause=missing||halted||disposed?'capture_unknown':started===null?'waiting':m.workerCaptureToken===null?'unbound':null;
            series.dispatch(row,doc,nonrecordingCause===null,true,nonrecordingCause);
          }
          doc.workerBound=true;doc.batchResults.v3.accepted=Math.min(1000000,doc.batchResults.v3.accepted+1);
          doc.lastDispatchOrdinal=finalDispatchOrdinal;
          doc.seriesPage=finalPage;doc.lastSeriesSequence=finalSeriesSequence;
          if(doc.readerGeneration===null)doc.readerGeneration=copied.find(r=>r.kind==='b1_dispatch')?.readerGenerationOrdinal || null;
          batches.recordsAccepted=Math.min(1000000,batches.recordsAccepted+copied.length);
          respond({ok:true,recording:started!==null&&!halted&&!missing&&!disposed,acceptedRecords:copied.length,workerCaptureToken,reason:'none'});
          if(!doc.probeCount)void probeDocument(doc);return false;
        }
        let acceptedRecords = 0;
        for (const r of copied) {
          if (halted || disposed) break;
          const common = {tabOrdinal:doc.tabOrdinal,documentOrdinal:doc.documentOrdinal,recording:r.recording};
          let accepted = false;
          if (r.kind === 'observation') {
            const raw = sampleKey(r.observation);
            const sampleOrdinal = ++sampleCount;
            observations.set(raw,{observation:r.observation,doc,sampleOrdinal});
            accepted = append({kind:'observation',...common,at:r.at,sampleOrdinal,pageOrdinal:ordinal(pages,r.observation.pageInstanceId),contentSequence:r.observation.contentSequence});
            for (const link of linksBySample.get(raw) || []) correlateLink(link);
          } else if (r.kind === 'dom') accepted = append({kind:'dom',...common,domSampleOrdinal:++domCount,before:r.before,after:r.after,...r.sample});
          else if (r.kind === 'structure_inventory') {
            accepted = append({kind:'structure_inventory',...common,before:r.before,after:r.after,inventory:r.inventory});
            if (accepted) { inventories++; doc.inventories++; }
          }
          else if (r.kind === 'stage') accepted = append({kind:'content_stage',...common,at:r.at,stage:r.stage,...r.fields});
          else { if (!cleanReports.length) fail('capture_failed'); accepted = append({kind:'capture_error',...common,at:r.at}); }
          if (accepted) { acceptedRecords++; batches.recordsAccepted = Math.min(1000000,batches.recordsAccepted + 1); }
        }
        const ok = acceptedRecords === copied.length;
        if (!ok) batches.rejected = Math.min(1000000,batches.rejected + 1);
        const resultKey = ok ? 'accepted' : 'rejected';
        doc.batchResults[versionKey][resultKey] = Math.min(1000000,doc.batchResults[versionKey][resultKey] + 1);
        respond(modern ? {ok,recording:started !== null && !halted && !missing && !disposed,acceptedRecords} : {ok});
        if (!doc.probeCount) void probeDocument(doc);
      } catch (_) { fail(); }
      return false;
    }
    chrome.runtime.onMessage.addListener(listener);
    if(enableSeries){
      const updated=(tabId,change)=>{
        if(disposed||halted||!integer(tabId)||!currentDocuments.has(tabId)&&!registeredDocuments.has(tabId)||!change)return;
        let reason=change.status==='loading'?'loading':change.discarded===true?'discarded':change.frozen===true?'frozen':null;
        if(!reason&&typeof change.url==='string'){
          try {const url=new URL(change.url);if(url.protocol!=='https:'||url.username||url.password||url.port||!['chatgpt.com','claude.ai'].includes(url.hostname))reason='unsupported_origin';}
          catch{reason='unsupported_origin';}
        }
        if(reason)retireProbeTab(tabId,reason);
      };
      const removed=tabId=>retireProbeTab(tabId,'tab_closed');
      for(const [event,callback]of [[chrome.tabs?.onUpdated,updated],[chrome.tabs?.onRemoved,removed]]){
        if(event?.addListener&&event?.removeListener){event.addListener(callback);lifecycleListeners.push([event,callback]);}
      }
    }
    const bootstrappedAt = timestamp();
    function sweepPrivate(){
      if(!enableSeries)return;
      series.sweep();const at=failureTime();
      for(const tabId of registeredDocuments.keys())registrationFor(tabId);
      for(const [ref,item]of wireRecords)if(at===null||at>=item.deadline){wireRecords.delete(ref);series.failure('pending_expired');}
      for(const [ref,item]of expectedSends)if(at===null||at-item.at>30000){expectedSends.delete(ref);series.failure('send_unverified');}
      for(const socket of sockets){
        const removed=new Set(socket.events.filter(item=>at===null||at-item.before>30000));
        for(const item of removed){
          if(item.ack===null||item.ackProof&&!item.current&&!item.strictNonCurrentComplete)series.failure('pending_expired');
          const identity=identityKey(item.event),rest=(eventsByIdentity.get(identity)||[]).filter(entry=>entry.sent!==item);
          if(rest.length)eventsByIdentity.set(identity,rest);else eventsByIdentity.delete(identity);
        }
        socket.events=socket.events.filter(item=>!removed.has(item));
      }
      for(const map of [scopes,pages,turns]){
        const times=ordinalTimes.get(map);if(times)for(const [key,when]of times)if(at===null||at-when>=30000){times.delete(key);map.delete(key);}
      }
      if(halted){
        removeLifecycleListeners();
        clearInterval(retentionTimer);clearInterval(probeTimer);series.dispose();wireRecords.clear();expectedSends.clear();
        for(const socket of [...sockets])releaseSocket(socket);
        for(const map of [scopes,pages,turns,tabs]){map.clear();ordinalTimes.get(map)?.clear();}
        for(const doc of documents.values())releasedContentFailures.push(contentDiagnostic(doc));
        documents.clear();currentDocuments.clear();registeredDocuments.clear();links.length=0;observations.clear();eventsByIdentity.clear();linksBySample.clear();linksByEvent.clear();
      }
    }
    const retentionTimer=enableSeries?setInterval(sweepPrivate,1000):null;
    const probeTimer = setInterval(() => { sweepPrivate(); if (started !== null) void probeClocks(); },10000);
    function contentDiagnostic(doc){return {tabOrdinal:doc.tabOrdinal,documentOrdinal:doc.documentOrdinal,clockOrigin:doc.clockOrigin,
      failureReporting:doc.batchVersions.v3?doc.batchVersions.v1||doc.batchVersions.v2?'mixed':'v3_only':doc.batchVersions.v1?doc.batchVersions.v2?'mixed':'legacy_only':doc.batchVersions.v2?'v2_only':'none',
      batchVersions:{v1:doc.batchVersions.v1,v2:doc.batchVersions.v2,...(enableSeries?{v3:doc.batchVersions.v3}:{})},
      batchResults:{v1:{...doc.batchResults.v1},v2:{...doc.batchResults.v2},...(enableSeries?{v3:{...doc.batchResults.v3}}:{})},
      failures:Object.fromEntries(FAILURES.map(category=>[category,{...doc.failures[category]}]))};}
    function snapshot() {
      timestamp();
      sweepPrivate();
      const measuredSeries=series?.summary() || null,measuredChannel=channel?.snapshot() || null;
      let state = null;
      try { state = dictionary(workerStateReader?.(),['initialized','paired','enabled','pendingControl','fatal','transportReady']);
        if (state && Object.values(state).some(v => typeof v !== 'boolean')) state = null; } catch (_) {}
      const elapsedMs = started === null || last === null || failures.clock_unavailable.count || failures.clock_invalid.count || failures.clock_reversed.count
        ? null : Math.max(0,last - started);
      const remainingMs = started === null ? maxDurationMs : elapsedMs === null ? null : Math.max(0,maxDurationMs - elapsedMs);
      const phase = missing || disposed || halted ? 'unknown' : started === null ? 'waiting' : 'recording';
      const reason = disposed ? 'disposed' : failures.expired.count ? 'expired' : failures.capacity.count ? 'capacity_exceeded'
        : missing || halted ? 'capture_incomplete' : !fingerprint ? 'missing_build_identity' : !state || !state.initialized ? 'initializing'
        : state.fatal ? 'storage_failed' : !state.paired ? 'unpaired' : !state.enabled || state.pendingControl ? 'paused'
        : !state.transportReady ? 'disconnected' : started === null ? 'waiting_authentication' : 'ready';
      return {v:1,environment:'native_chrome_capture',formalAcceptance:false,status:missing || disposed || halted ? 'unknown' : 'capturing',
        independentScopeVerified:false,currentDocumentVerified:false,linkStatus:'link_unverified',missing,disposed,clockOrigin:timeOrigin,
        runtime:{buildFingerprint:fingerprint,generationOrdinal,clockOrigin:timeOrigin,bootstrappedAt,workerSelfReported:true,loadedArtifactVerified:false},
        build:{contract:'native-measurement-v1',sourceFingerprint:fingerprint,fingerprintKind:'extension-inputs-sha256'},
        preflight:{phase,remainingMs,reason,canRecord:reason === 'ready',
          ...(state || {initialized:false,paired:false,enabled:false,pendingControl:false,fatal:false,transportReady:false})},
        capture:{phase,startedAt:started === null ? null : timeOrigin + started,
          maxDurationMs,maxEntries,elapsedMs,remainingMs,lastRecordAt},
        seriesEvidence:measuredSeries,channelEvidence:measuredChannel,
        failures:Object.fromEntries(FAILURES.map(category => [category,{...failures[category]}])),
        contentFailures:[...releasedContentFailures.map(row=>JSON.parse(JSON.stringify(row))),...[...documents.values()].map(contentDiagnostic)],
        limits:{maxActiveSockets:64,maxTotalConnections:null},
        socketClosures:{...socketClosures},
        batches:{...batches},counts:{records:entries.length,connections:connectionCount,activeConnections:sockets.size,activeSocketLimitHits,documents:documents.size+releasedContentFailures.length,samples:sampleCount,inventories},
        records:entries.map(r => JSON.parse(JSON.stringify(r)))};
    }
    return Object.freeze({sink,WebSocketClass:CapturedSocket,snapshot,
      probeClocks:() => probeClocks(true),
      dispose() {
        if (disposed) return;
        fail('disposed');
        disposed = true;
        clearInterval(probeTimer);
        clearInterval(retentionTimer);
        removeLifecycleListeners();
        chrome.runtime.onMessage.removeListener(listener);
        for (const socket of [...sockets]) releaseSocket(socket);
        for (const [timer,reject] of probes) { clearTimeout(timer); reject(new Error('native_capture_disposed')); }
        probes.clear(); documents.clear(); tabs.clear(); sockets.clear(); links.length = 0; observations.clear(); scopes.clear(); turns.clear(); pages.clear();
        eventsByIdentity.clear(); linksBySample.clear(); linksByEvent.clear();
        currentDocuments.clear(); registeredDocuments.clear(); pendingProbes.clear();
        workerStateReader = null;
        series?.dispose();channel?.dispose();wireRecords.clear();expectedSends.clear();referenceProvider=null;
      }});
  }
  return Object.freeze({createWorkerCapture});
});
