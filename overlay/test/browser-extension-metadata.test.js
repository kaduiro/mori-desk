const { test } = require('node:test');
const assert = require('node:assert/strict');
const utils = require('../extensions/browser-bridge/provider-utils');
const { createReader } = require('../extensions/browser-bridge/conversation-metadata');

// Synthetic DOM API fixture. These attributes are explicitly provisional;
// provider markup and real Chrome installation still require manual checks.
function text(value, unreadable = false) {
  return { nodeType: 3, get nodeValue() {
    if (unreadable) throw new Error('Unapproved message/draft text was read');
    return value;
  } };
}
function matches(node, selector) {
  if (node.nodeType !== 1) return false;
  if (selector.includes(':not')) {
    const [positive, negative] = selector.split(':not(');
    return matches(node, positive) && !matches(node, negative.slice(0, -1));
  }
  const tag = selector.match(/^[a-z][a-z0-9-]*/i)?.[0];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const [, name, expected] of selector.matchAll(/\[([a-z0-9-]+)(?:="([^"]*)")?\]/gi)) {
    const value = node.getAttribute(name);
    if (value === null || (expected !== undefined && value !== expected)) return false;
  }
  return true;
}
function element(tag, attributes = {}, ...children) {
  const node = {
    nodeType: 1, tagName: tag.toUpperCase(), childNodes: children,
    hidden: Object.hasOwn(attributes, 'hidden'),
    getAttribute: name => Object.hasOwn(attributes, name) ? attributes[name] : null,
    getClientRects() {
      for (let current = this; current; current = current.parentElement) {
        if (current.hidden || current.getAttribute?.('aria-hidden') === 'true') return [];
      }
      return [{}];
    },
    closest(selectors) {
      for (let current = this; current; current = current.parentElement) {
        if (selectors.split(',').some(selector => matches(current, selector.trim()))) return current;
      }
      return null;
    },
  };
  for (const child of children) child.parentElement = node;
  return node;
}
const user = (value, provider = 'chatgpt') => element('div', provider === 'chatgpt'
  ? { 'data-message-author-role': 'user' } : { 'data-testid': 'user-message' }, text(value));
function documentWith(...nodes) {
  return {
    nodes,
    get title() { throw new Error('An unbound document title must not be used'); },
    querySelectorAll(selectors) {
      const found = [];
      function visit(node) {
        if (node.nodeType === 1 && selectors.split(',').some(selector => matches(node, selector.trim()))) found.push(node);
        for (const child of node.childNodes || []) visit(child);
      }
      for (const node of this.nodes) visit(node);
      return found;
    },
  };
}
const history = (...links) => element('nav', {}, ...links.map(([href, title]) =>
  element('a', { href }, text(title), element('button', {}, text('PRIVATE_ACTION', true)))));

test('metadata normalization bounds UTF-16 without breaking emoji and removes whitespace/control/bidi', () => {
  assert.equal(utils.metadataText(' \n インターン\t\t相談\u202e \u2066 次の一歩 \r\n'), 'インターン 相談 次の一歩');
  assert.equal(utils.metadataText('a\u0000b\u0085c'), 'abc');
  assert.equal(utils.metadataText('a \ud800 b'), 'a b');
  assert.equal(utils.metadataText('👩‍💻の相談'), '👩‍💻の相談');
  assert.equal(utils.metadataText('a'.repeat(159) + '😀'), 'a'.repeat(159));
  assert.equal(utils.metadataText('a'.repeat(158) + '😀' + 'tail'), 'a'.repeat(158) + '😀');
  for (const raw of [' \n X\u0000 Y \udc00 Z', 'a \u202e b', 'a'.repeat(1000), '👩‍💻'.repeat(80)]) {
    const normalized = utils.metadataText(raw);
    assert.ok(normalized.length <= 160);
    assert.equal(utils.validMetadataText(normalized), true);
  }
  for (const value of ['line\nbreak', 'a  b', '\u00a0text', 'a\u202eb', '\ud800', '\udc00', 'x'.repeat(161), null, 5]) {
    assert.equal(utils.validMetadataText(value), false, String(value));
  }
});

test('observation accepts only the two authorized normalized metadata strings and legacy omissions', () => {
  const base = { type: 'mori.observation', v: 1, pageInstanceId: 'page-1', contentSequence: 1,
    observedAt: 1000, status: 'idle', generationToken: null, outcome: null };
  assert.ok(utils.safeObservation(base));
  const clean = utils.safeObservation({ ...base, conversationTitle: '会話名', requestPreview: '送信済みの依頼',
    title: 'PRIVATE', prompt: 'PRIVATE', answer: 'PRIVATE', html: 'PRIVATE', key: 'PRIVATE' });
  assert.equal(clean.conversationTitle, '会話名');
  assert.equal(clean.requestPreview, '送信済みの依頼');
  assert.doesNotMatch(JSON.stringify(clean), /PRIVATE/);
  assert.ok(utils.safeObservation({ ...base, conversationTitle: '', requestPreview: '' }));
  for (const value of ['line\nbreak', '\ud800', 'x'.repeat(161), {}, null]) {
    assert.equal(utils.safeObservation({ ...base, conversationTitle: value }), null);
    assert.equal(utils.safeObservation({ ...base, requestPreview: value }), null);
  }
});

