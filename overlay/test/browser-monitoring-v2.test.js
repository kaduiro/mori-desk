/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
// Synthetic contract tests. These do not certify provider DOM or native UI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const protocol = require('../src/browser-bridge-protocol');
const { createObservationProofs } = require('../src/browser-observation-proofs');
const { createBrowserSessionStore } = require('../src/browser-session-store');
const coordinator = require('../extensions/browser-bridge/session-coordinator');
const outbox = require('../extensions/browser-bridge/outbox');
const health = require('../extensions/browser-bridge/restart-health');
const contract = require('../extensions/browser-bridge/monitoring-contract');

const scope = (overrides = {}) => ({ kind: 'conversation', viewEpoch: 'view-a', bindingEpoch: 'binding-a',
  samplingEpoch: 'sampling-a', workerEpoch: 'worker-a', leaseId: 'lease-a', documentId: 'document-a', startUnobserved: false, ...overrides });
const event = (overrides = {}) => ({ type: 'scope.event', v: 1, schema: 2, scope: scope(), gap: null,
  eventId: 'event-a', browserRunId: 'run-a', sessionId: 'session-a', sequence: 1, kind: 'observation',
  provider: 'chatgpt', tabId: 1, pageInstanceId: 'page-a', routeRevision: 0, conversationRef: '/c/a',
  turnId: null, generation: 0, phase: 'idle', outcome: null, observation: 'fresh', observedAt: 1000,
  replay: false, conversationTitle: '', requestPreview: '', ...overrides });
const peer = { capabilities: [...contract.CAPABILITIES] };
function storeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mori-v2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = 1000;
  const store = createBrowserSessionStore({ dataDir: dir, now: () => time });
  store.connect('client-a', 'run-a');
  return { dir, store, setTime: value => { time = value; } };
}

test('v2 scope schema rejects metadata in view, extra fields and false canonical identities', () => {
  const view = event({ scope: scope({ kind: 'view' }), conversationRef: null });
  assert.equal(protocol.validateEvent(view).scope.kind, 'view');
  assert.throws(() => protocol.validateEvent({ ...view, requestPreview: 'unbound text' }));
  assert.throws(() => protocol.validateEvent({ ...view, conversationRef: '/c/a' }));
  assert.throws(() => protocol.validateEvent({ ...view, draft: 'forbidden' }));
  assert.throws(() => protocol.validateEvent(event({ conversationRef: null })));
  assert.throws(() => protocol.validateEvent({ ...event(), type: 'event' }));
});

test('durable store distinguishes a new commit, ignored ordering and durable terminal duplicate', t => {
  const { store, dir } = storeFixture(t);
  assert.equal(store.ingest('client-a', event()).disposition, 'committed_current');
  assert.equal(store.ingest('client-a', event({ eventId: 'other-id' })).disposition, 'ignored_order');
  const terminal = event({ kind: 'terminal', phase: 'settled', outcome: 'unverified', turnId: 'turn-a', generation: 1, sequence: 2 });
  assert.equal(store.ingest('client-a', terminal).disposition, 'committed_current');
  assert.equal(store.ingest('client-a', { ...terminal, replay: true }).disposition, 'duplicate_durable');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'))).version, 2);
  assert.equal(store.getSnapshot()[0].unreadCount, 1);
});

test('an old browser run gap remains durable without manufacturing a completion', t => {
  const { store } = storeFixture(t);
  store.connect('client-a', 'run-b');
  const gap = event({ kind: 'gap', replay: true, observation: 'stale', phase: 'running',
    generation: 1, turnId: 'turn-a', gap: { turnId: 'turn-a', reason: 'sampling_gap', observedAt: 1000 } });
  store.ingest('client-a', gap);
  const row = store.getSnapshot()[0];
  assert.equal(row.unreadCount, 0); assert.equal(row.resultGaps.length, 1);
  assert.equal(store.ingest('client-a', gap).disposition, 'duplicate_durable');
});

test('view receipts cannot focus and exact manual acknowledgement preserves a later notice', t => {
  const { store } = storeFixture(t);
  const first = event({ scope: scope({ kind: 'view' }), conversationRef: null, phase: 'settled',
    kind: 'terminal', turnId: 'turn-a', generation: 1, outcome: 'unverified' });
  store.ingest('client-a', first);
  const row = store.getSnapshot()[0], captured = row.noticeSequence;
  assert.equal(row.canFocus, false); assert.equal(store.getFocusTarget(row.id), null);
  assert.match(row.statusLabel, /結果未検証/);
  store.ingest('client-a', { ...first, eventId: 'event-b', sequence: 2, turnId: 'turn-b', generation: 2 });
  assert.equal(store.ack(row.id, captured).ok, true);
  assert.equal(store.getSnapshot()[0].unreadCount, 1);
  assert.equal(store.dismiss(row.id).reason, 'unread_notice');
});

