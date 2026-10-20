"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Executes the actual renderer. This small DOM fixture does not represent a
// native window or real Chrome; it checks draft lifecycle and command routing.
class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
    this.listeners = new Map(); this.dataset = {}; this.className = "";
    this.value = ""; this.hidden = false; this.disabled = false; this._text = "";
    this.scrolls = [];
    this.classList = { toggle: (name, force) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean));
      const include = force === undefined ? !names.has(name) : force;
      if (include) names.add(name); else names.delete(name);
      this.className = [...names].join(" "); return include;
    } };
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  set textContent(value) { this._text = String(value); this.replaceChildren(); }
  get innerHTML() { throw new Error("Panel fixture forbids HTML parsing"); }
  set innerHTML(_value) { throw new Error("Panel fixture forbids HTML parsing"); }
  append(...elements) {
    for (const element of elements) { element.remove(); this.children.push(element); element.parentNode = this; }
  }
  replaceChildren(...elements) {
    for (const child of this.children) child.parentNode = null;
    this.children = []; this.append(...elements);
  }
  insertBefore(element, next) {
    if (element === next) return;
    element.remove();
    const index = next ? this.children.indexOf(next) : this.children.length;
    assert.notEqual(index, -1, "insertBefore target must be an actual child");
    this.children.splice(index, 0, element); element.parentNode = this;
  }
  remove() {
    if (this.parentNode) {
      const index = this.parentNode.children.indexOf(this);
      if (index >= 0) this.parentNode.children.splice(index, 1);
      this.parentNode = null;
    }
  }
  addEventListener(kind, listener) {
    const listeners = this.listeners.get(kind) || []; listeners.push(listener); this.listeners.set(kind, listeners);
  }
  async fire(kind) {
    if (kind === "click" && this.disabled) return;
    await Promise.all((this.listeners.get(kind) || []).map(listener => listener({ preventDefault() {} })));
  }
  scrollIntoView(options) { this.scrolls.push(options); }
}

function descendants(element) { return [element, ...element.children.flatMap(descendants)]; }
function byClass(element, name) { return descendants(element).find(node => node.className.split(/\s+/).includes(name)); }
function button(element, label) { return descendants(element).find(node => node.tagName === "BUTTON" && node.textContent === label); }

function session(overrides = {}) {
  return {
    id: "browser:fixture:session1", label: "ChatGPT 1", displayTitle: "ChatGPT 1", customLabel: "", provider: "chatgpt",
    status: "unknown", statusLabel: "ブラウザ未接続", statusReason: "disconnected",
    statusDetail: "このブラウザとの接続がありません。", recoveryHint: "Chrome と Mori Desk の接続を確認してください。",
    focusUnavailableReason: "ブラウザとの接続が戻るまで、このタブへ移動できません。",
    phase: "running", observation: "stale", outcome: null, generation: 2,
    turnStartedAt: 1700000000000, phaseChangedAt: 1700000000000,
    lastObservationAt: 1700000001000, lastConnectionAt: 1700000002000,
    unreadCount: 1, requiresCompletionAck: true, pendingNotice: { noticeSequence: 7 }, canFocus: false,
    ...overrides,
  };
}

