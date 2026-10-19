"use strict";

// Keep this check small and compatible with older Node versions that may be on
// PATH. A nonzero exit tells the BAT launcher to try another installation.
var fs = require("fs");
var path = require("path");
var version = /^24\.(\d+)\.(\d+)$/.exec(process.versions.node);
if (!version || Number(version[1]) < 18) process.exit(1);

try {
  var npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!fs.statSync(npmCli).isFile()) process.exit(1);
} catch (_) {
  process.exit(1);
}