test('proofs are minted only for exact current commits and old scope gaps do not revoke a new scope', () => {
  let wall = 1000, mono = 0, n = 0;
  const proofs = createObservationProofs({ now: () => wall, monotonic: () => mono, uuid: () => `proof-${++n}` });
  const connection = { clientId: 'client-a' }, e = event();
  assert.equal(proofs.observe(connection, e, 'ignored_order').proof, null);
  assert.equal(proofs.observe(connection, { ...e, replay: true }, 'committed_current').proof, null);
  const p = proofs.observe(connection, e, 'committed_current').proof;
  assert.ok(p);
  const newer = event({ sessionId: 'session-b', scope: scope({ viewEpoch: 'view-b' }), eventId: 'event-b' });
  const p2 = proofs.observe(connection, newer, 'committed_current').proof;
  proofs.observe(connection, event({ kind: 'closed', observation: 'closed', replay: true }), 'committed_current');
  const h = { proofs: [p2], revokedProofs: [], browserRunId: 'run-a', workerEpoch: 'worker-a',
    providers: [{ provider: 'chatgpt', inventory: 'known', fresh: 1 }, { provider: 'claude', inventory: 'known', fresh: 0 }] };
  assert.equal(proofs.verifyHealth(connection, h), true);
  mono = 15001; wall = 16001;
  assert.equal(proofs.verifyHealth(connection, h), false);
});

test('proof revocation is exact and unknown inventory cannot claim a surviving token', () => {
  let n = 0;
  const p = createObservationProofs({ now: () => 1000, monotonic: () => 0, uuid: () => `p-${++n}` });
  const c = { clientId: 'client-a' }, token = p.observe(c, event(), 'committed_current').proof;
  const h = { proofs: [token], revokedProofs: [], browserRunId: 'run-a', workerEpoch: 'worker-a',
    providers: [{ provider: 'chatgpt', inventory: 'unknown', fresh: null }] };
  assert.equal(p.verifyHealth(c, h), false);
  assert.equal(p.verifyHealth(c, { ...h, proofs: [], revokedProofs: [token] }), true);
  assert.equal(p.verifyHealth(c, { ...h, providers: [{ provider: 'chatgpt', inventory: 'known', fresh: 1 }] }), false);
});

test('desktop admission is twenty physical tabs across profiles, without evicting an existing proof', () => {
  let n = 0;
  const p = createObservationProofs({ now: () => 1000, monotonic: () => 0, uuid: () => `p-${++n}` });
  const a = { clientId: 'profile-a' }, b = { clientId: 'profile-b' };
  for (let i = 0; i < 20; i++) assert.ok(p.observe(a, event({ tabId: i, sessionId: `s-${i}` }), 'committed_current').proof);
  assert.equal(p.observe(b, event(), 'committed_current').reason, 'desktop_capacity');
  p.observe(a, event({ tabId: 0, sessionId: 's-0', kind: 'closed', observation: 'closed', sequence: 2 }), 'committed_current');
  assert.ok(p.observe(b, event({ sequence: 2, eventId: 'retry' }), 'committed_current').proof);
});

test('a held v2 record never blocks another compatible v1 session and cannot reorder its own series', () => {
  const held = event({ kind: 'closed', observation: 'closed' });
  const { schema, scope: unused, gap, ...v1 } = event({ type: 'event', sessionId: 'legacy', eventId: 'legacy', kind: 'closed', observation: 'closed' });
  assert.equal(contract.selectDeliverable([held, v1], { capabilities: [] }), v1);
  assert.equal(contract.selectDeliverable([held, { ...held, sequence: 2 }], peer, new Set(['scope.event/run-a/session-a'])), null);
  const box = outbox.append({ v: 1, events: [] }, [held, v1]);
  assert.equal(box.v, 2); assert.equal(outbox.valid(box), true);
  assert.equal(outbox.acknowledge(box, { type: 'event.ack', ...held }).events.length, 2);
});

test('capacity context, sticky faults and disconnection have distinct causes', () => {
  assert.equal(contract.primaryReason('capacity', { owner: 'coordinator', resource: 'session_records' }), 'extension_record_limit');
  assert.equal(contract.primaryReason('capacity', { owner: 'coordinator', resource: 'active_tabs' }), 'extension_limit');
  assert.equal(contract.primaryReason('capacity'), 'capacity_unclassified');
  assert.equal(contract.primaryReason('binding_unconfirmed', { connected: false }), 'disconnected');
  assert.equal(contract.primaryReason('storage_failed', { connected: false }), 'storage_failed');
  assert.equal(contract.primaryReason('future_unknown'), 'unclassified');
});

