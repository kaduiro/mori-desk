'use strict';
// Reviewer-owned model of the HTML tree and event schedule. This does not use
// repository tests, helpers, selectors, expected values, or renderer internals.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const path = require('node:path');
const repoRoot = path.resolve(process.argv[2] || process.env.MORI_REVIEW_REPO || process.cwd());
const baselineRoot = process.argv[3] || process.env.MORI_REVIEW_BASELINE;
const outputDir = path.resolve(process.env.MORI_REVIEW_OUTPUT || path.join(require('node:os').tmpdir(), 'mori-independent-source-review'));
fs.mkdirSync(outputDir, { recursive: true });

class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = document;
    this.children = []; this.parentNode = null; this.listeners = new Map();
    this.dataset = {}; this.hidden = false; this.open = false;
    this.disabled = false; this._value = ''; this.selectionStart = 0; this.selectionEnd = 0;
    this.classList = { toggle() {} }; this.textContent = '';
  }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, before) {
    if (node.parentNode) {
      const index = node.parentNode.children.indexOf(node);
      node.parentNode.children.splice(index, 1);
      if (contains(node, this.ownerDocument.activeElement)) {
        this.ownerDocument.activeElement = this.ownerDocument.body;
        this.ownerDocument.focusLosses++;
      }
    }
    const index = before ? this.children.indexOf(before) : this.children.length;
    if (index < 0) throw Error('invalid insertion');
    this.children.splice(index, 0, node); node.parentNode = this;
  }
  remove() {
    if (!this.parentNode) return;
    if (contains(this, this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
    this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null;
  }
  replaceChildren(...nodes) { for (const node of [...this.children]) node.remove(); this.append(...nodes); }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  emit(type) { for (const callback of this.listeners.get(type) || []) callback({ preventDefault() {}, type, target: this }); }
  focus() {
    const previous = this.ownerDocument.activeElement;
    this.ownerDocument.activeElement = this;
    if (previous && previous !== this) previous.emit('blur');
  }
  scrollIntoView() {}
  get value() { return this._value; }
  set value(value) {
    value = String(value);
    if (value !== this._value) { this.selectionStart = this.selectionEnd = value.length; this._value = value; }
  }
}
function contains(parent, child) { for (let node = child; node; node = node.parentNode) if (node === parent) return true; return false; }
function descendants(parent) { return parent.children.flatMap(child => [child, ...descendants(child)]); }
function byClass(parent, className) { return descendants(parent).find(child => child.className === className); }
function rendered(node) {
  for (let current = node; current; current = current.parentNode) {
    if (current.hidden || (current.tagName === 'DETAILS' && !current.open)) return false;
  }
  return contains(node.ownerDocument.body, node);
}
function row(id, history, customLabel = '') {
  return { id, isHistory: history, isCurrent: !history, provider: 'chatgpt', customLabel,
    displayTitle: `Conversation ${id}`, conversationTitle: `Conversation ${id}`,
    requestPreview: `Submitted ${id}`, unreadCount: id === 'A' ? 2 : 1,
    canFocus: true, observation: 'fresh', phase: 'idle' };
}
async function ticks() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
async function harness(source) {
  const document = { nodes: new Map(), activeElement: null, focusLosses: 0 };
  document.createElement = tag => new Element(tag, document);
  document.getElementById = id => document.nodes.get(id);
  document.body = document.createElement('body'); document.activeElement = document.body;
  for (const id of ['status', 'pair', 'connection', 'connection-detail', 'server-detail', 'mode', 'profiles', 'count', 'empty', 'sessions', 'history', 'history-count', 'history-unread', 'history-sessions', 'copy', 'extension', 'pairing', 'code']) {
    const node = document.createElement(id === 'history' ? 'details' : 'div'); node.id = id;
    document.nodes.set(id, node); document.body.append(node);
  }
  document.getElementById('history').append(...['history-count', 'history-unread', 'history-sessions'].map(id => document.getElementById(id)));
  document.getElementById('history').open = true;
  let snapshot = { sessions: [] }, changed;
  const saves = [];
  const mori = {
    status: async () => structuredClone(snapshot), onChange: callback => { changed = callback; },
    setLabel(id, label) { return new Promise((resolve, reject) => saves.push({ id, label, resolve, reject })); },
  };
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), { document, window: { mori }, Intl, Date, Set, Map, Number, Array });
  await ticks();
  return { document, saves,
    async update(rows) { snapshot = { sessions: rows, connection: { canPair: true } }; changed(); await ticks(); },
    card(id) { return descendants(document.body).find(node => node.className === 'session' && byClass(node, 'session-name')?.textContent === `Conversation ${id}`); },
    input(id) { return byClass(this.card(id), 'session-label-input'); },
    editor(id) { return byClass(this.card(id), 'session-label-editor'); },
    group(id) { return this.card(id).parentNode.id; },
  };
}

