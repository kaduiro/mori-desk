/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
// Offline anonymous evidence only. A matching FIFO prefix is conditional on the
// local observations, authentication and isolation; it is never a direct ID or
// full-wire comparison. No product validator/author test oracle is imported.
const { dictionary: dict, arrayOf, equal } = require('./monitoring-independent-payload');
const count = n => Number.isSafeInteger(n) && n >= 0 && n <= 1000000;
const ordinal = n => count(n) && n > 0;
const nullableOrdinal = n => n === null || ordinal(n);
const time = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER;
const tri = n => n === null || typeof n === 'boolean';
const TYPES = ['hello','authenticate','pair.confirm','challenge','pair.ready','ready','ping','pong','client.health',
  'scope.event','event','scope.event.ack','scope.event.nack','event.ack','focus.request','focus.result','error','unknown'];
const PHASES = ['waiting','recording','unknown'];
const REASONS = ['cut_pending','target_not_reached','target_timeout','cut_mismatch','prefix_incomplete','prefix_mismatch',
  'prefix_validation_pending','case_outside_cut','multiple_authenticated_channels','connection_replaced','reconnected',
  'ping_ambiguous','send_failed','pending_ack','ack_timeout','duplicate_event','clock_unknown','expired','capacity',
  'local_comparison_unavailable','store_projection_only','suffix_incomplete','post_cut_failure','export_window_unobserved',
  'comparison_pending','capture_failed','invalid_schema','disposed','proof_unavailable','disconnected','control_changed','credential_changed','decode_failed'];
const SERIES_REASONS = ['none','pending','matched','mismatch','missing_hook','input_conflict','invocation_missing','event_conflict',
  'clone_unverified','send_unverified','pending_expired','stale_capture','ambiguous','namespace_changed','invalid_schema','capacity',
  'expired','disposed','metadata_excluded','non_sample_origin','transformed_payload','semantic_unavailable','proof_unavailable','proof_mismatch','capture_not_recording'];
