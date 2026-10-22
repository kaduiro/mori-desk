/* SPDX-License-Identifier: AGPL-3.0-only */
// Only manifest installation uses an unticketed start. Recovery loads the
// installer definition separately and invokes start with its worker ticket.
void globalThis.MoriBrowserObserver.start({ attemptId: null });
