# Independent recovery source review evidence

This directory contains the reviewer's own acceptance invariants, runnable adversarial schedules, final results, and two retained failing results from before corrections. No implementation test or other acceptance-agent fixture was read or reused. Expected outcomes come from the recovery plan and the independently recorded invariants.

Use Node 24.18+ within the 24.x line. The recorded runs used Node 24.19.0 on Linux. These are source and synthetic API/DOM exercises. They are not installed Chrome, Electron, native Windows/macOS IME, or real provider acceptance.

## Reproduce

Each script accepts the product repository directory as its first argument. The renderer and worker scripts additionally require a baseline snapshot directory as their second argument. `MORI_REVIEW_REPO` and `MORI_REVIEW_BASELINE` are equivalent environment variables. Paths are runtime inputs; no machine-specific repository path is embedded in the portable scripts.

The recorded baseline is commit `3b1d39d178896d07ae36941518049f0bbef22c85`. Prepare a separate, read-only snapshot of that commit containing at least the original renderer and service worker. A normal `git archive` extraction into a dedicated temporary directory is sufficient; do not alter the working product tree.

```bash
MORI_REVIEW_OUTPUT=/tmp/mori-review-run node docs/review-evidence/renderer-adversary.cjs /path/to/mori-desk /path/to/baseline-snapshot
MORI_REVIEW_OUTPUT=/tmp/mori-review-run node docs/review-evidence/worker-a-adversary.cjs /path/to/mori-desk /path/to/baseline-snapshot
MORI_REVIEW_OUTPUT=/tmp/mori-review-run node docs/review-evidence/content-adversary.cjs /path/to/mori-desk
MORI_REVIEW_OUTPUT=/tmp/mori-review-run node docs/review-evidence/recovery-adversary.cjs /path/to/mori-desk
```

Outputs default to the OS temporary directory under `mori-independent-source-review`. The scripts create only their own output directory/files and never write to the supplied product or baseline directories. The worker script also writes the source it executed to its output directory so a later source change cannot obscure what was reviewed. No browser profile, real conversation, credential, network connection, or provider page is used. Fake credentials and labels are fixed synthetic test data.

## Files and limits

| File | Purpose |
|---|---|
| `invariants.md` | Original acceptance record, fixed before changed source/test review; preserved byte-for-byte with its original environment locations |
| `b-invariants.md` | Explicit B event schedules, fixed before changed content/installer review |
| `renderer-adversary.cjs` | Own DOM/event model: physical ancestry, editor/focus/composition state, cross-row asynchronous saves |
| `worker-a-adversary.cjs` | Actual worker/coordinator/outbox with own Chrome/persistence/network boundary doubles: A, control ordering, focus race |
| `content-adversary.cjs` | Actual content/controller/coordinator; production-unconfirmed negative path and explicitly synthetic confirmed protocol paths |
| `recovery-adversary.cjs` | Actual recovery module with independently delayed installation and failure classification |
| `*-results.json` | Named scenario results and exact reviewed primary-source SHA-256 |
| `content-before-fix-results.json` | Forbidden terminal across an unsampled pause: preserved FAIL |
| `worker-before-focus-fix-results.json` | Stale final focus reply after route change: preserved FAIL |
| `independent-review.md` | Findings, resolution evidence, judgment, remaining gates |
| `source-manifest.json` | Product dependency hashes and evidence recording metadata |

The portable variants change path/output configuration only. Their case inputs and assertions match the original reviewer harnesses. All four portable variants were actually executed successfully after conversion. The archived result files remain the original named-case evidence; the portable executions produced the same scenario results and primary-source hashes.

The content harness supplies a confirmed binding only inside its own VM to reach protocol paths that production deliberately does not yet enable. This is not a real provider verifier or evidence for B8. The renderer models event/DOM semantics and deliberately treats a focused subtree reparent as a focus loss; it cannot model a native IME candidate window.

Sensitivity checks use the historical baseline and a source-string mutation confined to the worker's VM. No fault is written into product files. The mutation removes only the per-record revocation gate and must fail specifically because a later row is closed after pause.
