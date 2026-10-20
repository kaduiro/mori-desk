/* SPDX-License-Identifier: AGPL-3.0-only */
(() => {
  'use strict';
  if (globalThis.__moriBrowserObserverInstalled) return;
  globalThis.__moriBrowserObserverInstalled = true;
  const utils = MoriProviderUtils;
  let pageInstanceId = crypto.randomUUID();
  const controller = MoriObservationController.createController();
  const metadataReader = MoriConversationMetadata.createReader();
  let route = utils.routeForUrl(location.href);
  let sequence = 0;
  let timeout = null;
  let verificationTimeout = null;
  let observationInterval = null;
  let lastSignature = null;
  let lastSentAt = 0;
  let stopped = false;
  let observerRoot = null;
  let previousGenerationNodes = [];
  let generationFence = null;
  let knownBeforeGeneration = new Set();
  let sampled = false;
  let explicitNavigation = null;
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
    document.removeEventListener('click', onPageClick, true);
    document.removeEventListener('visibilitychange', observeNow);
    removeEventListener('popstate', onPopState);
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

  function generationNodes(adapter) {
    if (!adapter) return [];
    const selectors = [...adapter.selectors.STOP, ...(adapter.selectors.SHORT_STOP || []),
      ...(adapter.selectors.BUSY || []), ...(adapter.provider === 'claude' ? ['[data-is-streaming="true"]'] : [])];
    const nodes = new Set();
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) if (utils.isVisible(node)) nodes.add(node);
    }
    return [...nodes];
  }

  function bindObserver() {
    // Some layouts render the composer/stop controls beside main, and replace
    // main during SPA navigation. Observe the body so these control changes
    // trigger the same bounded debounce. Mutation payloads are never read;
    // the separate metadata reader samples only authorized title/user nodes.
    const target = document.body;
    if (!target || target === observerRoot) return;
    observer.disconnect(); observerRoot = target;
    observer.observe(target, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['aria-label', 'aria-hidden', 'aria-busy', 'role', 'contenteditable',
        'data-testid', 'data-is-streaming', 'data-message-author-role', 'data-sidebar-item',
        'href', 'hidden', 'disabled'],
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
    const nextKey = nextRoute ? `${nextRoute.provider}:${nextRoute.conversationRef}` : null;
    const previousKnownKeys = metadataReader.knownConversationKeys();
    let assignedNewConversation = false;
    if (!utils.sameRoute(route, nextRoute)) {
      assignedNewConversation = controller.isRunning()
        && utils.canAssignConversation(route, location.href)
        && explicitNavigation !== true && explicitNavigation !== nextKey
        && !knownBeforeGeneration.has(nextKey);
      if (!assignedNewConversation) {
        controller.reset();
        // SPA navigation can leave the previous conversation's stop/streaming
        // controls mounted. Do not start a turn in the new route from them.
        generationFence ||= new WeakSet();
        for (const node of previousGenerationNodes) generationFence.add(node);
        knownBeforeGeneration = new Set();
        // A new empty GPT/project scope can share a document and a null
        // conversation ID. Rotate the opaque observation identity so a focus
        // request captured for the previous scope cannot acknowledge it.
        pageInstanceId = crypto.randomUUID();
      }
      route = nextRoute;
      lastSignature = null;
      explicitNavigation = null;
    }
    bindObserver();
    const adapter = adapterForRoute(route);
    const now = Date.now();
    let observation = adapter ? adapter.observe(document, location.href) : { supported: false };
    const markers = generationNodes(adapter);
    if (generationFence) {
      if (markers.some(node => generationFence.has(node))) observation = { supported: false, generating: false };
      else generationFence = null;
    }
    previousGenerationNodes = markers;
    const wasRunning = controller.isRunning();
    const state = controller.sample(observation, now);
    const metadata = metadataReader.sample(document, location.href, { assignedNewConversation });
    if (!wasRunning && state.status === 'running') {
      // Only routes already present before this generation are known existing
      // conversations. A newly created history link can precede its URL update.
      knownBeforeGeneration = new Set(sampled ? previousKnownKeys : metadataReader.knownConversationKeys());
    }
    sampled = true;
    const signature = JSON.stringify([route?.path, state.status, state.outcome, state.generationToken,
      metadata.conversationTitle, metadata.requestPreview]);
    let acknowledgement;
    if (force || signature !== lastSignature || now - lastSentAt >= 10000) {
      lastSignature = signature; lastSentAt = now;
      const message = {
        type: 'mori.observation', v: 1, pageInstanceId, contentSequence: ++sequence,
        observedAt: now, ...state, ...metadata,
      };
      // Only a bounded current title/latest submitted user excerpt accompany
      // status. No drafts, replies, URLs or DOM nodes cross this boundary.
      // IDs and the route are verified by the worker from sender.
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

  function onPageClick(event) {
    if (stopped) return;
    if (event.isTrusted && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey
      && (event.button === undefined || event.button === 0)) {
      const link = event.target?.closest?.('a[href]');
      const target = link?.getAttribute?.('target');
      if (link && (!target || target === '_self')) {
        try {
          const destination = utils.routeForUrl(new URL(link.getAttribute('href'), location.href).href);
          if (destination && !utils.sameRoute(route, destination)) {
            explicitNavigation = `${destination.provider}:${destination.conversationRef}`;
          }
        } catch (_) {}
      }
    }
    if (event.isTrusted && adapterForRoute(route)?.isStopTarget(event.target, document, location.href)) {
      controller.stopRequested(); schedule();
    }
  }
  function observeNow() { observe(true); }
  function onPopState() {
    if (!utils.sameRoute(route, utils.routeForUrl(location.href))) explicitNavigation = true;
    observe(true);
  }
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
  document.addEventListener('click', onPageClick, true);
  document.addEventListener('visibilitychange', observeNow);
  addEventListener('popstate', onPopState);
  addEventListener('pageshow', observeNow);
  addEventListener('pagehide', onPageHide);
  try { chrome.runtime.onMessage.addListener(onRuntimeMessage); }
  catch (error) { handleRuntimeFailure(error); }
  if (!stopped) {
    observationInterval = setInterval(observeNow, 10000);
    observe(true);
  }
})();
