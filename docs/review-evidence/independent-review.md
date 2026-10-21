# Independent source review — recovery changes A/B/C

## Judgment

The final reviewed A/C source and B safety scaffolding satisfy the independently exercised invariants listed below. Two additional safety defects were reproduced during this review, corrected by the product owners, and retested with unchanged scenarios and expected outcomes. No unresolved defect was found in the source paths exercised at the final hashes.

This is a bounded source/synthetic judgment. **B's useful automatic recovery is not complete:** production `conversation-binding.js` always returns `unconfirmed`, because provider-specific evidence has not been established. Correct names/excerpts/status/notifications/focus on real ChatGPT and Claude therefore remain unachieved by this candidate. Safety of withholding observations does not establish B8, Windows limited-use readiness, or employee distribution readiness.

The review did not modify any product or repository test file, make a commit, or push. All original review work was confined to the review's temporary artifact directory. The parent may copy this portable evidence into the repository after inspecting it.

## Independence

Root `AGENTS.md`, the upstream contributor instructions, and `docs/recovery-fix-test-plan-ja.md` were read first. Initial invariants were fixed before changed product source or implementation tests were read. Original invariant SHA-256: `0db49a746d100d45efac8fdd071d88dc0725767aec49af9739a60cc527eb2a19`. B supplement SHA-256: `0a93c4fbbf725c0ddad7281f2f7eb8170a7a90e29667ec2cefe3ccfb474f91ed`.

No implementation test, shared fixture, prior reproduction harness, or other acceptance agent's fixture was opened. Product modules are the system under test, not the source of expected results. The reviewer's own row/event ledger determines which physical row, generation, unread receipt, and route should survive each schedule. The same model family remains a source of correlated reasoning; passing these independent fixtures does not remove the need for real-browser and human acceptance evidence.

## Findings and corrections

### F1 — a paused, unsampled interval could produce a false terminal

**Affected boundary:** `overlay/extensions/browser-bridge/content-script.js`, `observe`, `requestRegistration`, and `sendObservation`; downstream terminal creation in `session-coordinator.js`.

The content gate stopped adapter/controller sampling when a lease was absent, but retained its earlier running controller. The independently controlled sequence was:

1. Establish a confirmed synthetic binding and accept running generation T.
2. Return a paused rejection, causing the content observer to lose its lease.
3. Stop generation while observations are gated. Verify that adapter sample count does not increase during this interval.
4. Grant a lease for the same route/binding, then supply idle samples through the settling delay.

The prior source emitted one terminal for T; the fixed invariant required zero because the stop occurred during unobserved time. The actual content/controller/coordinator produced the failure. The production-binding negative test remained separate and unconfirmed.

`content-before-fix-results.json` retains the FAIL at content SHA-256 `7382a8f1011c7995de59e669f536aab72085f0589eed3a049814bf5170aba127`. The owner added `breakSamplingContinuity`: explicit revocation or omitted sampling resets the controller and rotates opaque page identity. New permission can no longer continue the old generation across that gap.

The unchanged oracle passes at `bbca446fa121a577e1fd00e6b0e66fed9eeb7d4a08b7923526a64c99996620c1`. The paired positive case still produces exactly one terminal when the same observer continues sampling and only worker permission is renewed. This is protocol evidence with controlled binding, not a real ChatGPT/Claude observation.

### F2 — an old final focus reply could succeed after the current route changed

**Affected boundary:** `overlay/extensions/browser-bridge/service-worker.js`, `validateFocus` after awaiting `mori.focus.check`.

The old path inspected the tab and observer before the focus response, then accepted the response without reading the tab again. The independent schedule reached the second/final focus validation, computed a valid response for A, changed the externally maintained current tab URL to B while that response was in flight, delayed `onUpdated`, and returned the old response. `focusRequest` returned success for A. That success is the boundary used to permit notice acknowledgement.

`worker-before-focus-fix-results.json` retains the FAIL at worker SHA-256 `3af8c6db5982337e1436ff53aa6346116d633e5332d40fe7fe6851bb651c2c86`. The owner added a fresh `tabs.get` and exact route/availability check after the reply, followed by the generation/lease/session checks. The unchanged oracle now rejects the stale success.

This is a controlled API-ordering reproduction. It does not establish how often the schedule occurs in installed Chrome. The test checks a concrete avoidable stale-response window; it does not claim that a browser route can never change after the final verified instant.

### F3 — reconciliation needed a revocation check between records

**Affected boundary:** `service-worker.js`, `reconcileTabs`.

