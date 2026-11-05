"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CLIENT_ID_RE = /^[0-9]+-[a-z0-9_-]+\.apps\.googleusercontent\.com$/i;
const MAX_CONFIG_BYTES = 32768;

function parseClientConfig(source, { requireSecret = false } = {}) {
  let data;
  try { data = JSON.parse(source); }
  catch { throw new Error("invalid-json"); }
  if (!data || typeof data !== "object" || Array.isArray(data) || data.web || data.type === "service_account")
    throw new Error("not-desktop-client");
  const client = data.installed || data;
  const clientId = client?.client_id || client?.clientId;
  const clientSecret = client?.client_secret || client?.clientSecret;
  if (!CLIENT_ID_RE.test(clientId || "") || (requireSecret && !clientSecret)
    || (clientSecret != null && (typeof clientSecret !== "string" || !/^\S{1,512}$/.test(clientSecret))))
    throw new Error("invalid-desktop-client");
  if (data.installed && (typeof data.installed !== "object" || Array.isArray(data.installed)))
    throw new Error("not-desktop-client");
  return { clientId, clientSecret: clientSecret || null };
}

function readClientConfig(file, fsImpl = fs, options = {}) {
  const stat = fsImpl.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES)
    throw new Error("invalid-config-file");
  return parseClientConfig(fsImpl.readFileSync(file, "utf8"), options);
}

function installClientConfig(file, dataDir, fsImpl = fs) {
  const config = readClientConfig(file, fsImpl, { requireSecret: true });
  fsImpl.mkdirSync(dataDir, { recursive: true });
  const target = path.join(dataDir, "client.json");
  const temporary = path.join(dataDir, `.client-${process.pid}-${require("node:crypto").randomBytes(8).toString("hex")}.tmp`);
  try {
    fsImpl.writeFileSync(temporary, JSON.stringify(config), { encoding: "utf8", mode: 0o600, flag: "wx" });
    fsImpl.renameSync(temporary, target);
  } finally {
    try { fsImpl.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { ok: true };
}

module.exports = { CLIENT_ID_RE, MAX_CONFIG_BYTES, parseClientConfig, readClientConfig, installClientConfig };
