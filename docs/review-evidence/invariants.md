# Independent acceptance invariants — fixed before implementation review

Scope: recovery changes A and C, followed by B when available. Source baseline: `/tmp/mori-recovery-baseline-3b1d39d`. Product repository: `/workspace/scratch/71b181da6eca/mori-desk`.

Evidence read before this record: root `AGENTS.md`, upstream `.runtime/AGENTS.md`, and `docs/recovery-fix-test-plan-ja.md`. No implementation tests, changed product source, implementation fixture, or implementation-derived expected outcomes were read before fixing this record.

## Renderer: independently falsifiable outcomes

1. **Visible editing ancestry.** Start with a single history row, focus its name field, enter unfinished Japanese composition, then deliver a snapshot making the same physical row current. Every ancestor of the existing field must remain rendered, with the same field node, focus, composition text, and caret. One row only. A logical history count of zero cannot hide its still-occupied ancestor.
2. **Focused editing without composition.** Repeat the history/current transitions while plain text editing is focused. No refresh may blur, replace, or detach the active input; nonedited rows still move to their intended group.
3. **Final placement.** Deliver history→current→history→current while one edit is active. After composition ends and the user actually finishes editing, the same row must end in the latest intended group once, with empty groups hidden only after physical placement. Temporary visibility/counts must help the user find the row.
4. **IME boundaries.** Composition-confirming Enter must not call save. Cancelling an IME candidate does not mean cancelling the whole name edit. A subsequent deliberate save must target that row. Real Windows/macOS IME behavior remains a separate unexecuted gate even when synthetic events pass.
5. **Async revision protection.** Begin saving row A text X; before resolution, type Y, refresh/reconnect, then resolve the old save. Y, its input node and selection survive. A failed old save also cannot undo later input or strand the control unusably.
6. **Cross-row save identity.** Begin saving A, then remove/change/reorder A or edit B before A's promise resolves. Both the invocation target and result handling remain attached to captured A identity; no label, input value, edit state, or focus belonging to B may change because A's save resolved.
7. **Existing naming boundaries.** A blank deliberate save restores automatic naming. Intended sharing among same-conversation tabs must not cross provider/profile/conversation boundaries, and active input must survive externally updated saved names.

## Initialization, enumeration, persistence, and controls

8. **Initialization independence.** With healthy persistence and a tab enumeration that never settles, required initialization completes, normal control requests remain usable, and no storage error/credential deletion occurs. Sync throw, rejection, and late resolve are equivalent deferred-observation failures; no uncaught rejection.
9. **Fatal persistence is retained.** Fail local read/write, session read/write, credential validation, or reconciliation persistence. No success/ACK is emitted for an uncommitted receipt, and classification reflects the actual failing boundary. A query catch cannot swallow a persistence error.
10. **No absence inferred from incomplete evidence.** Rejected/expired/permission-filtered enumeration is not an empty set of open tabs. Existing row identity, unread receipt set, and destination survive unless current same-record evidence establishes removal or a route change.
11. **Snapshot age protection.** Start enumeration with A; then save new B or replace A with a different document/record generation; return the original A-only or empty snapshot. Newly recorded/replaced rows cannot be closed by that older snapshot. Matching only a reused numeric tab ID is insufficient.
12. **Revocation ordering.** Hold enumeration/probe/injection and an observation at each async boundary; pause or unpair. Already-started durable commits settle before control success; work not admitted before revocation cannot write afterward or recreate credentials/session/outbox. Late external API completion does not cancel this requirement.
13. **No dependency cycle.** Initialization, observer registration, onReady, and install/start hooks may overlap. No path waits for a registration that itself needs an initialization or mutation queue held by that path. Duplicate triggers cannot create duplicate active observation streams or receipt delivery.
14. **Fault-category honesty.** Unknown implementation errors and scheduling failure use fixed non-secret categories distinct from storage failure and from success. Enumeration recovery and real persistence failures remain separately observable.

## Evidence and judgments

- Own adversarial event sequences and direct source-boundary reasoning are permitted; implementation tests are not the oracle.
- Successful source review or synthetic exercises do not establish live provider DOM attribution, automatic recovery usefulness, real Chrome/Electron integration, Windows BAT/setup/update, native Japanese IME, macOS, signing, or distribution readiness.
- Pending/unknown external gates stay pending; permanently withholding all observations can pass a safety check while failing useful recovery.