async function editingAncestry(source) {
  const ui = await harness(source);
  await ui.update([row('A', true), row('B', true), row('C', false)]);
  const a = ui.input('A'); a.focus(); a.emit('compositionstart');
  a.value = '調整中'; a.emit('input'); a.selectionStart = 1; a.selectionEnd = 2;
  await ui.update([row('C', true), row('B', false), row('A', false)]);
  assert.equal(rendered(a), true, 'focused composition must have visible ancestors');
  assert.equal(ui.group('A'), 'history-sessions');
  assert.equal(ui.group('B'), 'sessions', 'another row must move while A composes');
  assert.equal(ui.group('C'), 'history-sessions');
  assert.equal(ui.input('A'), a); assert.equal(ui.document.activeElement, a);
  assert.equal(a.value, '調整中'); assert.equal(a.selectionStart, 1); assert.equal(a.selectionEnd, 2);
  await ui.update([row('A', true), row('B', false)]);
  await ui.update([row('A', false), row('B', false)]);
  assert.equal(rendered(a), true, 'only remaining held history row must remain visible');
  assert.equal(ui.document.focusLosses, 0);
  assert.match(ui.document.getElementById('history-count').textContent, /編集中/);
  ui.editor('A').emit('submit'); assert.equal(ui.saves.length, 0, 'composition submit cannot save');
  a.emit('compositionend'); await ticks();
  assert.equal(ui.saves.length, 0); assert.equal(ui.group('A'), 'history-sessions');
  ui.input('B').focus(); await ticks();
  assert.equal(ui.group('A'), 'sessions'); assert.equal(ui.document.getElementById('history').hidden, true);
  assert.equal(descendants(ui.document.body).filter(node => node.className === 'session').length, 2);
  assert.equal(a.value, '調整中');
}

async function singleHistoryAncestry(source) {
  const ui = await harness(source);
  await ui.update([row('A', true)]);
  const input = ui.input('A'); input.focus(); input.emit('compositionstart');
  input.value = '編集中'; input.emit('input');
  await ui.update([row('A', false)]);
  assert.equal(rendered(input), true, 'sole history editor must keep every ancestor visible after reconnect');
  assert.equal(ui.document.activeElement, input);
  assert.equal(ui.input('A'), input);
}

async function asyncSave(source) {
  const ui = await harness(source);
  await ui.update([row('A', true, 'Old A'), row('B', false, 'Old B')]);
  const a = ui.input('A'), b = ui.input('B'); a.focus(); a.value = 'Saved X'; a.emit('input');
  ui.editor('A').emit('submit');
  assert.deepEqual(ui.saves.map(({id, label}) => ({id, label})), [{ id: 'A', label: 'Saved X' }]);
  a.value = 'New Y'; a.emit('input');
  await ui.update([row('A', false, 'Old A'), row('B', false, 'Old B')]);
  b.focus(); b.value = 'B unsaved'; b.emit('input'); b.selectionStart = 2; b.selectionEnd = 4;
  await ui.update([row('B', false, 'Old B'), row('A', false, 'Saved X')]);
  ui.saves[0].resolve({ ok: true }); await ticks();
  assert.equal(ui.input('A'), a); assert.equal(a.value, 'New Y');
  assert.equal(ui.input('B'), b); assert.equal(b.value, 'B unsaved');
  assert.equal(ui.document.activeElement, b); assert.equal(b.selectionStart, 2); assert.equal(b.selectionEnd, 4);
  ui.editor('A').emit('submit');
  ui.saves[1].reject(Error('Controlled failure')); await ticks();
  assert.equal(a.value, 'New Y'); assert.equal(ui.editor('A').children[1].disabled, false);
  ui.editor('A').emit('submit'); assert.equal(ui.saves[2].id, 'A'); assert.equal(ui.saves[2].label, 'New Y');
  ui.saves[2].resolve({ ok: true }); await ui.update([row('B', false, 'Old B'), row('A', false, 'New Y')]);
  a.value = ''; a.emit('input'); ui.editor('A').emit('submit');
  assert.equal(ui.saves[3].label, ''); ui.saves[3].resolve({ ok: true });
  await ui.update([row('A', false, ''), row('B', false, 'Old B')]);
  assert.equal(a.value, ''); assert.equal(b.value, 'B unsaved');
}

async function main() {
  const changed = path.join(repoRoot, 'overlay/src/mori-browser-renderer.js');
  if (!baselineRoot) throw new Error('Supply the baseline snapshot directory as argument 3 or MORI_REVIEW_BASELINE.');
  const baseline = path.join(path.resolve(baselineRoot), 'overlay/src/mori-browser-renderer.js');
  const output = { scope: 'Independent synthetic DOM/event model, not a browser or native IME test',
    sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(changed)).digest('hex'), results: [] };
  for (const [name, task] of [['changed sole history ancestry', () => singleHistoryAncestry(changed)], ['changed ancestry/focus/composition', () => editingAncestry(changed)], ['changed async save/cross-row/failure/blank', () => asyncSave(changed)]]) {
    try { await task(); output.results.push({ name, status: 'PASS' }); }
    catch (error) { output.results.push({ name, status: 'FAIL', reason: error.message }); }
  }
  try { await singleHistoryAncestry(baseline); output.results.push({ name: 'baseline sensitivity', status: 'FAIL', reason: 'baseline incorrectly passed ancestry invariant' }); }
  catch (error) { output.results.push({ name: 'baseline sensitivity', status: /visible/.test(error.message) ? 'PASS' : 'FAIL', detected: error.message }); }
  fs.writeFileSync(path.join(outputDir, 'renderer-results.json'), JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify(output, null, 2));
  process.exitCode = output.results.every(result => result.status === 'PASS') ? 0 : 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
