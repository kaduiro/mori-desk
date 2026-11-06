const crypto = require("node:crypto");
const { WebSocketServer, WebSocket } = require("ws");
const { createBrowserBridgeAuth } = require("./browser-bridge-auth");
const { createBrowserSessionStore } = require("./browser-session-store");
const { createObservationProofs } = require('./browser-observation-proofs');
const {
  VERSION, WS_PATH, EXTENSION_ID, MAX_FRAME_BYTES, assertKeys, isId, isInteger,
  protocolError, validateHello, decodeFrame, RESTART_HEALTH_CAPABILITY, validateDesktopBuild, validateClientHealth,
  monitoring, validateObservationHealth,
} = require("./browser-bridge-protocol");

const AUTH_TIMEOUT_MS = 5000;
const FOCUS_TIMEOUT_MS = 5000;
const CONNECTION_STALE_MS = 60000;
const MAX_UNAUTHENTICATED = 8;
const MAX_PENDING_FOCUS = 20;
const HEALTH_STALE_MS = 45000;
const MEASUREMENT_EVENT_FIELDS = ['type','v','schema','eventId','browserRunId','sessionId','sequence','kind','provider','tabId',
  'pageInstanceId','routeRevision','conversationRef','turnId','generation','phase','outcome','observation','observedAt','replay'];
function measurementDictionary(value,keys,ignored=[]) {
  try {
    if (!value||typeof value!=='object'||Array.isArray(value)) return null;
    const proto=Object.getPrototypeOf(value),names=Reflect.ownKeys(value);
    if (proto!==null&&proto!==Object.prototype||names.length>64||names.some(k=>typeof k!=='string'||!keys.includes(k)&&!ignored.includes(k))) return null;
    const d=Object.getOwnPropertyDescriptors(value);
    if(keys.some(k=>!Object.hasOwn(d,k))||names.some(k=>!Object.hasOwn(d[k],'value'))) return null;
    return Object.fromEntries(keys.map(k=>[k,d[k].value]));
  } catch (_) {return null;}
}
function measurementEvent(value) {
  const e=measurementDictionary(value,[...MEASUREMENT_EVENT_FIELDS,'scope','gap'],['conversationTitle','requestPreview']);
  if(!e)return null;
  const s=measurementDictionary(e.scope,['kind','viewEpoch','bindingEpoch','samplingEpoch','workerEpoch','leaseId','documentId','startUnobserved']);
  const g=e.gap===null?null:measurementDictionary(e.gap,['turnId','reason','observedAt']);
  return s&&(e.gap===null||g!==null)?{...e,scope:s,gap:g}:null;
}
function measurementAck(value) {
  const keys=['type','schema','eventId','browserRunId','sessionId','sequence','disposition','duplicate','reason'];
  const a=measurementDictionary(value,[...keys,'proof']);
  if(!a||a.proof!==null&&(typeof a.proof!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(a.proof)))return null;
  return {...Object.fromEntries(keys.map(k=>[k,a[k]])),proofPresent:a.proof!==null};
}

function headerCount(request, name) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) count += 1;
  }
  return count;
}

