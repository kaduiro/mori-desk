/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTracker } = require('../extensions/browser-bridge/conversation-binding');
const chatgpt = require('../extensions/browser-bridge/adapters/chatgpt');
const claude = require('../extensions/browser-bridge/adapters/claude');

// Synthetic structural fixtures derived from Chrome observations, never page
// HTML or conversation text. Text/input/HTML access fails even in rejection cases.
function element(tag, attrs = {}, children = []) {
  const node = { tagName: tag.toUpperCase(), attrs, children, parentElement: null,
    get hidden() { return Object.hasOwn(this.attrs, 'hidden'); },
    getAttribute(name) { return this.attrs[name] ?? null; },
    matches(selector) {
      return selector.split(',').some(part => {
        let rest = part.trim();
        const tagName = rest.match(/^[a-z][a-z0-9-]*/i)?.[0];
        if (tagName && this.tagName !== tagName.toUpperCase()) return false;
        if (tagName) rest = rest.slice(tagName.length);
        while (rest) {
          const named = rest.match(/^([#.])([a-z0-9_-]+)/i);
          if (named) {
            if (named[1] === '#' ? this.getAttribute('id') !== named[2]
              : !(this.getAttribute('class') || '').split(/\s+/).includes(named[2])) return false;
            rest = rest.slice(named[0].length); continue;
          }
          const attribute = rest.match(/^\[([a-z0-9-]+)(?:="([^"]*)")?\]/i);
          if (!attribute) throw new Error(`Unsupported fixture selector: ${part}`);
          const value = this.getAttribute(attribute[1]);
          if (value === null || (attribute[2] !== undefined && value !== attribute[2])) return false;
          rest = rest.slice(attribute[0].length);
        }
        return true;
      });
    },
    querySelectorAll(selector) {
      return this.children.flatMap(child => [ ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector) ]);
    },
    closest(selector) {
      for (let n = this; n; n = n.parentElement) if (n.matches(selector)) return n;
      return null;
    },
    getClientRects() {
      if (this.attrs.layout === 'contents' || this.closest('[hidden], [aria-hidden="true"]')) return [];
      return [{}];
    },
  };
  for (const child of children) child.parentElement = node;
  for (const name of ['textContent', 'innerText', 'innerHTML', 'outerHTML', 'value']) {
    Object.defineProperty(node, name, { get() { throw new Error('Forbidden content access'); } });
  }
  return node;
}
function documentWith(main) {
  const doc = element('body', {}, [main]);
  doc.readyState = 'complete';
  return doc;
}
function gpt(id = 'a') {
  const transcript = element('div', { 'data-chatgpt-conversation-selection-target': id }, [
    element('div', { 'data-chatgpt-selection-conversation-id': id }),
  ]);
  const busy = element('span', { 'aria-busy': 'true', hidden: '' });
  transcript.children.push(busy); busy.parentElement = transcript;
  const activity = element('div', { 'data-thread-user-message-navigation-content': '' }, [transcript]);
  const stop = element('button', { 'aria-label': '停止', hidden: '' });
  const editor = element('div', { contenteditable: 'true', role: 'textbox' });
  const form = element('form', { 'data-chatgpt-composer': '', 'data-composer-placement': 'thread' }, [editor, stop]);
  const composer = element('div', { 'data-map-composer-conversation': id, layout: 'contents' }, [form]);
  const outside = element('button', { 'aria-label': '停止' });
  const main = element('main', {}, [activity, composer, outside]);
  return { doc: documentWith(main), transcript, activity, composer, form, editor, stop, busy, outside, main };
}
function claudePage(id = 'a') {
  const editor = element('div', { 'data-testid': 'chat-input', contenteditable: 'true', role: 'textbox' });
  const shield = element('div', { 'data-testid': 'chat-stale-nav-shield', hidden: '' });
  const root = element('div', { 'data-testid': 'bardhub-claudechat-root', 'data-conv-id': id,
    'data-hub-ready': '1', 'data-hub-awaiting-creation': '0', 'data-hub-draft': '1' }, [editor]);
  return { doc: documentWith(element('main', {}, [root, shield])), root, shield, editor };
}
const tracker = () => { let n = 0; return createTracker({ uuid: () => `binding-${++n}` }); };

test('synthetic local-ID view is distinct from a canonical conversation and never crosses a route change', () => {
  const f = gpt('local-chatgpt:temporary-a'); let n = 0;
  const t = createTracker({ uuid: () => `view-${++n}`, detailed: true, allowView: true });
  const first = t.sample(f.doc, 'https://chatgpt.com/c/assigned-a');
  assert.equal(first.state, 'confirmed'); assert.equal(first.kind, 'view');
  assert.doesNotMatch(JSON.stringify(first), /temporary-a|assigned-a/);
  const changed = t.sample(f.doc, 'https://chatgpt.com/c/other-b');
  assert.equal(changed.state, 'unconfirmed'); assert.equal(t.scope(), null);
  assert.equal(t.sample(f.doc, 'https://chatgpt.com/c/other-b').state, 'unconfirmed');
  f.transcript.attrs['data-chatgpt-conversation-selection-target'] = 'other-b';
  f.transcript.children[0].attrs['data-chatgpt-selection-conversation-id'] = 'other-b';
  f.composer.attrs['data-map-composer-conversation'] = 'other-b';
  const next = t.sample(f.doc, 'https://chatgpt.com/c/other-b');
  assert.equal(next.kind, 'conversation'); assert.notEqual(next.epoch, first.epoch);
});

test('synthetic view rejects mismatched messages and keeps unrelated stop controls outside its form', () => {
  const f = gpt('local-chatgpt:a');
  const t = createTracker({ detailed: true, allowView: true });
  assert.equal(t.sample(f.doc, 'https://chatgpt.com/c/b').kind, 'view');
  assert.equal(chatgpt.isStopTarget(f.outside, t.scope(), 'https://chatgpt.com/c/b', { continuing: true }), false);
  f.transcript.children[0].attrs['data-chatgpt-selection-conversation-id'] = 'old';
  assert.equal(t.sample(f.doc, 'https://chatgpt.com/c/b').state, 'unconfirmed');
});

test('a previously recognized short-stop generation continues through a quiet busy marker', () => {
  const f = gpt('a'), t = tracker();
  t.sample(f.doc, 'https://chatgpt.com/c/a'); delete f.stop.attrs.hidden;
  assert.equal(chatgpt.observe(t.scope(), 'https://chatgpt.com/c/a').supported, false);
  assert.equal(chatgpt.observe(t.scope(), 'https://chatgpt.com/c/a', { continuing: true }).generating, true);
  assert.equal(chatgpt.isStopTarget(f.stop, t.scope(), 'https://chatgpt.com/c/a', { continuing: true }), true);
});

test('ChatGPT admits matching transcript and display:contents composer; scopes generation to that view', () => {
  const f = gpt(), t = tracker();
  const first = t.sample(f.doc, 'https://chatgpt.com/c/a');
  assert.equal(first.state, 'confirmed');
  assert.deepEqual(t.sample(f.doc, 'https://chatgpt.com/c/a'), first);
  assert.equal(chatgpt.observe(t.scope(), 'https://chatgpt.com/c/a').generating, false);
  assert.equal(chatgpt.isStopTarget(f.outside, t.scope(), 'https://chatgpt.com/c/a'), false);
  delete f.stop.attrs.hidden; delete f.busy.attrs.hidden;
  assert.equal(chatgpt.observe(t.scope(), 'https://chatgpt.com/c/a').generating, true);
  assert.equal(chatgpt.isStopTarget(f.stop, t.scope(), 'https://chatgpt.com/c/a'), true);
  assert.doesNotMatch(JSON.stringify(first), /roots|querySelector|data-/);
});

test('ChatGPT rejects route-first, composer-first and mixed-message SPA transitions and rotates epochs', () => {
  const f = gpt(), t = tracker();
  const a = t.sample(f.doc, 'https://chatgpt.com/c/a');
  const changed = t.sample(f.doc, 'https://chatgpt.com/c/b');
  assert.equal(changed.state, 'unconfirmed'); assert.notEqual(changed.epoch, a.epoch);
  assert.equal(t.scope(), null);
  f.composer.attrs['data-map-composer-conversation'] = 'b';
  assert.equal(t.sample(f.doc, 'https://chatgpt.com/c/b').state, 'unconfirmed');
  f.transcript.attrs['data-chatgpt-conversation-selection-target'] = 'b';
  assert.equal(t.sample(f.doc, 'https://chatgpt.com/c/b').state, 'unconfirmed');
  f.transcript.children[0].attrs['data-chatgpt-selection-conversation-id'] = 'b';
  const b = t.sample(f.doc, 'https://chatgpt.com/c/b');
  assert.equal(b.state, 'confirmed'); assert.notEqual(b.epoch, changed.epoch);
  assert.equal(t.sample(f.doc, 'https://chatgpt.com/g/g-project/c/b').state, 'confirmed');
});

test('ChatGPT rejects ambiguous, hidden, local-ID and loading layouts; replacement invalidates the lease epoch', () => {
  for (const mutate of [f => { f.main.children.push(f.composer); },
    f => { f.editor.attrs.hidden = ''; }, f => { f.doc.readyState = 'loading'; },
    f => { f.transcript.attrs['data-chatgpt-conversation-selection-target'] = 'local-chatgpt:other'; },
    f => { f.composer.attrs['data-map-composer-conversation'] = 'other'; }]) {
    const f = gpt(); mutate(f);
    assert.equal(tracker().sample(f.doc, 'https://chatgpt.com/c/a').state, 'unconfirmed');
  }
  const t = tracker(), a = gpt(), b = gpt();
  const before = t.sample(a.doc, 'https://chatgpt.com/c/a');
  const after = t.sample(b.doc, 'https://chatgpt.com/c/a');
  assert.equal(after.state, 'confirmed'); assert.notEqual(after.epoch, before.epoch);
  assert.equal(t.sample(b.doc, 'https://chatgpt.com/').state, 'unconfirmed');
});

test('Claude requires ready exact-ID root with its composer and no visible stale-navigation shield', () => {
  const f = claudePage(), t = tracker();
  const first = t.sample(f.doc, 'https://claude.ai/chat/a');
  assert.equal(first.state, 'confirmed');
  assert.equal(claude.observe(t.scope(), 'https://claude.ai/chat/a').ready, true);
  delete f.shield.attrs.hidden;
  const blocked = t.sample(f.doc, 'https://claude.ai/chat/a');
  assert.equal(blocked.state, 'unconfirmed'); assert.notEqual(first.epoch, blocked.epoch);
  f.shield.attrs.hidden = '';
  assert.equal(t.sample(f.doc, 'https://claude.ai/chat/a').state, 'confirmed');
  for (const [name, value] of [['data-conv-id', 'old'], ['data-hub-ready', '0'], ['data-hub-awaiting-creation', '1']]) {
    const page = claudePage(); page.root.attrs[name] = value;
    assert.equal(tracker().sample(page.doc, 'https://claude.ai/chat/a').state, 'unconfirmed');
  }
  assert.equal(t.sample(f.doc, 'https://claude.ai/new').state, 'unconfirmed');
});

test('ChatGPT excludes unrelated activity panels and composer annotations from message, busy and error queries', () => {
  const f=gpt(),t=tracker();
  const panel=element('aside',{},[element('div',{'data-user-message-bubble':''}),
    element('div',{'data-testid':'conversation-turn-error'}),element('div',{'aria-busy':'true'})]);
  f.activity.children.push(panel);panel.parentElement=f.activity;
  const annotation=element('div',{'data-user-message-bubble':''});
  f.composer.children.push(annotation);annotation.parentElement=f.composer;
  assert.equal(t.sample(f.doc,'https://chatgpt.com/c/a').state,'confirmed');
  assert.equal(t.scope().querySelectorAll('[data-user-message-bubble]').length,0);
  assert.equal(t.scope().querySelectorAll('[data-testid="conversation-turn-error"]').length,0);
  assert.equal(chatgpt.observe(t.scope(),'https://chatgpt.com/c/a').error,false);
  assert.deepEqual(t.scope().querySelectorAll('[aria-busy="true"]'),[f.busy]);
});
