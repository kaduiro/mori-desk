"use strict";

const path = require("node:path");
const { openJsonFile } = require("./browser-bridge-persistence");

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const BILLING = new Set(["unknown", "not-linked", "linked"]);
const SOURCE = "self-reported-cloud-console";
const WINDOWS = new Set(["minute", "day"]);

function validQuota(value) {
  return value === null || !!value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(",") === "limit,metric,used,window"
    && typeof value.metric === "string" && value.metric.length >= 1 && value.metric.length <= 100
    && !/[\x00-\x1f\x7f]/.test(value.metric)
    && Number.isSafeInteger(value.limit) && value.limit > 0 && value.limit <= 1000000000
    && Number.isSafeInteger(value.used) && value.used >= 0 && value.used <= 1000000000
    && WINDOWS.has(value.window);
}

function valid(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || (value.version === 1
      ? Object.keys(value).sort().join(",") !== "billing,calendarQuotaChecked,checkedAt,gmailQuotaChecked,projectId,source,version"
      : Object.keys(value).sort().join(",") !== "billing,calendarQuota,calendarQuotaChecked,checkedAt,gmailQuota,gmailQuotaChecked,projectId,source,version")
    || ![1, 2].includes(value.version) || !PROJECT_ID.test(value.projectId)
    || !BILLING.has(value.billing) || typeof value.gmailQuotaChecked !== "boolean"
    || typeof value.calendarQuotaChecked !== "boolean" || !Number.isSafeInteger(value.checkedAt)
    || value.checkedAt <= 0 || value.source !== SOURCE
    || value.version === 2 && (!validQuota(value.gmailQuota) || !validQuota(value.calendarQuota)))
    throw new Error("invalid-google-setup-state");
}

function createGoogleSetupStore(dataDir, now = Date.now) {
  const file = openJsonFile(path.join(dataDir, "status.json"), valid, { maxBytes: 1024 });
  function snapshot() {
    const value = file.value || { version: 1, projectId: "", billing: "unknown",
      gmailQuotaChecked: false, calendarQuotaChecked: false, checkedAt: null, source: "unconfirmed" };
    return { ...value, gmailQuota: value.gmailQuota || null, calendarQuota: value.calendarQuota || null };
  }
  function save(input) {
    const next = { version: 2, projectId: input?.projectId, billing: input?.billing,
      gmailQuotaChecked: input?.gmailQuotaChecked, calendarQuotaChecked: input?.calendarQuotaChecked,
      gmailQuota: input?.gmailQuota ?? null, calendarQuota: input?.calendarQuota ?? null,
      checkedAt: now(), source: SOURCE };
    valid(next);
    file.write(next);
    return snapshot();
  }
  return { snapshot, save };
}

module.exports = { createGoogleSetupStore, valid };
