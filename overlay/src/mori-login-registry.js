"use strict";

// Electron launchItems only enumerates matching executables. Before writing a
// fixed Run value name, independently check whether that name exists, even if
// it belongs to a different checkout. Read only its presence, never its data.
// Win32 contract: RegGetValueW(NULL data/size), ERROR_FILE_NOT_FOUND = absence.
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
        // intptr_t preserves the sign-extended predefined HKEY on both x86
        // and x64. No handle is opened, and no registry writer is imported.
        query = lib.func("int32_t __stdcall RegGetValueW(intptr_t hkey, const char16_t *subkey, const char16_t *name, uint32_t flags, void *type, void *data, void *size)");
      }
      const presence = hkey => {
        const code = query(hkey, RUN_KEY, NAME, 0x1000ffff, null, null, null);
        return code === 0 ? true : code === 2 ? false : null;
      };
      return { user: presence(HKEY_CURRENT_USER), machine: presence(HKEY_LOCAL_MACHINE) };
    } catch { return { user: null, machine: null }; }
  };
}
module.exports = { createRegistrationNameProbe };