const SERIES_EDGES = ['dispatch_ingress','ingress_reduction','reduction_assignment','queue_clone','queue_accept','outgoing_clone','transport_send','wire_ack'];
const SERIES_COUNTS = ['dispatches','ingresses','invocations','allocations','cloneEdges','wireEvents','acks','causalVerified','payloadVerified','contradictions','pending'];
function counts(value,keys,required=keys) {
  const d=dict(value,keys,required);
  return d && Object.values(d).every(count) ? d : null;
}
function summaryOf(value) {
  const d=dict(value,['clientMessageCount','serverMessageCount','clientTypeCounts','serverTypeCounts','eventCount','ackCount',
    'pendingCount','phaseCounts','complete','localStateAttributionExact','observedThrough']);
  if (!d || !['clientMessageCount','serverMessageCount','eventCount','ackCount','pendingCount'].every(k=>count(d[k]))
    || typeof d.complete !== 'boolean' || !tri(d.localStateAttributionExact) || d.observedThrough !== null && !time(d.observedThrough)) return null;
  const client=counts(d.clientTypeCounts,TYPES,[]),server=counts(d.serverTypeCounts,TYPES,[]),phases=counts(d.phaseCounts,PHASES);
  return client && server && phases ? {...d,clientTypeCounts:client,serverTypeCounts:server,phaseCounts:phases} : null;
}
function channelOf(value) {
  const c=dict(value,['contract','status','reason','strictDirectComparison','fullWireBytesVerified','formalAcceptance','independentScopeVerified',
    'selection','localConnectionOrdinal','authenticationGenerationOrdinal','capturedFromSocketStart','locallyAuthenticated',
    'singletonAuthenticated','cut','prefix','suffix','run','messages','pings']);
  if (!c || c.contract !== 'conditional-fifo-prefix-v2' || !['pending','unknown'].includes(c.status) || !REASONS.includes(c.reason)
    || !['strictDirectComparison','fullWireBytesVerified','formalAcceptance','independentScopeVerified'].every(k=>c[k]===false)
    || !nullableOrdinal(c.localConnectionOrdinal) || !nullableOrdinal(c.authenticationGenerationOrdinal)
    || !['capturedFromSocketStart','locallyAuthenticated','singletonAuthenticated'].every(k=>typeof c[k]==='boolean')) return null;
  const s=dict(c.selection,['strategy','targetPingOrdinal','frozenBeforeAuthentication']);
  const cut=c.cut===null ? null : dict(c.cut,['pingOrdinal','pingAt','clientMessageEnd','serverMessageEnd','rawPongComplete','productPongProcessed',
    'localPongLabelMatched','prefixValidationComplete','prefixEventCount','prefixAckCount','prefixPendingCount','state','boundaryAt','sealedAt']);
  const run=dict(c.run,['failureRevision','failureAfterCut','eligibility','exportSequence','exportAt','observedThrough','capturePhase']);
  if (!s || s.strategy !== 'precommitted-authenticated-ping-ordinal-v1' || !ordinal(s.targetPingOrdinal)
    || s.targetPingOrdinal < 2 || s.targetPingOrdinal > 60 || typeof s.frozenBeforeAuthentication !== 'boolean'
    || c.cut!==null && (!cut || !['pingOrdinal','clientMessageEnd','serverMessageEnd'].every(k=>nullableOrdinal(cut[k]))
    || cut.pingAt !== null && (!Number.isSafeInteger(cut.pingAt) || cut.pingAt < 0)
    || !['rawPongComplete','productPongProcessed','localPongLabelMatched','prefixValidationComplete'].every(k=>tri(cut[k]))
    || !['prefixEventCount','prefixAckCount','prefixPendingCount'].every(k=>count(cut[k]))
    || !['pending','sealed','invalid'].includes(cut.state) || !['boundaryAt','sealedAt'].every(k=>cut[k]===null||time(cut[k])))
    || !run || !count(run.failureRevision) || typeof run.failureAfterCut !== 'boolean' || !['eligible','unknown'].includes(run.eligibility)
    || !ordinal(run.exportSequence) || !time(run.exportAt) || run.observedThrough !== null && !time(run.observedThrough)
    || !PHASES.includes(run.capturePhase)) return null;
  const prefix=summaryOf(c.prefix),suffix=summaryOf(c.suffix),rows=arrayOf(c.messages,16384),pings=arrayOf(c.pings,16384);
  if (!prefix || !suffix || !rows || !pings) return null;
  const messages=[];
  for (const row of rows) {
    const m=dict(row,['connectionOrdinal','direction','messageOrdinal','typeCategory','membership','phase','eventOrdinal','pingOrdinal',
      'interval','localStateAttributionExact','channelProofExact','sendReturned','decisionComplete','currentAccepted']);
    if (!m || !ordinal(m.connectionOrdinal) || !ordinal(m.messageOrdinal) || !['client_to_server','server_to_client'].includes(m.direction)
      || !TYPES.includes(m.typeCategory) || !['prefix','suffix','boundary_pending'].includes(m.membership) || !PHASES.includes(m.phase)
      || !nullableOrdinal(m.eventOrdinal) || !nullableOrdinal(m.pingOrdinal)
      || !['localStateAttributionExact','channelProofExact','sendReturned','decisionComplete','currentAccepted'].every(k=>tri(m[k]))) return null;
    if (m.interval!==null) { const i=arrayOf(m.interval,2); if (!i || i.length!==2 || !i.every(time) || i[1]<i[0]) return null; }
    messages.push(m);
  }
  const parsedPings=[];
  for (const row of pings) {
    const p=dict(row,['connectionOrdinal','pingOrdinal','pingAt','clientMessageOrdinal','serverMessageOrdinal','sendReturned',
      'pongRawComplete','productPongProcessed','localPongLabelMatched']);
    if (!p || !ordinal(p.connectionOrdinal) || !ordinal(p.pingOrdinal) || !Number.isSafeInteger(p.pingAt) || p.pingAt<0
      || !ordinal(p.clientMessageOrdinal) || !nullableOrdinal(p.serverMessageOrdinal)
      || !['sendReturned','pongRawComplete','productPongProcessed','localPongLabelMatched'].every(k=>tri(p[k]))) return null;
    parsedPings.push(p);
  }
  return {...c,selection:s,cut,run,prefix,suffix,messages,pings:parsedPings};
}
function validLocal(c,worker) {
  if (!c.cut || c.status==='unknown' || c.selection.frozenBeforeAuthentication!==true || !c.capturedFromSocketStart || !c.locallyAuthenticated
    || !c.singletonAuthenticated || !ordinal(c.localConnectionOrdinal) || !ordinal(c.authenticationGenerationOrdinal)
    || c.run.failureRevision!==0 || c.run.failureAfterCut || c.run.eligibility!=='eligible' || c.run.capturePhase!=='recording'
    || c.cut.state!=='sealed' || !c.cut.rawPongComplete || !c.cut.localPongLabelMatched || !c.cut.prefixValidationComplete
    || worker && c.cut.productPongProcessed!==true || c.cut.pingOrdinal!==c.selection.targetPingOrdinal
    || !ordinal(c.cut.clientMessageEnd) || !ordinal(c.cut.serverMessageEnd) || c.cut.prefixPendingCount!==0
    || !c.prefix.complete || !c.suffix.complete || c.prefix.pendingCount!==0 || !time(c.cut.sealedAt)
    || !time(c.cut.boundaryAt) || c.cut.boundaryAt>c.cut.sealedAt || !time(c.run.observedThrough)
    || c.run.observedThrough<c.cut.sealedAt || c.run.exportAt<c.run.observedThrough
    || c.messages.some(m=>m.phase==='unknown'||['unknown','scope.event.nack','error','event','event.ack'].includes(m.typeCategory)
      || m.localStateAttributionExact===false || m.channelProofExact===false
      || m.typeCategory==='scope.event' && m.localStateAttributionExact!==true
      || m.interval!==null&&m.interval[1]>c.run.observedThrough)) return false;
  for (const direction of ['client_to_server','server_to_client']) {
    const rows=c.messages.filter(m=>m.direction===direction);
    const boundary=direction==='client_to_server'?c.cut.clientMessageEnd:c.cut.serverMessageEnd;
    if (rows.length<boundary || rows.some((m,i)=>m.messageOrdinal!==i+1 || m.connectionOrdinal!==c.localConnectionOrdinal
      || m.membership!==(m.messageOrdinal<=boundary?'prefix':'suffix') || m.interval===null
      || (worker ? direction==='client_to_server' : direction==='server_to_client') && m.sendReturned!==true)) return false;
  }
  const before=c.messages.filter(m=>m.membership==='prefix');
  if (before.some(m=>['scope.event','scope.event.ack'].includes(m.typeCategory) && m.localStateAttributionExact!==true
    || ['scope.event','scope.event.ack'].includes(m.typeCategory) && m.decisionComplete!==true
    || worker && ['scope.event','scope.event.ack'].includes(m.typeCategory) && (m.channelProofExact!==true || typeof m.currentAccepted!=='boolean'))) return false;
  const events=c.messages.filter(m=>m.typeCategory==='scope.event');
  const acks=c.messages.filter(m=>m.typeCategory==='scope.event.ack');
  if (c.messages.some(m=>!['scope.event','scope.event.ack'].includes(m.typeCategory)&&m.eventOrdinal!==null)
    || c.messages.some(m=>['scope.event','scope.event.ack','ping','pong'].includes(m.typeCategory)&&m.phase!=='recording')) return false;
  if (events.some((m,i)=>m.direction!=='client_to_server'||m.eventOrdinal!==i+1)
    || acks.some(m=>m.direction!=='server_to_client'||!ordinal(m.eventOrdinal)
      || events.filter(e=>e.eventOrdinal===m.eventOrdinal).length!==1
      || acks.filter(a=>a.eventOrdinal===m.eventOrdinal).length!==1)
    || before.filter(m=>m.typeCategory==='scope.event').some(e=>
      before.filter(a=>a.typeCategory==='scope.event.ack'&&a.eventOrdinal===e.eventOrdinal).length!==1)
    || before.filter(m=>m.typeCategory==='scope.event.ack').some(a=>
      before.filter(e=>e.typeCategory==='scope.event'&&e.eventOrdinal===a.eventOrdinal).length!==1)) return false;
  function consistent(rows,s) {
    const n=type=>rows.filter(r=>r.typeCategory===type).length;
    if (s.clientMessageCount!==rows.filter(r=>r.direction==='client_to_server').length
      || s.serverMessageCount!==rows.filter(r=>r.direction==='server_to_client').length
      || s.eventCount!==n('scope.event')+n('event') || s.ackCount!==n('scope.event.ack')+n('event.ack')) return false;
    for (const phase of PHASES) if (s.phaseCounts[phase]!==rows.filter(r=>r.phase===phase).length) return false;
    for (const [direction,field] of [['client_to_server','clientTypeCounts'],['server_to_client','serverTypeCounts']])
      for (const type of TYPES) if ((s[field][type]||0)!==rows.filter(r=>r.direction===direction&&r.typeCategory===type).length) return false;
    return true;
  }
  if (!consistent(before,c.prefix) || !consistent(c.messages.filter(m=>m.membership==='suffix'),c.suffix)
    || c.cut.prefixEventCount!==c.prefix.eventCount || c.cut.prefixAckCount!==c.prefix.ackCount
    || c.prefix.observedThrough!==c.run.observedThrough || c.suffix.observedThrough!==c.run.observedThrough) return false;
  const suffixEvents=events.filter(e=>e.membership==='suffix');
  const notAcked=suffixEvents.filter(e=>!acks.some(a=>a.eventOrdinal===e.eventOrdinal)).length;
  if (c.suffix.pendingCount<notAcked || c.suffix.pendingCount>suffixEvents.length) return false;
  // Recompute expired pending evidence from observed intervals as well as the
  // exporter flags. Healthy claims cannot hide an already elapsed ACK budget.
  if (suffixEvents.some(e=>{
    const ack=acks.find(a=>a.eventOrdinal===e.eventOrdinal);
    return !ack ? c.run.observedThrough-e.interval[1]>5000
      : (ack.decisionComplete!==true || e.decisionComplete!==true) && c.run.observedThrough-ack.interval[1]>5000;
  })) return false;
  if (c.pings.some((p,i)=>p.pingOrdinal!==i+1 || p.connectionOrdinal!==c.localConnectionOrdinal
    || i>0&&p.pingAt<=c.pings[i-1].pingAt
    || c.messages.filter(m=>m.direction==='client_to_server'&&m.typeCategory==='ping'&&m.pingOrdinal===p.pingOrdinal
      &&m.messageOrdinal===p.clientMessageOrdinal).length!==1
    || p.serverMessageOrdinal!==null && c.messages.filter(m=>m.direction==='server_to_client'&&m.typeCategory==='pong'
      &&m.pingOrdinal===p.pingOrdinal&&m.messageOrdinal===p.serverMessageOrdinal).length!==1)
    || c.messages.filter(m=>m.direction==='client_to_server'&&m.typeCategory==='ping').length!==c.pings.length
    || c.messages.filter(m=>m.direction==='server_to_client'&&m.typeCategory==='pong').length!==c.pings.filter(p=>p.serverMessageOrdinal!==null).length) return false;
  const pings=c.pings.filter(p=>p.pingOrdinal<=c.selection.targetPingOrdinal);
  if (pings.length!==c.selection.targetPingOrdinal || pings.some((p,i)=>p.pingOrdinal!==i+1
    || p.connectionOrdinal!==c.localConnectionOrdinal || i>0&&p.pingAt<=pings[i-1].pingAt
    || worker&&p.sendReturned!==true || !p.pongRawComplete || !p.localPongLabelMatched || worker&&p.productPongProcessed!==true
    || c.messages.filter(m=>m.direction==='client_to_server'&&m.messageOrdinal===p.clientMessageOrdinal&&m.typeCategory==='ping'&&m.pingOrdinal===p.pingOrdinal).length!==1
    || c.messages.filter(m=>m.direction==='server_to_client'&&m.messageOrdinal===p.serverMessageOrdinal&&m.typeCategory==='pong'&&m.pingOrdinal===p.pingOrdinal).length!==1)) return false;
  const last=pings.at(-1);
  return last.pingAt===c.cut.pingAt && last.clientMessageOrdinal===c.cut.clientMessageEnd && last.serverMessageOrdinal===c.cut.serverMessageEnd;
}
function analyzeChannelEvidence(worker,desktop) {
  const base={contract:'conditional-fifo-prefix-v2',status:'unknown',reason:'evidence_unavailable',
    strictDirectComparison:false,fullWireBytesVerified:false,formalAcceptance:false,independentScopeVerified:false,
    observationWindow:'each_export_only',futureFailuresExcluded:false};
  const w=channelOf(worker),d=channelOf(desktop);
  if (!w||!d) return {...base,reason:worker==null||desktop==null?'evidence_unavailable':'invalid_schema'};
  if (!validLocal(w,true)||!validLocal(d,false)) return {...base,reason:'local_evidence_incomplete'};
  const sameCut=w.selection.targetPingOrdinal===d.selection.targetPingOrdinal
    && w.cut.pingOrdinal===d.cut.pingOrdinal && w.cut.pingAt===d.cut.pingAt
    && w.cut.clientMessageEnd===d.cut.clientMessageEnd && w.cut.serverMessageEnd===d.cut.serverMessageEnd;
  if (!sameCut) return {...base,reason:'cut_mismatch'};
  const project=m=>({direction:m.direction,messageOrdinal:m.messageOrdinal,typeCategory:m.typeCategory,eventOrdinal:m.eventOrdinal,pingOrdinal:m.pingOrdinal});
  const canonical=rows=>rows.filter(m=>m.membership==='prefix').map(project)
    .sort((a,b)=>a.direction.localeCompare(b.direction)||a.messageOrdinal-b.messageOrdinal);
  const pingProject=p=>({pingOrdinal:p.pingOrdinal,pingAt:p.pingAt,clientMessageOrdinal:p.clientMessageOrdinal,serverMessageOrdinal:p.serverMessageOrdinal});
  const wp=w.pings.filter(p=>p.pingOrdinal<=w.selection.targetPingOrdinal).map(pingProject);
  const dp=d.pings.filter(p=>p.pingOrdinal<=d.selection.targetPingOrdinal).map(pingProject);
  const wm=canonical(w.messages),dm=canonical(d.messages);
  const sameMessages=wm.length===dm.length && wm.every((row,i)=>Object.keys(row).every(k=>row[k]===dm[i][k]));
  if (!sameMessages||!equal(wp,dp)) return {...base,status:'mismatch',reason:'prefix_mismatch'};
  return {...base,status:'conditional_match',reason:'matching_precommitted_prefix',
    targetPingOrdinal:w.selection.targetPingOrdinal,clientMessageCount:w.cut.clientMessageEnd,serverMessageCount:w.cut.serverMessageEnd,
    prefixEventCount:w.prefix.eventCount,prefixAckCount:w.prefix.ackCount,
    suffixCounts:{workerClient:w.suffix.clientMessageCount,workerServer:w.suffix.serverMessageCount,
      desktopClient:d.suffix.clientMessageCount,desktopServer:d.suffix.serverMessageCount},
    observationWindow:'historical_cut_with_separate_suffix_endpoints'};
}
function analyzeSeriesEvidence(value,records) {
  const base={contract:'independent-series-v3',status:'unavailable',formalAcceptance:false,fullChainVerified:false,
    semanticCompleteness:'unverified',edgeCountsArePartial:true};
  if (!value) return base;
  const s=dict(value,['v','contract','status','formalAcceptance','semanticCompleteness','counts','reasonCounts']);
  const c=s&&counts(s.counts,SERIES_COUNTS),reasons=s&&counts(s.reasonCounts,SERIES_REASONS,[]);
  if (!s||s.v!==1||s.contract!==base.contract||!['collecting','unknown'].includes(s.status)||s.formalAcceptance!==false
    ||s.semanticCompleteness!=='unverified'||!c||!reasons||!Array.isArray(records)||records.length>16384)
    return {...base,status:'unknown',reason:'invalid_schema'};
  const edges=[],samples=[];
  for (const row of records) {
    if (row?.kind==='series_edge') {
      const e=dict(row,['kind','edgeOrdinal','at','recording','edge','dispatchOrdinal','ingressOrdinal','invocationOrdinal',
        'allocationOrdinal','connectionOrdinal','eventOrdinal','ownerScopeMatch','payloadExact','causalExact','proofExact','reason']);
      if (!e||!ordinal(e.edgeOrdinal)||!time(e.at)||typeof e.recording!=='boolean'||!SERIES_EDGES.includes(e.edge)
        ||!['dispatchOrdinal','ingressOrdinal','invocationOrdinal','allocationOrdinal','connectionOrdinal','eventOrdinal'].every(k=>nullableOrdinal(e[k]))
        ||!['ownerScopeMatch','payloadExact','causalExact','proofExact'].every(k=>tri(e[k]))||!SERIES_REASONS.includes(e.reason))
        return {...base,status:'unknown',reason:'invalid_schema'};
      edges.push(e);
    } else if (row?.kind==='series_sample') {
      const sampleKeys=['kind','dispatchOrdinal','at','recording','witnessBeforeOrdinal','witnessAfterOrdinal','ownerOrdinal','semanticVerdict'];
      const d=dict(row,[...sampleKeys,'tabOrdinal','documentOrdinal'],sampleKeys);
      const v=d&&dict(d.semanticVerdict,['signal','state','outcome']);
      if (!d||!ordinal(d.dispatchOrdinal)||!time(d.at)||typeof d.recording!=='boolean'
        || Object.hasOwn(d,'tabOrdinal')!==Object.hasOwn(d,'documentOrdinal')
        || Object.hasOwn(d,'tabOrdinal')&&(!ordinal(d.tabOrdinal)||!ordinal(d.documentOrdinal))
        ||!['witnessBeforeOrdinal','witnessAfterOrdinal','ownerOrdinal'].every(k=>nullableOrdinal(d[k]))
        ||!v||!['running_observed','quiet_observed','unknown'].includes(v.signal)||!['compatible','contradicted','unknown'].includes(v.state)||v.outcome!=='unknown')
        return {...base,status:'unknown',reason:'invalid_schema'};
      samples.push({...d,semanticVerdict:v});
    }
  }
  if (new Set(edges.map(e=>e.edgeOrdinal)).size!==edges.length) return {...base,status:'unknown',reason:'ambiguous'};
  const active=edges.filter(e=>e.recording);
  const contradiction=e=>[e.ownerScopeMatch,e.causalExact,e.proofExact].includes(false)
    || e.payloadExact===false&&e.reason!=='transformed_payload';
  const missing=new Set(['mismatch','missing_hook','input_conflict','invocation_missing','event_conflict','clone_unverified',
    'send_unverified','pending_expired','stale_capture','ambiguous','namespace_changed','invalid_schema','capacity','expired','disposed',
    'proof_unavailable','proof_mismatch']);
  const semanticContradictions=samples.filter(s=>s.recording&&s.semanticVerdict.state==='contradicted').length;
  const incomplete=active.some(e=>contradiction(e)||missing.has(e.reason)) || semanticContradictions>0;
  return {...base,status:s.status==='collecting'&&!incomplete?'partial':'unknown',reportedCounts:c,reasonCounts:reasons,
    observed:{edges:edges.length,recordingEdges:active.length,samples:samples.length,
      causalTrue:active.filter(e=>e.causalExact===true).length,payloadTrue:active.filter(e=>e.payloadExact===true).length,
      contradictions:active.filter(contradiction).length,
      transformedPayloadDifferences:active.filter(e=>e.payloadExact===false&&e.reason==='transformed_payload').length,semanticContradictions},
    reason:'individual_edges_only'};
}
module.exports={analyzeChannelEvidence,analyzeSeriesEvidence};
