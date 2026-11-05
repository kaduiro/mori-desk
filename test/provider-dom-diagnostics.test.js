"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const inspect = require("../scripts/inspect-provider-dom");

function fixture() {
  const composer = { hidden: false, getAttribute: () => null, getClientRects: () => [{}] };
  const root = { getAttribute: name => name === "data-conversation-id" ? "private-conversation" : null,
    querySelectorAll: selector => selector.includes("#prompt-textarea") ? [composer] : [] };
  for (const node of [composer, root]) for (const forbidden of ["textContent", "innerHTML", "outerHTML", "innerText", "value"]) {
    Object.defineProperty(node, forbidden, { get() { throw new Error(`Forbidden: ${forbidden}`); } });
  }
  const doc = { visibilityState: "visible", querySelectorAll: selector => {
    if (selector === "[data-conversation-id]") return [root];
    return selector.includes("#prompt-textarea") ? [composer] : [];
  } };
  for (const forbidden of ["title", "cookie", "body"]) Object.defineProperty(doc, forbidden, {
    get() { throw new Error(`Forbidden: ${forbidden}`); },
  });
  return doc;
}

test("manual provider diagnostics expose only structural counts and never conversation content or IDs", () => {
  const report = inspect(fixture(), "https://chatgpt.com/c/private-conversation?private-query=secret");
  assert.equal(report.roots["data-conversation-id"].matchesCurrentRoute, 1);
  assert.equal(report.roots["data-conversation-id"].matchingRootsWithComposer, 1);
  assert.equal(report.controls.composer.visible, 1);
  assert.equal(report.provesConversationBinding, false);
  assert.doesNotMatch(JSON.stringify(report), /private|secret|https:|textContent|innerHTML|cookie/);
});

test("manual provider diagnostics do not infer binding from a different conversation or a matching marker", () => {
  assert.equal(inspect(fixture(), "https://chatgpt.com/c/other").roots["data-conversation-id"].matchesCurrentRoute, 0);
  assert.equal(inspect(fixture(), "https://claude.ai/chat/private-conversation").provesConversationBinding, false);
  assert.throws(() => inspect(fixture(), "https://unrelated.invalid/c/private-conversation"), /Open a normal/);
});
