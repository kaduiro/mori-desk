"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const { ID_RE } = require("./mori-mail-core");

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN = "https://oauth2.googleapis.com/token";
function failure(code) { return Object.assign(new Error(code), { code }); }

async function readJson(response, maxBytes = 2 * 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) throw failure("empty-response");
  let size = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw failure("response-too-large"); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
  catch { throw failure("invalid-response"); }
}

async function tokenRequest(params, fetchImpl) {
  const response = await fetchImpl(TOKEN, { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params), signal: AbortSignal.timeout(15000) });
  const body = await readJson(response, 50000);
  if (!response.ok) throw failure(body.error === "invalid_grant" ? "auth-expired" : "auth-failed");
  if (typeof body.access_token !== "string" || !body.access_token) throw failure("auth-failed");
  return body;
}

async function authorize({ client, shell, fetchImpl = fetch, timeoutMs = 300000 }) {
  const state = crypto.randomBytes(32).toString("base64url");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  let settle;
  const codePromise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  void codePromise.catch(() => {});
  let completed = false, port = 0;
  const server = http.createServer((request, response) => {
    if (completed) { response.writeHead(409).end(); return; }
    if (request.method !== "GET" || request.headers.host !== `127.0.0.1:${port}`
      || typeof request.url !== "string" || request.url.length > 8192) {
      response.writeHead(400).end(); return;
    }
    let callback;
    try { callback = new URL(request.url, `http://127.0.0.1:${port}`); }
    catch { response.writeHead(400).end(); return; }
    if (callback.pathname !== "/callback" || callback.searchParams.get("state") !== state) {
      response.writeHead(400).end(); return;
    }
    completed = true;
    const code = callback.searchParams.get("code");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'" });
    response.end("<!doctype html><meta charset=utf-8><p>Mori Desk に戻ってください。このタブを閉じられます。</p>");
    if (!code || code.length > 4096 || callback.searchParams.has("error")) settle.reject(failure("consent-denied"));
    else settle.resolve(code);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    port = server.address().port;
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    for (const [key, value] of Object.entries({ client_id: client.clientId,
      redirect_uri: redirectUri, response_type: "code", scope: SCOPE,
      access_type: "offline", prompt: "consent", state,
      code_challenge: challenge, code_challenge_method: "S256" })) url.searchParams.set(key, value);
    const timeout = setTimeout(() => settle.reject(failure("auth-timeout")), timeoutMs);
    try {
      // The browser launch can stall on some Windows configurations. Keep the
      // consent timeout effective even while the shell promise is unresolved.
      await Promise.race([shell.openExternal(url.href), codePromise]);
      const code = await codePromise;
      const token = await tokenRequest({ client_id: client.clientId,
        ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
        code, code_verifier: verifier, redirect_uri: redirectUri,
        grant_type: "authorization_code" }, fetchImpl);
      if (!String(token.scope || "").split(" ").includes(SCOPE)) throw failure("scope-denied");
      if (typeof token.refresh_token !== "string" || !token.refresh_token) throw failure("missing-refresh-token");
      return { accessToken: token.access_token, refreshToken: token.refresh_token,
        expiresAt: Date.now() + Number(token.expires_in || 3000) * 1000 };
    } finally { clearTimeout(timeout); }
  } finally { if (server.listening) server.close(); }
}

async function refreshToken({ client, refreshToken, fetchImpl = fetch }) {
  const body = await tokenRequest({ client_id: client.clientId,
    ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    refresh_token: refreshToken, grant_type: "refresh_token" }, fetchImpl);
  return { accessToken: body.access_token,
    expiresAt: Date.now() + Number(body.expires_in || 3000) * 1000 };
}

function apiError(response, body) {
  const retryHeader = response.headers?.get?.("retry-after");
  const seconds = retryHeader == null ? NaN : Number(retryHeader);
  const retryDate = retryHeader == null ? NaN : Date.parse(retryHeader);
  const nextAt = Number.isFinite(seconds) && seconds >= 0
    ? Date.now() + Math.min(seconds * 1000, 3600000)
    : Number.isFinite(retryDate) ? Math.min(retryDate, Date.now() + 3600000) : null;
  if (response.status === 429 || response.status === 403
    && (body?.error?.status === "RESOURCE_EXHAUSTED" ||
      (body?.error?.errors || []).some(entry => /quota|rateLimit|usageLimits/i.test(entry?.reason || ""))))
    return Object.assign(failure("google-quota"), { nextAt });
  if (response.status === 401) return failure("unauthorized");
  if (response.status === 403) return failure("permission-denied");
  if (response.status === 404) return failure("not-found");
  return failure("gmail-api-failed");
}

async function call({ path, accessToken, units, reserve, fetchImpl = fetch, maxBytes = 2 * 1024 * 1024 }) {
  const slot = reserve(units);
  if (!slot.allowed) throw Object.assign(failure(slot.reason), { nextAt: slot.nextAt });
  const response = await fetchImpl(API + path, { headers: {
    Authorization: `Bearer ${accessToken}`, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  const body = await readJson(response, maxBytes);
  if (!response.ok) throw apiError(response, body);
  return body;
}

function profile(args) { return call({ ...args, path: "/profile", units: 1 }); }
function listUnread({ pageToken = null, ...args }) {
  const url = new URL(API + "/messages");
  url.searchParams.set("q", "in:inbox is:unread");
  url.searchParams.set("maxResults", "100");
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  return call({ ...args, path: url.pathname.slice(new URL(API).pathname.length) + url.search, units: 5 });
}
function history({ startHistoryId, pageToken = null, ...args }) {
  if (!/^\d+$/.test(startHistoryId || "")) throw failure("invalid-history-id");
  const url = new URL(API + "/history");
  url.searchParams.set("startHistoryId", startHistoryId);
  url.searchParams.set("maxResults", "500");
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  return call({ ...args, path: url.pathname.slice(new URL(API).pathname.length) + url.search, units: 2 });
}
function message({ id, format = "metadata", ...args }) {
  if (!ID_RE.test(id || "") || !["metadata", "full"].includes(format)) throw failure("invalid-message-id");
  const url = new URL(`${API}/messages/${encodeURIComponent(id)}`);
  url.searchParams.set("format", format);
  if (format === "metadata") for (const name of ["From", "To", "Subject", "Message-ID"])
    url.searchParams.append("metadataHeaders", name);
  return call({ ...args, path: url.pathname.slice(new URL(API).pathname.length) + url.search,
    units: format === "full" ? 60 : 20, maxBytes: format === "full" ? 4 * 1024 * 1024 : 2 * 1024 * 1024 });
}

module.exports = { SCOPE, authorize, refreshToken, profile, listUnread, history, message, failure };
