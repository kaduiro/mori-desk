"use strict";

// Electron launchItems only enumerates matching executables. Read the fixed
// Mori Run value so an installed app can identify a previous Mori source
// registration without treating every same-name value as its own.
const RUN_KEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const NAME = "com.kaduiro.moridesk";
const HKEY_CURRENT_USER = -2147483647;
const HKEY_LOCAL_MACHINE = -2147483646;
function createRegistrationNameProbe({ platform = process.platform, loadKoffi = () => require("koffi") } = {}) {
  let query;
  return function probe() {
    if (platform !== "win32") return { user: null, machine: null };
    try {
      if (!query) {
        const lib = loadKoffi().load("advapi32.dll");
        // intptr_t preserves the sign-extended predefined HKEY on x86/x64.
        // Read REG_SZ only; no registry writer or handle is imported.
        query = lib.func("int32_t __stdcall RegGetValueW(intptr_t hkey, const char16_t *subkey, const char16_t *name, uint32_t flags, _Out_ uint32_t *type, void *data, _Inout_ uint32_t *size)");
      }
      const read = (hkey, includeData) => {
        const size = [0], type = [0];
        const code = query(hkey, RUN_KEY, NAME, 0x00000002, type, null, size);
        if (code === 2) return { present: false, command: null };
        if (code !== 0 || type[0] !== 1) return { present: null, command: null };
        if (!includeData) return { present: true, command: null };
        if (!Number.isInteger(size[0]) || size[0] < 2 || size[0] > 8192 || size[0] % 2) return { present: null, command: null };
        const data = Buffer.alloc(size[0]);
        const actual = [data.length];
        if (query(hkey, RUN_KEY, NAME, 0x00000002, type, data, actual) !== 0
          || type[0] !== 1 || actual[0] < 2 || actual[0] > data.length || actual[0] % 2)
          return { present: null, command: null };
        const command = data.toString("utf16le", 0, actual[0]);
        if (!command.endsWith("\0") || command.slice(0, -1).includes("\0")) return { present: null, command: null };
        return { present: true, command: command.slice(0, -1) };
      };
      const user = read(HKEY_CURRENT_USER, true);
      const machine = read(HKEY_LOCAL_MACHINE, false);
      return { user: user.present, machine: machine.present, userCommand: user.command };
    } catch { return { user: null, machine: null, userCommand: null }; }
  };
}
module.exports = { createRegistrationNameProbe };