function harness(rows = [session()]) {
  const elements = new Map(["status", "pair", "connection", "connection-detail", "server-detail", "mode", "profiles", "count", "empty", "sessions", "code", "pairing", "copy", "extension"].map(id => [id, new Element("div")]));
  const document = {
    activeElement: null,
    getElementById(id) { assert.ok(elements.has(id), `Unknown panel element: ${id}`); return elements.get(id); },
    createElement(tag) { return new Element(tag); },
    querySelector() { throw new Error("Session identifiers must not be interpolated into selectors"); },
  };
  let state = { sessions: rows, bridge: { connectedClients: [], pairedClients: [] }, connection: { canPair: true }, selectedSessionId: null, selectionRevision: 0 };
  let onChange = null;
  const calls = [];
  let save = async (id, label) => {
    state = { ...state, sessions: state.sessions.map(row => row.id === id ? { ...row, customLabel: label.trim(), displayTitle: label.trim() || row.label } : row) };
    onChange();
    return { ok: true };
  };
  const window = { mori: {
    status: async () => state,
    onChange(callback) { onChange = callback; },
    focus: async (id, noticeSequence) => { calls.push({ kind: "focus", id, noticeSequence }); return { ok: false, reason: "target_changed" }; },
    ack: async (id, noticeSequence) => { calls.push({ kind: "ack", id, noticeSequence }); return { ok: true }; },
    setLabel: (id, label) => { calls.push({ kind: "label", id, label }); return save(id, label); },
    dismiss: async id => { calls.push({ kind: "dismiss", id }); return { ok: true }; },
    revoke: async () => ({ ok: true }), pair: async () => ({ ok: true }), copy: async () => ({ ok: true }), openExtension: async () => ({ ok: true }),
  } };
  const context = vm.createContext({ document, window, Intl, Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/mori-browser-renderer.js"), "utf8"), context);
  async function settle() { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }
  return {
    document, elements, calls, settle,
    get state() { return state; },
    set state(value) { state = value; },
    setSave(fn) { save = fn; },
    async refresh(next = state) { state = next; await onChange(); await settle(); },
    card(index = 0) { return elements.get("sessions").children[index]; },
  };
}

test("browser panel shows actionable stale-state context without treating retained generation as current", async () => {
  const h = harness(); await h.settle();
  const card = h.card();
  assert.equal(byClass(card, "session-state").textContent, "ブラウザ未接続");
  assert.equal(byClass(card, "session-detail").textContent, h.state.sessions[0].statusDetail);
  assert.equal(byClass(card, "session-recovery").textContent, h.state.sessions[0].recoveryHint);
  assert.equal(byClass(card, "session-navigation-hint").textContent, h.state.sessions[0].focusUnavailableReason);
  assert.equal(button(card, "タブへ戻る").disabled, true);
  const metadata = byClass(card, "session-metadata").children;
  assert.deepEqual(metadata[0].children.map(node => node.textContent), ["最後に観測した状態", "生成中"]);
  assert.deepEqual(metadata[1].children.map(node => node.textContent), ["検知した生成回数", "2 回"]);
  assert.match(metadata[4].children[1].textContent, /2023\/11\//);
  assert.equal(byClass(card, "session-unread").textContent, "未確認 1 件");
  assert.equal(byClass(card, "session-label-input").maxLength, 80);
  await button(card, "タブへ戻る").fire("click");
  assert.equal(h.calls.length, 0, "Disconnected navigation cannot send focus or ACK");
});

test("live panel refresh preserves the actual editing node and draft through row ordering changes", async () => {
  const first = session(), second = session({ id: "session2", label: "Claude 1", displayTitle: "Claude 1", provider: "claude" });
  const h = harness([first, second]); await h.settle();
  const card = h.card(), input = byClass(card, "session-label-input");
  h.document.activeElement = input; input.value = "まだ入力中の名前"; input.selectionStart = 3; input.selectionEnd = 3;
  await input.fire("input");
  await h.refresh({ ...h.state, sessions: [second, { ...first, statusLabel: "生成中", status: "generating", observation: "fresh", canFocus: true, unreadCount: 2 }] });
  assert.equal(h.card(), card, "A live reorder must not move the focused editor");
  assert.equal(byClass(card, "session-label-input"), input);
  assert.equal(h.document.activeElement, input);
  assert.equal(input.value, "まだ入力中の名前");
  assert.equal(input.selectionStart, 3);
  assert.equal(byClass(card, "session-state").textContent, "生成中");
  assert.equal(byClass(card, "session-unread").textContent, "未確認 2 件");
  h.document.activeElement = null;
  await h.refresh();
  assert.equal(h.card(1), card, "Ordering resumes without replacing the input node");
  assert.equal(input.value, "まだ入力中の名前");
});

test("local display-name save refreshes the canonical name and empty input restores the automatic name", async () => {
  const h = harness(); await h.settle();
  const card = h.card(), input = byClass(card, "session-label-input"), form = byClass(card, "session-label-editor");
  input.value = "  議事録の整理  "; await input.fire("input"); await form.fire("submit"); await h.settle();
  assert.deepEqual(h.calls[0], { kind: "label", id: "browser:fixture:session1", label: "  議事録の整理  " });
  assert.equal(input.value, "議事録の整理");
  assert.equal(byClass(card, "session-name").textContent, "議事録の整理");
  assert.equal(byClass(card, "session-source").textContent, "自動名：ChatGPT 1");
  input.value = ""; await input.fire("input"); await form.fire("submit"); await h.settle();
  assert.equal(byClass(card, "session-name").textContent, "ChatGPT 1");
  assert.equal(byClass(card, "session-source").hidden, true);
  assert.equal(input.value, "");
  assert.deepEqual(h.calls.map(call => call.kind), ["label", "label"], "Naming does not acknowledge an unread receipt");
});

test("a slow or rejected display-name save preserves newer typing and the visible error", async () => {
  const h = harness(); await h.settle();
  const card = h.card(), input = byClass(card, "session-label-input"), form = byClass(card, "session-label-editor");
  let resolveSave;
  h.setSave(() => new Promise(resolve => { resolveSave = resolve; }));
  input.value = "最初の名前"; await input.fire("input"); await form.fire("submit");
  assert.equal(button(card, "表示名を保存").disabled, true);
  input.value = "後から入力した名前"; await input.fire("input");
  h.state = { ...h.state, sessions: [{ ...h.state.sessions[0], customLabel: "最初の名前", displayTitle: "最初の名前" }] };
  resolveSave({ ok: true }); await h.settle();
  assert.equal(input.value, "後から入力した名前");
  assert.equal(byClass(card, "session-name").textContent, "最初の名前");
  h.setSave(async () => ({ ok: false, message: "表示名を保存できませんでした。" }));
  await form.fire("submit"); await h.settle();
  assert.equal(input.value, "後から入力した名前");
  assert.equal(h.elements.get("status").textContent, "表示名を保存できませんでした。");
  assert.equal(button(card, "表示名を保存").disabled, false);
});

test("persistent panel buttons capture the current notice and never ACK a failed focus", async () => {
  const h = harness([session({ canFocus: true })]); await h.settle();
  const card = h.card(), focusButton = button(card, "タブへ戻る");
  await h.refresh({ ...h.state, sessions: [{ ...h.state.sessions[0], pendingNotice: { noticeSequence: 19 }, unreadCount: 2 }] });
  assert.equal(button(card, "タブへ戻る"), focusButton);
  await focusButton.fire("click"); await h.settle();
  assert.deepEqual(h.calls, [{ kind: "focus", id: "browser:fixture:session1", noticeSequence: 19 }]);
  assert.match(h.elements.get("status").textContent, /未読は保持/);
  await button(card, "確認済みにする").fire("click"); await h.settle();
  assert.deepEqual(h.calls[1], { kind: "ack", id: "browser:fixture:session1", noticeSequence: 19 });
});

test("targeted details scroll once per explicit selection and labels remain inert text", async () => {
  const unsafeText = '<img src="x" onerror="unexpected()">';
  const id = 'session["# ]';
  const h = harness([session({ id, customLabel: unsafeText, displayTitle: unsafeText })]); await h.settle();
  const card = h.card();
  assert.equal(byClass(card, "session-name").textContent, unsafeText);
  assert.equal(descendants(card).filter(node => node.tagName === "IMG").length, 0);
  await h.refresh({ ...h.state, selectedSessionId: id, selectionRevision: 1 });
  assert.equal(card.scrolls.length, 1);
  assert.match(card.className, /session-selected/);
  await h.refresh(); await h.refresh();
  assert.equal(card.scrolls.length, 1, "Observation updates must not repeatedly jump the page");
  await h.refresh({ ...h.state, selectionRevision: 2 });
  assert.equal(card.scrolls.length, 2);
});
