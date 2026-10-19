#!/usr/bin/env node
"use strict";

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Mori Desk contributors
// Original geometry for the Mori sprout mascot. No upstream artwork is read.
// This file is the editable source for SVG sprites and PNG/ICO application art.
// Uses only Node built-ins so Windows setup needs no image editor or Python.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const P = Object.freeze({
  ink: "#294e3c", leaf: "#77be80", light: "#afe0a0", moss: "#55956d",
  cream: "#fbf3d8", cheek: "#e6ad82", gold: "#edba55", white: "#fffdf4",
  shadow: "#34563e", clear: "#00000000",
});

function drawing(state = "idle") {
  const out = [];
  const rect = (x, y, w, h, color, layer = "body", css = "") =>
    out.push({ x, y, w, h, color: P[color] || color, layer, css });
  rect(8, 30, 16, 1, "shadow", "shadow");
  // A small seed-shaped forest creature with a two-leaf crown.
  rect(14, 7, 3, 6, "ink", "leaf");
  rect(15, 7, 1, 5, "moss", "leaf");
  rect(8, 4, 6, 3, "ink", "leaf");
  rect(10, 7, 5, 2, "ink", "leaf");
  rect(9, 5, 5, 2, "leaf", "leaf");
  rect(11, 7, 3, 1, "light", "leaf");
  rect(18, 2, 6, 3, "ink", "leaf");
  rect(17, 5, 6, 3, "ink", "leaf");
  rect(19, 3, 4, 2, "light", "leaf");
  rect(18, 5, 4, 2, "leaf", "leaf");
  rect(10, 10, 12, 2, "ink");
  rect(7, 12, 18, 3, "ink");
  rect(6, 15, 20, 9, "ink");
  rect(7, 24, 18, 3, "ink");
  rect(10, 27, 12, 2, "ink");
  rect(8, 13, 16, 12, "moss");
  rect(11, 11, 10, 2, "leaf");
  rect(8, 14, 16, 2, "leaf");
  rect(9, 25, 14, 2, "moss");
  rect(10, 16, 12, 1, "cream");
  rect(9, 17, 14, 7, "cream");
  rect(11, 24, 10, 1, "cream");
  rect(4, 19, 2, 6, "ink");
  rect(26, 19, 2, 6, "ink");
  rect(5, 20, 1, 4, "leaf");
  rect(26, 20, 1, 4, "leaf");
  rect(8, 28, 5, 2, "ink");
  rect(19, 28, 5, 2, "ink");
  rect(9, 28, 3, 1, "moss");
  rect(20, 28, 3, 1, "moss");

  if (state === "sleeping") {
    rect(11, 20, 3, 1, "ink"); rect(18, 20, 3, 1, "ink");
    rect(15, 23, 2, 1, "ink");
    rect(26, 8, 4, 1, "moss", "status", "float");
    rect(28, 9, 1, 1, "moss", "status", "float");
    rect(27, 10, 1, 1, "moss", "status", "float");
    rect(26, 11, 4, 1, "moss", "status", "float");
  } else if (state === "attention" || state === "waking") {
    rect(11, 19, 3, 1, "ink"); rect(11, 20, 1, 1, "ink"); rect(13, 20, 1, 1, "ink");
    rect(18, 19, 3, 1, "ink"); rect(18, 20, 1, 1, "ink"); rect(20, 20, 1, 1, "ink");
    rect(14, 22, 4, 1, "ink"); rect(15, 23, 2, 1, "ink");
  } else {
    const eyeY = state === "thinking" ? 18 : 19;
    rect(11, eyeY, 2, 3, "ink", "body", "eye");
    rect(19, eyeY, 2, 3, "ink", "body", "eye");
    rect(15, 23, 2, 1, "ink");
  }
  rect(9, 22, 2, 1, "cheek"); rect(21, 22, 2, 1, "cheek");

  if (state === "working" || state === "juggling") {
    rect(8, 25, 16, 3, "ink", "status");
    rect(9, 26, 14, 1, "cream", "status");
    rect(10, 26, 3, 1, "leaf", "status", "step1");
    rect(14, 26, 3, 1, "leaf", "status", "step2");
    rect(18, 26, 4, 1, "leaf", "status", "step3");
  }
  if (state === "thinking" || state === "juggling") {
    for (let i = 0; i < 3; i++) rect(3 + i * 3, 8 - i, 2, 2, "gold", "status", `step${i + 1}`);
  }
  if (state === "attention") {
    rect(24, 6, 7, 7, "ink", "status", "float");
    rect(25, 7, 5, 5, "light", "status", "float");
    rect(25, 9, 1, 1, "ink", "status", "float");
    rect(26, 10, 1, 1, "ink", "status", "float");
    rect(27, 9, 1, 1, "ink", "status", "float");
    rect(28, 8, 1, 1, "ink", "status", "float");
  }
  if (state === "notification" || state === "error") {
    rect(24, 5, 7, 9, "ink", "status");
    rect(25, 6, 5, 7, "gold", "status");
    rect(27, 7, 1, 3, "ink", "status");
    rect(27, 11, 1, 1, "ink", "status");
  }
  return out;
}

