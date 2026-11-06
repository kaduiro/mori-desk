"use strict";

const path = require("node:path");
const { openJsonFile } = require("./browser-bridge-persistence");

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const BILLING = new Set(["unknown", "not-linked", "linked"]);
const SOURCE = "self-reported-cloud-console";

function valid(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(",") !== "billing,calendarQuotaChecked,checkedAt,gmailQuotaChecked,projectId,source,version"
    || value.version !== 1 || !PROJECT_ID.test(value.projectId)
    || !BILLING.has(value.billing) || typeof value.gmailQuotaChecked !== "boolean"
    || typeof value.calendarQuotaChecked !== "boolean" || !Number.isSafeInteger(value.checkedAt)
    || value.checkedAt <= 0 || value.source !== SOURCE) throw new Error("invalid-google-setup-state");
}

function createGoogleSetupStore(dataDir, now = Date.now) {
  const file = openJsonFile(path.join(dataDir, "status.json"), valid, { maxBytes: 512 });
  function snapshot() {
    return file.value || { version: 1, projectId: "", billing: "unknown",
      gmailQuotaChecked: false, calendarQuotaChecked: false, checkedAt: null, source: "unconfirmed" };
  }
  function save(input) {
    const next = { version: 1, projectId: input?.projectId, billing: input?.billing,
      gmailQuotaChecked: input?.gmailQuotaChecked, calendarQuotaChecked: input?.calendarQuotaChecked,
      checkedAt: now(), source: SOURCE };
    valid(next);
    file.write(next);
    return snapshot();
  }
  return { snapshot, save };
}

module.exports = { createGoogleSetupStore, valid };