The initial A revision checked control generation before entering the loop. Each record's commit yields to asynchronous storage, allowing a later pause/unpair before the next record. This concern was reported while B was in progress. The final source checks again before each candidate.

The independent test blocks A's admitted close at session persistence, requests pause, and attempts a new admission. Pause success waits; the new admission is rejected immediately. Once A settles, B is not closed and A's durable close receipt is preserved. A VM-only fault that removes the per-record check fails specifically because B is subsequently closed. This establishes sensitivity to the relevant boundary rather than to an unrelated crash or timeout.

### Supplemental corrections independently confirmed

The implementation owner also strengthened timeout handling and alarm reconciliation. The independent recovery schedule confirms that an execution timeout revokes its ticket **before** a separate browser lookup for failure classification is allowed to finish. A late installer return does not lead to a start call. The source places `endAttempt(...retainLease: false)` at the start of the catch path.

The final alarm now calls reconciliation, which also requests fresh observations. Independent cases confirm both an initially failed enumeration with an already-absent saved tab and a tab removed during pause: the next automatic alarm after resumption closes the stale record exactly once. These are controlled alarm events; their scheduling latency in installed Chrome is not measured here.

## Final exercised results

| Area | Result | What this establishes |
|---|---|---|
| Renderer | 3 direct scenarios PASS | A sole held history editor retains visible ancestry; input/focus/caret/composition survive oscillating placement; other rows move; delayed saves preserve later A input and B editing; save failure/blank save behave consistently |
| Renderer sensitivity | 1 PASS | The historical baseline fails the sole-history case specifically because its ancestor becomes hidden |
| Worker | 18 direct scenarios PASS | Query/readiness separation; deadline/late-list handling; sync/rejected query faults; physical reconciliation retries; new/replaced/redacted-tab protection; storage and invalid-data fail-closed behavior; alarm category; common-queue pause and durable receipt order; final focus route recheck |
| Worker sensitivity | 2 PASS | Historical query throw is exposed as the original storage misclassification; removal of between-record revocation fails on the later row closure |
| Content | 4 direct scenarios PASS | Production unconfirmed paths do not read/send generation or metadata; old-route registration is rejected; uninterrupted worker permission renewal retains one valid terminal; unsampled pause produces zero terminals |
| Recovery | 1 direct scenario PASS | Ticket is invalid before slow failure classification and late installer completion cannot continue to start |

These are 29 named reviewer scenarios, including three sensitivity checks. Several scenarios contain multiple assertions. This is not a claim that all A/B/C/U cases in the recovery plan have been executed.

Final primary-source SHA-256:

| Source | SHA-256 |
|---|---|
| `overlay/src/mori-browser-renderer.js` | `b8d4ca0d91ae62b5c97bf9c86bf47966c4f3106c7b5590d995fb821c1fc37694` |
| `overlay/extensions/browser-bridge/service-worker.js` | `187b45a8e2b1988984913e854bfb76b9afca39c6d3e59dd948f2afce7f38a04d` |
| `overlay/extensions/browser-bridge/content-script.js` | `bbca446fa121a577e1fd00e6b0e66fed9eeb7d4a08b7923526a64c99996620c1` |
| `overlay/extensions/browser-bridge/observer-recovery.js` | `bd81dac7cd27afc1758c88b88b4ea0c063b82d08bde6ea6501a3d100808981bc` |

## What remains outside this approval

- Real provider attribution and positive B8 behavior are unimplemented/unverified. The controlled confirmed binding in the harness is not a substitute.
- Real Chrome extension reload/update, actual service-worker suspension, isolated-world lifetime, real timeout ordering, and the full deadline matrix are not established by these API doubles.
- Real Electron/Chrome end-to-end HMAC, persistence, HUD, notification and captured-receipt focus acknowledgement are not tested by this review. Other contributors' runs must retain their own scope and evidence.
- Native Windows/macOS input method composition, candidate selection/cancellation, focus, and OS key protection are NOT-RUN here. Synthetic `compositionstart`/`compositionend` proves only state handling.
- Windows first BAT setup without Node, next-day startup, update rollback, background provider work, two-hour/three-resume acceptance, macOS, real installers/signatures/distribution, and a working-day trial are NOT-RUN here.
- Recovery within 45 seconds and normal updates within five seconds are not measured here. A permanently unknown/unconfirmed product cannot be counted as useful automatic recovery merely because it avoids unsafe observations.

The inspected source changes may advance to the next applicable integration stage. This record does not authorize treating the candidate as ready for Windows limited use, employee distribution, or completion of the user's full business workflow.
