/* SPDX-License-Identifier: AGPL-3.0-only */
(() => {
  'use strict';
  if (globalThis.__moriBrowserObserverInstalled) return;
  globalThis.__moriBrowserObserverInstalled = true;
  const utils = MoriProviderUtils;
  let pageInstanceId = crypto.randomUUID();
  const controller = MoriObservationController.createController();
  let route = utils.routeForUrl(location.href);
  let sequence = 0;
  let timeout = null;
  let verificationTimeout = null;
  let observationInterval = null;
  let lastSignature = null;
  let lastSentAt = 0;
  let stopped = false;
  let observerRoot = null;
  const observer = new MutationObserver(() => schedule());

  function runtimeId() {
    try { return globalThis.chrome?.runtime?.id || null; }
    catch (_) { return null; }
  }

  function stopInvalidatedObserver() {
    if (stopped) return;
    stopped = true;
    observer.disconnect(); observerRoot = null;
    clearTimeout(timeout); timeout = null;
    clearTimeout(verificationTimeout); verificationTimeout = null;
    clearInterval(observationInterval); observationInterval = null;
    document.removeEventListener('click', onStopClick, true);
    document.removeEventListener('visibilitychange', observeNow);
    removeEventListener('popstate', observeNow);
    removeEventListener('pageshow', observeNow);
    removeEventListener('pagehide', onPageHide);
    // An invalidated extension API may also reject listener removal. The DOM
    // observer and timers above are independent and have already been stopped.
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch (_) {}
    // Losing the extension context is not an AI completion. A page reload
    // installs the new observer; the desktop keeps its existing stale rules.
  }

  function handleRuntimeFailure(error) {
    if (!runtimeId() || /Extension context invalidated/i.test(error?.message || '')) {
      stopInvalidatedObserver();
    }
    // A sleeping/restarting worker or a temporarily closed message port does
    // not invalidate this page's observer. Its next sample can retry normally.
  }

  function sendObservation(message) {
    const unavailable = error => {
      handleRuntimeFailure(error);
      return utils.safeObservationAck({ ok: null, reason: 'worker_unavailable' });
    };
    try {
      return Promise.resolve(chrome.runtime.sendMessage(message)).then(utils.safeObservationAck, unavailable);
    } catch (error) { return Promise.resolve(unavailable(error)); }
  }

  function adapterForRoute(value) {
    return value?.provider === 'chatgpt' ? MoriChatgptAdapter
      : value?.provider === 'claude' ? MoriClaudeAdapter : null;
  }

  function bindObserver() {
    // Some layouts render the composer/stop controls beside main, and replace
    // main during SPA navigation. Observe the body so these control changes
    // trigger the same bounded debounce; mutation text is never inspected.
    const target = document.body;
    if (!target || target === observerRoot) return;
    observer.disconnect(); observerRoot = target;
    observer.observe(target, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ['aria-label', 'aria-hidden', 'aria-busy', 'role', 'contenteditable',
        'data-testid', 'data-is-streaming', 'hidden', 'disabled'],
    });
  }

  function schedule(delay = 180) {
    if (stopped || timeout !== null) return;
    timeout = setTimeout(() => { timeout = null; observe(false); }, delay);
  }

  function observe(force) {
    if (stopped) return;
    if (!runtimeId()) { stopInvalidatedObserver(); return; }
    const nextRoute = utils.routeForUrl(location.href);
    if (!utils.sameRoute(route, nextRoute)) {
      const assignedNewConversation = controller.isRunning()
        && utils.canAssignConversation(route, location.href);
      if (!assignedNewConversation) {
        controller.reset();
        // A new empty GPT/project scope can share a document and a null
        // conversation ID. Rotate the opaque observation identity so a focus
        // request captured for the previous scope cannot acknowledge it.
        pageInstanceId = crypto.randomUUID();
      }
      route = nextRoute;
      lastSignature = null;
    }
    bindObserver();
    const adapter = adapterForRoute(route);
    const now = Date.now();
    const observation = adapter ? adapter.observe(document, location.href) : { supported: false };
    const state = controller.sample(observation, now);
    const signature = JSON.stringify([route?.path, state.status, state.outcome, state.generationToken]);
    let acknowledgement;
    if (force || signature !== lastSignature || now - lastSentAt >= 10000) {
      lastSignature = signature; lastSentAt = now;
      const message = {
        type: 'mori.observation', v: 1, pageInstanceId, contentSequence: ++sequence,
        observedAt: now, ...state,
      };
      // No conversation text, title, URL, input value, or DOM node crosses this
      // boundary. IDs and the route are verified by the worker from sender.
      // sendMessage can throw synchronously after an extension reload, before
      // a Promise exists. Catch both that case and asynchronous rejections.
      acknowledgement = sendObservation(message);
    }
    if (stopped) return;
    if (controller.isRunning() && !observation.generating && verificationTimeout === null) {
      verificationTimeout = setTimeout(() => { verificationTimeout = null; observe(false); }, 900);
    }
    return { status: !route ? 'unsupported_route' : !observation.supported ? 'unknown' : state.status,
      acknowledgement };
  }

  function onStopClick(event) {
    if (stopped) return;
    if (event.isTrusted && adapterForRoute(route)?.isStopTarget(event.target, document, location.href)) {
      controller.stopRequested(); schedule();
    }
  }
  function observeNow() { observe(true); }
  // An unload is not a completion event. Browser tabs/navigation supply closure
  // information, and the desktop marks observations stale when we disappear.
  function onPageHide() { observer.disconnect(); observerRoot = null; }
  function onRuntimeMessage(message, sender, respond) {
    if (stopped) return;
    const id = runtimeId();
    if (!id) { stopInvalidatedObserver(); return; }
    if (sender.id !== id) return;
    try {
      if (message?.type === 'mori.observe.now') {
        observe(true); if (!stopped) respond({ ok: true });
      } else if (message?.type === 'mori.health.check') {
        const result = observe(true);
        // Wait for this exact observation's worker receipt. Reading a running
        // control alone does not prove that the current document was accepted.
        // Replies still contain categories only, never page content or IDs.
        Promise.resolve(result?.acknowledgement).then(ack => {
          if (!stopped) respond({ ok: true, v: 1, status: result?.status || 'unknown',
            observationAck: utils.safeObservationAck(ack) });
        });
        return true;
      } else if (message?.type === 'mori.focus.check') {
        const current = utils.routeForUrl(location.href);
        respond({
          ok: document.visibilityState !== 'prerender' && !!current
            && utils.sameRoute(route, current)
            && message.pageInstanceId === pageInstanceId
            && message.conversationRef === current.conversationRef,
          pageInstanceId,
          conversationRef: current?.conversationRef ?? null,
        });
      }
    } catch (error) { handleRuntimeFailure(error); }
  }
  document.addEventListener('click', onStopClick, true);
  document.addEventListener('visibilitychange', observeNow);
  addEventListener('popstate', observeNow);
  addEventListener('pageshow', observeNow);
  addEventListener('pagehide', onPageHide);
  try { chrome.runtime.onMessage.addListener(onRuntimeMessage); }
  catch (error) { handleRuntimeFailure(error); }
  if (!stopped) {
    observationInterval = setInterval(observeNow, 10000);
    observe(true);
  }
})();
