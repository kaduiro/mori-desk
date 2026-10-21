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
function visibleThroughParents(element) {
  for (let node = element; node; node = node.parentNode) {
    if (node.hidden || (node.tagName === "DETAILS" && !node.open)) return false;
  }
  return true;
}

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
  const elements = new Map(["status", "pair", "connection", "connection-detail", "server-detail", "mode", "profiles", "count", "empty", "sessions", "history", "history-sessions", "history-count", "history-unread", "code", "pairing", "copy", "extension"].map(id => [id, new Element(id === "history" ? "details" : "div")]));
  elements.get("history").open = false;
  elements.get("history").append(elements.get("history-sessions"));
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
    state = { ...state, sessions: state.sessions.map(row => row.id === id ? { ...row, customLabel: label.trim(), displayTitle: label.trim() || row.conversationTitle || row.label } : row) };
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
    historyCard(index = 0) { return elements.get("history-sessions").children[index]; },
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
  assert.equal(byClass(card, "session-source").textContent, "ChatGPT 1 · 会話名は未取得");
  input.value = ""; await input.fire("input"); await form.fire("submit"); await h.settle();
  assert.equal(byClass(card, "session-name").textContent, "ChatGPT 1");
  assert.equal(byClass(card, "session-source").hidden, false);
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

test("conversation titles and submitted previews distinguish current tabs from collapsed previous records", async () => {
  const first = session({ isCurrent: true, isHistory: false, conversationTitle: "長期インターンの考え方", displayTitle: "長期インターンの考え方", requestPreview: "何から始め何を目指せばいいですか" });
  const second = session({ id: "second", label: "ChatGPT 2", isCurrent: true, conversationTitle: "HUD のセッション表示", displayTitle: "HUD のセッション表示", requestPreview: '<img src="x">タブを見分けたい' });
  const previous = session({ id: "previous", label: "ChatGPT 3", isCurrent: false, isHistory: true, unreadCount: 2 });
  const h = harness([previous, first, second]); await h.settle();
  assert.equal(h.elements.get("count").textContent, "2 件");
  assert.equal(h.elements.get("sessions").children.length, 2);
  assert.equal(byClass(h.card(), "session-name").textContent, first.conversationTitle);
  assert.equal(byClass(h.card(1), "session-name").textContent, second.conversationTitle);
  assert.equal(byClass(h.card(1), "session-request-preview").textContent, `直近の依頼：${second.requestPreview}`);
  assert.equal(descendants(h.card(1)).filter(node => node.tagName === "IMG").length, 0);
  assert.equal(h.elements.get("history-count").textContent, "1 件");
  assert.equal(h.elements.get("history-unread").textContent, "未確認 2 件");
  assert.equal(h.elements.get("history").open, false);
  assert.equal(h.historyCard().dataset.history, "true");
  assert.equal(h.calls.length, 0);
});

test("a selected history record opens once without acknowledging its receipt", async () => {
  const previous = session({ isHistory: true, isCurrent: false });
  const h = harness([previous]); await h.settle();
  assert.equal(h.elements.get("count").textContent, "0 件");
  assert.equal(h.elements.get("empty").hidden, false);
  await h.refresh({ ...h.state, selectedSessionId: previous.id, selectionRevision: 1 });
  assert.equal(h.elements.get("history").open, true);
  assert.equal(h.historyCard().scrolls.length, 1);
  h.elements.get("history").open = false;
  await h.refresh();
  assert.equal(h.elements.get("history").open, false, "Live refresh preserves the user's collapsed state");
  assert.equal(h.calls.length, 0);
});

test("route metadata refresh updates the title and preview while preserving IME composition and name drafts", async () => {
  const first = session({ isCurrent: true, conversationTitle: "最初の会話", displayTitle: "最初の会話", requestPreview: "最初の依頼" });
  const h = harness([first]); await h.settle();
  const card = h.card(), input = byClass(card, "session-label-input");
  h.document.activeElement = input;
  await input.fire("compositionstart");
  input.value = "へんかんちゅう"; input.selectionStart = 4; input.selectionEnd = 4;
  await h.refresh({ ...h.state, sessions: [{ ...first, conversationTitle: "切り替え先の会話", displayTitle: "切り替え先の会話", requestPreview: "切り替え後の依頼" }] });
  assert.equal(byClass(card, "session-name").textContent, "切り替え先の会話");
  assert.match(byClass(card, "session-request-preview").textContent, /切り替え後の依頼/);
  assert.equal(input.value, "へんかんちゅう");
  assert.equal(input.selectionStart, 4);
  await byClass(card, "session-label-editor").fire("submit");
  assert.equal(h.calls.length, 0, "IME Enter must not prematurely save the label");
  await input.fire("compositionend"); await h.settle();
  await h.refresh({ ...h.state, sessions: [{ ...h.state.sessions[0], conversationTitle: "", displayTitle: first.label, requestPreview: "" }] });
  assert.equal(input.value, "へんかんちゅう");
  assert.match(byClass(card, "session-source").textContent, /会話名は未取得/);
  assert.equal(byClass(card, "session-request-preview").textContent, "直近の依頼は未取得です。");
});

