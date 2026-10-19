# Browser Bridge protocol v1

This document describes the development preview. The strict implementation in
`overlay/src/browser-bridge-protocol.js` is the normative message schema.

## Transport and identity

- WebSocket path: `/browser/v1`.
- IPv4 loopback bind: `127.0.0.1`; candidate ports 23333 through 23337.
- Required Origin: `chrome-extension://obooegdoanifidoffaodpobadpeiilcl`.
- Host must equal `127.0.0.1:<actual-bound-port>`; duplicate Host/Origin and
  invalid peers are rejected. No LAN browser bridge listener is installed.
- Protocol version: 1. Product identity in authentication: `mori-desk`.
- Desktop application identity: `com.kaduiro.moridesk`.
- Maximum frame 16 KiB; authentication timeout 5 seconds; focus timeout 5 seconds.
- Connection ping interval 20 seconds; connection stale at 60 seconds; DOM
  observation stale after 90 seconds. These are separate clocks.

## Pairing

The desktop creates a `mori1:` base64url encoded JSON code with version, product,
instance, one-use pairing ID, actual port, random secret, and expiry (2 minutes).
The code is displayed only through the trusted desktop connection UI.

The client sends `hello`, the server returns a context and server proof, and
the client verifies it before sending its own proof. HMAC-SHA-256 proofs cover
the protocol domain, direction label, version, pair/resume mode, credential ID,
client ID, product ID, instance ID, server-run ID, actual port, and both nonces.
The exact canonical array is defined in `browser-bridge-auth.js` and mirrored
by `extensions/browser-bridge/transport.js`.

A permanent credential is derived from the authenticated context. The desktop
first stores it as pending and sends `pair.ready`. The extension persists it
and sends `pair.confirm`. The desktop promotes it to active and sends `ready`.
Resuming with a pending derived credential recovers an interrupted confirm.
The permanent credential itself is never sent in a WebSocket message.

Desktop credentials require Electron safeStorage with a protected backend.
Linux `basic_text` and unavailable storage disable pairing. Extension credentials
are in non-sync local storage with access limited to trusted extension contexts.
The public manifest key fixes the development extension ID; it is not a
production CRX signing key. Formal distribution needs an organization-owned
identity and matching desktop allowlist configuration.

## Events

Authenticated clients send an event envelope with only these fields:

```json
{
  "type": "event",
  "v": 1,
  "eventId": "opaque-event-id",
  "browserRunId": "opaque-browser-run-id",
  "sessionId": "opaque-tab-session-id",
  "sequence": 2,
  "kind": "terminal",
  "provider": "chatgpt",
  "tabId": 17,
  "pageInstanceId": "opaque-document-id",
  "routeRevision": 0,
  "conversationRef": "/c/opaque-conversation-id",
  "turnId": "opaque-turn-id",
  "generation": 1,
  "phase": "settled",
  "outcome": "unverified",
  "observation": "fresh",
  "observedAt": 1792368000000,
  "replay": false
}
```

`kind` is `observation`, `terminal`, or `closed`. `phase` is `idle`, `running`, or
`settled`. Outcome is null or `completed`, `interrupted`, `error`, `unverified`;
the preview adapters do **not** emit `completed`. Observation is `fresh`,
`stale`, `closed`, or `unsupported`. Provider is `chatgpt` or `claude`.
`conversationRef` is a validated provider conversation path or null, not a full
URL, page title, or answer. Unknown keys and invalid field combinations fail.

The authenticated connection supplies client/profile identity. The desktop
row key combines client, browser-run, and tab-session identities. Tabs showing
the same conversation remain independent.

## Durability and replay

Terminal and closed metadata is stored in the extension's local outbox before
transmission. The desktop validates and atomically saves its state and receipt
before replying with `event.ack`. The ACK includes the original event, browser
run, session, and sequence IDs. Only then may the outbox discard the event.

Duplicate terminal replay does not create another receipt. A late previous-turn
terminal can create an unread receipt without replacing the current running
turn. Events from an older browser run cannot focus a reused tab ID. Browser
restart, tab close, a stale observation, or ping alone never means completion.

The current phase and all unread receipts are distinct persistent records.
Starting a new turn does not clear an older receipt. Known acknowledgements and
explicit dismissals survive restart. Acknowledgement applies only through the
captured receipt sequence, not through future receipts that arrive concurrently.

## Focus

The desktop sends `focus.request` with request ID and the captured browser-run,
session, tab, page, route revision, and conversation identities. The extension
rechecks the tab and content page before and after `tabs.update` and
`windows.update`. A changed identity, closed tab, disconnected profile, API
failure, or timeout returns failure and preserves unread state.

`focus.result` must match the captured identities and authenticated connection.
If the click captured no unread sequence (`null`), success does not acknowledge
any receipt that arrived while focus was in progress. There is no prompt input,
message send, terminal paste, or permission approval browser command.

## Limits and failure behavior

Desktop: 3 paired profiles, 8 unauthenticated sockets, 20 active observed
sessions, 200 stored sessions, 4096 stored terminal receipts, 5 MiB store limit,
20 messages/second with burst 40. Extension: 20 monitored tabs and 200 pending
terminal/closed outbox entries within 512 KiB.

Capacity and storage errors are explicit. The preview does not silently prune
unread history. Profile revoke invalidates the credential, closes its sockets,
and removes its metadata; automatic long-term history management is deferred.

Local WebSocket messages are not encrypted. Authentication proves possession
of the paired key and validates connection context; it is not a defense against
malware already able to read the same user's desktop/browser profile.
