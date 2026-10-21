/* SPDX-License-Identifier: AGPL-3.0-only */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports
    ? require('./provider-utils.js') : root.MoriProviderUtils);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoriTransport = api;
})(typeof globalThis === 'object' ? globalThis : this, function (utils) {
  'use strict';
  const PORTS = [23333, 23334, 23335, 23336, 23337];
  const MAX_BYTES = 16 * 1024;
  const encoder = new TextEncoder();
  function toBase64url(bytes) {
    let binary = '';
    for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  function fromBase64url(value, length) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 4096) throw new Error('invalid_encoding');
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    if (length !== undefined && bytes.length !== length) throw new Error('invalid_encoding');
    if (toBase64url(bytes) !== value) throw new Error('invalid_encoding');
    return bytes;
  }
  function canonical(label, challenge) {
    return JSON.stringify(['mori-desk/browser/v1', label, 1, challenge.mode,
      challenge.credentialId, challenge.clientId, challenge.productId,
      challenge.instanceId, challenge.serverRunId, challenge.port,
      challenge.clientNonce, challenge.serverNonce]);
  }
  async function hmac(secret, value, cryptoApi = globalThis.crypto) {
    const key = await cryptoApi.subtle.importKey('raw', fromBase64url(secret, 32),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return toBase64url(await cryptoApi.subtle.sign('HMAC', key, encoder.encode(value)));
  }
  function equalProof(left, right) {
    let a; let b;
    try { a = fromBase64url(left, 32); b = fromBase64url(right, 32); } catch (_) { return false; }
    let different = 0;
    for (let index = 0; index < a.length; index++) different |= a[index] ^ b[index];
    return different === 0;
  }
  function parsePairingCode(value, now = Date.now()) {
    if (typeof value !== 'string' || value.length > 2048 || !value.trim().startsWith('mori1:')) throw new Error('invalid_pairing_code');
    let code;
    try { code = JSON.parse(new TextDecoder().decode(fromBase64url(value.trim().slice(6)))); }
    catch (_) { throw new Error('invalid_pairing_code'); }
    if (!code || code.v !== 1 || code.productId !== 'mori-desk'
      || !utils.ID.test(code.instanceId || '') || !utils.ID.test(code.pairingId || '')
      || !PORTS.includes(code.port) || !Number.isFinite(code.expiresAt)) throw new Error('invalid_pairing_code');
    try { fromBase64url(code.secret, 32); } catch (_) { throw new Error('invalid_pairing_code'); }
    if (code.expiresAt <= now || code.expiresAt > now + 180000) throw new Error('pairing_expired');
    return { v: 1, productId: code.productId, instanceId: code.instanceId,
      pairingId: code.pairingId, port: code.port, secret: code.secret, expiresAt: code.expiresAt };
  }
  function verifyChallenge(challenge, expected) {
    if (!challenge || challenge.type !== 'challenge' || challenge.v !== 1
      || challenge.mode !== expected.mode || challenge.productId !== 'mori-desk'
      || challenge.instanceId !== expected.instanceId || challenge.clientId !== expected.clientId
      || challenge.credentialId !== expected.credentialId || challenge.clientNonce !== expected.clientNonce
      || challenge.port !== expected.port || !PORTS.includes(challenge.port)
      || !utils.ID.test(challenge.serverRunId || '')) return false;
    try { fromBase64url(challenge.serverNonce, 32); fromBase64url(challenge.proof, 32); } catch (_) { return false; }
    return true;
  }

  class Transport {
    constructor({ clientId, browserRunId, getCredential, saveCredential,
      onStatus = () => {}, onReady = () => {}, onFocus = async () => ({ ok: false }),
      WebSocketClass = globalThis.WebSocket, cryptoApi = globalThis.crypto,
      now = () => Date.now() }) {
      Object.assign(this, { clientId, browserRunId, getCredential, saveCredential, onStatus, onReady,
        onFocus, WebSocketClass, cryptoApi, now });
      this.connection = null; this.connecting = null; this.reconnectTimer = null;
      this.attempt = 0; this.generation = 0; this.enabled = true; this.pairing = false;
      this.pairingOwner = null;
      this.lastSendAt = 0;
    }
    isReady() { return !!this.connection?.ready; }
    setEnabled(value) {
      this.enabled = value;
      if (!value) this.disconnect('paused'); else void this.ensureConnected();
    }
    disconnect(reason = 'disconnected') {
      this.generation++;
      clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
      this.connection?.fail(reason, false);
      this.onStatus({ state: reason === 'paused' ? 'paused' : 'disconnected', code: reason });
    }
    scheduleReconnect() {
      if (!this.enabled || this.pairing || !this.getCredential() || this.reconnectTimer) return;
      const delay = Math.min(30000, 1000 * (2 ** Math.min(this.attempt++, 5))) + Math.floor(Math.random() * 250);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null; void this.ensureConnected();
      }, delay);
    }
    async pair(value) {
      const code = parsePairingCode(value, this.now());
      this.disconnect('pairing'); this.enabled = true; this.pairing = true;
      const owner = {}; this.pairingOwner = owner;
      this.onStatus({ state: 'pairing', code: null });
      try { await this.connectOne(code.port, code); }
      finally {
        code.secret = '';
        // A replaced pair may finish after its successor has started. Only
        // the current attempt may release the exclusion on resume attempts.
        if (this.pairingOwner === owner) {
          this.pairingOwner = null; this.pairing = false;
          if (!this.isReady()) this.scheduleReconnect();
        }
      }
    }
    async ensureConnected({ immediate = false } = {}) {
      if (!this.enabled || this.pairing || this.isReady()) return;
      if (this.connecting) return this.connecting;
      if (this.reconnectTimer) {
        // DOM observations and reconnect alarms must share the scheduled
        // backoff. Only the user's explicit retry may cancel that wait.
        if (immediate !== true) return;
        clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
      }
      const credential = this.getCredential();
      if (!credential) { this.onStatus({ state: 'unpaired', code: null }); return; }
      const generation = this.generation;
      const ports = [...new Set([credential.port, ...PORTS])].filter(port => PORTS.includes(port));
      this.connecting = (async () => {
        this.onStatus({ state: 'connecting', code: null });
        let code = 'desktop_offline';
        for (const port of ports) {
          if (!this.enabled || this.pairing || generation !== this.generation) return;
          try { await this.connectOne(port); return; }
          catch (error) { code = error.message; }
        }
        if (generation !== this.generation || this.pairing || !this.enabled) return;
        this.onStatus({ state: 'disconnected', code });
        this.scheduleReconnect();
      })().finally(() => { this.connecting = null; });
      return this.connecting;
    }
    connectOne(port, pairCode = null) {
      const generation = this.generation;
      return new Promise((resolve, reject) => {
        const credential = pairCode || this.getCredential();
        if (!credential) { reject(new Error('unpaired')); return; }
        const mode = pairCode ? 'pair' : 'resume';
        const clientNonce = toBase64url(this.cryptoApi.getRandomValues(new Uint8Array(32)));
        const expected = { mode, clientId: this.clientId, instanceId: credential.instanceId,
          credentialId: pairCode ? pairCode.pairingId : this.clientId, clientNonce, port };
        let sharedSecret = pairCode ? pairCode.secret : credential.key;
        let challenge = null; let derivedKey = null; let stage = 'hello';
        let fulfilled = false; let closed = false; let heartbeat = null;
        let ws;
        try { ws = new this.WebSocketClass(`ws://127.0.0.1:${port}/browser/v1`); }
        catch (_) { reject(new Error('connection_failed')); return; }
        const connection = { ws, ready: false, pending: new Map(), lastPong: this.now() };
        const fail = (code, reconnect = true) => {
          if (closed) return;
          closed = true; clearTimeout(authTimer); clearInterval(heartbeat);
          sharedSecret = ''; derivedKey = null;
          for (const pending of connection.pending.values()) {
            clearTimeout(pending.timer); pending.reject(new Error(code));
          }
          connection.pending.clear();
          const wasCurrent = this.connection === connection;
          if (wasCurrent) this.connection = null;
          try { ws.close(); } catch (_) {}
          if (!fulfilled) reject(new Error(code));
          if (fulfilled && wasCurrent) {
            this.onStatus({ state: 'disconnected', code });
            if (reconnect) this.scheduleReconnect();
          }
        };
        connection.fail = fail;
        this.connection = connection;
        const authTimer = setTimeout(() => fail('authentication_timeout'), 5000);
        // Crypto and credential persistence yield to pause, disconnect,
        // authentication timeout and replacement connections. A continuation
        // from the old socket must not publish ready or start a heartbeat.
        const current = () => {
          if (closed) return false;
          if (this.connection === connection && this.generation === generation && this.enabled) return true;
          fail('connection_closed', false);
          return false;
        };
        const send = message => {
          if (!current()) throw new Error('connection_closed');
          const text = JSON.stringify(message);
          if (encoder.encode(text).byteLength > MAX_BYTES) throw new Error('message_too_large');
          ws.send(text);
        };
        ws.onopen = () => {
          try { send({ type: 'hello', v: 1, mode, clientId: this.clientId,
            browserRunId: this.browserRunId, instanceId: expected.instanceId,
            credentialId: expected.credentialId, clientNonce }); }
          catch (_) { fail('connection_failed'); }
        };
        let chain = Promise.resolve();
        ws.onmessage = event => {
          chain = chain.then(async () => {
            if (!current()) return;
            if (typeof event.data !== 'string' || encoder.encode(event.data).byteLength > MAX_BYTES) throw new Error('invalid_message');
            let message;
            try { message = JSON.parse(event.data); } catch (_) { throw new Error('invalid_message'); }
            if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('invalid_message');
            if (message.type === 'error') {
              // Never display server-supplied prose; only bounded code labels.
              const code = /^[a-z_]{1,64}$/.test(message.code || '') ? message.code : 'server_error';
              throw new Error(code);
            }
            if (!connection.ready) {
              if (message.type === 'challenge' && stage === 'hello') {
                if (!verifyChallenge(message, expected)) throw new Error('identity_mismatch');
                const proof = await hmac(sharedSecret, canonical('server-proof', message), this.cryptoApi);
                if (!current()) return;
                if (!equalProof(proof, message.proof)) throw new Error('authentication_failed');
                challenge = message;
                if (mode === 'pair') derivedKey = await hmac(sharedSecret, canonical('credential', challenge), this.cryptoApi);
                if (!current()) return;
                const clientProof = await hmac(sharedSecret, canonical('client-proof', challenge), this.cryptoApi);
                if (!current()) return;
                stage = 'authenticated';
                send({ type: 'authenticate', proof: clientProof });
              } else if (message.type === 'pair.ready' && mode === 'pair' && stage === 'authenticated') {
                if (message.clientId !== this.clientId || message.credentialId !== this.clientId) throw new Error('identity_mismatch');
                // This write must succeed before the desktop activates the key.
                await this.saveCredential({ clientId: this.clientId, instanceId: expected.instanceId,
                  key: derivedKey, port });
                if (!current()) return;
                const proof = await hmac(derivedKey, canonical('pair-confirm', challenge), this.cryptoApi);
                if (!current()) return;
                stage = 'confirmed'; send({ type: 'pair.confirm', proof });
              } else if (message.type === 'ready'
                && ((mode === 'pair' && stage === 'confirmed') || (mode === 'resume' && stage === 'authenticated'))) {
                if (message.v !== 1 || message.clientId !== this.clientId || message.instanceId !== expected.instanceId
                  || message.serverRunId !== challenge?.serverRunId || message.port !== port) throw new Error('identity_mismatch');
                if (mode === 'resume' && credential.port !== port) await this.saveCredential({ ...credential, port });
                if (!current()) return;
                clearTimeout(authTimer); connection.ready = true; this.attempt = 0;
                sharedSecret = ''; derivedKey = null;
                this.onStatus({ state: 'connected', code: null, port });
                // Status callbacks can synchronously pause or replace this
                // connection; leave its promise rejectable until they return.
                if (!current()) return;
                heartbeat = setInterval(() => {
                  if (this.now() - connection.lastPong > 65000) { fail('heartbeat_timeout'); return; }
                  try { send({ type: 'ping', at: this.now() }); } catch (_) { fail('connection_failed'); }
                }, 20000);
                fulfilled = true; resolve();
                // Do not await callbacks in the incoming-message queue: outbox
                // replay waits for ACKs that must be processed by this queue.
                Promise.resolve(this.onReady()).catch(() => fail('sync_failed'));
              } else throw new Error('unexpected_auth_message');
              return;
            }
            if (message.type === 'pong') { connection.lastPong = this.now(); return; }
            if (message.type === 'ping') { send({ type: 'pong', at: message.at }); return; }
            if (message.type === 'event.ack') {
              const pending = connection.pending.get(message.eventId);
              if (!pending) return;
              if (message.sessionId !== pending.event.sessionId || message.browserRunId !== pending.event.browserRunId
                || message.sequence !== pending.event.sequence) throw new Error('invalid_ack');
              clearTimeout(pending.timer); connection.pending.delete(message.eventId); pending.resolve(message);
            } else if (message.type === 'focus.request') {
              Promise.resolve(this.onFocus(message)).then(result => {
                if (!closed && connection.ready) send({ type: 'focus.result', requestId: message.requestId,
                  browserRunId: message.browserRunId, sessionId: message.sessionId,
                  pageInstanceId: message.pageInstanceId, routeRevision: message.routeRevision,
                  conversationRef: message.conversationRef, ...result });
              }).catch(() => {
                if (!closed) send({ type: 'focus.result', requestId: message.requestId, ok: false,
                  reason: 'focus_failed', browserRunId: message.browserRunId, sessionId: message.sessionId,
                  pageInstanceId: message.pageInstanceId, routeRevision: message.routeRevision,
                  conversationRef: message.conversationRef });
              });
            } else throw new Error('unexpected_message');
          }).catch(error => fail(error.message || 'connection_failed'));
        };
        ws.onerror = () => fail('connection_failed');
        ws.onclose = () => fail('connection_closed');
      });
    }
    async sendEvent(event) {
      const connection = this.connection;
      if (!connection?.ready) throw new Error('disconnected');
      const wait = Math.max(0, 80 - (this.now() - this.lastSendAt));
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      if (connection !== this.connection || !connection.ready) throw new Error('disconnected');
      this.lastSendAt = this.now();
      const text = JSON.stringify(event);
      if (encoder.encode(text).byteLength > MAX_BYTES) throw new Error('message_too_large');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          connection.pending.delete(event.eventId); reject(new Error('ack_timeout'));
          connection.fail('ack_timeout');
        }, 5000);
        connection.pending.set(event.eventId, { event, resolve, reject, timer });
        try { connection.ws.send(text); }
        catch (_) { clearTimeout(timer); connection.pending.delete(event.eventId); reject(new Error('connection_failed')); }
      });
    }
  }

  return { Transport, PORTS, MAX_BYTES, toBase64url, fromBase64url, canonical, hmac,
    equalProof, parsePairingCode, verifyChallenge };
});
