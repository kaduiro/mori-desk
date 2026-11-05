/* SPDX-License-Identifier: AGPL-3.0-only */
const crypto = require('node:crypto');
const contract = require('../extensions/browser-bridge/monitoring-contract');

function createObservationProofs({ now = Date.now, monotonic = () => performance.now(), uuid = () => crypto.randomUUID() } = {}) {
  const slots = new Map(), pending = new Map();
  // Classification metadata for an already verified health snapshot. This is
  // not another proof cache: no token is retained or accepted through it.
  const healthOwners = new WeakMap();
  let revision = 0;
  const key = (client, e) => `${client}/${e.browserRunId}/${e.tabId}`;
  function current(r) {
    const age = now() - r.observedAt, elapsed = monotonic() - r.receivedMono;
    return age >= 0 && age < contract.PROOF_MS && elapsed >= 0 && elapsed < contract.PROOF_MS
      && age <= contract.MAX_SAMPLE_GAP_MS && elapsed <= contract.MAX_SAMPLE_GAP_MS;
  }
  function expire() {
    for (const [k,r] of slots) if (!current(r)) { slots.delete(k); revision++; }
    for (const [k,r] of pending) if (monotonic() - r.seenAt >= contract.PROOF_MS) pending.delete(k);
  }
  function revokeConnection(connection) {
    for (const [k,r] of slots) if (r.connection === connection) slots.delete(k);
    for (const [k,r] of pending) if (r.connection === connection) pending.delete(k);
  }
  function observe(connection, e, disposition) {
    expire();
    const k = key(connection.clientId, e);
    if (e.kind === 'closed' || e.kind === 'gap' || e.observation !== 'fresh') {
      const slot = slots.get(k);
      // A durable replay from a retired view must not revoke this tab's new
      // scope. Historical receipts do not own current monitoring admission.
      if (disposition === 'committed_current' && slot?.sessionId === e.sessionId
        && slot.scope === contract.scopeOwnerKey(e.scope) && e.sequence >= slot.sequence) { slots.delete(k); revision++; }
      const waiting = pending.get(k);
      if (disposition === 'committed_current' && waiting?.sessionId === e.sessionId
        && waiting.scope === contract.scopeOwnerKey(e.scope)) pending.delete(k);
      return { proof: null, reason: null };
    }
    if (disposition !== 'committed_current' || e.replay || now() - e.observedAt < 0 || now() - e.observedAt >= contract.PROOF_MS) return { proof: null, reason: null };
    const existing = slots.get(k);
    if (!existing && (slots.size >= 20 || pending.size && pending.keys().next().value !== k)) {
      if (!pending.has(k) && pending.size < 200) pending.set(k, { connection, sessionId: e.sessionId,
        scope: contract.scopeOwnerKey(e.scope), at: monotonic(), seenAt: monotonic() });
      else if (pending.has(k)) Object.assign(pending.get(k), { seenAt: monotonic(), sessionId: e.sessionId, scope: contract.scopeOwnerKey(e.scope) });
      return { proof: null, reason: 'desktop_capacity' };
    }
    pending.delete(k);
    const record = { connection, proof: uuid(), provider: e.provider, browserRunId: e.browserRunId,
      workerEpoch: e.scope.workerEpoch, scope: contract.scopeOwnerKey(e.scope), sessionId: e.sessionId,
      pageInstanceId: e.pageInstanceId, routeRevision: e.routeRevision,
      eventId: e.eventId, sequence: e.sequence, observedAt: e.observedAt, receivedMono: monotonic() };
    slots.set(k, record);
    revision++;
    return { proof: record.proof, reason: null };
  }
  function verifyHealth(connection, health) {
    expire();
    for (const token of health.revokedProofs) {
      for (const [k,r] of slots) if (r.connection === connection && r.proof === token) { slots.delete(k); revision++; }
    }
    const received = new Set(health.proofs);
    const counts = { chatgpt: 0, claude: 0 };
    const owners = [];
    for (const token of received) {
      const [slotKey, r] = [...slots.entries()].find(([,v]) => v.proof === token) || [];
      if (!r || r.connection !== connection || r.browserRunId !== health.browserRunId || r.workerEpoch !== health.workerEpoch) return false;
      counts[r.provider]++;
      owners.push({ key: slotKey,
        index: health.proofs.indexOf(token), connection: r.connection, provider: r.provider,
        browserRunId: r.browserRunId, workerEpoch: r.workerEpoch, scope: r.scope, sessionId: r.sessionId,
        pageInstanceId: r.pageInstanceId, routeRevision: r.routeRevision,
        observedAt: r.observedAt, receivedMono: r.receivedMono });
    }
    for (const row of health.providers) if (row.inventory === 'known' && row.fresh !== counts[row.provider]
      || row.inventory === 'unknown' && counts[row.provider]) return false;
    // A health frame can have been queued before an event's ACK arrived.
    // Absence of its newly issued token cannot revoke that in-flight grant.
    // Explicit gap/closed observations and socket retirement revoke scope.
    healthOwners.set(health, owners);
    return true;
  }
  function projectHealth(connection, health) {
    expire();
    const next = structuredClone(health);
    const counts = { chatgpt: 0, claude: 0 };
    for (const r of slots.values()) if (r.connection === connection && health.proofs.includes(r.proof)) counts[r.provider]++;
    const reasons = { chatgpt: {}, claude: {} };
    for (const owner of healthOwners.get(health) || []) {
      const latest = slots.get(owner.key);
      if (latest?.connection === connection && latest.proof === health.proofs[owner.index]) continue;
      // Only an exact latest token can contribute to fresh. A newer commit
      // under this owner is awaiting its new health report, not time-expired.
      const sameOwner = latest && ['connection', 'provider', 'browserRunId', 'workerEpoch',
        'scope', 'sessionId', 'pageInstanceId', 'routeRevision'].every(field => latest[field] === owner[field]);
      const reason = sameOwner && latest.connection === connection ? 'delivery_pending'
        : latest || current(owner) ? 'observation_pending' : 'observation_expired';
      reasons[owner.provider][reason] = (reasons[owner.provider][reason] || 0) + 1;
    }
    for (const row of next.providers) {
      if (row.inventory !== 'known') continue;
      const missing = row.fresh - counts[row.provider];
      row.fresh = counts[row.provider]; row.unmonitored += missing;
      let classified = 0;
      for (const [reason, count] of Object.entries(reasons[row.provider])) {
        row.reasons[reason] = (row.reasons[reason] || 0) + count; classified += count;
      }
      // An unverified/unknown snapshot supplies no evidence about expiry.
      if (classified < missing) row.reasons.observation_pending = (row.reasons.observation_pending || 0) + missing - classified;
    }
    delete next.proofs;
    delete next.revokedProofs;
    return next;
  }
  return { observe, verifyHealth, projectHealth, revokeConnection, expire, getRevision: () => revision };
}
module.exports = { createObservationProofs };
