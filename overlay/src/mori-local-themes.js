"use strict";

// The source preview ships the original Mori theme and does not follow the
// upstream theme catalogue or download its separately licensed artwork.
module.exports = function createLocalThemes() {
  const disabled = () => ({ status: "error", code: "MORI_THEME_DOWNLOAD_DISABLED",
    message: "Mori Desk 開発版では、同梱の Mori テーマを使用してください。" });
  const catalog = () => ({ status: "disabled", catalogVersion: null, checkedAt: null });
  return {
    ensureCatalogReady: async () => "disabled",
    getCatalogStatus: catalog,
    listOfficialThemes: async () => ({ status: "ok", catalogStatus: "disabled",
      catalogVersion: null, checkedAt: null, themes: [] }),
    decorateThemeMetadata: metadata => metadata,
    installTheme: async () => disabled(),
    cancelInstall: () => ({ status: "ok" }),
    getOperationState: () => null,
    commitStagedInstall: disabled,
    uninstall: disabled,
    cleanupOrphans: () => [],
    refreshInstalledScan: () => new Map(),
    isManagedTheme: () => false,
    refreshCatalog: async () => "disabled",
  };
};