test('title uses the exact canonical history route; preview reads only the latest submitted USER text', () => {
  const url = 'https://chatgpt.com/g/g-p-PRIVATE_SCOPE/c/current?PRIVATE_QUERY#PRIVATE_FRAGMENT';
  const doc = documentWith(
    history(['/c/other', 'Other title'], ['/c/current', '  実習の\n目標  ']),
    element('div', { 'data-message-author-role': 'user' }, text('PRIVATE_OLD_USER', true)),
    user('次の一週間に\n取り組むことを整理して'),
    element('div', { 'data-message-author-role': 'assistant' }, text('PRIVATE_ANSWER', true)),
    element('div', { contenteditable: 'true' }, text('PRIVATE_DRAFT', true)),
    element('textarea', {}, text('PRIVATE_INPUT', true)),
  );
  const metadata = createReader().sample(doc, url);
  assert.deepEqual(metadata, { conversationTitle: '実習の 目標', requestPreview: '次の一週間に 取り組むことを整理して' });
  assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE/);
});

test('a quoted conversation link is not a title; hidden/edited messages and assistant text are not previews', () => {
  const doc = documentWith(
    element('a', { href: '/c/current' }, text('PRIVATE_QUOTED_TITLE', true)),
    element('div', { 'data-message-author-role': 'assistant' }, text('PRIVATE_ANSWER', true)),
    element('div', { hidden: '', 'data-message-author-role': 'user' }, text('PRIVATE_HIDDEN', true)),
    element('div', { 'data-message-author-role': 'user' },
      element('textarea', {}, text('PRIVATE_EDIT_DRAFT', true))),
  );
  assert.deepEqual(createReader().sample(doc, 'https://chatgpt.com/c/current'),
    { conversationTitle: '', requestPreview: '' });
});

test('paragraphs and line breaks in the latest submitted request become a single readable line', () => {
  const doc = documentWith(element('div', { 'data-message-author-role': 'user' },
    element('p', {}, text('最初の依頼')), element('p', {}, text('次の条件'), element('br'), text('最後の条件'))));
  assert.equal(createReader().sample(doc, 'https://chatgpt.com/c/current').requestPreview,
    '最初の依頼 次の条件 最後の条件');
});

test('SPA A to B blanks A preview even when its old DOM remains, while the B title binds to its own link', () => {
  const nav = history(['/c/a', '会話 A'], ['/c/b', '会話 B']);
  const a = user('A への依頼');
  const doc = documentWith(nav, a);
  const reader = createReader();
  assert.deepEqual(reader.sample(doc, 'https://chatgpt.com/c/a'), { conversationTitle: '会話 A', requestPreview: 'A への依頼' });
  assert.deepEqual(reader.sample(doc, 'https://chatgpt.com/c/b'), { conversationTitle: '会話 B', requestPreview: '' });
  assert.equal(reader.sample(doc, 'https://chatgpt.com/c/b').requestPreview, '');
  // Cloning the old content during a render is still ambiguous.
  doc.nodes = [nav, user('A への依頼')];
  assert.equal(reader.sample(doc, 'https://chatgpt.com/c/b').requestPreview, '');
  doc.nodes = [nav, user('B の最新の依頼')];
  assert.deepEqual(reader.sample(doc, 'https://chatgpt.com/c/b'), { conversationTitle: '会話 B', requestPreview: 'B の最新の依頼' });
  assert.equal(reader.sample(doc, 'https://chatgpt.com/c/a').requestPreview, '');
  doc.nodes = [nav, user('A への依頼')];
  assert.equal(reader.sample(doc, 'https://chatgpt.com/c/a').requestPreview, 'A への依頼');
});

test('rapid SPA switches and missing titles never inherit an old title or request', () => {
  const doc = documentWith(history(['/c/a', '会話 A']), user('A の依頼'));
  const reader = createReader();
  reader.sample(doc, 'https://chatgpt.com/c/a');
  assert.deepEqual(reader.sample(doc, 'https://chatgpt.com/c/b'), { conversationTitle: '', requestPreview: '' });
  assert.deepEqual(reader.sample(doc, 'https://chatgpt.com/c/c'), { conversationTitle: '', requestPreview: '' });
  assert.deepEqual(reader.sample(doc, 'https://chatgpt.com/'), { conversationTitle: '', requestPreview: '' });
  assert.deepEqual(reader.sample(doc, 'https://unrelated.test/c/a'), { conversationTitle: '', requestPreview: '' });
});

test('a new ID assigned to the observed running conversation retains its submitted request', () => {
  const doc = documentWith(user('新しい会話の依頼'));
  const reader = createReader();
  assert.equal(reader.sample(doc, 'https://chatgpt.com/').requestPreview, '');
  doc.nodes.unshift(history(['/c/new-id', '新しい会話']));
  assert.deepEqual(reader.sample(doc, 'https://chatgpt.com/c/new-id', { assignedNewConversation: true }),
    { conversationTitle: '新しい会話', requestPreview: '新しい会話の依頼' });
});

test('Claude uses its submitted user-message marker and exact chat history link', () => {
  const doc = documentWith(history(['/chat/claude-1', '調査の手順']), user('送信済みの調査依頼', 'claude'),
    element('div', { 'data-testid': 'assistant-message' }, text('PRIVATE_ANSWER', true)),
    element('div', { contenteditable: 'true', role: 'textbox' }, text('PRIVATE_DRAFT', true)));
  assert.deepEqual(createReader().sample(doc, 'https://claude.ai/chat/claude-1'),
    { conversationTitle: '調査の手順', requestPreview: '送信済みの調査依頼' });
  assert.deepEqual(createReader().sample(doc, 'https://claude.ai/project/claude-1'),
    { conversationTitle: '', requestPreview: '' });
});
