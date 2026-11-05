"use strict";

const EMAIL_RE = /^[^\s<>@]{1,64}@[^\s<>@]{1,253}$/;
const ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_SENDERS = 20;

function email(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return EMAIL_RE.test(normalized) && normalized.length <= 320 ? normalized : null;
}

function fromAddress(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/<([^<>]+)>\s*$/);
  return email(match ? match[1] : value);
}

function header(message, name) {
  const item = message?.payload?.headers?.find(entry =>
    typeof entry?.name === "string" && entry.name.toLowerCase() === name);
  return typeof item?.value === "string" ? item.value : "";
}

function normalizeMessage(message) {
  if (!ID_RE.test(message?.id || "") || !ID_RE.test(message?.threadId || "")) return null;
  const receivedAt = Number(message.internalDate);
  if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) return null;
  const labels = Array.isArray(message.labelIds) ? message.labelIds.filter(x => typeof x === "string") : [];
  return { id: message.id, threadId: message.threadId,
    sender: fromAddress(header(message, "from")),
    from: header(message, "from").slice(0, 320),
    to: header(message, "to").slice(0, 320),
    subject: (header(message, "subject") || "（件名なし）").slice(0, 300),
    snippet: String(message.snippet || "").slice(0, 500),
    receivedAt, unread: labels.includes("UNREAD"),
    inbox: labels.includes("INBOX"),
    excluded: labels.some(label => ["SENT", "DRAFT", "SPAM", "TRASH"].includes(label)) };
}

function sections(rows, senders, hiddenIds) {
  const priority = [], unread = [];
  const chosen = new Set(senders);
  const hidden = new Set(hiddenIds);
  for (const row of rows) {
    if (row.excluded) continue;
    if (chosen.has(row.sender) && !hidden.has(row.id)) priority.push(row);
    else if (row.inbox && row.unread && !chosen.has(row.sender)) unread.push(row);
  }
  const compare = (a, b) => b.receivedAt - a.receivedAt || a.id.localeCompare(b.id);
  return { priority: priority.sort(compare), unread: unread.sort(compare) };
}

function gmailUrl(account, threadId) {
  if (!email(account) || !ID_RE.test(threadId || "")) return null;
  // Gmail's web fragment is not a Gmail API contract. The UI labels this URL accordingly.
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}#all/${encodeURIComponent(threadId)}`;
}

function plainBody(message, maxChars = 20000) {
  const queue = [message?.payload];
  while (queue.length) {
    const part = queue.shift();
    if (!part) continue;
    if (part.mimeType === "text/plain" && typeof part.body?.data === "string") {
      try { return Buffer.from(part.body.data, "base64url").toString("utf8").slice(0, maxChars); }
      catch { return ""; }
    }
    if (Array.isArray(part.parts)) queue.push(...part.parts.slice(0, 50));
  }
  return "";
}

module.exports = { email, fromAddress, normalizeMessage, sections, gmailUrl, plainBody, ID_RE, MAX_SENDERS };
