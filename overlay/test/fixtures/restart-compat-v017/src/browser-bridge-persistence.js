const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Both files remain in the app's own userData tree. Never touch ~/.clawd here.
function atomicWrite(file, text, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = fsImpl.openSync(temporary, "wx", 0o600);
    fsImpl.writeFileSync(descriptor, text, "utf8");
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    fsImpl.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
    try { fsImpl.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function openJsonFile(file, validate, { fs: fsImpl = fs, maxBytes = 5 * 1024 * 1024 } = {}) {
  let lastText = null;
  let recovery = null;
  let value = null;
  function read(candidate) {
    if (fsImpl.statSync(candidate).size > maxBytes) throw new Error("Browser store exceeds its byte limit");
    const text = fsImpl.readFileSync(candidate, "utf8");
    const parsed = JSON.parse(text);
    validate(parsed);
    return { parsed, text };
  }
  try {
    const loaded = read(file);
    value = loaded.parsed;
    lastText = loaded.text;
  } catch (error) {
    if (error.code === "ENOENT") {
      // A missing primary with an existing backup is a recovery, not a new install.
      try {
        const loaded = read(`${file}.bak`);
        value = loaded.parsed; lastText = loaded.text; recovery = "recovered_backup";
      } catch (backupError) { if (backupError.code !== "ENOENT") throw backupError; }
    } else {
      try {
        const loaded = read(`${file}.bak`);
        value = loaded.parsed; lastText = loaded.text; recovery = "recovered_backup";
      } catch { throw new Error(`Browser store is unreadable: ${path.basename(file)}`, { cause: error }); }
    }
  }
  return {
    value, recovery,
    write(next) {
      validate(next);
      const nextText = JSON.stringify(next);
      if (Buffer.byteLength(nextText) > maxBytes) throw new Error("Browser store exceeds its byte limit");
      // Never copy unvalidated/corrupt primary bytes over the known-good backup.
      if (lastText !== null) atomicWrite(`${file}.bak`, lastText, fsImpl);
      atomicWrite(file, nextText, fsImpl);
      lastText = nextText;
      this.value = next;
    },
  };
}

module.exports = { atomicWrite, openJsonFile };
