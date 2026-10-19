"use strict";

// The preview has no unattended updater and never fetches upstream releases.
module.exports = function createManualUpdater(ctx = {}) {
  const snapshot = () => ({ state: "idle", autoUpdateSupported: false });
  const noop = () => {};
  return {
    setupAutoUpdater: noop,
    checkForUpdates: async () => {
      const value = snapshot();
      if (ctx.onUpdateCheckStatusChanged) ctx.onUpdateCheckStatusChanged(value);
      return value;
    },
    getUpdateCheckSnapshot: snapshot,
    clearUpdateError: snapshot,
    getUpdateMenuItem: () => null,
    getUpdateMenuLabel: () => "Mori Desk · 手動更新",
    quietDiscover: async () => ({ status: "disabled" }),
    handlePendingVersion: noop,
    reconcilePendingOnStartup: noop,
    onSilentModeExit: noop,
    getPendingUpdateVersion: () => null,
    startUpdateScheduler: noop,
    stopUpdateScheduler: noop,
    isSchedulerRunning: () => false,
  };
};
