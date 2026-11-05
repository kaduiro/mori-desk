'use strict';

// Explicit development-only owner. Loading reads only this source fingerprint;
// it does not start a collector, open a data directory or install listeners.
// Run with the assembled runtime's dependencies (not a replacement bridge).
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { Receiver } = require('ws');
const { createBrowserBridge } = require('../src/browser-bridge-server');
const { createAckWitness } = require('./monitoring-independent-witness');
const payload = require('./monitoring-independent-payload');
const { createChannelCapture } = require('./monitoring-independent-channel');

const PORTS = Object.freeze([23337, 23336, 23335, 23334, 23333]);
let componentFingerprint = null;
try { componentFingerprint = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'); } catch {}
const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
const PAIRING_FAILURES = new Set(['expired', 'overflow', 'clock_invalid', 'clock_discontinuity', 'disposed',
  'directory_unavailable', 'secure_storage_unavailable', 'ports_unavailable', 'browser_store_unreadable',
  'credential_store_unreadable', 'bridge_unavailable']);
const EVENT_FIELDS = ['type', 'v', 'schema', 'eventId', 'browserRunId', 'sessionId', 'sequence', 'kind', 'provider',
  'tabId', 'pageInstanceId', 'routeRevision', 'conversationRef', 'turnId', 'generation', 'phase', 'outcome',
  'observation', 'observedAt', 'replay'];
const SCOPE_FIELDS = ['kind', 'viewEpoch', 'bindingEpoch', 'samplingEpoch', 'workerEpoch', 'leaseId', 'documentId', 'startUnobserved'];
const ROW_FIELDS = ['id', 'clientId', 'browserRunId', 'sessionId', 'provider', 'tabId', 'pageInstanceId', 'routeRevision',
  'conversationRef', 'currentTurnId', 'generation', 'lastSequence', 'lastObservationAt', 'phase', 'outcome',
  'observation', 'acceptedEventId', 'retired'];
const RECEIPT_FIELDS = ['id', 'eventId', 'turnId', 'generation', 'observedAt', 'outcome', 'noticeSequence'];
function wireDictionary(value,keys,ignored=[]) {
  try {
    if (!value||typeof value!=='object'||Array.isArray(value)) return null;
    const proto=Object.getPrototypeOf(value),names=Reflect.ownKeys(value);
    if (proto!==null&&proto!==Object.prototype||names.length>64||names.some(k=>typeof k!=='string'||!keys.includes(k)&&!ignored.includes(k))) return null;
    const d=Object.getOwnPropertyDescriptors(value);
    if (keys.some(k=>!Object.hasOwn(d,k))||names.some(k=>!Object.hasOwn(d[k],'value'))) return null;
    return Object.fromEntries(keys.map(k=>[k,d[k].value]));
  } catch { return null; }
}
function wireType(value) { try { const d=Object.getOwnPropertyDescriptor(value,'type');return d&&Object.hasOwn(d,'value')?d.value:null; } catch {return null;} }
const CATEGORIES = new Set(['partial_evidence', 'pending', 'nack', 'ack_unmatched', 'order_unverified', 'noncurrent_ack',
  'ack_schema_invalid', 'expected_event_invalid', 'expected_context_invalid', 'independent_evidence_unavailable',
  'connection_mismatch', 'event_mismatch', 'repeated_wire_ack', 'witness_capacity', 'snapshot_invalid', 'row_not_unique',
  'event_kind_conflict', 'terminal_receipt_missing', 'receipt_ack_invalid', 'receipt_identity_unverified',
  'event_not_current_observation', 'scope_mismatch', 'store_mismatch', 'current_proof_unavailable',
  'snapshot_or_interval_invalid', 'disconnected', 'connection_replaced', 'timeout', 'ambiguous', 'clock_invalid',
  'clock_discontinuity', 'overflow', 'expired', 'disposed', 'decode_failed', 'write_failed', 'store_unavailable']);
function pick(value, keys) { const out = {}; for (const key of keys) {
  const atom = value?.[key];
  out[key] = atom === null || typeof atom === 'boolean' || (typeof atom === 'number' && Number.isFinite(atom)) ||
    (typeof atom === 'string' && atom.length <= 256) ? atom : undefined;
} return out; }
function pickStoreRecord(value, keys) {
  const out = pick(value, keys), rawId = value?.id;
  // Only the private store's composite row/receipt ID exceeds the ordinary
  // 256-character atom limit: "browser:" + three 1..128 wire IDs + two colons.
  out.id = undefined;
  if (typeof rawId === 'string' && rawId.length <= 394) {
    const parts = rawId.split(':');
    if (parts.length === 4 && parts[0] === 'browser' && parts.slice(1).every(part =>
      part.length >= 1 && part.length <= 128 && !/[^A-Za-z0-9_-]/.test(part))) out.id = rawId;
  }
  return out;
}
function scope(value) { return pick(value, SCOPE_FIELDS); }
function bounded(value, fallback, hard) { return Number.isSafeInteger(value) && value > 0 ? Math.min(value, hard) : fallback; }
function safeCategory(value) { return CATEGORIES.has(value) ? value : 'partial_evidence'; }

function createNativeCollector(options = {}) {
  const { dataDir, safeStorage, extensionId, buildInfo, now = () => performance.now() } = options;
  const runtime = Object.freeze({ componentFingerprint, fingerprintKind: 'source_read_at_module_load',
    kitSourceFingerprint: fingerprint(options.kitSourceFingerprint), buildFingerprint: fingerprint(options.measurementBuildFingerprint),
    runGeneration: crypto.randomBytes(6).readUIntBE(0, 6), collectorSelfReported: true, loadedArtifactVerified: false });
  const maxEntries = bounded(options.maxEntries, 1024, 8192);
  const maxConnections = bounded(options.maxConnections, 16, 128);
  const maxDurationMs = bounded(options.maxDurationMs, 120000, 600000);
  const timeoutMs = bounded(options.timeoutMs, 10000, 60000);
  const maxBytes = bounded(options.maxBytes, 8 * 1024 * 1024, 32 * 1024 * 1024);
  let status = 'idle', category = 'pending', origin = null, highWater = null, bridge = null, server = null;
  let port = null, timer = null, startPromise = null, disposePromise = null, bytes = 0, connectionCount = 0;
  let invalid = false;
  let channel = null;
  let captureStartedAt = null, lastRecordAt = null;
  const connections = new Map(), currentClients = new Map(), events = [], pings = [];
  const witness = createAckWitness({ maxEntries });
  channel = createChannelCapture({side:'collector',targetPingOrdinal:options.targetPingOrdinal ?? 2,
    maxMessages:bounded(options.maxChannelMessages,4096,16384),maxSockets:Math.min(maxConnections,64),maxDurationMs,
    now:() => clock() ?? NaN});

  function invalidate(reason) {
    invalid = true; if (status !== 'disposed') status = 'unknown'; category = reason;
    channel?.sink.failure(reason);
    for (const event of events) { event.category = reason; event.uncertain = true; releaseSource(event); }
    for (const conn of connections.values()) { conn.ackOutputs.length = 0; clearTimeout(conn.ackOutputTimer); conn.ackOutputTimer = null; }
    for (const ping of pings) { ping.category = reason; ping.uncertain = true; }
  }
  function clock() {
    if (invalid || status === 'disposed') return null;
    let value; try { value = now(); } catch { invalidate('clock_invalid'); return null; }
    if (!Number.isFinite(value) || value < 0) { invalidate('clock_invalid'); return null; }
    if (highWater !== null && value < highWater) { invalidate('clock_discontinuity'); return null; }
    if (origin === null) origin = value;
    highWater = value;
    // Pairing is manual and must not spend the capture budget. Keep the source
    // clock origin/high-water unchanged, including while waiting for pairing.
    if (captureStartedAt !== null && value - origin - captureStartedAt > maxDurationMs) { invalidate('expired'); return null; }
    return value - origin;
  }
  function recordedAt(at) { if (!invalid && Number.isFinite(at)) lastRecordAt = at; }
  function interval(start, end) { return start === null || end === null ? null : [start, end]; }
  function reserve() {
    if (events.length + pings.length >= maxEntries) { invalidate('overflow'); return false; }
    return !invalid;
  }
  function charge(length) { bytes += length; if (bytes > maxBytes) invalidate('overflow'); return !invalid; }
  function releaseSource(event) {
    event.source = pick(event.source,['provider','kind','replay']); event.persisted = null;
  }
  function lost(conn, reason) {
    conn.closed = true;
    conn.ackOutputs.length = 0;
    clearTimeout(conn.ackOutputTimer); conn.ackOutputTimer = null;
    channel.sink.socketClosed(conn.channelRef,reason);
    for (const event of events) if (event.conn === conn) { event.uncertain = true; event.category = reason; releaseSource(event); }
    for (const ping of pings) if (ping.conn === conn) { ping.uncertain = true; ping.category = reason; }
  }
  function expire() {
    const at = clock(); if (at === null) return;
    for (const conn of connections.values()) if (conn.ackOutputs.some(item => at - item.at > 5000)) {
      conn.ackOutputs.length = 0; channel.sink.failure('ack_timeout');
    }
    for (const item of [...events, ...pings]) {
      if (!item.ackSent && !item.pongSent && item.received && at - item.received[1] > timeoutMs) {
        item.uncertain = true; item.category = 'timeout';
        if (item.source) releaseSource(item);
      }
    }
  }
  function readStore() {
    if (invalid || status === 'disposed' || !events.some(e => !e.ackSent && !e.uncertain)) return;
    const start = clock(); let fd;
    try {
      fd = fs.openSync(path.join(dataDir, 'sessions.json'), 'r');
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error();
      const buffer = Buffer.alloc(stat.size);
      if (fs.readSync(fd, buffer, 0, buffer.length, 0) !== buffer.length) throw new Error();
      // Raw parsed metadata exists only during this read. No callback/export keeps it.
      const raw = JSON.parse(buffer.toString('utf8'));
      if (raw.version !== 2 || !Array.isArray(raw.sessions) || raw.sessions.length > 200 ||
        !Array.isArray(raw.receipts) || raw.receipts.length > 4096) throw new Error();
      const projected = { version: 2, sessions: raw.sessions.map(row => ({ ...pickStoreRecord(row, ROW_FIELDS), scope: scope(row.scope) })),
        receipts: raw.receipts.map(row => pickStoreRecord(row, RECEIPT_FIELDS)) };
      const end = clock();
      for (const event of events) {
        if (event.ackSent || event.uncertain || !event.conn.authenticated) continue;
        const found = projected.sessions.some(row => row.acceptedEventId === event.source.eventId &&
          row.sessionId === event.source.sessionId && row.browserRunId === event.source.browserRunId && row.clientId === event.conn.clientId);
        if (found) { event.durableRead = interval(start, end); recordedAt(end); event.persisted = { version: 2,
          sessions: projected.sessions.filter(row => row.clientId === event.conn.clientId && row.browserRunId === event.source.browserRunId && row.sessionId === event.source.sessionId),
          receipts: projected.receipts.filter(row => row.eventId === event.source.eventId) }; }
      }
    } catch { /* A missing/newer snapshot is missing evidence, never a successful commit. */ }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  }
  function changed() {
    readStore();
    // Development composition callback carries no rows or identification text.
    // A UI callback cannot change the bridge's persistence/ACK result.
    try { if (typeof options.onChange === 'function') options.onChange(); } catch {}
  }
  function eventProjection(input) {
    const e=wireDictionary(input,[...EVENT_FIELDS,'scope','gap'],['conversationTitle','requestPreview']);
    if (!e) return null;
    const s=wireDictionary(e.scope,SCOPE_FIELDS),g=e.gap===null?null:wireDictionary(e.gap,['turnId','reason','observedAt']);
    return s&&(e.gap===null||g!==null)?payload.eventOf({...e,scope:s,gap:g}):null;
  }
  function ackProjection(input) {
    const keys=['type','schema','eventId','browserRunId','sessionId','sequence','disposition','duplicate','reason'];
    const a=wireDictionary(input,[...keys,'proof']);
    if (!a||a.proof!==null&&(typeof a.proof!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(a.proof))) return null;
    return payload.ackOf({...Object.fromEntries(keys.map(k=>[k,a[k]])),proofPresent:a.proof!==null});
  }
  function channelMessage(conn,input,direction,start,end) {
    const type = wireType(input);
    const projection = type === 'scope.event' ? eventProjection(input) : type === 'scope.event.ack' ? ackProjection(input)
      : type === 'scope.event.nack' ? payload.nackOf(wireDictionary(input,['type','schema','eventId','browserRunId','sessionId','sequence','reason']))
        : ['ping','pong'].includes(type) ? wireDictionary(input,['type','at']) : null;
    const handle = channel.sink.messageBegin(conn.channelRef,{direction,type,projection,
      phase:invalid ? 'unknown' : captureStartedAt === null ? 'waiting' : 'recording',before:start});
    if (handle) channel.sink.messageEnd(handle,{status:direction === 'client_to_server' ? 'received' : 'returned',after:end});
    return handle;
  }
  function received(conn, input, start, end, channelHandle) {
    if (input.type === 'hello') {
      conn.clientId = typeof input.clientId === 'string' ? input.clientId.slice(0, 128) : null;
      conn.browserRunId = typeof input.browserRunId === 'string' ? input.browserRunId.slice(0, 128) : null;
    } else if (input.type === 'scope.event') {
      conn.eventOrdinal = channelHandle?.eventOrdinal ?? null;
      if (!reserve()) return;
      const source=eventProjection(input);
      const event = { conn, eventOrdinal: conn.eventOrdinal, source: source||{},
        channelHandle,
        received: interval(start, end), durableRead: null, ackSent: null, persisted: null, result: null,
        category: 'pending', uncertain: !conn.authenticated||!source };
      if (event.uncertain) event.category = 'independent_evidence_unavailable';
      events.push(event);
      recordedAt(end);
    } else if (input.type === 'ping' && conn.authenticated && Number.isSafeInteger(input.at) && input.at >= 0 && reserve()) {
      if (conn.lastPing && (input.at <= conn.lastPing.at || end === null ||
        Math.abs((input.at - conn.lastPing.at) - (end - conn.lastPing.end)) > maxDurationMs)) conn.clientClockUnknown = true;
      if (conn.clientClockUnknown) channel.sink.failure('clock_unknown');
      conn.lastPing = { at: input.at, end };
      const prior = pings.filter(p => p.at === input.at);
      const ping = { conn, pingOrdinal: ++conn.pingOrdinal, at: input.at, received: interval(start, end), pongSent: null,
        category: prior.length ? 'ambiguous' : conn.clientClockUnknown ? 'clock_discontinuity' : 'pending', uncertain: prior.length > 0 || !!conn.clientClockUnknown };
      for (const item of prior) { item.category = 'ambiguous'; item.uncertain = true; }
      if (conn.clientClockUnknown) for (const item of pings) if (item.conn === conn && item.category !== 'ambiguous') {
        item.category = 'clock_discontinuity'; item.uncertain = true;
      }
      pings.push(ping);
      recordedAt(end);
    }
  }
  function sent(conn, input, raw, start, end, channelHandle) {
    if (input.type === 'ready') {
      if (input.clientId !== conn.clientId || typeof input.serverRunId !== 'string') return;
      const prior = currentClients.get(conn.clientId);
      if (prior && prior !== conn) lost(prior, 'connection_replaced');
      if (prior && prior !== conn) conn.clientClockUnknown = true;
      if (!conn.authenticated) channel.sink.authenticated(conn.channelRef,Object.freeze({}));
      conn.authenticated = true; conn.serverRunId = input.serverRunId; currentClients.set(conn.clientId, conn);
      // One lifetime budget, anchored at the first authenticated ready's actual
      // JS write-end observation. Reconnect and later clients cannot renew it.
      if (captureStartedAt === null && !invalid && Number.isFinite(end)) captureStartedAt = end;
      // A reconnect changes the calibration generation even if client at is unique.
      if (prior && prior !== conn) for (const ping of pings) if (ping.conn === prior) { ping.uncertain = true; ping.category = 'connection_replaced'; }
      return;
    }
    if (input.type === 'pong') {
      const matches = pings.filter(p => p.conn === conn && p.at === input.at && !p.pongSent);
      if (matches.length === 1) { const ping = matches[0]; ping.pongSent = interval(start, end); recordedAt(end); if (!ping.uncertain) ping.category = 'partial_evidence'; }
      return;
    }
    if (!['scope.event.ack', 'scope.event.nack'].includes(input.type)) return;
    let ackOutputProjection = null;
    if (input.type === 'scope.event.ack') {
      const output = conn.ackOutputs.shift();
      if (output && start !== null && start - output.at < 5000) ackOutputProjection = output.projection;
      else if (output) channel.sink.failure('ack_timeout');
      if (!conn.ackOutputs.length) { clearTimeout(conn.ackOutputTimer); conn.ackOutputTimer = null; }
    }
    const matches = events.filter(e => e.conn === conn && !e.ackSent && ['eventId', 'browserRunId', 'sessionId', 'sequence'].every(k => e.source[k] === input[k]));
    if (matches.length !== 1) { for (const event of matches) { event.uncertain = true; event.category = 'ambiguous'; } return; }
    const event = matches[0]; event.ackSent = interval(start, end);
    event.currentAckProofPresent = input.type === 'scope.event.ack' && input.schema === 2 &&
      input.disposition === 'committed_current' && input.duplicate === false && input.reason === null &&
      typeof input.proof === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(input.proof);
    recordedAt(end);
    if (event.uncertain || invalid) return;
    const result = witness.inspect({ wireAck: raw, expectedEvent: event.source, persistedSnapshot: event.persisted,
      context: { authenticated: conn.authenticated && !conn.closed && currentClients.get(conn.clientId) === conn,
        independentWire: true, independentStore: !!event.persisted, clientId: conn.clientId,
        connectionId: String(conn.ordinal), currentConnectionId: String(currentClients.get(conn.clientId)?.ordinal),
        serverRunId: conn.serverRunId, currentServerRunId: conn.serverRunId, browserRunId: conn.browserRunId, scope: event.source.scope },
      // A later file read is not a witnessed commit boundary. Client receive and
      // validation are absent here; NEVER populate those endpoints from write().
      intervals: { ackSent: event.ackSent && { clockGeneration: 'collector', start: event.ackSent[0], end: event.ackSent[1] } } });
    event.result = pick(result, ['eventMatched', 'storeMatched', 'scopeMatched', 'connectionMatched', 'terminalDurable']);
    event.category = safeCategory(result.category);
    event.persisted = null;
    if (input.type === 'scope.event.ack' && event.channelHandle && channelHandle) {
      const ackSubjectRef = Object.freeze({}), projection = ackOutputProjection;
      channel.sink.ackValidated({rawMessageRef:channelHandle,ackSubjectRef,eventSubjectRef:event.channelHandle,
        socketRef:conn.channelRef,ackProjection:projection,proofExact:null});
      channel.sink.validationComplete({ackSubjectRef,eventSubjectRef:event.channelHandle,socketRef:conn.channelRef,
        gate:input.proof === null && input.reason === null && (input.disposition !== 'committed_current' || event.source.replay)
          ? 'proof_absent' : result.storeMatched && result.scopeMatched && result.connectionMatched && event.currentAckProofPresent
          && event.durableRead && event.ackSent && event.durableRead[1] <= event.ackSent[0] ? 'accepted_current' : 'unclassified',
        proofExact:null,at:end});
    }
    releaseSource(event);
  }
  function observeSocket(socket) {
    // Slots belong to live TCP sockets, not to failed handshake history. Closed
    // sockets already release their Receiver/listeners below. Keep a distinct
    // monotonic anonymous ordinal, without reusing a closed connection identity.
    if (connections.size >= maxConnections || !Number.isSafeInteger(connectionCount + 1)) { invalidate('overflow'); return; }
    const channelRef = Object.freeze({}), opened = channel.sink.socketOpened(channelRef);
    if (!opened) { invalidate('overflow'); return; }
    connectionCount = opened.connectionOrdinal;
    const conn = { ordinal: opened.connectionOrdinal, socket, authenticated: false, closed: false,channelRef,
      eventOrdinal: 0, pingOrdinal: 0, clientId: null, browserRunId: null, serverRunId: null,ackOutputs:[],ackOutputTimer:null };
    connections.set(socket, conn);
    let rxHeader = Buffer.alloc(0), txHeader = Buffer.alloc(0), rxUpgraded = false, txUpgraded = false;
    let rxStart = null, txStart = null, rxMessages = [], txMessages = [];
    const rx = new Receiver({ isServer: true, maxPayload: 16384, allowSynchronousEvents: true });
    const tx = new Receiver({ isServer: false, maxPayload: 16384, allowSynchronousEvents: true });
    function decode(data, binary, target) {
      if (binary) { channel.sink.failure('decode_failed'); lost(conn,'decode_failed'); return; }
      if (invalid) return;
      try { const raw = data.toString('utf8'); target.push({ input: JSON.parse(raw), raw }); }
      catch { lost(conn, 'decode_failed'); }
    }
    rx.on('message', (data, binary) => decode(data, binary, rxMessages));
    tx.on('message', (data, binary) => decode(data, binary, txMessages));
    for (const receiver of [rx, tx]) receiver.on('error', () => lost(conn, 'decode_failed'));
    function body(chunk, incoming) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!charge(buffer.length)) return null;
      if (incoming ? rxUpgraded : txUpgraded) return buffer;
      let header = Buffer.concat([incoming ? rxHeader : txHeader, buffer]);
      const offset = header.indexOf('\r\n\r\n');
      if (offset < 0) { if (header.length > 16384) { lost(conn, 'decode_failed'); header = Buffer.alloc(0); }
        if (incoming) rxHeader = header; else txHeader = header; return null; }
      if (!incoming && !header.subarray(0, offset).toString('ascii').startsWith('HTTP/1.1 101 ')) { lost(conn, 'decode_failed'); return null; }
      if (incoming) { rxUpgraded = true; rxHeader = Buffer.alloc(0); } else { txUpgraded = true; txHeader = Buffer.alloc(0); }
      return header.subarray(offset + 4);
    }
    const onData = chunk => {
      if (invalid || conn.closed) return;
      try { const start = clock(); const buffer = body(chunk, true); if (!buffer?.length) return;
        if (rxStart === null) rxStart = start;
        // ws.Receiver unmasks client payload IN PLACE. Never let our decoder
        // mutate bytes subsequently consumed by the actual bridge receiver.
        rx.write(Buffer.from(buffer)); const end = clock();
        for (const message of rxMessages) {
          const handle = channelMessage(conn,message.input,'client_to_server',rxStart,end);
          received(conn, message.input, rxStart, end,handle);
        }
        if (rxMessages.length) rxStart = null; rxMessages = [];
      } catch { lost(conn, 'decode_failed'); }
    };
    // Installed at TCP connection, before the HTTP owner's upgrade listener.
    socket.prependListener('data', onData);
    const originalWrite = socket.write;
    function observedWrite(...args) {
      const start = clock();
      if (!invalid && !conn.closed) try { const buffer = body(args[0], false); if (buffer?.length) {
        if (txStart === null) txStart = start; tx.write(Buffer.from(buffer));
      } } catch { lost(conn, 'decode_failed'); }
      let result;
      try { result = Reflect.apply(originalWrite, this, args); }
      catch (error) { lost(conn, 'write_failed'); throw error; }
      const end = clock();
      try { for (const message of txMessages) {
        const handle = channelMessage(conn,message.input,'server_to_client',txStart,end);
        sent(conn, message.input, message.raw, txStart, end,handle);
      } }
      catch { lost(conn, 'decode_failed'); }
      if (txMessages.length) txStart = null; txMessages = [];
      return result;
    }
    socket.write = observedWrite;
    const onClose = () => { lost(conn, 'disconnected'); connections.delete(socket); cleanup(); };
    function cleanup() {
      socket.removeListener('data', onData); socket.removeListener('close', onClose);
      if (socket.write === observedWrite) socket.write = originalWrite;
      rx.destroy(); tx.destroy(); rxHeader = txHeader = Buffer.alloc(0); rxMessages = txMessages = [];
    }
    conn.cleanup = cleanup; socket.once('close', onClose);
  }
  async function start() {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      if (status !== 'idle') return { ok: false, category: status === 'disposed' ? 'disposed' : category };
      try {
        if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new Error();
        const resolved = path.resolve(dataDir).toLowerCase();
        for (const env of ['APPDATA', 'LOCALAPPDATA']) if (process.env[env]) {
          const forbidden = path.resolve(process.env[env]).toLowerCase();
          if (resolved === forbidden || resolved.startsWith(forbidden + path.sep)) throw new Error();
        }
        // The caller creates and owns this EMPTY directory. No discovery, default
        // APPDATA path, production vault reopening, or directory creation occurs.
        if (fs.lstatSync(dataDir).isSymbolicLink() || !fs.statSync(dataDir).isDirectory() || fs.readdirSync(dataDir).length) throw new Error();
        if (fs.realpathSync(dataDir).toLowerCase() !== resolved) throw new Error();
      } catch { status = 'unknown'; category = 'directory_unavailable'; return { ok: false, category }; }
      try {
        if (!safeStorage?.isEncryptionAvailable?.() || safeStorage.getSelectedStorageBackend?.() === 'basic_text' ||
          typeof safeStorage.encryptString !== 'function' || typeof safeStorage.decryptString !== 'function') throw new Error();
      } catch { status = 'unknown'; category = 'secure_storage_unavailable'; return { ok: false, category }; }
      if (clock() === null) return { ok: false, category };
      try {
        bridge = createBrowserBridge({ dataDir, safeStorage, ...(extensionId ? { extensionId } : {}),
          ...(buildInfo ? { buildInfo } : {}), onChange: changed,
          onIngestInput:(socket,projection) => {
            const conn = connections.get(socket);
            if (!conn) { channel.sink.failure('local_comparison_unavailable'); return; }
            channel.sink.ingestInput(conn.channelRef,projection);
          },onAckOutput:(socket,projection) => {
            const conn = connections.get(socket), safe = payload.ackOf(projection);
            if (!conn || !safe || conn.ackOutputs.length >= 64) { channel.sink.failure('local_comparison_unavailable'); return; }
            const at = clock();
            if (at === null) { channel.sink.failure('clock_unknown'); return; }
            conn.ackOutputs.push({projection:safe,at});
            if (!conn.ackOutputTimer) {
              conn.ackOutputTimer = setTimeout(() => { conn.ackOutputTimer = null; conn.ackOutputs.length = 0; channel.sink.failure('ack_timeout'); },5000);
              conn.ackOutputTimer.unref?.();
            }
          },onMeasurementFailure:reason => channel.sink.failure(reason) });
        if (!(await bridge.ready).ok || !bridge.getStatus().pairingAvailable) throw new Error();
        for (const candidate of PORTS) {
          const attempt = http.createServer((request, response) => { response.writeHead(404); response.end(); });
          attempt.maxConnections = maxConnections;
          attempt.maxHeadersCount = 32; attempt.headersTimeout = 5000; attempt.requestTimeout = 5000;
          attempt.on('connection', observeSocket);
          attempt.on('drop', () => invalidate('overflow'));
          const bound = await new Promise(resolve => {
            attempt.once('error', () => resolve(false));
            attempt.listen(candidate, '127.0.0.1', () => resolve(true));
          });
          if (bound) { server = attempt; port = candidate; bridge.attach(server); break; }
        }
        if (!server) { category = 'ports_unavailable'; status = 'unknown'; bridge.dispose(); return { ok: false, category }; }
        status = 'running'; category = 'partial_evidence'; timer = setInterval(expire, Math.min(timeoutMs, 1000)); timer.unref?.();
        return { ok: true, port, category };
      } catch { const failure = bridge?.getStatus().error;
        bridge?.dispose(); status = 'unknown'; category = ['browser_store_unreadable', 'credential_store_unreadable', 'secure_storage_unavailable'].includes(failure) ? failure : 'bridge_unavailable';
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        return { ok: false, category }; }
    })();
    return startPromise;
  }
  function beginPairing() {
    if (status === 'running') clock();
    const reason = pairingReason();
    if (reason !== 'none') return { ok: false, category: reason, reason };
    try { return { ok: true, ...bridge.beginPairing(port), reason: 'none' }; }
    catch { return { ok: false, category: 'pairing_unavailable', reason: 'pairing_unavailable' }; }
  }
  function pairingReason() {
    if (status === 'idle') return startPromise ? 'starting' : 'not_started';
    if (status !== 'running' || invalid) return PAIRING_FAILURES.has(category) ? category : 'pairing_unavailable';
    try { return bridge?.getStatus().pairingAvailable === true ? 'none' : 'pairing_unavailable'; }
    catch { return 'pairing_unavailable'; }
  }
  function snapshot() {
    if (status === 'running') expire();
    const remainingMs = category === 'expired' ? 0 : invalid || status !== 'running' || captureStartedAt === null
      ? null : Math.max(0, maxDurationMs - (highWater - origin - captureStartedAt));
    const reason = pairingReason();
    return { schema: 1, clockGeneration: 1, status, category, pass: false, formalAcceptance: false, independentScopeVerified: false, orderProven: false,
      runtime: { ...runtime },channelEvidence:channel.snapshot(),
      pairing: { canIssue: reason === 'none', canCopy: reason === 'none', reason },
      connection: { state: [...connections.values()].some(conn => conn.authenticated && !conn.closed) ? 'authenticated'
        : connections.size ? 'unauthenticated' : 'disconnected' },
      capture: { phase: invalid || status === 'unknown' || status === 'disposed' ? 'unknown' : captureStartedAt === null ? 'waiting' : 'recording',
        startedAt: captureStartedAt, maxDurationMs, maxEntries,
        elapsedMs: invalid || captureStartedAt === null ? null : highWater - origin - captureStartedAt, remainingMs, lastRecordAt },
      limits: { maxActiveConnections: maxConnections, maxEntries, maxBytes, maxDurationMs, timeoutMs,
        maxFrameBytes: 16384, maxStoreBytes: 8 * 1024 * 1024 },
      // Total accepted TCP connections includes closed unauthenticated attempts;
      // activeConnections alone owns the simultaneous-connection budget.
      counts: { connections: connectionCount, activeConnections: connections.size, events: events.length, pings: pings.length, bytes },
      events: events.map(event => ({ connectionOrdinal: event.conn.ordinal, eventOrdinal: event.eventOrdinal,
        provider: ['chatgpt', 'claude'].includes(event.source.provider) ? event.source.provider : 'unknown',
        kind: ['observation', 'terminal', 'gap', 'closed'].includes(event.source.kind) ? event.source.kind : 'unknown',
        replay: event.source.replay === true, received: event.received && [...event.received],
        durableRead: event.durableRead && [...event.durableRead], ackSent: event.ackSent && [...event.ackSent],
        category: event.category, eventMatched: event.result?.eventMatched === true, storeMatched: event.result?.storeMatched === true,
        scopeMatched: event.result?.scopeMatched === true, connectionMatched: event.result?.connectionMatched === true,
        currentAckProofPresent: event.currentAckProofPresent === true,
        // Independent reread end precedes this frame's first JS write call.
        // This is neither commit/fsync time nor kernel delivery evidence.
        storeReadBeforeAckWrite: invalid || !event.durableRead || !event.ackSent ? null : event.durableRead[1] <= event.ackSent[0],
        ackMatched: event.result?.eventMatched === true, missing: true, pass: false, formalAcceptance: false,
        independentScopeVerified: false, orderProven: false })),
      pings: pings.map(ping => ({ connectionOrdinal: ping.conn.ordinal, pingOrdinal: ping.pingOrdinal, at: ping.at,
        received: ping.received && [...ping.received], pongSent: ping.pongSent && [...ping.pongSent],
        category: ping.category, unique: !ping.uncertain && !!ping.pongSent, missing: ping.uncertain || !ping.pongSent })) };
  }
  async function dispose() {
    if (disposePromise) return disposePromise;
    disposePromise = (async () => {
      if (startPromise) await startPromise;
      clearInterval(timer); invalidate('disposed'); status = 'disposed';
      bridge?.dispose();
      for (const [socket, conn] of connections) { clearTimeout(conn.ackOutputTimer); conn.ackOutputs.length = 0; conn.cleanup(); socket.destroy(); }
      connections.clear(); currentClients.clear(); witness.dispose();
      channel.dispose();
      if (server) await new Promise(resolve => server.close(resolve));
      for (const event of events) { event.source = {}; event.persisted = null; event.conn = { ordinal: event.conn.ordinal }; }
      for (const ping of pings) ping.conn = { ordinal: ping.conn.ordinal };
      bridge = server = null;
    })();
    return disposePromise;
  }
  // Node composition only. Neither object nor port is exposed through collector IPC.
  return Object.freeze({ start, beginPairing, snapshot, dispose,
    getProductBridge: () => status === 'disposed' ? null : bridge,
    getProductPort: () => status === 'disposed' ? null : port });
}

module.exports = { createNativeCollector };
