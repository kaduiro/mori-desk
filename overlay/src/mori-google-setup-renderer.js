"use strict";
const $ = id => document.getElementById(id);
const dateText = value => new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
function show(data) {
  if (!data?.ok) { $("saved-state").textContent = "保存状態を読み取れません。"; return; }
  $("project-id").value = data.projectId || "";
  $("billing").value = data.billing || "unknown";
  $("gmail-quota").checked = !!data.gmailQuotaChecked;
  $("calendar-quota").checked = !!data.calendarQuotaChecked;
  for (const name of ["gmail", "calendar"]) {
    const quota = data[name + "Quota"];
    $(name + "-metric").value = quota?.metric || "";
    $(name + "-used").value = quota?.used ?? "";
    $(name + "-limit").value = quota?.limit ?? "";
    $(name + "-window").value = quota?.window || "minute";
  }
  $("saved-state").textContent = data.checkedAt
    ? `本人申告として ${dateText(data.checkedAt)} に保存しました。` + ["gmail", "calendar"].map(name => {
      const quota = data[name + "Quota"];
      return quota ? ` ${name === "gmail" ? "Gmail" : "Calendar"}「${quota.metric}」: 使用 ${quota.used} / 上限 ${quota.limit}、残り目安 ${Math.max(0, quota.limit - quota.used)}（${quota.window === "minute" ? "1分" : "1日"}、転記時点）` : "";
    }).join("") : "未確認です。";
}
function quotaInput(name) {
  const used = $(name + "-used").value, limit = $(name + "-limit").value;
  if (!used && !limit) return null;
  if (!used || !limit) throw new Error("quota-pair-required");
  const metric = $(name + "-metric").value.trim();
  if (!metric) throw new Error("metric-required");
  return { metric, used: Number(used), limit: Number(limit), window: $(name + "-window").value };
}
$("save-state").addEventListener("click", async () => {
  const projectId = $("project-id").value.trim();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    $("saved-state").textContent = "6～30文字の Google Cloud プロジェクト ID を入力してください。";
    return;
  }
  $("save-state").disabled = true;
  try {
    const gmailQuota = quotaInput("gmail"), calendarQuota = quotaInput("calendar");
    const result = await window.moriGoogleSetup.save({ projectId, billing: $("billing").value,
      gmailQuotaChecked: $("gmail-quota").checked,
      calendarQuotaChecked: $("calendar-quota").checked, gmailQuota, calendarQuota });
    if (result?.ok) show(result);
    else $("saved-state").textContent = "確認内容を保存できませんでした。";
  } catch { $("saved-state").textContent = "使用量・上限・指標名を揃えて入力するか、使用量と上限を空欄にしてください。"; }
  finally { $("save-state").disabled = false; }
});
window.moriGoogleSetup.state().then(show).catch(() => { $("saved-state").textContent = "保存状態を読み取れません。"; });
window.moriGoogleSetup.prompt().then(result => {
  $("agent-prompt").value = result?.ok ? result.text : "指示文を読み込めません。";
  $("copy-agent-prompt").disabled = !result?.ok;
}).catch(() => { $("agent-prompt").value = "指示文を読み込めません。"; $("copy-agent-prompt").disabled = true; });
$("copy-agent-prompt").addEventListener("click", async () => {
  const button = $("copy-agent-prompt"); button.disabled = true;
  try { const result = await window.moriGoogleSetup.copyPrompt();
    $("copy-agent-status").textContent = result?.ok ? "指示文をコピーしました。Codex または Claude に貼り付けてください。" : "コピーできませんでした。下の文章を選択してコピーしてください。";
  } catch { $("copy-agent-status").textContent = "コピーできませんでした。下の文章を選択してコピーしてください。"; }
  finally { button.disabled = false; }
});
