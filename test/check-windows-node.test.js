"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../scripts/check-windows-node.js"), "utf8");

// Exercise the standalone checker with installations that cannot all be on
// PATH at once. The Windows integration suite separately invokes real BATs.
function check(version, { npm = "file", execPath = path.resolve("Node & tools!", "node.exe") } = {}) {
  const inspected = [];
  let exitCode = 0;
  const stop = {};
  try {
    vm.runInNewContext(source, {
      process: {
        versions: { node: version }, execPath,
        exit(code) { exitCode = code; throw stop; },
      },
      require(name) {
        if (name === "path") return path;
        if (name === "fs") return {
          statSync(file) {
            inspected.push(file);
            if (npm === "missing") throw new Error("ENOENT");
            if (npm === "denied") throw new Error("EACCES");
            return { isFile: () => npm === "file" };
          },
        };
        throw new Error(`Unexpected module: ${name}`);
      },
    }, { timeout: 1000 });
  } catch (error) {
    if (error !== stop) throw error;
  }
  return { exitCode, inspected };
}

test("accepts the supported lower boundary and the pinned portable release", () => {
  for (const version of ["24.18.0", "24.18.1", "24.22.0"]) {
    assert.equal(check(version).exitCode, 0, version);
  }
});

test("rejects older, other-major, and prerelease Node installations", () => {
  for (const version of ["0.12.18", "22.20.0", "24.17.9", "25.0.0", "26.12.0", "24.22.0-rc.1"]) {
    const result = check(version);
    assert.equal(result.exitCode, 1, version);
    assert.deepEqual(result.inspected, [], "unsupported Node should not reach npm selection");
  }
});

test("requires the selected installation's adjacent npm entry", () => {
  const execPath = path.resolve("Node & tools! % literal", "node.exe");
  const result = check("24.22.0", { execPath });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.inspected, [path.join(path.dirname(execPath), "node_modules/npm/bin/npm-cli.js")]);
});

test("rejects missing, inaccessible, or directory npm entries", () => {
  for (const npm of ["missing", "denied", "directory"]) {
    assert.equal(check("24.22.0", { npm }).exitCode, 1, npm);
  }
});