test("moving an edited session into history waits until the editor loses focus", async () => {
  const current = session({ isCurrent: true, isHistory: false });
  const h = harness([current]); await h.settle();
  const card = h.card(), input = byClass(card, "session-label-input");
  h.document.activeElement = input; input.value = "保存前の表示名"; await input.fire("input");
  await h.refresh({ ...h.state, sessions: [{ ...current, isCurrent: false, isHistory: true }] });
  assert.equal(h.card(), card, "Disconnect cannot detach the focused DOM node");
  assert.equal(input.value, "保存前の表示名");
  assert.equal(h.elements.get("count").textContent, "0 件");
  h.document.activeElement = null; await input.fire("blur"); await h.settle();
  assert.equal(h.historyCard(), card);
  assert.equal(input.value, "保存前の表示名");
  assert.equal(h.calls.length, 0);
});

test("C1: reconnecting the only history row keeps its composing editor visible until editing ends", async () => {
  const previous = session({ isCurrent: false, isHistory: true, customLabel: "保存済みの名前", unreadCount: 2 });
  const h = harness([previous]); await h.settle();
  h.elements.get("history").open = true;
  const card = h.historyCard(), input = byClass(card, "session-label-input"), form = byClass(card, "session-label-editor");
  h.document.activeElement = input;
  await input.fire("compositionstart");
  input.value = "へんかんちゅう"; input.selectionStart = 3; input.selectionEnd = 5;
  await h.refresh({ ...h.state, sessions: [{ ...previous, isCurrent: true, isHistory: false, canFocus: true }] });
  assert.equal(visibleThroughParents(input), true, "Reconnection must not hide an ancestor of the composing editor");
  assert.equal(h.historyCard(), card);
  assert.equal(h.card(), undefined, "Do not move the focused card to its new logical group yet");
  assert.equal(h.elements.get("count").textContent, "1 件");
  assert.equal(h.document.activeElement, input);
  assert.equal(input.value, "へんかんちゅう");
  assert.deepEqual([input.selectionStart, input.selectionEnd], [3, 5]);
  await form.fire("submit");
  assert.equal(h.calls.length, 0, "Submitting during composition cannot save or ACK");
  input.value = "変換した名前";
  await input.fire("compositionend"); await h.settle();
  assert.equal(visibleThroughParents(input), true);
  await form.fire("submit"); await h.settle();
  assert.deepEqual(h.calls, [{ kind: "label", id: previous.id, label: "変換した名前" }]);
  assert.equal(byClass(card, "session-unread").textContent, "未確認 2 件");
  h.document.activeElement = null; await input.fire("blur"); await h.settle();
  assert.equal(h.card(), card);
  assert.equal(h.historyCard(), undefined);
  assert.equal(h.elements.get("history").hidden, true);
  assert.equal(byClass(card, "session-label-input"), input);
  assert.equal(input.value, "変換した名前");
  assert.equal(h.elements.get("sessions").children.length, 1);
});

test("C2: reconnecting other rows still changes their groups while one history name is being edited", async () => {
  const edited = session({ id: "edited", isCurrent: false, isHistory: true });
  const reconnecting = session({ id: "reconnecting", isCurrent: false, isHistory: true, unreadCount: 3 });
  const disconnecting = session({ id: "disconnecting", isCurrent: true, isHistory: false, customLabel: "別の名前" });
  const h = harness([edited, reconnecting, disconnecting]); await h.settle();
  h.elements.get("history").open = true;
  const editedCard = h.historyCard(), reconnectingCard = h.historyCard(1), disconnectingCard = h.card();
  const input = byClass(editedCard, "session-label-input");
  h.document.activeElement = input; input.value = "まだ編集中"; await input.fire("input");
  await h.refresh({ ...h.state, sessions: [
    { ...edited, isCurrent: true, isHistory: false },
    { ...reconnecting, isCurrent: true, isHistory: false },
    { ...disconnecting, isCurrent: false, isHistory: true },
  ] });
  assert.equal(editedCard.parentNode, h.elements.get("history-sessions"));
  assert.equal(visibleThroughParents(input), true);
  assert.equal(reconnectingCard.parentNode, h.elements.get("sessions"), "An unrelated row is not pinned by another editor");
  assert.equal(disconnectingCard.parentNode, h.elements.get("history-sessions"));
  assert.equal(byClass(disconnectingCard, "session-label-input").value, "別の名前");
  assert.equal(byClass(reconnectingCard, "session-unread").textContent, "未確認 3 件");
  assert.equal(input.value, "まだ編集中");
  assert.equal(h.calls.length, 0);
});

