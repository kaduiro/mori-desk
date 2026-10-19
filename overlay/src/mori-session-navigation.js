"use strict";

// Session entry points have a product-mode owner. Browser observations never
// enter the CLI Dashboard reducer or its numeric quick-mode window.
function createMoriSessionNavigation({
  cliEnabled = false,
  openBrowser,
  openCliDashboard,
  openCliQuickSelect,
} = {}) {
  for (const [name, value] of Object.entries({ openBrowser, openCliDashboard, openCliQuickSelect })) {
    if (typeof value !== "function") {
      throw new TypeError(`createMoriSessionNavigation requires ${name}`);
    }
  }

  return {
    showDashboard(options) {
      return cliEnabled ? openCliDashboard(options) : openBrowser();
    },
    showQuickSelect() {
      // The registered action still follows shortcut-actions.js platform gates.
      // Browser mode opens the ordinary browser list; it does not claim 1–9
      // numeric selection or instantiate an empty CLI Dashboard.
      return cliEnabled ? openCliQuickSelect() : openBrowser();
    },
  };
}

module.exports = createMoriSessionNavigation;
