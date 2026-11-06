"use strict";
const $ = id => document.getElementById(id);
const dateText = value => new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
function show(data) {
  if (!data?.ok) { $("saved-state").textContent = "保存状態を読み取れません。"; return; }
  $("project-id").value = data.projectId || "";
  $("billing").value = data.billing || "unknown";
  $("gmail-quota").checked = !!data.gmailQuotaChecked;
  $("calendar-quota").checked = !!data.calendarQuotaChecked;
  $("saved-state").textContent = data.checkedAt
    ? `本人申告として ${dateText(data.checkedAt)} に保存しました。` : "未確認です。";
}
$("save-state").addEventListener("click", async () => {
  const projectId = $("project-id").value.trim();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    $("saved-state").textContent = "6～30文字の Google Cloud プロジェクト ID を入力してください。";
    return;
  }
  $("save-state").disabled = true;
  try {
    const result = await window.moriGoogleSetup.save({ projectId, billing: $("billing").value,
      gmailQuotaChecked: $("gmail-quota").checked,
      calendarQuotaChecked: $("calendar-quota").checked });
    if (result?.ok) show(result);
    else $("saved-state").textContent = "確認内容を保存できませんでした。";
  } catch { $("saved-state").textContent = "確認内容を保存できませんでした。"; }
  finally { $("save-state").disabled = false; }
});
window.moriGoogleSetup.state().then(show).catch(() => { $("saved-state").textContent = "保存状態を読み取れません。"; });