function svg(state) {
  const rects = drawing(state);
  const group = (layer, cls = "") => `<g${cls ? ` class="${cls}"` : ""}>\n${rects
    .filter((r) => r.layer === layer)
    .map((r) => `  <rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${r.color}"${r.css ? ` class="${r.css}"` : ""}/>`)
    .join("\n")}\n</g>`;
  const speed = state === "working" || state === "juggling" ? "1.6s" : "4s";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Original Mori Desk artwork. MIT license. Source: scripts/generate-mori-assets.js -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="256" height="256" shape-rendering="crispEdges">
<title>Mori: ${state}</title>
<style>
  .shadow { opacity: .16; }
  .body { animation: breathe ${speed} steps(2, end) infinite; }
  .leaf { animation: breathe ${speed} steps(2, end) infinite; }
  .float { animation: float 2s steps(2, end) infinite; }
  .step1, .step2, .step3 { animation: progress 1.5s steps(2, end) infinite; }
  .step2 { animation-delay: .5s; }
  .step3 { animation-delay: 1s; }
  @keyframes breathe { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-1px); } }
  @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-1px); } }
  @keyframes progress { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
</style>
${group("shadow", "shadow")}
${group("body", "body")}
${group("leaf", "leaf")}
${group("status")}
</svg>
`;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data) {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([head, name, data, tail]);
}

function rgba(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(hex.length === 9 ? parseInt(hex.slice(7, 9), 16) : 255);
}

function png(size, state = "idle", template = false) {
  const pixels = Buffer.alloc(size * size * 4);
  for (const r of drawing(state)) {
    if (r.layer === "shadow") continue;
    let color = rgba(r.color);
    // A monochrome tray silhouette with transparent face and visible eyes.
    if (template) color = r.color === P.cream || r.color === P.cheek
      ? [0, 0, 0, 0] : [0, 0, 0, 255];
    const x1 = Math.floor(r.x * size / 32), y1 = Math.floor(r.y * size / 32);
    const x2 = Math.floor((r.x + r.w) * size / 32), y2 = Math.floor((r.y + r.h) * size / 32);
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) {
      const offset = (y * size + x) * 4;
      color.forEach((value, i) => { pixels[offset + i] = value; });
    }
  }
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function ico(sizes) {
  const images = sizes.map((n) => png(n));
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((n, i) => {
    const p = 6 + i * 16;
    header[p] = n === 256 ? 0 : n; header[p + 1] = header[p];
    header.writeUInt16LE(1, p + 4); header.writeUInt16LE(32, p + 6);
    header.writeUInt32LE(images[i].length, p + 8); header.writeUInt32LE(offset, p + 12);
    offset += images[i].length;
  });
  return Buffer.concat([header, ...images]);
}

function generatedAssets() {
  const files = new Map();
  for (const state of ["idle", "thinking", "working", "juggling", "attention", "notification", "error", "sleeping", "waking"])
    files.set(`assets/svg/mori-${state}.svg`, Buffer.from(svg(state)));
  files.set("assets/svg/mori-about-hero.svg", Buffer.from(svg("idle")));
  files.set("assets/source/mori-mark.svg", Buffer.from(svg("idle")));
  files.set("assets/icon.png", png(1024));
  files.set("assets/dock-icon.png", png(1024));
  files.set("assets/icon.ico", ico([16, 24, 32, 48, 64, 128, 256]));
  files.set("assets/tray-iconTemplate.png", png(18, "idle", true));
  files.set("assets/tray-iconTemplate@2x.png", png(36, "idle", true));
  files.set("assets/tray-icon-flash.png", png(32, "attention"));
  files.set("assets/tray-icon-flashTemplate.png", png(18, "attention", true));
  files.set("assets/tray-icon-flashTemplate@2x.png", png(36, "attention", true));
  for (const size of [16, 32, 48, 64, 128, 256, 512, 1024])
    files.set(`assets/icons/${size}x${size}.png`, png(size));
  return files;
}

function main() {
  const check = process.argv.includes("--check");
  const files = generatedAssets();
  const manifest = {
    schemaVersion: 1,
    source: "scripts/generate-mori-assets.js",
    license: "MIT",
    description: "Original Mori Desk artwork; no upstream artwork is included.",
    files: [...files].map(([name, data]) => ({ path: name, bytes: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") })),
  };
  files.set("assets/mori-manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
  let failures = 0;
  for (const [name, data] of files) {
    const file = path.join(ROOT, name);
    if (check) {
      let actual;
      try { actual = fs.readFileSync(file); } catch { actual = null; }
      if (!actual || !data.equals(actual)) { console.error(`Mori asset is missing or differs from its source: ${name}`); failures++; }
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
    }
  }
  if (failures) { process.exitCode = 1; return; }
  console.log(`Mori Desk: ${check ? "verified" : "generated"} ${files.size} original asset files.`);
}

if (require.main === module) main();
module.exports = { generatedAssets, png, ico, svg };
