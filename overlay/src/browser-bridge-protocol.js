// Browser metadata has its own protocol. Never pass it to the CLI /state route.
const crypto = require("node:crypto");

const VERSION = 1;
const PRODUCT_ID = "mori-desk";
const WS_PATH = "/browser/v1";
const EXTENSION_ID = "obooegdoanifidoffaodpobadpeiilcl";
const MAX_FRAME_BYTES = 16 * 1024;
const MAX_CONVERSATION_METADATA_LENGTH = 160;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const PHASES = new Set(["idle", "running", "settled"]);
const OUTCOMES = new Set(["completed", "interrupted", "error", "unverified"]);
const OBSERVATIONS = new Set(["fresh", "stale", "closed", "unsupported"]);
const RESTART_HEALTH_CAPABILITY = "restart-health-v1";
const HEALTH_REASONS = Object.freeze(["checking", "unconfirmed", "loading", "discarded", "frozen",
  "permission_denied", "paused", "unsupported", "over_limit", "unavailable"]);
const VERSION_TEXT = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,31}$/;

function protocolError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isId(value) { return typeof value === "string" && ID.test(value); }
function isSecret(value) {
  return typeof value === "string" && SECRET.test(value)
    && Buffer.from(value, "base64url").length === 32
    && Buffer.from(value, "base64url").toString("base64url") === value;
}
function isInteger(value, min = 0) { return Number.isSafeInteger(value) && value >= min; }
function isObject(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function isConversationMetadata(value) {
  return typeof value === "string" && value.length <= MAX_CONVERSATION_METADATA_LENGTH
    && value.isWellFormed() && value === value.replace(/\s+/gu, " ").trim()
    && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);
}
function assertKeys(value, allowed) {
  if (!isObject(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw protocolError("invalid_schema");
  }
}

function authText(label, context) {
  return JSON.stringify([
    "mori-desk/browser/v1", label, VERSION, context.mode,
    context.credentialId, context.clientId, context.productId,
    context.instanceId, context.serverRunId, context.port,
    context.clientNonce, context.serverNonce,
  ]);
}

function mac(key, label, context) {
  return crypto.createHmac("sha256", Buffer.from(key, "base64url"))
    .update(authText(label, context), "utf8").digest("base64url");
}

function verifyMac(proof, key, label, context) {
  if (!isSecret(proof) || !isSecret(key)) return false;
  return crypto.timingSafeEqual(Buffer.from(proof, "base64url"), Buffer.from(mac(key, label, context), "base64url"));
}

function validateHello(input) {
  assertKeys(input, ["type", "v", "mode", "clientId", "browserRunId", "instanceId", "credentialId", "clientNonce"]);
  if (input.type !== "hello" || input.v !== VERSION
    || !["pair", "resume"].includes(input.mode)
    || ![input.clientId, input.browserRunId, input.instanceId, input.credentialId].every(isId)
    || !isSecret(input.clientNonce)
    || (input.mode === "resume" && input.credentialId !== input.clientId)) {
    throw protocolError("invalid_hello");
  }
  return { ...input };
}

function normalizeConversationRef(provider, ref) {
  if (ref === null) return null;
  const pattern = provider === "chatgpt"
    ? /^\/c\/[A-Za-z0-9-]{1,128}$/ : /^\/chat\/[A-Za-z0-9-]{1,128}$/;
  if (typeof ref !== "string" || !pattern.test(ref)) throw protocolError("invalid_conversation");
  return ref;
}

function validateEvent(input) {
  assertKeys(input, ["type", "v", "eventId", "browserRunId", "sessionId", "sequence", "kind",
    "provider", "tabId", "pageInstanceId", "routeRevision", "conversationRef", "turnId", "generation",
    "phase", "outcome", "observation", "observedAt", "replay", "conversationTitle", "requestPreview"]);
  if (input.type !== "event" || input.v !== VERSION
    || ![input.eventId, input.browserRunId, input.sessionId, input.pageInstanceId].every(isId)
    || !isInteger(input.sequence, 1) || !isInteger(input.tabId) || !isInteger(input.routeRevision)
    || !isInteger(input.generation) || !isInteger(input.observedAt, 1)
    || !["observation", "terminal", "closed"].includes(input.kind)
    || !["chatgpt", "claude"].includes(input.provider)
    || !PHASES.has(input.phase) || !OBSERVATIONS.has(input.observation)
    || (input.turnId !== null && !isId(input.turnId))
    || (input.outcome !== null && !OUTCOMES.has(input.outcome))
    || typeof input.replay !== "boolean"
    || (input.phase === "running" && (input.outcome !== null || input.turnId === null || input.generation < 1))
    || (input.kind === "terminal" && (input.phase !== "settled" || !OUTCOMES.has(input.outcome) || input.turnId === null || input.generation < 1))
    || (input.kind === "closed" && input.observation !== "closed")) {
    throw protocolError("invalid_event");
  }
  for (const key of ["conversationTitle", "requestPreview"]) {
    if (Object.hasOwn(input, key) && !isConversationMetadata(input[key])) throw protocolError("invalid_metadata");
  }
  return { ...input, conversationRef: normalizeConversationRef(input.provider, input.conversationRef) };
}

function validateDesktopBuild(input) {
  assertKeys(input, ["desktopVersion", "buildId", "observerContract"]);
  if (typeof input.desktopVersion !== "string" || !VERSION_TEXT.test(input.desktopVersion)
    || typeof input.buildId !== "string" || !/^[a-f0-9]{64}$/.test(input.buildId)
    || input.observerContract !== 1) throw protocolError("invalid_build");
  return { desktopVersion: input.desktopVersion, buildId: input.buildId, observerContract: 1 };
}

function validateClientHealth(input) {
  assertKeys(input, ["type", "v", "schema", "browserRunId", "workerEpoch", "sequence", "extensionVersion",
    "observerVersion", "buildId", "observerContract", "providers", "delivery"]);
  if (input.type !== "client.health" || input.v !== VERSION || input.schema !== 1
    || !isId(input.browserRunId) || !isId(input.workerEpoch) || !isInteger(input.sequence, 1)
    || typeof input.extensionVersion !== "string" || !VERSION_TEXT.test(input.extensionVersion)
    || typeof input.observerVersion !== "string" || !VERSION_TEXT.test(input.observerVersion)
    || typeof input.buildId !== "string" || !/^[a-f0-9]{64}$/.test(input.buildId) || input.observerContract !== 1
    || !Array.isArray(input.providers) || input.providers.length !== 2) throw protocolError("invalid_health");
  const providers = new Set();
  let eligibleTotal = 0;
  for (const row of input.providers) {
    assertKeys(row, ["provider", "inventory", "discovered", "eligible", "admitted", "fresh", "unmonitored", "reasons"]);
    if (!["chatgpt", "claude"].includes(row.provider) || providers.has(row.provider)
      || !["known", "unknown"].includes(row.inventory)) throw protocolError("invalid_health");
    providers.add(row.provider);
    const counts = ["discovered", "eligible", "admitted", "fresh", "unmonitored"];
    if (row.inventory === "unknown") {
      if (counts.some(key => row[key] !== null) || row.reasons !== null) throw protocolError("invalid_health");
      continue;
    }
    if (counts.some(key => !isInteger(row[key]) || row[key] > 100000)
      || row.fresh > row.admitted || row.admitted > row.eligible || row.eligible > row.discovered
      || row.unmonitored !== row.discovered - row.fresh) throw protocolError("invalid_health");
    assertKeys(row.reasons, HEALTH_REASONS);
    if (HEALTH_REASONS.some(key => !isInteger(row.reasons[key]) || row.reasons[key] > 100000)
      || HEALTH_REASONS.reduce((sum, key) => sum + row.reasons[key], 0) !== row.unmonitored) throw protocolError("invalid_health");
    eligibleTotal += row.eligible;
  }
  if (eligibleTotal > 20) throw protocolError("invalid_health");
  const delivery = input.delivery;
  assertKeys(delivery, ["state", "remainingReplay", "livePending", "reserveUsed"]);
  if (!["unknown", "syncing", "current", "capacity_blocked"].includes(delivery.state)) throw protocolError("invalid_health");
  for (const [key, max] of [["remainingReplay", 220], ["livePending", 220], ["reserveUsed", 20]]) {
    if (delivery.state === "unknown" ? delivery[key] !== null : !isInteger(delivery[key]) || delivery[key] > max) {
      throw protocolError("invalid_health");
    }
  }
  if (delivery.state === "current" && delivery.remainingReplay !== 0) throw protocolError("invalid_health");
  return structuredClone(input);
}

function decodeFrame(data, isBinary = false) {
  if (isBinary || Buffer.byteLength(data) > MAX_FRAME_BYTES) throw protocolError("invalid_frame");
  let input;
  try { input = JSON.parse(data.toString("utf8")); } catch { throw protocolError("invalid_json"); }
  if (!isObject(input) || typeof input.type !== "string") throw protocolError("invalid_schema");
  return input;
}

function desktopSessionId(clientId, browserRunId, sessionId) {
  return `browser:${clientId}:${browserRunId}:${sessionId}`;
}

module.exports = {
  VERSION, PRODUCT_ID, WS_PATH, EXTENSION_ID, MAX_FRAME_BYTES, MAX_CONVERSATION_METADATA_LENGTH,
  isId, isSecret, isInteger, isObject, isConversationMetadata, assertKeys, protocolError,
  authText, mac, verifyMac, validateHello, validateEvent,
  normalizeConversationRef, decodeFrame, desktopSessionId,
  RESTART_HEALTH_CAPABILITY, HEALTH_REASONS, validateDesktopBuild, validateClientHealth,
};
