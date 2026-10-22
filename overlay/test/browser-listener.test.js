"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter, once } = require("node:events");
const { performance } = require("node:perf_hooks");
const { createBrowserListener } = require("../src/browser-listener");
const initServer = require("../src/server");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("listener condition timed out");
    await delay(10);
  }
}
async function listen(server) {
  const ready = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await ready;
  return server.address().port;
}
async function close(server) {
  if (!server) return;
  await new Promise((resolve, reject) => server.close(error => {
    if (!error || error.code === "ERR_SERVER_NOT_RUNNING") resolve();
    else reject(error);
  }));
}

test("real sockets: all five occupied ports recover after release, including the maximum retry interval", { timeout: 18000 }, async t => {
  const blockers = Array.from({ length: 5 }, () => http.createServer());
  const ports = [];
  for (const server of blockers) ports.push(await listen(server));
  const servers = [], transitions = [];
  let attached = null, attaches = 0, detaches = 0;
  const owner = createBrowserListener({
    getPortCandidates: () => ports,
    createServer: () => { const server = http.createServer(); servers.push(server); return server; },
    attach: server => {
      assert.equal(attached, null, "the previous bridge attachment must be detached before replacement");
      attached = server; attaches++;
      return () => { assert.equal(attached, server); attached = null; detaches++; };
    },
    onChange: state => transitions.push({ ...state, observedAt: performance.now() }),
  });
  t.after(async () => { await owner.dispose(); await Promise.all(blockers.map(close)); });
  assert.equal(await owner.ensureListening(), null);
  assert.equal(owner.getStatus().reason, "ports_in_use");
  await until(() => owner.getStatus().attempt >= 4 && owner.getStatus().state === "retry_wait", 9000);
  const starts = transitions.filter(item => item.state === "binding");
  for (const [index, expected] of [1000, 2000, 4000].entries()) {
    const interval = starts[index + 1].observedAt - starts[index].observedAt;
    assert.ok(interval >= expected - 75 && interval <= expected + 750, `retry interval ${index}: ${interval}`);
  }
  const releasedAt = performance.now();
  await close(blockers[2]);
  await until(() => owner.getStatus().state === "listening");
  assert.ok(performance.now() - releasedAt < 5000, "port release must recover within the listener budget");
  assert.equal(owner.getStatus().port, ports[2]);
  assert.equal(servers.filter(server => server.listening).length, 1);
  assert.equal(attaches - detaches, 1);
  assert.equal(await owner.dispose(), true);
  assert.equal(attached, null);
  assert.equal(attaches, detaches);
});

test("server integration: simultaneous start, repair and resume share one browser listener", async t => {
  const servers = [], changes = [];
  let attached = null, runtimePort = null;
  const api = initServer({
    browserOnly: true,
    isWinHost: false,
    getPortCandidates: () => [0],
    createHttpServer: handler => { const server = http.createServer(handler); servers.push(server); return server; },
    attachBrowserBridge: server => {
      assert.equal(attached, null); attached = server;
      return () => { assert.equal(attached, server); attached = null; };
    },
    writeRuntimeConfig: port => { runtimePort = port; return true; },
    clearRuntimeConfig: () => { runtimePort = null; return true; },
    readRuntimePort: () => runtimePort,
    readRuntimeIdentity: () => ({ ok: false }),
    onBrowserListenerChanged: state => changes.push(state),
  });
  t.after(() => api.cleanup());
  const start = api.startHttpServer();
  assert.equal(api.ensureListening(), start);
  const [port, repaired] = await Promise.all([start, api.repairRuntimeStatus()]);
  assert.equal(repaired.status, "ok");
  assert.ok(port > 0);
  assert.equal(servers.length, 1);
  assert.equal(api.getListenerStatus().state, "listening");
  assert.equal(api.getRuntimeStatus().port, port);
  assert.equal(runtimePort, port);
  await close(servers[0]);
  await until(() => api.getListenerStatus().state === "listening" && servers.length === 2);
  assert.equal(servers.filter(server => server.listening).length, 1);
  assert.ok(changes.some(state => state.state === "idle" && state.port === null));
  await api.cleanup();
  assert.equal(runtimePort, null);
  assert.equal(api.getListenerStatus().state, "disposed");
  assert.equal(await api.startHttpServer(), null);
  assert.equal(servers.length, 2);
});