test('local queue pressure preserves the deployed health-v2 wire reason vocabulary', () => {
  // Frozen 0.1.13 vocabulary: both ends enforce exact keys, including zeros.
  const deployed = 'storage_failed data_invalid authentication_failed schema_invalid paused unpaired disconnected permission_denied discarded frozen initializing loading navigation_pending unsupported_route unsupported_layout observer_version peer_unsupported extension_limit extension_record_limit desktop_capacity recovery_limit session_limit receipt_limit outbox_full capacity_unclassified conversation_id_pending scope_unconfirmed ambiguous_scope dom_unknown observation_rejected lease_pending observer_unavailable initialization_unconfirmed retry_wait retry_unavailable observation_pending delivery_pending observation_expired unclassified'.split(' ');
  assert.deepEqual(contract.REASONS, deployed);
  assert.equal(contract.primaryReason('observer_queue_full'), 'observer_unavailable');
  assert.equal(contract.REASON_LABELS.observer_queue_full, '拡張機能の観測処理が混雑');
});

test('hand-counted four-tab inventory separates fresh view from its scope annotation', () => {
  const tabs = [1,2,3,4].map(id => ({ id, url: `https://chatgpt.com/c/${id}`, status: 'complete' }));
  const results = new Map([[1,{ok:true}],[2,{ok:true}],[3,{ok:false,reason:'binding_unconfirmed'}],[4,{ok:false,reason:'tab_frozen'}]]);
  const r = health.summarizeV2(tabs, results, { evidence: new Map([[1,{proof:'p'}]]) })[0];
  assert.deepEqual([r.discovered,r.eligible,r.admitted,r.fresh,r.unmonitored], [4,4,2,1,3]);
  assert.equal(r.reasons.delivery_pending,1); assert.equal(r.reasons.scope_unconfirmed,1); assert.equal(r.reasons.frozen,1);
  assert.equal(Object.values(r.reasons).reduce((a,b)=>a+b,0),3);
});

test('sampling epoch replacement starts a different turn and start gaps persist as durable events', () => {
  let n = 0; const uuid = () => `generated-${++n}`;
  const input = { type: 'mori.observation', v: 2, pageInstanceId: 'page-a', contentSequence: 1,
    observedAt: 1000, status: 'running', generationToken: 'token-a', outcome: null,
    ...scope(), scopeKind: 'conversation', conversationTitle: '', requestPreview: '' };
  delete input.kind; delete input.documentId;
  const context = { tabId: 1, documentId: 'document-a', route: { provider: 'chatgpt', conversationRef: '/c/a' }, scope: scope({ startUnobserved: true }) };
  const first = coordinator.reduceObservation(coordinator.newState('run-a'), input, context, { uuid, now: 1000 });
  assert.equal(first.events.filter(e=>e.kind==='gap'&&e.gap.reason==='start_unobserved').length,1);
  const t1 = first.events.at(-1).turnId;
  const second = coordinator.reduceObservation(first.state, { ...input, contentSequence: 2, generationToken: 'token-b', samplingEpoch: 'sampling-b' },
    { ...context, scope: scope({ samplingEpoch: 'sampling-b', startUnobserved: true }) }, { uuid, now: 1000 });
  assert.notEqual(second.events.at(-1).turnId,t1);
  assert.equal(second.events.filter(e=>e.kind==='gap'&&e.gap.turnId===t1&&e.gap.reason==='sampling_gap').length,1);
});

test('a retired scope commit cannot replace the current physical tab proof', t => {
  const { store, setTime } = storeFixture(t);
  let n = 0;
  const p = createObservationProofs({ now: () => 2000, monotonic: () => 0, uuid: () => `p-${++n}` });
  const c = { clientId: 'client-a' };
  store.ingest(c.clientId, event()); setTime(2000);
  const newer = event({sessionId:'session-b',eventId:'event-b',observedAt:2000,scope:scope({viewEpoch:'view-b'})});
  const token = p.observe(c,newer,store.ingest(c.clientId,newer).disposition).proof;
  const old = event({sequence:2,eventId:'old-late',observedAt:1500});
  const result = store.ingest(c.clientId,old);
  assert.equal(result.disposition,'committed_receipt');
  assert.equal(p.observe(c,old,result.disposition).proof,null);
  assert.equal(p.verifyHealth(c,{proofs:[token],revokedProofs:[],browserRunId:'run-a',workerEpoch:'worker-a',
    providers:[{provider:'chatgpt',inventory:'known',fresh:1}]}),true);
});

