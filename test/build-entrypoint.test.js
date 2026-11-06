"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildScriptFor } = require("../scripts/run");

test("desktop build entrypoints select the requested OS and architecture without cross-building", () => {
  for (const command of ["build:win:x64", "build:win:arm64", "build:win:all"])
    assert.equal(buildScriptFor(command, "win32"), command);
  for (const command of ["build:mac:x64", "build:mac:arm64"])
    assert.equal(buildScriptFor(command, "darwin"), command);
  assert.throws(() => buildScriptFor("build:mac:arm64", "win32"), /must run on macOS/);
  assert.throws(() => buildScriptFor("build:win:x64", "darwin"), /must run on Windows/);
  assert.throws(() => buildScriptFor("build:all", "win32"), /Unknown Mori command/);
});