test("queued repair cannot recreate runtime metadata after cleanup", async t => {
  // This case controls only the Promise ordering; actual bind/close behavior
  // is covered by the surrounding real-socket cases.
  const server = new EventEmitter();
  let runtimePort = null, writes = 0;
  server.listening = false;
  server.address = () => ({ address: "127.0.0.1", port: 23333 });
  server.listen = () => {
    server.listening = true;
    process.nextTick(() => server.emit("listening"));
  };
  server.close = callback => {
    server.listening = false;
    process.nextTick(() => { server.emit("close"); callback(); });
  };
  const api = initServer({
    browserOnly: true,
    isWinHost: false,
    getPortCandidates: () => [23333],
    createHttpServer: () => server,
    writeRuntimeConfig: port => { runtimePort = port; writes++; return true; },
    clearRuntimeConfig: () => { runtimePort = null; return true; },
    readRuntimePort: () => runtimePort,
    readRuntimeIdentity: () => ({ ok: false }),
  });
  t.after(() => api.cleanup());
  assert.equal(await api.startHttpServer(), 23333);
  const initialWrites = writes;
  const repair = api.repairRuntimeStatus();
  const closed = api.cleanup();
  assert.equal((await repair).status, "error");
  await closed;
  assert.equal(runtimePort, null);
  assert.equal(writes, initialWrites);
  assert.equal(api.getRuntimeStatus().listening, false);
});

test("browser-only default candidates stay fixed even when CLI remote mode is configured", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mori-listener-candidates-"));
  const envKeys = ["CLAWD_SSH_REMOTE", "CLAWD_REMOTE_IDENTITY_PATH"];
  const previousEnv = envKeys.map(key => [key, process.env[key]]);
  process.env.CLAWD_SSH_REMOTE = "1";
  process.env.CLAWD_REMOTE_IDENTITY_PATH = path.join(directory, "missing-remote-identity.json");
  t.after(() => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const attempted = [];
  const api = initServer({
    browserOnly: true,
    isWinHost: false,
    createHttpServer: () => {
      const server = new EventEmitter();
      let actualPort = null;
      server.listening = false;
      server.listen = (port, host) => {
        attempted.push([port, host]); actualPort = port;
        process.nextTick(() => {
          if (port !== 23337) server.emit("error", Object.assign(new Error("occupied"), { code: "EADDRINUSE" }));
          else { server.listening = true; server.emit("listening"); }
        });
      };
      server.address = () => ({ address: "127.0.0.1", port: actualPort });
      server.close = callback => { server.listening = false; process.nextTick(callback); };
      return server;
    },
    writeRuntimeConfig: () => true,
    clearRuntimeConfig: () => true,
    readRuntimePort: () => null,
    readRuntimeIdentity: () => ({ ok: false }),
  });
  t.after(() => api.cleanup());
  assert.equal(await api.startHttpServer(), 23337);
  assert.deepEqual(attempted, [23333, 23334, 23335, 23336, 23337].map(port => [port, "127.0.0.1"]));
});

