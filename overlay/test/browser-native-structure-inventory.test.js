/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
// Synthetic privacy/count plumbing. This does not validate a provider selector.
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectStructureInventory } = require('../scripts/monitoring-independent-witness');
function node(attrs = {}, hidden = false) {
  const value = { parentElement: null, children: [], isConnected: true,
    getAttribute: name => Object.hasOwn(attrs, name) ? attrs[name] : null,
    getClientRects: () => hidden ? [] : [{ width: 1, height: 1 }] };
  for (const name of ['textContent', 'innerText', 'innerHTML', 'outerHTML', 'value', 'title'])
    Object.defineProperty(value, name, { get() { throw new Error('forbidden_content_read'); } });
  return value;
}
function doc(mapping = new Map()) {
  return { visibilityState: 'visible', querySelectorAll: selector => mapping.get(selector) || [],
    defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) } };
}
test('inventory returns fixed counts and private route comparisons without content or identifiers', () => {
  const route = 'https://chatgpt.com/c/PRIVATE_ROUTE';
  const mapping = new Map([
    ['main,[role="main"]', [node()]],
    ['[contenteditable="true"],textarea', [node(), node({}, true)]],
    ['[data-conversation-id]', [node({ 'data-conversation-id': 'PRIVATE_ROUTE' }), node({ 'data-conversation-id': 'PRIVATE_OLD' })]],
    ['link[rel="canonical"]', [node({ href: route })]],
  ]);
  const result = inspectStructureInventory({ provider: 'chatgpt', document: doc(mapping), readRoute: () => route });
  assert.equal(result.routeKind, 'conversation'); assert.equal(result.visible, true);
  assert.equal(Object.keys(result.counts).length, 19);
  assert.deepEqual(result.counts.editable, { found: 2, visible: 1, matchesCurrentRoute: 0, capped: false });
  assert.equal(result.counts.conversationId.matchesCurrentRoute, 1);
  assert.equal(result.counts.canonical.matchesCurrentRoute, 1);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  for (const key of ['state', 'scope', 'proof', 'current', 'pass']) assert.equal(Object.hasOwn(result, key), false);
});
test('missing owner markers stay zero with ordinary composer candidates present', () => {
  const result = inspectStructureInventory({ provider: 'claude', document: doc(new Map([
    ['[data-testid="chat-input"]', [node()]],
  ])), readRoute: () => 'https://claude.ai/chat/private' });
  assert.equal(result.counts.claudeInput.visible, 1);
  assert.equal(result.counts.claudeHubRoot.found, 0);
  assert.equal(result.routeKind, 'conversation');
  assert.equal(Object.hasOwn(result, 'bindingConfirmed'), false);
});
test('inventory caps candidates and rejects unsupported routes before reading DOM', () => {
  const result = inspectStructureInventory({ provider: 'chatgpt', document: doc(new Map([
    ['form', Array.from({ length: 201 }, () => node())],
  ])), readRoute: () => 'https://chatgpt.com/' });
  assert.equal(result.counts.form.found, 200); assert.equal(result.counts.form.capped, true);
  assert.equal(result.routeKind, 'view');
  const forbidden = { querySelectorAll() { throw new Error('must_not_read'); } };
  assert.throws(() => inspectStructureInventory({ provider: 'chatgpt', document: forbidden,
    readRoute: () => 'https://example.invalid/c/private' }), /unsupported_route/);
  assert.throws(() => inspectStructureInventory({ provider: 'unknown', document: forbidden,
    readRoute: () => 'https://chatgpt.com/' }), /structure_inventory_configuration/);
});
