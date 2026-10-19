/* SPDX-License-Identifier: AGPL-3.0-only */
(() => {
  'use strict';
  if (globalThis.__moriBrowserObserverInstalled) return;
  globalThis.__moriBrowserObserverInstalled = true;
  const utils = MoriProviderUtils;
  const pageInstanceId = crypto.randomUUID();
  const controller = MoriObservationController.createController();
  let route = utils.routeForUrl(location.href);
  let sequence = 0;
  let timeout = null;
  let verificationTimeout = null;
  let lastSignature = null;
  let lastSentAt = 0;
  let stopped = false;
  let observerRoot = null;
  const observer = new MutationObserver(() => schedule());

  function adapterForRoute(value) {
    return value?.provider === 'chatgpt' ? MoriChatgptAdapter
      : value?.provider === 'claude' ? MoriClaudeAdapter : null;
  }

  function bindObserver() {
    // Scope frequent mutations to the conversation area when available. The
    // ten-second check also discovers a replaced SPA root.
    const target = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
    if (!target || target === observerRoot) return;
    observer.disconnect(); observerRoot = target;
    observer.observe(target, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ['aria-label', 'aria-hidden', 'data-testid', 'data-is-streaming', 'hidden', 'disabled'],
    });
  }

  function schedule(delay = 180) {
    if (stopped || timeout !== null) return;
    timeout = setTimeout(() => { timeout = null; observe(false); }, delay);
  }

  function observe(force) {
    if (stopped) return;
    const nextRoute = utils.routeForUrl(location.href);
    if (!utils.sameRoute(route, nextRoute)) {
      const assignedNewConversation = route && nextRoute
        && route.provider === nextRoute.provider && route.conversationRef === null
        && nextRoute.conversationRef !== null && controller.isRunning();
      if (!assignedNewConversation) controller.reset();
      route = nextRoute;
      lastSignature = null;
    }
    bindObserver();
    const adapter = adapterForRoute(route);
    const now = Date.now();
    const observation = adapter ? adapter.observe(document, location.href) : { supported: false };
    const state = controller.sample(observation, now);
    const signature = JSON.stringify([route?.path, state.status, state.outcome, state.generationToken]);
    if (force || signature !== lastSignature || now - lastSentAt >= 10000) {
      lastSignature = signature; lastSentAt = now;
      const message = {
        type: 'mori.observation', v: 1, pageInstanceId, contentSequence: ++sequence,
        observedAt: now, ...state,
      };
      // No conversation text, title, URL, input value, or DOM node crosses this
      // boundary. IDs and the route are verified by the worker from sender.
      chrome.runtime.sendMessage(message).catch(() => {});
    }
    if (controller.isRunning() && !observation.generating && verificationTimeout === null) {
      verificationTimeout = setTimeout(() => { verificationTimeout = null; observe(false); }, 900);
    }
  }

  document.addEventListener('click', event => {
    if (event.isTrusted && adapterForRoute(route)?.isStopTarget(event.target)) {
      controller.stopRequested(); schedule();
    }
  }, true);
  document.addEventListener('visibilitychange', () => observe(true));
  addEventListener('popstate', () => observe(true));
  addEventListener('pageshow', () => observe(true));
  // An unload is not a completion event. Browser tabs/navigation supply closure
  // information, and the desktop marks observations stale when we disappear.
  addEventListener('pagehide', () => { observer.disconnect(); observerRoot = null; });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'mori.observe.now') {
      observe(true); respond({ ok: true });
    } else if (message?.type === 'mori.focus.check') {
      const current = utils.routeForUrl(location.href);
      respond({
        ok: document.visibilityState !== 'prerender' && !!current
          && message.pageInstanceId === pageInstanceId
          && message.conversationRef === current.conversationRef,
        pageInstanceId,
        conversationRef: current?.conversationRef ?? null,
      });
    }
  });
  setInterval(() => observe(true), 10000);
  observe(true);
})();