test("a listener invalidated while publishing its port cannot leave runtime metadata behind", async t => {
  const server = new EventEmitter();
  let runtimePort = null;
  server.listening = false;
  server.address = () => ({ address: "127.0.0.1", port: 23333 });
  server.listen = () => {
    server.listening = true;
    process.nextTick(() => server.emit("listening"));
  };
  server.close = callback => { server.listening = false; process.nextTick(callback); };
  const api = initServer({
    browserOnly: true,
    isWinHost: false,
    getPortCandidates: () => [23333],
    createHttpServer: () => server,
    writeRuntimeConfig: port => {
      runtimePort = port;
      server.emit("error", Object.assign(new Error("listener lost before adoption"), { code: "ECONNRESET" }));
      return true;
    },
    clearRuntimeConfig: () => { runtimePort = null; return true; },
    readRuntimePort: () => runtimePort,
    readRuntimeIdentity: () => ({ ok: false }),
  });
  t.after(() => api.cleanup());
  assert.equal(await api.startHttpServer(), null);
  assert.equal(api.getRuntimeStatus().listening, false);
  assert.equal(server.listening, false);
  assert.equal(runtimePort, null);
});

test("real upgraded sockets and handlers are released before an errored listener is replaced", async t => {
  const servers = [], detached = [];
  const owner = createBrowserListener({
    getPortCandidates: () => [0],
    createServer: () => { const server = http.createServer(); servers.push(server); return server; },
    attach: server => {
      const upgrade = (_req, socket) => socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n");
      server.on("upgrade", upgrade);
      return () => { server.removeListener("upgrade", upgrade); detached.push(server); };
    },
  });
  t.after(() => owner.dispose());
  const port = await owner.ensureListening();
  const socket = net.connect(port, "127.0.0.1");
  socket.on("error", () => {});
  t.after(() => socket.destroy());
  await once(socket, "connect");
  const received = once(socket, "data");
  socket.write(`GET /socket HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n`);
  assert.match(String((await received)[0]), /^HTTP\/1\.1 101/);
  const closed = once(socket, "close");
  servers[0].emit("error", Object.assign(new Error("private path must not appear in status"), { code: "ECONNRESET" }));
  await closed;
  await until(() => owner.getStatus().state === "listening" && servers.length === 2);
  assert.equal(servers[0].listening, false);
  assert.equal(servers[0].listenerCount("upgrade"), 0);
  assert.equal(detached.length, 1);
  assert.equal(socket.destroyed, true);
  assert.equal(JSON.stringify(owner.getStatus()).includes("private path"), false);
});

test("dispose during real retry wait prevents rebind after the occupied port is released", async t => {
  const blocker = http.createServer();
  const port = await listen(blocker);
  let created = 0;
  const owner = createBrowserListener({
    getPortCandidates: () => [port],
    createServer: () => { created++; return http.createServer(); },
  });
  t.after(async () => { await owner.dispose(); await close(blocker); });
  assert.equal(await owner.ensureListening(), null);
  assert.equal(owner.getStatus().state, "retry_wait");
  assert.equal(await owner.dispose(), true);
  await close(blocker);
  await delay(1150);
  assert.equal(await owner.ensureListening(), null);
  assert.equal(created, 1);
  assert.equal(owner.getStatus().state, "disposed");
});

