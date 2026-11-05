/* SPDX-License-Identifier: AGPL-3.0-only */
(function (factory) {
  if (typeof module === 'object' && module.exports) module.exports = { createObserver: factory };
  else factory();
})(function (measurement) {
  'use strict';
  const observerVersion = '0.1.15';
  const REGISTRATION_RETRY_MS = 500;
  const TRANSIENT_REGISTRATION_FAILURES = new Set(['registration_failed', 'lease_invalid',
    'lease_expired', 'tab_unavailable', 'observation_failed', 'initialization_failed']);
  // Loading the packaged files has no observation side effects. Recovery must
  // explicitly start them with a worker-owned attempt ticket; a timed-out
  // executeScript(files) cannot later become an ordinary manifest start.
  globalThis.MoriBrowserObserver = Object.freeze({ start });

  function start({ attemptId = null } = {}) {
    const previous = globalThis.__moriBrowserObserverLifecycle;
    try {
      if (previous?.version === observerVersion && previous.isActive()) {
        return previous.register(attemptId, true);
      }
      previous?.stop();
    } catch (_) {}
    return install(attemptId);
  }

  function install(initialAttemptId) {
    // Only an explicitly instrumented development factory supplies a sink.
    // No page message, manifest start or recovery ticket can enable it.
    function measure(stage, fields = {}) { try { measurement?.record(stage, fields); } catch (_) {} }
    function measurementFailure() { try { measurement?.seriesFailure?.('missing_hook'); } catch (_) {} }
    function registrationMeasured(status, reason) {
      try {
        if (typeof measurement?.registrationResult === 'function') measurement.registrationResult({ status, reason });
        else measure('registration_result', { status, reason: status === 'ok' ? 'none'
          : reason === 'binding_unconfirmed' ? 'scope_unconfirmed' : 'unclassified' });
      } catch (_) {}
    }
    const utils = MoriProviderUtils;
    let pageInstanceId = crypto.randomUUID();
    const controller = MoriObservationController.createController();
    let metadataReader = MoriConversationMetadata.createReader();
    const bindingTracker = MoriConversationBinding.createTracker({ detailed: true, allowView: true });
    let route = utils.routeForUrl(location.href);
    let binding = bindingTracker.sample(document, location.href);
    let lease = null;
    let scopeObservation = false;
    let samplingEpoch = crypto.randomUUID();
    let lastSampleMono = null;
    let seenIdle = false;
    let startUnobserved = true;
    let attemptId = initialAttemptId;
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
    let samplingContinuity = false;
    let explicitNavigation = null;
    let assignedNewConversation = false;
    let registrationSerial = 0;
    let registrationPending = null;
    let lastRegistrationAt = -Infinity;
    let fastRegistrationFailures = 0;
    let admittedDomUnknown = false;
    let lastRegistrationResult = { ok: false, reason: 'binding_unconfirmed' };
    const observer = new MutationObserver(() => schedule());
    const owner = { version: observerVersion, isActive: () => !stopped && !!runtimeId(),
      stop: stopInvalidatedObserver, register: requestRegistration, identity };
    globalThis.__moriBrowserObserverLifecycle = owner;
    globalThis.__moriBrowserObserverInstalled = true;

    function runtimeId() {
      try { return globalThis.chrome?.runtime?.id || null; }
      catch (_) { return null; }
    }

    function stopInvalidatedObserver() {
      if (stopped) return;
      stopped = true; lease = null; registrationSerial++;
      observer.disconnect(); observerRoot = null;
      clearTimeout(timeout); timeout = null;
      clearTimeout(verificationTimeout); verificationTimeout = null;
      clearInterval(observationInterval); observationInterval = null;
      document.removeEventListener('click', onPageClick, true);
      document.removeEventListener('visibilitychange', observeNow);
      removeEventListener('popstate', onPopState);
      removeEventListener('pageshow', observeNow);
      removeEventListener('pagehide', onPageHide);
      try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch (_) {}
      if (globalThis.__moriBrowserObserverLifecycle === owner) {
        delete globalThis.__moriBrowserObserverLifecycle;
        delete globalThis.__moriBrowserObserverInstalled;
      }
      // Extension loss is never an AI completion.
    }

    function handleRuntimeFailure(error) {
      if (!runtimeId() || /Extension context invalidated/i.test(error?.message || '')) stopInvalidatedObserver();
      // A worker restart needs a new lease and a separate sampling series.
    }

    function breakSamplingContinuity({ preservePage = false } = {}) {
      if (!samplingContinuity) return;
      measure('continuity_broken');
      samplingEpoch = crypto.randomUUID(); lastSampleMono = null; seenIdle = false; startUnobserved = true;
      samplingContinuity = false; controller.reset();
      if (!preservePage) pageInstanceId = crypto.randomUUID(); lastSignature = null;
      knownBeforeGeneration = new Set(); sampled = false;
      // A sampling/page break revokes admission, but is not permission to
      // bypass registration backoff on every mutation of an unknown layout.
      registrationSerial++; registrationPending = null;
      clearTimeout(verificationTimeout); verificationTimeout = null;
      // A new lease cannot prove what happened during unsampled time. Rotate
      // identity so a previously running turn cannot become a terminal event
      // when observation resumes. Already durable receipts remain in the store.
    }

    function refreshIdentity() {
      const nextRoute = utils.routeForUrl(location.href);
      const nextBinding = bindingTracker.sample(document, location.href);
      const routeChanged = !utils.sameRoute(route, nextRoute) && !!(route || nextRoute);
      const bindingChanged = binding.state !== nextBinding.state || binding.epoch !== nextBinding.epoch;
      if (routeChanged || bindingChanged) {
        const nextKey = nextRoute ? `${nextRoute.provider}:${nextRoute.conversationRef}` : null;
        // Continuity requires an independently confirmed binding epoch. The
        // historical URL/node heuristics alone can never grant observation.
        assignedNewConversation = routeChanged && !bindingChanged && binding.state === 'confirmed'
          && controller.isRunning() && utils.canAssignConversation(route, location.href)
          && explicitNavigation !== true && explicitNavigation !== nextKey && !knownBeforeGeneration.has(nextKey);
        if (!assignedNewConversation) {
          samplingEpoch = crypto.randomUUID(); lastSampleMono = null; seenIdle = false; startUnobserved = true;
          controller.reset(); samplingContinuity = false;
          generationFence ||= new WeakSet();
          for (const node of previousGenerationNodes) generationFence.add(node);
          knownBeforeGeneration = new Set(); sampled = false;
          pageInstanceId = crypto.randomUUID();
        }
        route = nextRoute; binding = nextBinding; lease = null;
        lastSignature = null; explicitNavigation = null;
        lastRegistrationAt = -Infinity; registrationSerial++; registrationPending = null;
        fastRegistrationFailures = 0;
        admittedDomUnknown = false;
        clearTimeout(verificationTimeout); verificationTimeout = null;
      }
      if (!route || binding.state !== 'confirmed' || lease?.bindingEpoch !== binding.epoch) lease = null;
    }

    function identity() {
      refreshIdentity();
      return { observerVersion, pageInstanceId, route: route ? { ...route } : null,
        binding: { state: binding.state, epoch: binding.epoch, kind: binding.kind,
          viewEpoch: binding.viewEpoch, reason: binding.reason }, samplingEpoch, lease: lease ? { ...lease } : null };
    }

    function canRetryRegistrationQuickly() {
      return fastRegistrationFailures > 0 && fastRegistrationFailures <= 3
        && (admittedDomUnknown || TRANSIENT_REGISTRATION_FAILURES.has(lastRegistrationResult.reason));
    }

    function requestRegistration(nextAttempt = attemptId, force = false) {
      if (stopped || !runtimeId()) {
        registrationMeasured('failed', stopped ? 'stopped' : 'runtime_unavailable');
        return Promise.resolve({ ok: false, reason: 'registration_failed' });
      }
      // A real manifest start can arrive after an early recovery installer.
      // Retain its unticketed origin even if the empty page has no binding yet.
      if (force && nextAttempt === null) attemptId = null;
      refreshIdentity();
      if (registrationPending?.attemptId === nextAttempt) return registrationPending.promise;
      const retryDelay = canRetryRegistrationQuickly() ? REGISTRATION_RETRY_MS : 10000;
      const remaining = retryDelay - (Date.now() - lastRegistrationAt);
      if (!force && remaining > 0) {
        if (canRetryRegistrationQuickly()) schedule(remaining);
        return Promise.resolve(lastRegistrationResult);
      }
      lastRegistrationAt = Date.now();
      const serial = ++registrationSerial;
      const expected = { pageInstanceId, route, bindingEpoch: binding.epoch };
      const message = { type: 'mori.observer.register', v: 1, pageInstanceId, observerVersion, attemptId: nextAttempt };
      measure('registration_requested');
      let localFailure = null;
      const unavailable = error => { handleRuntimeFailure(error); localFailure = runtimeId() ? 'message_failed' : 'runtime_unavailable';
        return { ok: false, reason: 'registration_failed' }; };
      let sent;
      try { sent = Promise.resolve(chrome.runtime.sendMessage(message)).catch(unavailable); }
      catch (error) { sent = Promise.resolve(unavailable(error)); }
      const promise = sent.then(result => {
        refreshIdentity();
        if (stopped || serial !== registrationSerial || expected.pageInstanceId !== pageInstanceId
          || expected.bindingEpoch !== binding.epoch || !utils.sameRoute(expected.route, route)) {
          registrationMeasured('failed', stopped ? 'stopped' : serial !== registrationSerial ? 'registration_replaced'
            : expected.pageInstanceId !== pageInstanceId ? 'page_changed'
              : expected.bindingEpoch !== binding.epoch ? 'binding_changed' : 'route_changed');
          // Preserve this negative worker result for the recovery caller: it
          // can finish verified document ownership after an SPA transition.
          // It grants no scope/lease here, and the worker still checks its live
          // candidate, document, control generation and deadline at handoff.
          if (result?.ok === false && result.reason === 'binding_unconfirmed')
            return { ok: false, reason: 'binding_unconfirmed' };
          return { ok: false, reason: 'lease_invalid' };
        }
        const granted = result?.ok === true && result.v === 1 && result.pageInstanceId === pageInstanceId
          ? utils.safeLease(result) : null;
        if (granted && binding.state === 'confirmed' && granted.bindingEpoch === binding.epoch) {
          if (lease && !['workerEpoch', 'leaseId', 'bindingEpoch'].every(field => lease[field] === granted[field])) {
            lease = null; breakSamplingContinuity({ preservePage: true });
          }
          lease = granted; attemptId = nextAttempt; lastSignature = null;
          scopeObservation = result.scopeObservation === true;
          lastRegistrationResult = { ok: true, v: 1, pageInstanceId, ...granted };
          measure('lease_received');
          observe(true);
        } else {
          lastRegistrationResult = utils.safeObservationAck(result);
          if (lastRegistrationResult.ok !== false) lastRegistrationResult = { ok: false, reason: 'registration_failed' };
          fastRegistrationFailures++;
          admittedDomUnknown = false;
          // A late, expired recovery attempt must not revoke a newer live lease.
          if (['paused', 'old_document', 'invalid_sender'].includes(lastRegistrationResult.reason)) {
            lease = null; breakSamplingContinuity();
          }
          if (binding.state === 'confirmed' && route && canRetryRegistrationQuickly()) schedule(REGISTRATION_RETRY_MS);
        }
        registrationMeasured(lastRegistrationResult.ok === true ? 'ok' : 'failed',
          lastRegistrationResult.ok === true ? 'none' : localFailure || lastRegistrationResult.reason);
        return lastRegistrationResult;
      }).finally(() => { if (registrationPending?.serial === serial) registrationPending = null; });
      registrationPending = { serial, attemptId: nextAttempt, promise };
      return promise;
    }

    function sendObservation(message, adoptedSubject) {
      const capturedLease = lease;
      let measuredDispatch = null;
      if (measurement) {
        try {
          const fields = ['type','v','pageInstanceId','contentSequence','observedAt','status','generationToken','outcome',
            'workerEpoch','leaseId','bindingEpoch','scopeKind','viewEpoch','samplingEpoch','startUnobserved'];
          const descriptors = Object.getOwnPropertyDescriptors(message);
          const names=Reflect.ownKeys(descriptors),prototype=Object.getPrototypeOf(message);
          const valid=(prototype===null||prototype===Object.prototype)&&fields.every(key=>Object.hasOwn(descriptors,key))
            &&names.every(key=>typeof key==='string'&&[...fields,'conversationTitle','requestPreview'].includes(key)&&Object.hasOwn(descriptors[key],'value'));
          const projected = valid ? Object.fromEntries(fields.map(key => [key, descriptors[key].value])) : null;
          measuredDispatch = measurement.dispatchBegin?.(projected, adoptedSubject,
            { provider: route.provider, kind: binding.kind, conversationRef: binding.kind === 'view' ? null : route.conversationRef });
        } catch (_) { measurementFailure(); }
      }
      // Private development constructor only. Never pass display metadata to a
      // diagnostic sink, and never await measurement before normal delivery.
      try { measurement?.observation?.(Object.fromEntries([
        'contentSequence', 'pageInstanceId', 'generationToken', 'samplingEpoch',
        'workerEpoch', 'leaseId', 'bindingEpoch', 'viewEpoch', 'scopeKind', 'startUnobserved',
      ].map(key => [key, message[key]]))); } catch (_) {}
      const unavailable = error => { handleRuntimeFailure(error); return { ok: null, reason: 'worker_unavailable' }; };
      let sent;
      try {
        const returned = chrome.runtime.sendMessage(message);
        try { measurement?.dispatchEnd?.(measuredDispatch, adoptedSubject, 'returned'); } catch (_) { measurementFailure(); }
        sent = Promise.resolve(returned).catch(unavailable);
      }
      catch (error) {
        try { measurement?.dispatchEnd?.(measuredDispatch, adoptedSubject, 'threw'); } catch (_) { measurementFailure(); }
        sent = Promise.resolve(unavailable(error));
      }
      return sent.then(value => {
        const ack = utils.safeObservationAck(value);
        if (ack.ok !== true) {
          lastSignature = null;
          if (lease === capturedLease && ['lease_invalid', 'lease_expired', 'binding_unconfirmed',
            'paused', 'old_document', 'invalid_sender', 'observer_queue_full'].includes(ack.reason)) {
            lease = null; breakSamplingContinuity();
            lastRegistrationResult = ack; fastRegistrationFailures++;
            if (binding.state === 'confirmed' && route && canRetryRegistrationQuickly()) schedule(REGISTRATION_RETRY_MS);
          }
        }
        return ack;
      });
    }

    function adapterForRoute(value) {
      return value?.provider === 'chatgpt' ? MoriChatgptAdapter : value?.provider === 'claude' ? MoriClaudeAdapter : null;
    }

    function generationNodes(adapter, scope = document) {
      if (!adapter) return [];
      const selectors = [...adapter.selectors.STOP, ...(adapter.selectors.SHORT_STOP || []),
        ...(adapter.selectors.BUSY || []), ...(adapter.provider === 'claude' ? ['[data-is-streaming="true"]'] : [])];
      const nodes = new Set();
      for (const selector of selectors) {
        for (const node of scope.querySelectorAll(selector)) if (utils.isVisible(node)) nodes.add(node);
      }
      return [...nodes];
    }

    function bindObserver() {
      const target = document.body;
      if (!target) { measure('observer_install_deferred', { reason: 'initializing' }); return; }
      if (target === observerRoot) return;
      observer.disconnect(); observerRoot = target;
      observer.observe(target, { subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['aria-label', 'aria-hidden', 'aria-busy', 'role', 'contenteditable',
          'data-testid', 'data-is-streaming', 'data-message-author-role', 'data-sidebar-item', 'href', 'hidden', 'disabled',
          'data-chatgpt-conversation-selection-target', 'data-map-composer-conversation',
          'data-chatgpt-selection-conversation-id', 'data-conv-id', 'data-hub-ready',
          'data-hub-awaiting-creation', 'data-hub-draft', 'data-talvt-turn-state',
          'data-thread-user-message-navigation-content', 'data-chatgpt-composer', 'data-composer-placement'] });
      measure('observer_installed');
    }

    function schedule(delay = 180) {
      if (stopped || timeout !== null) return;
      timeout = setTimeout(() => { timeout = null; observe(false); }, delay);
    }

    function observe(force) {
      if (stopped) return;
      if (!runtimeId()) { stopInvalidatedObserver(); return; }
      measure('product_inspection_started');
      let measuredSubject = null;
      try {
      refreshIdentity(); bindObserver();
      const monotonic = globalThis.performance?.now?.() ?? Date.now();
      if (lastSampleMono !== null && (monotonic < lastSampleMono || monotonic - lastSampleMono > 15000)) {
        lease = null; breakSamplingContinuity();
      }
      if (!lease || binding.state !== 'confirmed' || !route) {
        breakSamplingContinuity();
        if (binding.state === 'confirmed' && route) {
          // A transient failure must not wait for another mutation or the
          // ten-second heartbeat. Bounded retries share one pending request;
          // stable failures and admitted-but-unknown DOM use ordinary polling.
          void requestRegistration();
        }
        // All entry points share this gate. No adapter, user excerpt, generation
        // reducer, or terminal message is evaluated before current admission.
        return { status: route ? 'unknown' : 'unsupported_route', identity: identity(),
          acknowledgement: Promise.resolve({ ok: false, reason: binding.state === 'confirmed' ? 'lease_invalid' : 'binding_unconfirmed' }) };
      }
      const previousKnownKeys = metadataReader.knownConversationKeys();
      samplingContinuity = true;
      const adapter = adapterForRoute(route);
      const verifiedScope = bindingTracker.scope?.(measurement ? subject => { measuredSubject = { ...subject, document }; } : undefined,
        measurement ? measurementFailure : undefined);
      if (typeof bindingTracker.scope === 'function' && !verifiedScope) {
        lease = null; breakSamplingContinuity();
        return { status: 'unknown', identity: identity() };
      }
      const scope = verifiedScope || document;
      const now = Date.now();
      let observation = adapter ? adapter.observe(scope, location.href, { continuing: controller.isRunning() }) : { supported: false };
      const markers = generationNodes(adapter, scope);
      if (generationFence) {
        if (markers.some(node => generationFence.has(node))) observation = { supported: false, generating: false };
        else generationFence = null;
      }
      previousGenerationNodes = markers;
      const wasRunning = controller.isRunning();
      const state = controller.sample(observation, monotonic);
      if (observation.supported) { lastSampleMono = monotonic; fastRegistrationFailures = 0; admittedDomUnknown = false; }
      if (observation.supported) measure('sample_valid');
      if (!wasRunning && state.status === 'running') startUnobserved = !seenIdle;
      if (['idle', 'settled'].includes(state.status) && observation.supported) seenIdle = true;
      const metadata = binding.kind === 'conversation'
        ? metadataReader.sample(document, location.href, { assignedNewConversation, scope, verifiedBinding: !!verifiedScope })
        : { conversationTitle: '', requestPreview: '' };
      assignedNewConversation = false;
      if (!wasRunning && state.status === 'running') knownBeforeGeneration = new Set(sampled ? previousKnownKeys : metadataReader.knownConversationKeys());
      sampled = true;
      const signature = JSON.stringify([route.path, state.status, state.outcome, state.generationToken,
        metadata.conversationTitle, metadata.requestPreview, lease.workerEpoch, lease.leaseId, lease.bindingEpoch]);
      let acknowledgement;
      if (force || signature !== lastSignature || now - lastSentAt >= 10000) {
        lastSignature = signature; lastSentAt = now;
        acknowledgement = sendObservation({ type: 'mori.observation', v: scopeObservation ? 2 : 1, pageInstanceId,
          contentSequence: ++sequence, observedAt: now, ...lease, ...state, ...metadata,
          ...(scopeObservation ? { scopeKind: binding.kind, viewEpoch: binding.viewEpoch, samplingEpoch, startUnobserved } : {}) }, measuredSubject);
        if (state.status === 'unknown') {
          lease = null; breakSamplingContinuity();
          admittedDomUnknown = true; fastRegistrationFailures++;
          if (canRetryRegistrationQuickly()) schedule(REGISTRATION_RETRY_MS);
        }
      }
      if (stopped) return;
      if (controller.isRunning() && !observation.generating && verificationTimeout === null) {
        verificationTimeout = setTimeout(() => { verificationTimeout = null; observe(false); }, 900);
      }
      return { status: !observation.supported ? 'unknown' : state.status, acknowledgement, identity: identity() };
      } finally { measuredSubject = null; measure('product_inspection_finished'); }
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
            if (destination && !utils.sameRoute(route, destination)) explicitNavigation = `${destination.provider}:${destination.conversationRef}`;
          } catch (_) {}
        }
      }
      refreshIdentity();
      if (lease && event.isTrusted && adapterForRoute(route)?.isStopTarget(event.target, bindingTracker.scope?.() || document, location.href, { continuing: controller.isRunning() })) {
        controller.stopRequested(); schedule();
      }
    }
    function observeNow() { observe(true); }
    function onPopState() {
      if (!utils.sameRoute(route, utils.routeForUrl(location.href))) explicitNavigation = true;
      observe(true);
    }
    function onPageHide() {
      observer.disconnect(); observerRoot = null; lease = null;
      controller.reset(); samplingContinuity = false; metadataReader = MoriConversationMetadata.createReader();
      samplingEpoch = crypto.randomUUID(); lastSampleMono = null; seenIdle = false; startUnobserved = true;
      pageInstanceId = crypto.randomUUID(); lastSignature = null;
      registrationSerial++; registrationPending = null; lastRegistrationAt = -Infinity;
    }
    function onRuntimeMessage(message, sender, respond) {
      if (stopped) return;
      const id = runtimeId();
      if (!id) { stopInvalidatedObserver(); return; }
      if (sender.id !== id) return;
      try {
        if (message?.type === 'mori.observer.identity') {
          // Bootstrap identity proves only who is present. It cannot ACK focus.
          respond({ ok: true, v: 1, ...identity() });
        } else if (message?.type === 'mori.observe.now') {
          const result = observe(true);
          if (!stopped && result) respond({ ok: true, v: 1, ...result.identity });
        } else if (message?.type === 'mori.health.check') {
          const result = observe(true);
          Promise.resolve(result?.acknowledgement).then(ack => {
            if (!stopped) respond({ ok: true, v: 1, status: result?.status || 'unknown',
              observationAck: utils.safeObservationAck(ack), ...result?.identity });
          });
          return true;
        } else if (message?.type === 'mori.focus.check') {
          refreshIdentity();
          respond({ ok: !document.prerendering && document.visibilityState !== 'prerender' && !!route
            && binding.state === 'confirmed' && !!lease && message.pageInstanceId === pageInstanceId
            && message.conversationRef === route.conversationRef
            && ['workerEpoch', 'leaseId', 'bindingEpoch'].every(field => message[field] === lease[field]),
            pageInstanceId, conversationRef: route?.conversationRef ?? null });
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
    if (stopped) return Promise.resolve({ ok: false, reason: 'registration_failed' });
    bindObserver();
    observationInterval = setInterval(observeNow, 10000);
    return requestRegistration(initialAttemptId, true);
  }
});
