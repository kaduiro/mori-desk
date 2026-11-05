"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = path.join(__dirname, "..", "src");

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.style = {};
    this.listeners = {};
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.ownText = "";
  }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  setAttribute() {}
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(""); }
  set innerHTML(value) { this.textContent = value; }
}

function loadAbout(lang) {
  const externalUrls = [];
  let aboutRequests = 0;
  const context = {
    console,
    navigator: { platform: "Win32" },
    localStorage: { getItem: () => null, setItem() {} },
    document: {
      createElement: tag => new Element(tag),
      createTextNode: value => ({ textContent: value }),
      getElementById: () => null,
      body: { contains: () => true },
    },
    ClawdSettingsSizeSlider: { createSizeSliderController: () => ({}) },
    settingsAPI: {
      moriCliEnabled: false,
      getAboutInfo: async () => {
        aboutRequests++;
        return {
          version: "0.1.3-preview.1",
          repoUrl: "https://github.com/kaduiro/mori-desk",
          upstreamRepoUrl: "https://github.com/rullerzhou-afk/clawd-on-desk",
          authorName: "kaduiro",
          authorUrl: "https://github.com/kaduiro",
          license: "AGPL-3.0-only",
          licenseUrl: "https://github.com/kaduiro/mori-desk/blob/main/LICENSE",
          copyright: "© 2026 Ruller_Lulu; Mori Desk modifications © 2026 kaduiro",
          legalNotice: "Provided without warranty.",
          autoUpdateSupported: false,
        };
      },
      openExternal: async url => { externalUrls.push(url); return { status: "ok" }; },
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ["settings-i18n.js", "settings-ui-core.js", "settings-tab-about.js"]) {
    vm.runInContext(fs.readFileSync(path.join(SRC, file), "utf8"), context, { filename: file });
  }
  const core = context.ClawdSettingsCore;
  core.state.snapshot = { lang };
  context.ClawdSettingsTabAbout.init(core);
  return { core, externalUrls, aboutRequests: () => aboutRequests };
}

function descendants(element) {
  return [element, ...(element.children || []).flatMap(descendants)];
}

for (const lang of ["ja", "en"]) {
  test(`About renders identity, ownership and attribution through the real Settings core (${lang})`, async () => {
    const harness = loadAbout(lang);
    const panel = new Element("section");
    assert.doesNotThrow(() => harness.core.tabs.about.render(panel));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.aboutRequests(), 1);
    assert.match(panel.textContent, /v0\.1\.3-preview\.1/);
    assert.match(panel.textContent, /github\.com\/kaduiro\/mori-desk/);
    assert.match(panel.textContent, /github\.com\/rullerzhou-afk\/clawd-on-desk/);
    assert.match(panel.textContent, /AGPL-3\.0-only/);
    assert.match(panel.textContent, /Ruller_Lulu/);
    const nodes = descendants(panel);
    const strings = harness.core.i18n.STRINGS[lang];
    for (const key of ["aboutAuthorLabel", "aboutMaintainersLabel", "aboutContributorsLabel"]) {
      const row = nodes.find(node => node.className === "about-info-row"
        && node.children[0].textContent.startsWith(strings[key]));
      assert.ok(row, `Missing ${key}`);
      if (key !== "aboutContributorsLabel") assert.match(row.textContent, /kaduiro/);
    }
    const contributorList = nodes.find(node => node.className === "about-contributors-list");
    assert.equal(contributorList.textContent, "@kaduiro");
    for (const label of ["github.com/kaduiro/mori-desk", "kaduiro", "@kaduiro"]) {
      const link = nodes.find(node => node.tagName === "a" && node.textContent === label);
      assert.ok(link, `Missing link ${label}`);
      link.listeners.click({ preventDefault() {} });
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(harness.externalUrls, [
      "https://github.com/kaduiro/mori-desk", "https://github.com/kaduiro", "https://github.com/kaduiro",
    ]);
    // Repeat a visit to exercise the static About cache as well.
    const secondPanel = new Element("section");
    harness.core.tabs.about.render(secondPanel);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.aboutRequests(), 2);
    assert.match(secondPanel.textContent, /v0\.1\.3-preview\.1/);
    assert.match(secondPanel.textContent, /kaduiro/);
  });
}
