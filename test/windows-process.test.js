"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { runWithFiles } = require("../scripts/windows-process");
const root = path.resolve(__dirname, "..");
const temporaryFiles = () => fs.readdirSync(root).filter(name => name.startsWith(".mori-process-"));
const run = (source, extra = {}) => runWithFiles(process.execPath, ["-e", source], { root, env: process.env, ...extra });

test("Windows setup capture preserves binary stdout and stdin without named pipes", async () => {
  const before = temporaryFiles();
  const data = Buffer.from([0, 255, 13, 10, 128, 42]);
  assert.deepEqual(await run("process.stdin.pipe(process.stdout)", { input: data }), data);
  assert.deepEqual(temporaryFiles(), before);
});

test("Windows setup capture reports child failure and removes owned temporary files", async () => {
  const before = temporaryFiles();
  await assert.rejects(run("process.stderr.write('expected failure'); process.exitCode = 7"), /failed \(7\).*\nexpected failure/);
  await assert.rejects(runWithFiles(path.join(root, "missing-executable-for-test.exe"), [], { root }), /ENOENT/);
  assert.deepEqual(temporaryFiles(), before);
});

test("Windows setup capture rejects oversized output before reading it into memory", async () => {
  const before = temporaryFiles();
  await assert.rejects(run("process.stdout.write('too large')", { maxBytes: 4 }), /output exceeded/);
  await assert.rejects(run("process.stderr.write('too large')", { maxBytes: 4 }), /output exceeded/);
  assert.deepEqual(temporaryFiles(), before);
});