test("C3: repeated reconnect and disconnect keep one editor node and move it once after blur", async () => {
  const row = session({ isCurrent: false, isHistory: true });
  const h = harness([row]); await h.settle();
  h.elements.get("history").open = true;
  const card = h.historyCard(), input = byClass(card, "session-label-input");
  h.document.activeElement = input;
  await input.fire("compositionstart"); input.value = "ひょうじめい";
  for (const isCurrent of [true, false, true, false, true]) {
    await h.refresh({ ...h.state, sessions: [{ ...row, isCurrent, isHistory: !isCurrent }] });
    assert.equal(visibleThroughParents(input), true);
    assert.equal(h.historyCard(), card);
    assert.equal(input.value, "ひょうじめい");
    assert.equal(h.elements.get("sessions").children.length + h.elements.get("history-sessions").children.length, 1);
  }
  h.document.activeElement = null;
  await input.fire("blur"); await h.settle();
  assert.equal(h.historyCard(), card, "A blur before compositionend must not detach a composing node");
  await input.fire("compositionend"); await h.settle();
  assert.equal(h.card(), card);
  await h.refresh(); await h.refresh();
  assert.equal(h.elements.get("sessions").children.length, 1);
  assert.equal(h.elements.get("history-sessions").children.length, 0);
  assert.equal(input.value, "ひょうじめい");
});

test("C4: IME candidate cancellation preserves the saved name and blank save restores the intended conversation", async () => {
  const previous = session({ id: "edited-conversation", isCurrent: false, isHistory: true,
    customLabel: "元の表示名", displayTitle: "元の表示名", conversationTitle: "自動の会話名" });
  const other = session({ id: "other-conversation", isCurrent: true, isHistory: false, customLabel: "他の会話" });
  const h = harness([previous, other]); await h.settle();
  h.elements.get("history").open = true;
  const card = h.historyCard(), input = byClass(card, "session-label-input"), form = byClass(card, "session-label-editor");
  h.document.activeElement = input;
  await input.fire("compositionstart"); input.value = "候補を選択中";
  await h.refresh({ ...h.state, sessions: [{ ...previous, isCurrent: true, isHistory: false }, other] });
  // This models cancellation restoring the pre-composition text. It does not
  // simulate a native IME or add an Escape handler to the product.
  input.value = "元の表示名"; await input.fire("compositionend"); await h.settle();
  assert.equal(visibleThroughParents(input), true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.state.sessions[0].customLabel, "元の表示名");
  input.value = ""; await input.fire("input"); await form.fire("submit"); await h.settle();
  h.document.activeElement = null; await input.fire("blur"); await h.settle();
  assert.deepEqual(h.calls, [{ kind: "label", id: "edited-conversation", label: "" }]);
  assert.equal(byClass(card, "session-name").textContent, "自動の会話名");
  assert.equal(h.state.sessions[1].customLabel, "他の会話");
  assert.equal(h.state.sessions[0].unreadCount, 1);
});

test("C5: a save finishing after reconnect cannot overwrite newer typing or save into another row", async () => {
  const previous = session({ id: "saving-conversation", isCurrent: false, isHistory: true, unreadCount: 2 });
  const other = session({ id: "untouched-conversation", isCurrent: true, isHistory: false, customLabel: "変更しない" });
  const h = harness([previous, other]); await h.settle();
  h.elements.get("history").open = true;
  const card = h.historyCard(), input = byClass(card, "session-label-input"), form = byClass(card, "session-label-editor");
  let resolveSave;
  h.setSave(() => new Promise(resolve => { resolveSave = resolve; }));
  h.document.activeElement = input; input.value = "先に保存した名前"; await input.fire("input"); await form.fire("submit");
  await h.refresh({ ...h.state, sessions: [{ ...previous, isCurrent: true, isHistory: false }, other] });
  input.value = "保存後に追加した入力"; await input.fire("input");
  h.state = { ...h.state, sessions: [{ ...h.state.sessions[0], customLabel: "先に保存した名前", displayTitle: "先に保存した名前" }, other] };
  resolveSave({ ok: true }); await h.settle();
  assert.equal(visibleThroughParents(input), true);
  assert.equal(input.value, "保存後に追加した入力");
  assert.equal(byClass(card, "session-name").textContent, "先に保存した名前");
  assert.equal(h.state.sessions[1].customLabel, "変更しない");
  h.document.activeElement = null; await input.fire("blur"); await h.settle();
  assert.equal(card.parentNode, h.elements.get("sessions"));
  assert.equal(input.value, "保存後に追加した入力");
  assert.equal(byClass(card, "session-unread").textContent, "未確認 2 件");
  h.setSave(async () => ({ ok: false, message: "保存失敗を再試行できます。" }));
  await form.fire("submit"); await h.settle();
  assert.equal(input.value, "保存後に追加した入力");
  assert.equal(button(card, "表示名を保存").disabled, false);
  assert.equal(h.elements.get("status").textContent, "保存失敗を再試行できます。");
  assert.deepEqual(h.calls.map(call => call.id), [previous.id, previous.id]);
});
