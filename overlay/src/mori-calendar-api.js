"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const { dayBounds, normalizeEvents } = require("./mori-calendar-core");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
const LIST_SCOPE = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const CALENDAR_LIST_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList";

function failure(code) { return Object.assign(new Error(code), { code }); }

async function readJson(response, maxBytes = 12 * 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) throw failure("empty-response");
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw failure("response-too-large");
    }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
  catch { throw failure("invalid-response"); }
}

async function tokenRequest(params, fetchImpl = fetch) {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params), signal: AbortSignal.timeout(15000),
  });
  const body = await readJson(response, 50000);
  if (!response.ok) {
    if (body.error === "invalid_request" && /client_secret is missing/i.test(body.error_description || ""))
      throw failure("client-secret-required");
    throw failure(body.error === "invalid_grant" ? "auth-expired" : "auth-failed");
  }
  if (typeof body.access_token !== "string" || !body.access_token) throw failure("auth-failed");
  return body;
}

async function authorize({ clientId, clientSecret, shell, fetchImpl = fetch, timeoutMs = 5 * 60 * 1000 }) {
  const state = crypto.randomBytes(32).toString("base64url");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  let settle;
  const codePromise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  // A browser-launch failure can happen before this promise is awaited.
  void codePromise.catch(() => {});
  let completed = false;
  let port = 0;
  const server = http.createServer((request, response) => {
    if (completed) { response.writeHead(409).end(); return; }
    if (request.method !== "GET" || request.headers.host !== "127.0.0.1:" + port) {
      response.writeHead(400).end(); return;
    }
    let callback;
    try { callback = new URL(request.url, "http://127.0.0.1:" + port); }
    catch { response.writeHead(400).end(); return; }
    if (callback.pathname !== "/callback" || callback.searchParams.get("state") !== state) {
      response.writeHead(400).end(); return;
    }
    completed = true;
    const code = callback.searchParams.get("code");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'" });
    response.end("<!doctype html><meta charset=utf-8><p>Mori Desk に戻ってください。このタブを閉じられます。</p>");
    if (!code || callback.searchParams.has("error")) settle.reject(failure("consent-denied"));
    else settle.resolve(code);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    port = server.address().port;
    const redirectUri = "http://127.0.0.1:" + port + "/callback";
    const url = new URL(AUTH_URL);
    for (const [key, value] of Object.entries({
      client_id: clientId, redirect_uri: redirectUri, response_type: "code",
      scope: SCOPE + " " + LIST_SCOPE, access_type: "offline", prompt: "consent", state,
      code_challenge: challenge, code_challenge_method: "S256",
    })) url.searchParams.set(key, value);
    const timeout = setTimeout(() => settle.reject(failure("auth-timeout")), timeoutMs);
    try {
      await shell.openExternal(url.href);
      const code = await codePromise;
      const token = await tokenRequest({
        client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}),
        code, code_verifier: verifier, redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }, fetchImpl);
      if (typeof token.refresh_token !== "string" || !token.refresh_token) throw failure("missing-refresh-token");
      if (!String(token.scope || "").split(" ").includes(SCOPE)) throw failure("scope-denied");
      return { accessToken: token.access_token, expiresAt: Date.now() + Number(token.expires_in || 3000) * 1000,
        refreshToken: token.refresh_token, listScope: String(token.scope || "").split(" ").includes(LIST_SCOPE) };
    } finally { clearTimeout(timeout); }
  } finally { if (server.listening) server.close(); }
}

async function refreshToken(clientId, clientSecret, refreshToken, fetchImpl = fetch) {
  const token = await tokenRequest({ client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    refresh_token: refreshToken, grant_type: "refresh_token" }, fetchImpl);
  return { accessToken: token.access_token, expiresAt: Date.now() + Number(token.expires_in || 3000) * 1000 };
}

function isQuotaError(response, body) {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  const reasons = (body?.error?.errors || []).map(entry => String(entry?.reason || ""));
  return body?.error?.status === "RESOURCE_EXHAUSTED"
    || reasons.some(reason => /quota|rateLimit|usageLimits|dailyLimit/i.test(reason));
}

function apiFailure(response, body) {
  if (isQuotaError(response, body)) return failure("google-quota");
  if (response.status === 401) return failure("auth-expired");
  if (response.status === 403) return failure("permission-denied");
  if (response.status === 404) return failure("calendar-not-found");
  return failure("calendar-api-failed");
}

async function listCalendars({ accessToken, requestPage, fetchImpl = fetch }) {
  const calendars = [];
  let pageToken = null;
  let pages = 0;
  do {
    if (++pages > 20) throw failure("too-many-pages");
    await requestPage();
    const url = new URL(CALENDAR_LIST_URL);
    url.searchParams.set("maxResults", "250");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetchImpl(url.href, {
      headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    const body = await readJson(response, 2 * 1024 * 1024);
    if (!response.ok) throw apiFailure(response, body);
    if (!Array.isArray(body.items)) throw failure("invalid-response");
    for (const item of body.items) {
      if (calendars.length >= 500) throw failure("too-many-calendars");
      if (typeof item?.id !== "string" || !item.id || item.id.length > 512) continue;
      const role = item.accessRole;
      calendars.push({ id: item.id, name: String(item.summaryOverride || item.summary || item.id).slice(0, 160),
        primary: item.primary === true, selected: item.selected === true,
        readable: ["reader", "writer", "owner"].includes(role) });
    }
    pageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : null;
  } while (pageToken);
  return calendars;
}

async function listToday({ accessToken, requestPage, fetchImpl = fetch, now = new Date(), calendarId = "primary" }) {
  if (typeof calendarId !== "string" || !calendarId || calendarId.length > 512) throw failure("invalid-calendar-id");
  const bounds = dayBounds(now);
  const all = [];
  let pageToken = null;
  let pages = 0;
  do {
    if (++pages > 20) throw failure("too-many-pages");
    await requestPage();
    const url = new URL("https://www.googleapis.com/calendar/v3/calendars/" + encodeURIComponent(calendarId) + "/events");
    for (const [key, value] of Object.entries({
      timeMin: bounds.start, timeMax: bounds.end, singleEvents: "true",
      orderBy: "startTime", maxResults: "250",
    })) url.searchParams.set(key, value);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetchImpl(url.href, {
      headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    const body = await readJson(response);
    if (!response.ok) {
      throw apiFailure(response, body);
    }
    if (!Array.isArray(body.items)) throw failure("invalid-response");
    all.push(...body.items);
    pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : null;
  } while (pageToken);
  return { key: bounds.key, events: normalizeEvents(all) };
}

module.exports = { AUTH_URL, TOKEN_URL, EVENTS_URL, CALENDAR_LIST_URL, SCOPE, LIST_SCOPE,
  authorize, refreshToken, listToday, listCalendars, isQuotaError, readJson };