function createBrowserBridge({ dataDir, safeStorage, extensionId = EXTENSION_ID, onChange = () => {}, onNotice = () => {}, now = Date.now, fs, buildInfo = null, measurement = null,
  onIngestInput = null, onAckOutput = null, onMeasurementFailure = null } = {}) {
  // Development constructor injection, not an HTTP/IPC setting. Only fixed
  // categories reach the sink; recording never controls durability or ACKs.
  function measure(stage) { try { measurement?.record(stage); } catch (_) {} }
  if (!dataDir || !/^[a-p]{32}$/.test(extensionId)) throw new Error("Browser bridge requires its private data directory and fixed extension ID");
  const build = buildInfo === null ? null : validateDesktopBuild(buildInfo);
  let auth;
  let store;
  let initializationError = null;
  let lastError = null;
  let disposed = false;
  let httpServer = null;
  const clients = new Map();
  const sockets = new Map();
  const pendingFocus = new Map();
  const observationProofs = createObservationProofs({ now });
  let proofRevision = 0;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false, clientTracking: true });
  try {
    auth = createBrowserBridgeAuth({ dataDir, safeStorage, now, fs });
    store = createBrowserSessionStore({ dataDir, now, fs, onChange, onNotice, measurement,
      onPersistenceError: category => console.warn('Mori browser persistence failed:', category) });
  } catch (error) { initializationError = error.code || "browser_store_unreadable"; }

  function safeChange() {
    try { onChange(store?.getSnapshot() || []); } catch { /* A closing window must not corrupt receipt durability. */ }
  }
  function send(socket, message) {
    if (socket.readyState !== WebSocket.OPEN) return false;
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw protocolError("server_frame_limit");
    if (typeof onAckOutput === 'function' && message.type === 'scope.event.ack') {
      try { const projection=measurementAck(message);
        if(!projection)try{onMeasurementFailure?.('invalid_schema');}catch(_){}
        onAckOutput(socket._socket,projection); }
      catch (_) { try { onMeasurementFailure?.('capture_failed'); } catch (_) {} }
    }
    socket.send(text, (error) => { if (error) socket.close(1011, "send_failed"); });
    return true;
  }
  function fail(socket, error, close = true) {
    const code = error?.code || "internal_error";
    lastError = code;
    send(socket, { type: "error", code });
    if (close) socket.close(1008, code.slice(0, 100));
    safeChange();
  }
  function settleFocus(requestId, result) {
    const pending = pendingFocus.get(requestId);
    if (!pending) return;
    pendingFocus.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }
  function closeConnection(socket, reason = "disconnected") {
    const connection = sockets.get(socket);
    if (!connection) return;
    sockets.delete(socket);
    observationProofs.revokeConnection(connection);
    clearTimeout(connection.authTimer);
    if (connection.authenticated && clients.get(connection.clientId) === connection) {
      clients.delete(connection.clientId);
      store?.disconnect(connection.clientId, connection.browserRunId);
    }
    for (const [requestId, pending] of pendingFocus) {
      if (pending.socket === socket) settleFocus(requestId, { ok: false, reason });
    }
    safeChange();
  }
  function authenticated(connection) {
    const prior = clients.get(connection.clientId);
    if (prior && prior !== connection) prior.socket.close(1000, "connection_replaced");
    connection.authenticated = true;
    measure('authenticated_ready');
    connection.handshake = null;
    clearTimeout(connection.authTimer);
    clients.set(connection.clientId, connection);
    store.connect(connection.clientId, connection.browserRunId);
    lastError = null;
    send(connection.socket, {
      type: "ready", v: VERSION, clientId: connection.clientId,
      instanceId: auth.instanceId, serverRunId: auth.serverRunId, port: connection.port,
      capabilities: [monitoring.CAPABILITIES[0], monitoring.CAPABILITIES[1],
        ...(build ? [RESTART_HEALTH_CAPABILITY, monitoring.CAPABILITIES[2]] : [])],
      ...(build ? { build } : {}),
    });
    safeChange();
  }
  function charge(connection, count = 1) {
    const elapsed = Math.max(0, now() - connection.tokenAt);
    connection.tokens = Math.min(40, connection.tokens + elapsed * 20 / 1000);
    connection.tokenAt = now();
    if (connection.tokens < count) throw protocolError("rate_limit");
    connection.tokens -= count;
  }
  function ingest(connection, message) {
    // Development owner callback only; normal mode does not project/read extra
    // fields. Metadata never crosses this callback boundary. It cannot alter ACKs.
    if (typeof onIngestInput === 'function' && message.type === 'scope.event') {
      try { const projection=measurementEvent(message);
        if(!projection)try{onMeasurementFailure?.('invalid_schema');}catch(_){}
        onIngestInput(connection.socket._socket,projection);
      } catch (_) { try { onMeasurementFailure?.('capture_failed'); } catch (_) {} }
    }
    measure('desktop_received');
    const result = store.ingest(connection.clientId, message);
    if (['committed_current', 'committed_receipt'].includes(result.disposition)) measure('desktop_committed');
    if (message.type === 'scope.event') {
      const proof = observationProofs.observe(connection, message, result.disposition);
      const sent = send(connection.socket, { type: 'scope.event.ack', schema: 2, eventId: message.eventId,
        browserRunId: message.browserRunId, sessionId: message.sessionId, sequence: message.sequence,
        disposition: result.disposition, duplicate: result.duplicate, ...proof });
      if (sent) measure('ack_sent');
      return;
    }
    send(connection.socket, { type: "event.ack", eventId: message.eventId,
      browserRunId: message.browserRunId, sessionId: message.sessionId, sequence: message.sequence, duplicate: result.duplicate });
  }
  function focusResult(connection, message) {
    assertKeys(message, ["type", "requestId", "ok", "reason", "browserRunId", "sessionId", "pageInstanceId", "routeRevision", "conversationRef"]);
    if (!isId(message.requestId) || typeof message.ok !== "boolean"
      || (message.reason !== undefined && (typeof message.reason !== "string" || message.reason.length > 128))) throw protocolError("invalid_focus_result");
    const pending = pendingFocus.get(message.requestId);
    if (!pending || pending.socket !== connection.socket) return;
    const matches = ["browserRunId", "sessionId", "pageInstanceId", "routeRevision", "conversationRef"]
      .every((key) => pending.target[key] === message[key]);
    if (!message.ok || !matches || !store.matchesFocusTarget(pending.target)) {
      settleFocus(message.requestId, { ok: false, reason: !matches ? "focus_identity_changed" : message.reason || "focus_failed" });
      return;
    }
    // A successful window API call acknowledges exactly the notice captured by the click.
    // null means the row had no unread receipt when clicked, and must remain a no-op.
    const result = pending.target.noticeSequence === null ? { ok: true } : store.ack(pending.target.id, pending.target.noticeSequence);
    settleFocus(message.requestId, result);
  }
  function message(connection, input) {
    if (disposed || !store || !auth || initializationError) throw protocolError(initializationError || "bridge_disposed");
    connection.lastReceivedAt = now();
    if (!connection.authenticated) {
      if (input.type === "hello" && !connection.handshake) {
        const hello = validateHello(input);
        connection.clientId = hello.clientId;
        connection.browserRunId = hello.browserRunId;
        connection.handshake = auth.challenge(hello, connection.port);
        send(connection.socket, connection.handshake.message);
        return;
      }
      if (input.type === "authenticate" && connection.handshake && !connection.waitingForConfirm) {
        assertKeys(input, ["type", "proof"]);
        const response = auth.authenticate(connection.handshake, input.proof);
        if (response.type === "pair.ready") {
          connection.waitingForConfirm = true;
          send(connection.socket, response);
        } else authenticated(connection);
        return;
      }
      if (input.type === "pair.confirm" && connection.waitingForConfirm) {
        assertKeys(input, ["type", "proof"]);
        auth.confirm(connection.handshake, input.proof);
        authenticated(connection);
        return;
      }
      throw protocolError("authentication_required");
    }
    if (clients.get(connection.clientId) !== connection) throw protocolError("connection_retired");
    charge(connection);
    store.heartbeat(connection.clientId);
    if (input.type === "ping" || input.type === "pong") {
      assertKeys(input, ["type", "at"]);
      if (!isInteger(input.at)) throw protocolError("invalid_ping");
      if (input.type === "ping") send(connection.socket, { type: "pong", at: input.at });
    } else if (input.type === "event" || input.type === 'scope.event') {
      try { ingest(connection, input); }
      catch (error) {
        if (input.type !== 'scope.event' || !['session_limit', 'receipt_limit', 'active_session_limit', 'session_store_write_failed'].includes(error.code)) throw error;
        send(connection.socket, { type: 'scope.event.nack', schema: 2, browserRunId: input.browserRunId,
          sessionId: input.sessionId, eventId: input.eventId, sequence: input.sequence, reason: error.code });
      }
    } else if (input.type === "snapshot") {
      assertKeys(input, ["type", "v", "events"]);
      if (input.v !== VERSION || !Array.isArray(input.events) || input.events.length > 20) throw protocolError("invalid_snapshot");
      charge(connection, input.events.length);
      for (const event of input.events) ingest(connection, event);
    } else if (input.type === "focus.result") {
      focusResult(connection, input);
    } else if (input.type === "client.health" && build) {
      const health = input.schema === 2 ? validateObservationHealth(input) : validateClientHealth(input);
      if (health.browserRunId !== connection.browserRunId) throw protocolError("health_identity_mismatch");
      if (connection.health && (connection.health.workerEpoch !== health.workerEpoch
        || connection.health.sequence >= health.sequence)) throw protocolError("health_sequence");
      // An older health frame can race a newer event/ACK on this socket.
      // It contributes no monitoring evidence; wait for the exact new proof.
      if (health.schema === 2 && !observationProofs.verifyHealth(connection, health)) { safeChange(); return; }
      // This is socket-scoped inventory, never a row observation or receipt.
      connection.health = health;
      connection.healthAt = now();
      connection.healthExpired = false;
      safeChange();
    } else {
      throw protocolError("unsupported_message");
    }
  }
  function connection(socket, port) {
    const context = { socket, port, authenticated: false, handshake: null, waitingForConfirm: false,
      lastReceivedAt: now(), lastPingAt: now(), tokens: 40, tokenAt: now() };
    sockets.set(socket, context);
    context.authTimer = setTimeout(() => {
      if (!context.authenticated) fail(socket, protocolError("authentication_timeout"));
    }, AUTH_TIMEOUT_MS);
    context.authTimer.unref?.();
    socket.on("message", (data, isBinary) => {
      try { message(context, decodeFrame(data, isBinary)); }
      catch (error) { fail(socket, error); }
    });
    socket.on("close", () => closeConnection(socket));
    socket.on("error", () => { closeConnection(socket, "connection_error"); socket.terminate(); });
  }
  function reject(socket, code) {
    socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  function upgrade(request, socket, head) {
    // Once Node emits "upgrade", the raw TCP socket is owned by upgrade
    // handlers. A peer reset while a rejection is being written (or before
    // another owner accepts it) must not escape as a main-process exception.
    socket.on("error", () => { socket.destroy(); });
    if (request.url !== WS_PATH) {
      if (request.url?.startsWith("/browser")) reject(socket, 403);
      return; // Other owners may handle other upgrade paths.
    }
    const address = httpServer?.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const local = request.socket.localAddress;
    const remote = request.socket.remoteAddress;
    if (disposed || !port || initializationError) { reject(socket, 503); return; }
    if (request.method !== "GET" || headerCount(request, "host") !== 1 || headerCount(request, "origin") !== 1
      || request.headers.host !== `127.0.0.1:${port}`
      || request.headers.origin !== `chrome-extension://${extensionId}`
      || !["127.0.0.1", "::ffff:127.0.0.1"].includes(local)
      || !["127.0.0.1", "::ffff:127.0.0.1"].includes(remote)
      || address.address !== "127.0.0.1") { reject(socket, 403); return; }
    if ([...sockets.values()].filter((item) => !item.authenticated).length >= MAX_UNAUTHENTICATED) { reject(socket, 429); return; }
    wss.handleUpgrade(request, socket, head, (client) => connection(client, port));
  }
  function shutdownSockets(reason) {
    for (const socket of [...sockets.keys()]) {
      closeConnection(socket, reason);
      socket.close(1001, reason);
      // HTTP server.close() alone does not close upgraded sockets.
      const timer = setTimeout(() => socket.terminate(), 200);
      timer.unref?.();
    }
  }
  function healthIsCurrent(context) {
    const age = now() - context.healthAt;
    return !!context.health && !context.healthExpired && age >= 0 && age <= HEALTH_STALE_MS;
  }
  const tickTimer = setInterval(() => {
    if (disposed) return;
    for (const context of sockets.values()) {
      if (!context.authenticated) continue;
      if (context.health && !context.healthExpired && !healthIsCurrent(context)) {
        context.healthExpired = true;
        safeChange();
      }
      if (now() - context.lastReceivedAt > CONNECTION_STALE_MS) {
        context.socket.close(1001, "heartbeat_timeout");
      } else if (now() - context.lastPingAt >= 20000) {
        context.lastPingAt = now(); send(context.socket, { type: "ping", at: now() });
      }
    }
    observationProofs.expire();
    if (proofRevision !== observationProofs.getRevision()) { proofRevision = observationProofs.getRevision(); safeChange(); }
    store?.tick();
  }, 1000);
  tickTimer.unref?.();

  const api = {
    ready: Promise.resolve({ ok: !initializationError }),
    attach(server) {
      if (httpServer && httpServer !== server) throw new Error("Browser bridge already has a local HTTP server");
      if (!httpServer) { httpServer = server; server.on("upgrade", upgrade); }
      return () => { if (httpServer === server) { server.removeListener("upgrade", upgrade); shutdownSockets("server_detached"); httpServer = null; } };
    },
    beginPairing(port) {
      if (disposed || initializationError || !auth) throw protocolError(initializationError || "bridge_unavailable");
      const address = httpServer?.address();
      const actualPort = typeof address === "object" && address ? address.port : null;
      if (!actualPort || (port !== undefined && port !== actualPort)) throw protocolError("server_not_listening");
      return auth.beginPairing(actualPort);
    },
    getStatus() {
      const address = httpServer?.address();
      return { ...auth?.getStatus(), available: !disposed && !initializationError, error: initializationError || lastError || auth?.getStatus().error || store?.getStatus().error || null,
        port: typeof address === "object" && address ? address.port : null,
        extensionId, protocolVersion: VERSION, store: store?.getStatus() || null,
        connectedClients: [...clients.values()].map(({ clientId, browserRunId }) => ({ clientId, browserRunId })),
        build,
        clientHealth: [...clients.values()].map(connection => ({ clientId: connection.clientId,
          browserRunId: connection.browserRunId,
          state: !connection.health ? "unknown" : healthIsCurrent(connection) ? "current" : "stale",
          health: healthIsCurrent(connection) ? (connection.health.schema === 2
            ? observationProofs.projectHealth(connection, connection.health) : structuredClone(connection.health)) : null })) };
    },
    getSnapshot() { return store?.getSnapshot() || []; },
    getVisualState() { return store?.getVisualState() || "idle"; },
    async focus(id, noticeSequence) {
      if (disposed || !store) return { ok: false, reason: "bridge_unavailable" };
      const target = store.getFocusTarget(id, noticeSequence);
      const client = target && clients.get(target.clientId);
      if (!target || !client || client.browserRunId !== target.browserRunId) return { ok: false, reason: "tab_unavailable" };
      if (pendingFocus.size >= MAX_PENDING_FOCUS) return { ok: false, reason: "focus_busy" };
      const requestId = crypto.randomUUID();
      return new Promise((resolve) => {
        const timer = setTimeout(() => settleFocus(requestId, { ok: false, reason: "focus_timeout" }), FOCUS_TIMEOUT_MS);
        timer.unref?.();
        pendingFocus.set(requestId, { target, socket: client.socket, resolve, timer });
        if (!send(client.socket, { type: "focus.request", v: VERSION, requestId,
          browserRunId: target.browserRunId, sessionId: target.sessionId, tabId: target.tabId,
          pageInstanceId: target.pageInstanceId, routeRevision: target.routeRevision,
          conversationRef: target.conversationRef, noticeSequence: target.noticeSequence })) {
          settleFocus(requestId, { ok: false, reason: "disconnected" });
        }
      });
    },
    async ack(id, noticeSequence) { return store ? store.ack(id, noticeSequence) : { ok: false, reason: "bridge_unavailable" }; },
    async acknowledgeGap(id, eventId) { return store ? store.acknowledgeGap(id, eventId) : { ok: false, reason: 'bridge_unavailable' }; },
    async dismiss(id) { return store ? store.dismiss(id) : { ok: false, reason: "bridge_unavailable" }; },
    async setLabel(id, label) { return store ? store.setLabel(id, label) : { ok: false, reason: "bridge_unavailable" }; },
    async revoke(clientId) {
      if (!auth || !store || !isId(clientId)) return { ok: false, reason: "invalid_client" };
      auth.removeClient(clientId); // Revoke first; a later metadata failure cannot leave access active.
      const client = clients.get(clientId);
      if (client) { closeConnection(client.socket, "unpaired"); client.socket.close(1000, "unpaired"); }
      store.forgetClient(clientId);
      safeChange();
      return { ok: true };
    },
    dispose() {
      if (disposed) return;
      disposed = true; clearInterval(tickTimer);
      httpServer?.removeListener("upgrade", upgrade);
      shutdownSockets("app_quit");
      wss.close(); auth?.dispose();
    },
  };
  return api;
}

module.exports = { createBrowserBridge, AUTH_TIMEOUT_MS, FOCUS_TIMEOUT_MS, CONNECTION_STALE_MS, HEALTH_STALE_MS };
