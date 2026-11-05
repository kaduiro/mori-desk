"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const hud = require("../src/mori-hud-layout");

test("Calendar and Mail offer a selectable free size and a visible drag target", () => {
  for (const page of ["mori-calendar.html", "mori-mail.html"]) {
    const html = fs.readFileSync(path.join(__dirname, "../src", page), "utf8");
    assert.match(html, /<option value="custom">自由<\/option>/);
    assert.match(html, /id="resize-grip"[^>]*aria-label="ドラッグして窓サイズを自由に変更"/);
  }
});

test("legacy HUD layout migrates without losing the user's saved position", () => {
  const old = { version: 1, x: 251, y: 180 };
  hud.valid(old);
  assert.deepEqual(hud.read(old), { version: 2, x: 251, y: 180,
    width: 400, height: 480, manual: true, zoom: 1.25, pinned: true, autoOpen: true });
  assert.equal(hud.read({ ...hud.read(old), autoOpen: false }).autoOpen, false);
  assert.throws(() => hud.valid({ ...hud.read(old), autoOpen: "false" }));
  assert.throws(() => hud.valid({ ...hud.read(old), zoom: 9 }));
  assert.throws(() => hud.valid({ ...hud.read(old), width: 20000 }));
  assert.throws(() => hud.valid({ ...hud.read(old), sizeMode: "unknown" }));
  assert.throws(() => hud.valid({ ...hud.read(old), freeWidth: 500 }));
  const free = { ...hud.read(old), sizeMode: "custom", freeWidth: 455, freeHeight: 530 };
  hud.valid(free);
  assert.equal(hud.sizeMode(free), "custom");
});

test("Calendar and Mail placement avoids an open HUD when the display has room", () => {
  const area = { x: 0, y: 0, width: 1440, height: 900 };
  const pet = { x: 500, y: 100, width: 80, height: 80 };
  const calendar = hud.automatic(pet, area, hud.DEFAULT);
  const mail = hud.automatic(pet, area, hud.DEFAULT, calendar);
  assert.deepEqual(calendar, { x: 590, y: 100, width: 400, height: 480 });
  assert.deepEqual(mail, { x: 90, y: 100, width: 400, height: 480 });
});

test("restored HUD position and size stay within the current work area", () => {
  const result = hud.clamp({ x: 1500, y: 800, width: 800, height: 700 },
    { x: 0, y: 0, width: 1280, height: 800 });
  assert.deepEqual(result, { x: 480, y: 100, width: 800, height: 700 });
});

test("visible resize grip keeps the top-left corner fixed and limits the drag to the display", () => {
  const start = { x: 700, y: 400, width: 400, height: 480 };
  const area = { x: 0, y: 0, width: 1280, height: 900 };
  assert.deepEqual(hud.gripBounds(start, { x: 900, y: 800 }, { x: 1000, y: 900 }, area),
    { x: 700, y: 400, width: 500, height: 500 });
  assert.deepEqual(hud.gripBounds(start, { x: 900, y: 800 }, { x: -2000, y: -2000 }, area),
    { x: 700, y: 400, width: 320, height: 300 });
});