test("dispose fences a pending bind and its late listening and error callbacks", async () => {
  const server = new EventEmitter();
  let closes = 0, published = 0;
  server.listening = false;
  server.listen = () => {};
  server.close = callback => { closes++; server.listening = false; process.nextTick(() => callback()); };
  server.address = () => ({ address: "127.0.0.1", port: 23333 });
  const owner = createBrowserListener({ createServer: () => server, onListening: () => { published++; return true; } });
  const started = owner.ensureListening();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(owner.getStatus().state, "binding");
  await owner.dispose();
  assert.equal(await started, null);
  server.listening = true;
  server.emit("listening");
  server.emit("error", new Error("late error"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(server.listening, false);
  assert.equal(published, 0);
  assert.equal(closes, 2);
  assert.equal(owner.getStatus().state, "disposed");
});

test("dispose before the first microtask does not change disposed back to binding", async () => {
  let created = 0;
  const owner = createBrowserListener({ createServer: () => { created++; return http.createServer(); } });
  const first = owner.ensureListening();
  await owner.dispose();
  assert.equal(await first, null);
  assert.equal(created, 0);
  assert.equal(owner.getStatus().state, "disposed");
});

test("dispose inside bridge attach waits for its detacher and never starts listen", async () => {
  const server = new EventEmitter();
  let listens = 0, detaches = 0, stopped;
  server.listening = false;
  server.listen = () => { listens++; };
  server.close = callback => process.nextTick(() => callback());
  const owner = createBrowserListener({
    createServer: () => server,
    attach: () => {
      stopped = owner.dispose();
      return () => { detaches++; };
    },
  });
  assert.equal(await owner.ensureListening(), null);
  assert.equal(await stopped, true);
  assert.equal(listens, 0);
  assert.equal(detaches, 1);
  assert.equal(owner.getStatus().state, "disposed");
});

test("error after listening but before the bind continuation cannot publish a healthy port", async () => {
  const server = new EventEmitter();
  const states = [];
  let persisted = 0;
  server.listening = false;
  server.address = () => ({ address: "127.0.0.1", port: 23333 });
  server.listen = () => process.nextTick(() => {
    server.listening = true;
    server.emit("listening");
    server.emit("error", Object.assign(new Error("failure after listening"), { code: "ECONNRESET" }));
  });
  server.close = callback => { server.listening = false; process.nextTick(() => callback()); };
  const owner = createBrowserListener({
    createServer: () => server,
    onChange: state => states.push(state),
    onListening: () => { persisted++; return true; },
  });
  assert.equal(await owner.ensureListening(), null);
  assert.equal(persisted, 0);
  assert.equal(states.some(state => state.state === "listening"), false);
  assert.equal(owner.getStatus().reason, "bind_failed");
  await owner.dispose();
});

test("uncertain resource cleanup blocks retry and never attaches a second listener", async () => {
  const server = new EventEmitter();
  let created = 0;
  server.listening = false;
  server.listen = () => process.nextTick(() => server.emit("error", Object.assign(new Error("busy"), { code: "EADDRINUSE" })));
  server.close = () => {}; // Neither a close callback nor an event proves release.
  const owner = createBrowserListener({ createServer: () => { created++; return server; }, bindBudgetMs: 40 });
  assert.equal(await owner.ensureListening(), null);
  assert.equal(owner.getStatus().state, "blocked");
  assert.equal(owner.getStatus().reason, "resource_cleanup_failed");
  await delay(80);
  assert.equal(created, 1);
  assert.equal(await owner.dispose(), false);
});

test("runtime persistence failure closes the real listener and is retried only on explicit reconcile", async t => {
  const servers = [];
  let writable = false;
  const owner = createBrowserListener({
    getPortCandidates: () => [0],
    createServer: () => { const server = http.createServer(); servers.push(server); return server; },
    onListening: () => writable,
  });
  t.after(() => owner.dispose());
  assert.equal(await owner.ensureListening(), null);
  assert.equal(owner.getStatus().state, "blocked");
  assert.equal(owner.getStatus().reason, "runtime_file_unavailable");
  assert.equal(servers[0].listening, false);
  await delay(1100);
  assert.equal(servers.length, 1);
  writable = true;
  assert.ok(await owner.ensureListening() > 0);
  assert.equal(owner.getStatus().state, "listening");
});

test("permission failure is classified without leaking raw error details or scanning more ports", async () => {
  let creates = 0;
  const server = new EventEmitter();
  server.listening = false;
  server.listen = () => { throw Object.assign(new Error("EACCES /private/user-data"), { code: "EACCES" }); };
  server.close = callback => process.nextTick(() => callback(Object.assign(new Error("closed"), { code: "ERR_SERVER_NOT_RUNNING" })));
  const owner = createBrowserListener({ createServer: () => { creates++; return server; } });
  assert.equal(await owner.ensureListening(), null);
  assert.equal(owner.getStatus().state, "blocked");
  assert.equal(owner.getStatus().reason, "permission_denied");
  assert.equal(JSON.stringify(owner.getStatus()).includes("private"), false);
  assert.equal(creates, 1);
  await owner.dispose();
});
