"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

// Windows restricted tokens can deny Node's stdio named pipes while still
// allowing ordinary child processes and files in the workspace. Keep the
// caller's token, cwd and environment; use inherited file handles for stdio.
function runWithFiles(command, args, options) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(options.root, ".mori-process-"));
    const files = ["stdin", "stdout", "stderr"].map(name => path.join(dir, name));
    const descriptors = [];
    const capture = options.capture !== false;
    const limit = options.maxBytes || 8 * 1024 * 1024;
    let child, timer, settled = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      let output = Buffer.alloc(0);
      try {
        if (!error && capture) {
          if (fs.statSync(files[1]).size > limit) throw new Error(`${command} output exceeded the expected source limit.`);
          output = fs.readFileSync(files[1]);
        }
      } catch (failure) { error ||= failure; }
      for (const fd of descriptors) { try { fs.closeSync(fd); } catch (failure) { error ||= failure; } }
      // Delete only the exact files and directory created by this call.
      for (const file of files) {
        try { fs.unlinkSync(file); } catch (failure) { if (failure.code !== "ENOENT") error ||= failure; }
      }
      try { fs.rmdirSync(dir); } catch (failure) { error ||= failure; }
      if (error) reject(error); else resolve(output);
    }
    try {
      const stdio = ["ignore", "inherit", "inherit"];
      if (options.input) {
        fs.writeFileSync(files[0], options.input, { flag: "wx" });
        stdio[0] = fs.openSync(files[0], "r"); descriptors.push(stdio[0]);
      }
      if (capture) for (const index of [1, 2]) {
        stdio[index] = fs.openSync(files[index], "wx+"); descriptors.push(stdio[index]);
      }
      child = spawn(command, args, { cwd: options.cwd || options.root, env: options.env,
        shell: false, windowsHide: true, stdio });
      let limitError = null;
      if (capture) {
        timer = setInterval(() => {
          try {
            if (!limitError && (fs.statSync(files[1]).size > limit || fs.statSync(files[2]).size > limit)) {
              limitError = new Error(`${command} output exceeded the expected source limit.`);
              child.kill();
            }
          } catch (error) { limitError ||= error; child.kill(); }
        }, 50);
        timer.unref();
      }
      child.once("error", finish);
      child.once("close", (code, signal) => {
        if (settled) return;
        if (limitError) return finish(limitError);
        if (capture && (fs.statSync(files[1]).size > limit || fs.statSync(files[2]).size > limit)) {
          return finish(new Error(`${command} output exceeded the expected source limit.`));
        }
        if (code !== 0) {
          let detail = "";
          if (capture) {
            const data = Buffer.alloc(16 * 1024);
            detail = data.subarray(0, fs.readSync(stdio[2], data, 0, data.length, 0)).toString("utf8").trim();
          }
          return finish(new Error(`${path.basename(command)} failed (${signal || code}).${detail ? `\n${detail}` : ""}`));
        }
        finish();
      });
    } catch (error) { finish(error); }
  });
}

module.exports = { runWithFiles };