test('explicit proof revocation changes the projection revision even when the health frame loses another token race', () => {
  const p = createObservationProofs({now:()=>1000,monotonic:()=>0,uuid:()=> 'proof-a'}), c={clientId:'client-a'};
  p.observe(c,event(),'committed_current'); const before=p.getRevision();
  assert.equal(p.verifyHealth(c,{revokedProofs:['proof-a'],proofs:['obsolete'],providers:[],browserRunId:'run-a',workerEpoch:'worker-a'}),false);
  assert.ok(p.getRevision()>before);
});

test('manual history cleanup frees records only after exact notice and gap acknowledgement; replay stays deduplicated', t => {
  const {store}=storeFixture(t);
  const terminal=event({kind:'terminal',phase:'settled',outcome:'unverified',turnId:'turn-a',generation:1});
  store.ingest('client-a',terminal); const row=store.getSnapshot()[0];
  assert.equal(store.dismiss(row.id).reason,'unread_notice'); store.ack(row.id,row.noticeSequence);
  const gap=event({eventId:'gap-a',sequence:2,kind:'gap',phase:'running',generation:2,turnId:'turn-b',observation:'stale',
    gap:{turnId:'turn-b',reason:'sampling_gap',observedAt:1000}});
  store.ingest('client-a',gap); assert.equal(store.dismiss(row.id).reason,'unread_gap');
  store.acknowledgeGap(row.id,'gap-a'); assert.equal(store.dismiss(row.id).ok,true);
  assert.equal(store.getStatus().sessions,0); assert.equal(store.getStatus().receipts,0);
  assert.equal(store.ingest('client-a',{...terminal,replay:true}).disposition,'duplicate_durable');
  assert.equal(store.ingest('client-a',{...gap,replay:true}).disposition,'duplicate_durable');
  assert.equal(store.getSnapshot().length,0);
  assert.throws(()=>store.ingest('client-a',{...terminal,observedAt:1001}),/event_id_conflict/);
  const later={...terminal,eventId:'late-receipt',sequence:3,turnId:'turn-c',generation:3,replay:true};
  store.ingest('client-a',later); assert.equal(store.getSnapshot()[0].unreadCount,1);
  assert.throws(()=>store.ingest('client-a',{...later,eventId:'forged-provider',provider:'claude',conversationRef:'/chat/a',tabId:99}),/session_identity_conflict/);
});

test('cleanup preserves a delivered closed fingerprint after a lost ACK',t=>{
  const {store}=storeFixture(t);const closed=event({kind:'closed',observation:'closed'});
  store.ingest('client-a',closed);const row=store.getSnapshot()[0];
  assert.equal(store.dismiss(row.id).ok,true);
  assert.equal(store.ingest('client-a',{...closed,replay:true}).disposition,'duplicate_durable');
  assert.equal(store.getSnapshot().length,0);
});

test('a new session missing from session storage is recovered from its durable journal as history', () => {
  const terminal=event({kind:'terminal',phase:'settled',outcome:'unverified',turnId:'turn-a',generation:1});
  const recovered=coordinator.recoverDurableEvents(coordinator.newState('run-a'),[terminal]);
  assert.equal(coordinator.validState(recovered),true); assert.equal(Object.keys(recovered.tabs).length,0);
  assert.equal(recovered.sessions['session-a'].closed,true);
  assert.equal(recovered.sessions['session-a'].observation,'stale');
  assert.deepEqual(coordinator.removeAcknowledgedClosed(recovered,terminal).sessions,{});
});

test('an idle view sampling renewal retains its scope record without inventing a new view or a receipt',()=>{
  let n=0;const uuid=()=>`view-${++n}`;
  const input={type:'mori.observation',v:2,pageInstanceId:'page-a',contentSequence:1,observedAt:1000,status:'idle',generationToken:null,outcome:null,
    ...scope(),scopeKind:'view',conversationTitle:'',requestPreview:''};delete input.kind;delete input.documentId;
  const context={tabId:1,documentId:'document-a',route:{provider:'chatgpt',path:'/c/a',conversationRef:'/c/a'},scope:scope({kind:'view'})};
  const first=coordinator.reduceObservation(coordinator.newState('run-a'),input,context,{uuid,now:1000});
  const second=coordinator.reduceObservation(first.state,{...input,pageInstanceId:'page-b',samplingEpoch:'sampling-b'},
    {...context,scope:scope({kind:'view',samplingEpoch:'sampling-b'})},{uuid,now:1000});
  assert.equal(Object.keys(second.state.sessions).length,1);assert.equal(second.state.tabs[1],first.state.tabs[1]);
  assert.equal(second.events.some(e=>['closed','terminal','gap'].includes(e.kind)),false);
});
