"use strict";

const http = require("node:http");
const { performance } = require("node:perf_hooks");

const PORTS = Object.freeze([23333, 23334, 23335, 23336, 23337]);
const RETRY_MS = Object.freeze([1000, 2000, 4000]);
const BIND_BUDGET_MS = 1000;

// Owns one local HTTP listener, not credentials, sessions, or the bridge. The
// start/repair/resume paths all join this owner; CLI listeners keep their owner.
function createBrowserListener({
  createServer = () => http.createServer(),
  getPortCandidates = () => PORTS,
  attach = () => null,
  onListening = () => true,
  onChange = () => {},
  now = Date.now,
  monotonic = () => performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  retryDelays = RETRY_MS,
  bindBudgetMs = BIND_BUDGET_MS,
} = {}) {
  let disposed = false;
  let generation = 0;
  let current = null;
  let flight = null;
  let retryTimer = null;
  let failures = 0;
  let attempt = 0;
  let status = { state: "idle", port: null, reason: null, retryAt: null, attempt: 0 };

  function publish(state, { port = null, reason = null, retryAt = null } = {}) {
    status = { state, port, reason, retryAt, attempt };
    try { onChange({ ...status }); } catch { /* A UI consumer cannot strand startup. */ }
  }

  function cancelRetry() {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
  }

  function isCurrent(entry) {
    return !disposed && current === entry && !entry.retired && entry.generation === generation;
  }

  function closeOwnedSockets(entry) {
    for (const socket of entry.sockets) {
      try { socket.destroy(); } catch {}
    }
  }

  function retire(entry, deadline) {
    if (!entry) return Promise.resolve(true);
    if (entry.retirement) return entry.retirement;
    entry.retired = true;
    entry.settleBind?.({ reason: "cancelled" });
    let resolveRetirement;
    // Publish the promise before invoking the bridge detacher. It may notify
    // consumers which synchronously request cleanup again.
    entry.retirement = new Promise(resolve => { resolveRetirement = resolve; });
    let detached = true;
    let done = false;
    let serverClosed = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimer(timer);
      entry.checkRetired = null;
      resolveRetirement(ok && detached);
    };
    // Node may finish HTTP server.close() before the individual upgraded
    // sockets emit close. Require both observations; do not misclassify that
    // normal ordering as a cleanup failure or replace a still-open socket.
    entry.checkRetired = () => {
      if (serverClosed && entry.sockets.size === 0) finish(true);
    };
    const timer = setTimer(() => finish(false), Math.max(0, deadline - monotonic()));
    // Keep this deadline referenced: callers awaiting cleanup must settle even
    // if a broken/injected server has no OS handle left to keep Node alive.
    const beginClose = () => {
      try { entry.detach?.(); } catch { detached = false; }
      entry.detach = null;
      closeOwnedSockets(entry);
      try {
        entry.server.close(error => {
          const closed = !error || error.code === "ERR_SERVER_NOT_RUNNING";
          if (!closed || entry.server.listening === true) { finish(false); return; }
          serverClosed = true;
          entry.checkRetired?.();
        });
        entry.server.closeAllConnections?.();
      } catch (error) {
        if (error?.code !== "ERR_SERVER_NOT_RUNNING" || entry.server.listening === true) { finish(false); return; }
        serverClosed = true;
        entry.checkRetired?.();
      }
    };
    // Disposal can be requested from attach's own notification. Wait for its
    // returned detacher before closing, and never call listen on that entry.
    if (entry.attaching) entry.afterAttach = beginClose;
    else beginClose();
    return entry.retirement;
  }

  function scheduleRetry(reason, startedAt) {
    if (disposed) return;
    const delay = retryDelays[Math.min(failures++, retryDelays.length - 1)];
    const remaining = Math.max(0, startedAt + delay - monotonic());
    cancelRetry();
    publish("retry_wait", { reason, retryAt: now() + remaining });
    if (disposed) return;
    retryTimer = setTimer(() => {
      retryTimer = null;
      void ensureListening();
    }, remaining);
    retryTimer.unref?.();
  }

  function lost(entry, reason) {
    if (!isCurrent(entry) || !entry.live) return;
    entry.live = false;
    publish("idle", { reason });
    if (flight) {
      void flight.then(() => { if (isCurrent(entry) && !entry.live) void ensureListening(); });
    } else void ensureListening();
  }

  function bind(entry, port, deadline) {
    return new Promise(resolve => {
      let settled = false;
      const settle = result => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        entry.settleBind = null;
        resolve(result);
      };
      const timer = setTimer(() => settle({ reason: "bind_timeout" }), Math.max(0, deadline - monotonic()));
      entry.settleBind = settle;
      entry.server.on("connection", socket => {
        entry.sockets.add(socket);
        socket.once("close", () => { entry.sockets.delete(socket); entry.checkRetired?.(); });
        if (!isCurrent(entry)) socket.destroy();
      });
      // Keep error/listening handlers on retired objects: a late OS callback
      // cannot become an unhandled error or resurrect an obsolete listener.
      entry.server.on("error", error => {
        if (!isCurrent(entry)) return;
        if (entry.live) { lost(entry, "listener_error"); return; }
        const reason = error?.code === "EADDRINUSE" ? "ports_in_use"
          : ["EACCES", "EPERM"].includes(error?.code) ? "permission_denied" : "bind_failed";
        entry.failure = reason;
        settle({ reason });
      });
      entry.server.on("close", () => {
        if (!isCurrent(entry)) return;
        if (entry.live) lost(entry, "listener_closed");
        else { entry.failure = "listener_closed"; settle({ reason: "listener_closed" }); }
      });
      entry.server.on("listening", () => {
        if (!isCurrent(entry)) {
          closeOwnedSockets(entry);
          try { entry.server.close(() => {}); } catch {}
          return;
        }
        let address = null;
        try { address = entry.server.address(); } catch {}
        if (!address || address.address !== "127.0.0.1" || !Number.isInteger(address.port)
          || address.port < 1 || address.port > 65535 || (port !== 0 && address.port !== port)) {
          settle({ reason: "bind_failed" });
          return;
        }
        settle({ port: address.port });
      });
      try { entry.server.listen(port, "127.0.0.1"); }
      catch (error) {
        settle({ reason: ["EACCES", "EPERM"].includes(error?.code) ? "permission_denied" : "bind_failed" });
      }
    });
  }

  async function runAttempt() {
    if (disposed) return null;
    const ownGeneration = ++generation;
    const startedAt = monotonic();
    const deadline = startedAt + bindBudgetMs;
    attempt++;
    publish("binding");
    if (disposed || ownGeneration !== generation) return null;

    if (current) {
      const retired = await retire(current, deadline);
      if (disposed || ownGeneration !== generation) return null;
      if (!retired) { publish("blocked", { reason: "resource_cleanup_failed" }); return null; }
      current = null;
    }

    let ports;
    try { ports = getPortCandidates(); } catch { ports = null; }
    // Zero is allowed only through the internal injected test seam. Production
    // server-config supplies the fixed loopback range, never user page input.
    if (!Array.isArray(ports) || !ports.length || ports.length > 5
      || ports.some(port => !Number.isInteger(port) || port < 0 || port > 65535)
      || new Set(ports).size !== ports.length) {
      publish("blocked", { reason: "invalid_candidates" });
      return null;
    }

    let failure = "ports_in_use";
    for (const port of ports) {
      if (disposed || ownGeneration !== generation) return null;
      if (monotonic() >= deadline) { failure = "bind_timeout"; break; }
      let entry;
      try {
        entry = { server: createServer(), generation: ownGeneration, retired: false,
          live: false, sockets: new Set(), detach: null, retirement: null, settleBind: null,
          attaching: false, afterAttach: null, failure: null };
        current = entry;
        if (!isCurrent(entry)) { await retire(entry, deadline); return null; }
        entry.attaching = true;
        try {
          const detach = attach(entry.server);
          if (typeof detach === "function") entry.detach = detach;
        } finally {
          entry.attaching = false;
          entry.afterAttach?.();
          entry.afterAttach = null;
        }
      } catch {
        failure = "bridge_unavailable";
        if (entry && !await retire(entry, deadline)) failure = "resource_cleanup_failed";
        if (!disposed) publish("blocked", { reason: failure });
        return null;
      }

      if (!isCurrent(entry)) { await retire(entry, deadline); return null; }

      const result = await bind(entry, port, deadline);
      if (!isCurrent(entry)) return null;
      if (result.port && !entry.failure) {
        let persisted = false;
        try { persisted = onListening(result.port, entry.server) === true; } catch {}
        if (!isCurrent(entry)) return null;
        if (persisted && !entry.failure && entry.server.listening === true && monotonic() <= deadline) {
          entry.live = true;
          failures = 0;
          publish("listening", { port: result.port });
          return disposed ? null : result.port;
        }
        failure = entry.failure || (!persisted ? "runtime_file_unavailable"
          : entry.server.listening !== true ? "listener_closed" : "bind_timeout");
      } else failure = entry.failure || result.reason;

      const retired = await retire(entry, deadline);
      if (disposed || ownGeneration !== generation) return null;
      if (!retired) { publish("blocked", { reason: "resource_cleanup_failed" }); return null; }
      current = null;
      if (failure !== "ports_in_use") break;
    }

    if (["ports_in_use", "bind_timeout", "listener_closed"].includes(failure)) {
      scheduleRetry(failure, startedAt);
    } else publish("blocked", { reason: failure });
    return null;
  }

  function ensureListening() {
    if (disposed) return Promise.resolve(null);
    if (flight) return flight;
    if (status.state === "listening" && current?.server.listening === true) return Promise.resolve(status.port);
    cancelRetry();
    // Assign the single flight before any callback can re-enter the owner.
    flight = Promise.resolve().then(runAttempt).catch(async () => {
      const retired = await retire(current, monotonic() + bindBudgetMs);
      if (!disposed) publish("blocked", { reason: retired ? "bind_failed" : "resource_cleanup_failed" });
      return null;
    }).finally(() => { flight = null; });
    return flight;
  }

  function dispose() {
    if (!disposed) {
      disposed = true;
      generation++;
      cancelRetry();
      publish("disposed");
    }
    return retire(current, monotonic() + bindBudgetMs);
  }

  return { ensureListening, getStatus: () => ({ ...status }), dispose };
}

module.exports = { createBrowserListener, PORTS, RETRY_MS, BIND_BUDGET_MS };
