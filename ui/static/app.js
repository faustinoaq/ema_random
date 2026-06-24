async function getJSON(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    openAuthModal();
    throw new Error("Unauthorized");
  }
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

const windowLinks = { 1: "", 2: "", 3: "", 4: "" };
const windowTimes = {
  1: { start: "08:00", end: "10:00" },
  2: { start: "10:30", end: "12:30" },
  3: { start: "13:00", end: "15:00" },
  4: { start: "15:30", end: "17:30" },
};
const additionalSurveyLinks = { end_of_day: "", dry_blood_spot: "" };
let activeWindow = null;
let activeAdditionalSurveyType = "";

function formatTime(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function computeStudyWindowsFromWake(wakeTime) {
  const [hours, minutes] = (wakeTime || "08:00").split(":").map(Number);
  const base = new Date();
  base.setHours(hours, minutes, 0, 0);
  const windows = [];
  for (let i = 0; i < 4; i += 1) {
    const start = new Date(base.getTime() + i * 150 * 60 * 1000);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
    windows.push({ start: formatTime(start), end: formatTime(end) });
  }
  return windows;
}

function refreshStudyWindowLabels(wakeTime = document.getElementById("studyWakeTime")?.value || "08:00") {
  const windows = computeStudyWindowsFromWake(wakeTime);
  for (let i = 1; i <= 4; i += 1) {
    windowTimes[i] = { start: windows[i - 1].start, end: windows[i - 1].end };
    const btn = document.querySelector(`#studyModal .window-badge[data-window="${i}"]`);
    if (btn) {
      btn.innerHTML = `<strong>Window ${i}:</strong> ${windowTimes[i].start} - ${windowTimes[i].end} <span class="window-status"></span>`;
    }
  }
}
let editingParticipant = null;
let editingParticipantStatus = "active";
let editingStudy = null;
let confirmDeleteAction = null;
let authRequired = false;
let participantsCache = [];
let studiesCache = [];

const linkModal = document.getElementById("linkModal");
const confirmModal = document.getElementById("confirmModal");
const messageModal = document.getElementById("messageModal");
const smsModal = document.getElementById("smsModal");
const authModal = document.getElementById("authModal");
const participantModal = document.getElementById("participantModal");
const studyModal = document.getElementById("studyModal");
const linkModalTitle = document.getElementById("linkModalTitle");
const windowLinkInput = document.getElementById("windowLinkInput");
const windowScheduleBlock = document.getElementById("windowScheduleBlock");
const windowScheduleList = document.getElementById("windowScheduleList");
const windowBadges = Array.from(document.querySelectorAll(".window-badge"));
const participantSubmitBtn = document.querySelector("#participantForm button[type='submit']");
const studySubmitBtn = document.querySelector("#studyForm button[type='submit']");
const studyParticipantSelect = document.getElementById("studyParticipant");
const confirmTitle = document.getElementById("confirmTitle");
const confirmMessage = document.getElementById("confirmMessage");
const confirmDeleteBtn = document.getElementById("confirmDeleteBtn");
const messageTitle = document.getElementById("messageTitle");
const messageBody = document.getElementById("messageBody");
const smsRecipient = document.getElementById("smsRecipient");
const smsBody = document.getElementById("smsBody");
const sendSmsBtn = document.getElementById("sendSmsBtn");
const exportParticipantsCsvBtn = document.getElementById("exportParticipantsCsvBtn");
const exportStudiesCsvBtn = document.getElementById("exportStudiesCsvBtn");
const authSubmitBtn = document.getElementById("authSubmitBtn");
const appRoot = document.getElementById("appRoot");
const surveyTemplateModal = document.getElementById("surveyTemplateModal");
const surveyTemplateForm = document.getElementById("surveyTemplateForm");
const templateWindow1 = document.getElementById("templateWindow1");
const templateWindow2 = document.getElementById("templateWindow2");
const templateWindow3 = document.getElementById("templateWindow3");
const templateWindow4 = document.getElementById("templateWindow4");
const templateEod = document.getElementById("templateEod");
const templateDbs = document.getElementById("templateDbs");
const eodSurveyTimeInput = document.getElementById("eodSurveyTime");
const dbsSurveyTimeInput = document.getElementById("dbsSurveyTime");
const eodSurveyUrlPreview = document.getElementById("eodSurveyUrlPreview");
const dbsSurveyUrlPreview = document.getElementById("dbsSurveyUrlPreview");
const openEodLinkBtn = document.getElementById("openEodLinkBtn");
const openDbsLinkBtn = document.getElementById("openDbsLinkBtn");
const openSurveyTemplatesBtn = document.getElementById("openSurveyTemplatesBtn");
const closeSurveyTemplateModalX = document.getElementById("closeSurveyTemplateModalX");
const saveSurveyTemplatesBtn = document.getElementById("saveSurveyTemplatesBtn");
const closeSurveyTemplatesBtn = document.getElementById("closeSurveyTemplatesBtn");
let smsTargetParticipantId = null;
let smsTargetParticipantLabel = "";
let surveyTemplateDefaults = {
  window_1: "",
  window_2: "",
  window_3: "",
  window_4: "",
  end_of_day: "",
  dry_blood_spot: "",
};

function openParticipantModal() {
  if (authRequired) return;
  participantModal.classList.remove("hidden");
}

function closeParticipantModal() {
  participantModal.classList.add("hidden");
}

function openStudyModal() {
  if (authRequired) return;
  studyModal.classList.remove("hidden");
}

function applySurveyTemplateDefaultsToStudy() {
  windowLinks[1] = surveyTemplateDefaults.window_1;
  windowLinks[2] = surveyTemplateDefaults.window_2;
  windowLinks[3] = surveyTemplateDefaults.window_3;
  windowLinks[4] = surveyTemplateDefaults.window_4;
  updateWindowBadgeStates();
}

function openSurveyTemplateModal() {
  if (authRequired) return;
  surveyTemplateModal.classList.remove("hidden");
}

function closeSurveyTemplateModal() {
  surveyTemplateModal.classList.add("hidden");
}

function closeStudyModal() {
  studyModal.classList.add("hidden");
}

function updateWindowBadgeStates() {
  windowBadges.forEach((btn) => {
    const windowNumber = Number(btn.dataset.window);
    const hasLink = Boolean(windowLinks[windowNumber]);
    btn.classList.toggle("filled", hasLink);
    btn.classList.toggle("missing", !hasLink);
  });
}

function renderWindowSchedule(scheduleItems = []) {
  if (!scheduleItems.length) {
    windowScheduleList.innerHTML = "<li>No scheduled times yet.</li>";
    windowScheduleBlock.classList.remove("hidden");
    return;
  }
  windowScheduleList.innerHTML = scheduleItems
    .map((item) => {
      if (!item?.time || !item?.date) return "<li>-</li>";
      const [h, m] = item.time.split(":").map(Number);
      const d = new Date(`${item.date}T00:00:00`);
      d.setHours(h, m, 0, 0);
      const dateLabel = d.toLocaleDateString([], { month: "short", day: "numeric" });
      const timeLabel = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const statusClass = item.sent ? "time-sent" : "time-pending";
      const statusText = item.sent ? "Sent" : "Pending";
      return `<li><span>${dateLabel}: ${timeLabel}</span> <span class="tag ${statusClass}">${statusText}</span></li>`;
    })
    .join("");
  windowScheduleBlock.classList.remove("hidden");
}

function openLinkModal(title, value, readonly = false, scheduleItems = []) {
  if (authRequired) return;
  linkModalTitle.textContent = title;
  windowLinkInput.value = value || "";
  windowLinkInput.readOnly = readonly;
  document.getElementById("saveWindowLinkBtn").style.display = readonly ? "none" : "inline-block";
  if (readonly) {
    renderWindowSchedule(scheduleItems);
  } else {
    windowScheduleBlock.classList.add("hidden");
    windowScheduleList.innerHTML = "";
  }
  linkModal.classList.remove("hidden");
}

function closeLinkModal() {
  linkModal.classList.add("hidden");
  activeWindow = null;
  activeAdditionalSurveyType = "";
}

function openConfirmModal(title, message, onConfirm, actionLabel = "Remove") {
  if (authRequired) return;
  confirmTitle.textContent = title;
  confirmMessage.textContent = message;
  confirmDeleteBtn.textContent = actionLabel;
  confirmDeleteAction = onConfirm;
  confirmModal.classList.remove("hidden");
}

function closeConfirmModal() {
  confirmModal.classList.add("hidden");
  confirmDeleteAction = null;
}

function openMessageModal(title, message) {
  messageTitle.textContent = title;
  messageBody.textContent = message;
  messageModal.classList.remove("hidden");
}

function closeMessageModal() {
  messageModal.classList.add("hidden");
}

function openSmsModal(participantId, label) {
  if (authRequired) return;
  smsTargetParticipantId = participantId;
  smsTargetParticipantLabel = label;
  smsRecipient.textContent = `To: ${label}`;
  smsBody.value = "";
  smsModal.classList.remove("hidden");
}

function closeSmsModal() {
  smsModal.classList.add("hidden");
  smsTargetParticipantId = null;
  smsTargetParticipantLabel = "";
}

function openAuthModal() {
  authRequired = true;
  appRoot.classList.add("hidden");
  authModal.classList.remove("hidden");
}

function closeAuthModal() {
  authRequired = false;
  authModal.classList.add("hidden");
  appRoot.classList.remove("hidden");
}

function encodeAttr(value) {
  return encodeURIComponent(value || "");
}

function stripPidFromUrl(value) {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    parsed.searchParams.delete("pid");
    return parsed.toString();
  } catch {
    return value;
  }
}

function appendPidToUrl(value, pid) {
  if (!value || !pid) return value;
  try {
    const parsed = new URL(value);
    parsed.searchParams.set("pid", pid);
    return parsed.toString();
  } catch {
    return value;
  }
}

function getSelectedStudyParticipantPid() {
  const option = studyParticipantSelect.selectedOptions?.[0];
  if (!option) return "";
  return option.dataset.participantId || option.textContent.trim() || "";
}

function getDefaultWindowTemplate(windowNumber) {
  if (windowNumber === 1) {
    return surveyTemplateDefaults.window_1 || "";
  }

  return surveyTemplateDefaults.window_2 || surveyTemplateDefaults.window_3 || surveyTemplateDefaults.window_4 || "";
}

function getWindowRawLink(windowNumber) {
  return stripPidFromUrl(windowLinks[windowNumber] || getDefaultWindowTemplate(windowNumber));
}

function getAdditionalSurveyRawLink(surveyType) {
  if (surveyType === "end_of_day") {
    return stripPidFromUrl(additionalSurveyLinks.end_of_day || surveyTemplateDefaults.end_of_day || "");
  }
  if (surveyType === "dry_blood_spot") {
    return stripPidFromUrl(additionalSurveyLinks.dry_blood_spot || surveyTemplateDefaults.dry_blood_spot || "");
  }
  return "";
}

function getAdditionalSurveyPreviewLink(surveyType) {
  const rawLink = getAdditionalSurveyRawLink(surveyType);
  const pid = getSelectedStudyParticipantPid();
  return appendPidToUrl(rawLink, pid);
}

function getWindowPreviewLink(windowNumber) {
  const rawLink = getWindowRawLink(windowNumber);
  const pid = getSelectedStudyParticipantPid();
  return appendPidToUrl(rawLink, pid);
}

function getReadonlyWindowPreviewLink(link, participantPid) {
  if (!link) return "";
  return appendPidToUrl(stripPidFromUrl(link), participantPid || "");
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function setSurveyPreviewLink(anchorEl, url) {
  if (!anchorEl) return;
  if (!url) {
    anchorEl.textContent = "Click to set link";
    anchorEl.href = "#";
    return;
  }
  anchorEl.textContent = url;
  anchorEl.href = url;
}

function refreshAdditionalSurveyPreviewLinks() {
  setSurveyPreviewLink(eodSurveyUrlPreview, getAdditionalSurveyPreviewLink("end_of_day"));
  setSurveyPreviewLink(dbsSurveyUrlPreview, getAdditionalSurveyPreviewLink("dry_blood_spot"));
}

function openAdditionalSurveyLinkEditor(surveyType) {
  if (authRequired) return;
  activeWindow = null;
  activeAdditionalSurveyType = surveyType;
  const title = surveyType === "end_of_day" ? "Set Link for EOD Survey" : "Set Link for DBS Survey";
  openLinkModal(title, getAdditionalSurveyRawLink(surveyType), false);
}

function escapeCsv(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map(escapeCsv).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function renderStudyParticipantOptions(participants, selectedId = null) {
  const options = ['<option value="">Select participant</option>'];
  participants.forEach((p) => {
    const selected = Number(selectedId) === p.id ? " selected" : "";
    options.push(
      `<option value="${p.id}" data-participant-id="${encodeAttr(p.participant_id || "")}"${selected}>${p.participant_id}</option>`
    );
  });
  studyParticipantSelect.innerHTML = options.join("");
}

function toYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getDefaultStudyDates() {
  const now = new Date();
  const todayDow = now.getDay(); // 0=Sun ... 4=Thu
  let daysUntilThursday = (4 - todayDow + 7) % 7;
  if (daysUntilThursday === 0) daysUntilThursday = 7; // next Thursday (not today)

  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + daysUntilThursday);

  const end = new Date(start);
  end.setDate(start.getDate() + 5); // Thu -> Tue (6 days inclusive)

  return { startDate: toYmd(start), endDate: toYmd(end) };
}

windowBadges.forEach((btn) => {
  btn.addEventListener("click", () => {
    activeWindow = Number(btn.dataset.window);
    openLinkModal(`Set Link for Window ${activeWindow}`, getWindowPreviewLink(activeWindow), false);
    windowLinkInput.dataset.rawValue = getWindowRawLink(activeWindow);
  });
});

document.getElementById("openParticipantModal").addEventListener("click", () => {
  editingParticipant = null;
  editingParticipantStatus = "active";
  document.getElementById("participantForm").reset();
  document.getElementById("participantModalTitle").textContent = "Add Participant";
  participantSubmitBtn.textContent = "Save";
  openParticipantModal();
});

document.getElementById("openStudyModal").addEventListener("click", () => {
  editingStudy = null;
  document.getElementById("studyForm").reset();
  studyParticipantSelect.value = "";
  const defaults = getDefaultStudyDates();
  document.getElementById("startDate").value = defaults.startDate;
  document.getElementById("endDate").value = defaults.endDate;
  document.getElementById("studyWakeTime").value = "08:00";
  refreshStudyWindowLabels("08:00");
  document.getElementById("promptsPerDay").value = 4;
  eodSurveyTimeInput.value = "20:00";
  dbsSurveyTimeInput.value = "19:30";
  additionalSurveyLinks.end_of_day = "";
  additionalSurveyLinks.dry_blood_spot = "";
  applySurveyTemplateDefaultsToStudy();
  refreshAdditionalSurveyPreviewLinks();
  document.getElementById("studyModalTitle").textContent = "Save Study";
  studySubmitBtn.textContent = "Save";
  openStudyModal();
});

openEodLinkBtn.addEventListener("click", () => {
  openAdditionalSurveyLinkEditor("end_of_day");
});

openDbsLinkBtn.addEventListener("click", () => {
  openAdditionalSurveyLinkEditor("dry_blood_spot");
});

eodSurveyUrlPreview.addEventListener("click", (event) => {
  event.preventDefault();
  openAdditionalSurveyLinkEditor("end_of_day");
});

dbsSurveyUrlPreview.addEventListener("click", (event) => {
  event.preventDefault();
  openAdditionalSurveyLinkEditor("dry_blood_spot");
});

document.getElementById("closeParticipantModalX").addEventListener("click", closeParticipantModal);
document.getElementById("closeStudyModalX").addEventListener("click", closeStudyModal);
document.getElementById("closeWindowLinkModalX").addEventListener("click", closeLinkModal);
document.getElementById("closeConfirmModalX").addEventListener("click", closeConfirmModal);
document.getElementById("cancelConfirmBtn").addEventListener("click", closeConfirmModal);
document.getElementById("closeSurveyTemplateModalX").addEventListener("click", closeSurveyTemplateModal);
document.getElementById("closeSurveyTemplatesBtn").addEventListener("click", closeSurveyTemplateModal);
document.getElementById("openSurveyTemplatesBtn").addEventListener("click", async () => {
  await loadSurveyTemplates();
  openSurveyTemplateModal();
});

surveyTemplateForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  saveSurveyTemplatesBtn.disabled = true;
  saveSurveyTemplatesBtn.textContent = "Saving...";
  try {
    const payload = {
      window_1: templateWindow1.value.trim(),
      window_2: templateWindow2.value.trim(),
      window_3: templateWindow3.value.trim(),
      window_4: templateWindow4.value.trim(),
      end_of_day: templateEod.value.trim(),
      dry_blood_spot: templateDbs.value.trim(),
    };
    const result = await getJSON("/api/settings/survey-templates", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    surveyTemplateDefaults = result;
    applySurveyTemplateDefaultsToStudy();
    refreshAdditionalSurveyPreviewLinks();
    closeSurveyTemplateModal();
    openMessageModal("Survey Templates Saved", "Survey template URLs have been updated successfully.");
  } catch (err) {
    openMessageModal("Unable to Save", err.message || "Unable to save survey templates.");
  } finally {
    saveSurveyTemplatesBtn.disabled = false;
    saveSurveyTemplatesBtn.textContent = "Save Templates";
  }
});

document.getElementById("closeMessageModalX").addEventListener("click", closeMessageModal);
document.getElementById("closeMessageBtn").addEventListener("click", closeMessageModal);
document.getElementById("closeSmsModalX").addEventListener("click", closeSmsModal);
document.getElementById("closeSmsBtn").addEventListener("click", closeSmsModal);
exportParticipantsCsvBtn.addEventListener("click", exportParticipantsCsv);
exportStudiesCsvBtn.addEventListener("click", exportStudiesCsv);
document.getElementById("confirmDeleteBtn").addEventListener("click", async () => {
  if (!confirmDeleteAction) return;
  await confirmDeleteAction();
  closeConfirmModal();
});
document.getElementById("closeWindowLinkBtn").addEventListener("click", closeLinkModal);
document.getElementById("saveWindowLinkBtn").addEventListener("click", () => {
  const value = windowLinkInput.value.trim();
  if (!isValidHttpUrl(value)) {
    openMessageModal("Invalid Link", "Please enter a valid URL starting with http:// or https://");
    return;
  }
  if (activeAdditionalSurveyType) {
    additionalSurveyLinks[activeAdditionalSurveyType] = stripPidFromUrl(value);
    refreshAdditionalSurveyPreviewLinks();
    closeLinkModal();
    return;
  }
  if (!activeWindow) return;
  windowLinks[activeWindow] = stripPidFromUrl(value);
  updateWindowBadgeStates();
  closeLinkModal();
});

windowLinkInput.addEventListener("input", () => {
  windowLinkInput.dataset.rawValue = stripPidFromUrl(windowLinkInput.value.trim());
});

studyParticipantSelect.addEventListener("change", () => {
  if (!activeWindow || windowLinkInput.readOnly) return;
  const rawValue = stripPidFromUrl(windowLinkInput.dataset.rawValue || windowLinkInput.value.trim() || getWindowRawLink(activeWindow));
  windowLinkInput.dataset.rawValue = rawValue;
  windowLinkInput.value = appendPidToUrl(rawValue, getSelectedStudyParticipantPid());
});

studyParticipantSelect.addEventListener("change", refreshAdditionalSurveyPreviewLinks);

document.getElementById("smsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!smsTargetParticipantId || sendSmsBtn.disabled) return;
  const body = smsBody.value.trim();
  if (!body) {
    openMessageModal("Missing Message", "Please type a message before sending.");
    return;
  }
  sendSmsBtn.disabled = true;
  sendSmsBtn.textContent = "Sending...";
  try {
    const res = await fetch(`/api/participants/${smsTargetParticipantId}/sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      throw new Error(await res.text());
    }
    closeSmsModal();
    openMessageModal("SMS Sent", `Message sent to ${smsTargetParticipantLabel || "participant phone"}.`);
    await loadLogs();
  } catch (err) {
    openMessageModal("SMS Failed", err.message || "Unable to send the message.");
  } finally {
    sendSmsBtn.disabled = false;
    sendSmsBtn.textContent = "Send";
  }
});

document.getElementById("authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (authSubmitBtn.disabled) return;
  const username = document.getElementById("authUsername").value.trim();
  const password = document.getElementById("authPassword").value;
  authSubmitBtn.disabled = true;
  authSubmitBtn.textContent = "Signing In...";
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      throw new Error(await res.text());
    }
    closeAuthModal();
    await Promise.all([loadDashboard(), loadParticipants(), loadLogs(), loadStudies(), loadSurveyTemplates()]);
  } catch {
    openMessageModal("Sign In Failed", "Invalid username or password.");
  } finally {
    authSubmitBtn.disabled = false;
    authSubmitBtn.textContent = "Sign In";
  }
});

async function loadSurveyTemplates() {
  const data = await getJSON("/api/settings/survey-templates");
  surveyTemplateDefaults = data;
  templateWindow1.value = data.window_1 || "";
  templateWindow2.value = data.window_2 || "";
  templateWindow3.value = data.window_3 || "";
  templateWindow4.value = data.window_4 || "";
  templateEod.value = data.end_of_day || "";
  templateDbs.value = data.dry_blood_spot || "";
  refreshAdditionalSurveyPreviewLinks();
}

async function loadDashboard() {
  const data = await getJSON("/api/dashboard");
  document.getElementById("activeStudies").textContent = data.active_studies;
  document.getElementById("participants").textContent = data.participants_enrolled;
  document.getElementById("sentToday").textContent = data.messages_sent_today;
  document.getElementById("compliance").textContent = `${data.compliance_percent}%`;
}

async function loadParticipants() {
  const rows = await getJSON("/api/participants");
  participantsCache = rows;
  renderStudyParticipantOptions(rows, studyParticipantSelect.value);
  const body = document.getElementById("participantRows");
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="3">No participants added yet.</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map(
      (r) => `<tr>
        <td>${r.participant_id || "-"}</td>
        <td>${r.phone}</td>
        <td>
          <button type="button" class="secondary action edit-participant" data-id="${r.id}" data-participant-id="${encodeAttr(r.participant_id || "")}" data-phone="${encodeAttr(r.phone)}" data-status="${encodeAttr(r.status || "active")}">Edit</button>
          <button type="button" class="secondary action sms-participant" data-id="${r.id}" data-participant-id="${encodeAttr(r.participant_id || "")}" data-phone="${encodeAttr(r.phone)}">Send SMS</button>
          <button type="button" class="secondary action delete-participant" data-id="${r.id}">Remove</button>
        </td>
      </tr>`
    )
    .join("");
  body.querySelectorAll(".edit-participant").forEach((btn) => {
    btn.addEventListener("click", () => {
      editingParticipant = Number(btn.dataset.id);
      editingParticipantStatus = decodeURIComponent(btn.dataset.status || "active");
      document.getElementById("participantCode").value = decodeURIComponent(btn.dataset.participantId || "");
      document.getElementById("phone").value = decodeURIComponent(btn.dataset.phone || "");
      document.getElementById("participantModalTitle").textContent = "Edit Participant";
      participantSubmitBtn.textContent = "Save";
      openParticipantModal();
    });
  });
  body.querySelectorAll(".delete-participant").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.id);
      openConfirmModal("Remove Participant", "This participant will be removed. Continue?", async () => {
        await getJSON(`/api/participants/${id}`, { method: "DELETE" });
        if (editingParticipant === id) {
          editingParticipant = null;
          editingParticipantStatus = "active";
          document.getElementById("participantForm").reset();
          document.getElementById("participantModalTitle").textContent = "Add Participant";
          participantSubmitBtn.textContent = "Save";
          closeParticipantModal();
        }
        await Promise.all([loadParticipants(), loadDashboard(), loadLogs()]);
      });
    });
  });
  body.querySelectorAll(".sms-participant").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.id);
      const label = decodeURIComponent(btn.dataset.phone || "");
      openSmsModal(id, label);
    });
  });
}

async function loadLogs() {
  const rows = await getJSON("/api/logs");
  const list = document.getElementById("logs");
  list.innerHTML = rows
    .slice(0, 10)
    .map((r) => `<li>${new Date(r.timestamp).toLocaleString()} ${r.event}: ${r.details}</li>`)
    .join("");
}

async function loadStudies() {
  const rows = await getJSON("/api/studies");
  studiesCache = rows;
  const body = document.getElementById("studyRows");
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="5">No studies configured yet.</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map((r) => {
      const windows = (r.windows || [])
        .map((w, i) => {
          const schedule = r.window_schedules?.[String(i + 1)] || [];
          return `<button type="button" class="tag button-tag tag-window" data-link="${encodeAttr(w.link || "")}" data-participant-pid="${encodeAttr(r.participant_code || "")}" data-label="Window ${i + 1}" data-schedule="${encodeAttr(JSON.stringify(schedule))}">W${i + 1} ${w.start}-${w.end}</button>`;
        })
        .join("");
      const additionalTagConfig = {
        end_of_day: { short: "EOD", label: "End of Day Survey", className: "tag-eod" },
        dry_blood_spot: { short: "DBS", label: "Dry Blood Spot Survey", className: "tag-dbs" },
      };
      const additionalTags = (r.additional_surveys || [])
        .map((survey) => {
          const cfg = additionalTagConfig[survey?.survey_type || ""];
          if (!cfg) return "";
          const schedule = r.additional_schedules?.[survey.survey_type] || [];
          const timeLabel = survey?.time || "--:--";
          return `<button type="button" class="tag button-tag ${cfg.className}" data-link="${encodeAttr(survey.link || "")}" data-participant-pid="${encodeAttr(r.participant_code || "")}" data-label="${cfg.label}" data-schedule="${encodeAttr(JSON.stringify(schedule))}">${cfg.short} ${timeLabel}</button>`;
        })
        .join("");
      return `<tr>
        <td>${r.participant_code || `#${r.participant_id || "-"}`}</td>
        <td>${r.start_date} to ${r.end_date}</td>
        <td>${r.comments || "-"}</td>
        <td><div class="stacked-tags">${windows}${additionalTags}</div></td>
        <td>
          <button type="button" class="secondary action edit-study" data-id="${r.id}">Edit</button>
          <button type="button" class="secondary action delete-study" data-id="${r.id}">Remove</button>
        </td>
      </tr>`;
    })
    .join("");
  body.querySelectorAll(".button-tag").forEach((btn) => {
    btn.addEventListener("click", () => {
      const label = btn.dataset.label || "Window";
      const rawLink = decodeURIComponent(btn.dataset.link || "");
      const participantPid = decodeURIComponent(btn.dataset.participantPid || "");
      const previewLink = getReadonlyWindowPreviewLink(rawLink, participantPid);
      const link = previewLink || rawLink || "No link configured";
      let scheduleItems = [];
      try {
        scheduleItems = JSON.parse(decodeURIComponent(btn.dataset.schedule || "[]"));
      } catch {
        scheduleItems = [];
      }
      openLinkModal(`${label} Link`, link, true, scheduleItems);
    });
  });
  body.querySelectorAll(".edit-study").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.id);
      const study = rows.find((s) => s.id === id);
      if (!study) return;
      editingStudy = id;
      studyParticipantSelect.value = String(study.participant_id || "");
      document.getElementById("startDate").value = study.start_date;
      document.getElementById("endDate").value = study.end_date;
      document.getElementById("promptsPerDay").value = 4;
      document.getElementById("studyComments").value = study.comments || "";
      document.getElementById("studyWakeTime").value = study.windows?.[0]?.start || "08:00";
      const eodSurvey = (study.additional_surveys || []).find((s) => s?.survey_type === "end_of_day");
      const dbsSurvey = (study.additional_surveys || []).find((s) => s?.survey_type === "dry_blood_spot");
      eodSurveyTimeInput.value = eodSurvey?.time || "20:00";
      dbsSurveyTimeInput.value = dbsSurvey?.time || "19:30";
      additionalSurveyLinks.end_of_day = stripPidFromUrl(eodSurvey?.link || "");
      additionalSurveyLinks.dry_blood_spot = stripPidFromUrl(dbsSurvey?.link || "");
      for (let i = 1; i <= 4; i += 1) {
        windowLinks[i] = stripPidFromUrl(study.windows?.[i - 1]?.link || getDefaultWindowTemplate(i));
      }
      refreshStudyWindowLabels(document.getElementById("studyWakeTime").value || "08:00");
      updateWindowBadgeStates();
      refreshAdditionalSurveyPreviewLinks();
      document.getElementById("studyModalTitle").textContent = "Edit Study";
      studySubmitBtn.textContent = "Save";
      openStudyModal();
    });
  });
  body.querySelectorAll(".delete-study").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.id);
      openConfirmModal("Remove Study", "This study will be removed. Continue?", async () => {
        await getJSON(`/api/studies/${id}`, { method: "DELETE" });
        if (editingStudy === id) {
          editingStudy = null;
          document.getElementById("studyForm").reset();
          document.getElementById("promptsPerDay").value = 4;
          for (let i = 1; i <= 4; i += 1) windowLinks[i] = "";
          updateWindowBadgeStates();
          document.getElementById("studyModalTitle").textContent = "Save Study";
          studySubmitBtn.textContent = "Save";
          closeStudyModal();
        }
        await Promise.all([loadStudies(), loadDashboard(), loadLogs()]);
      });
    });
  });
}

function exportParticipantsCsv() {
  if (!participantsCache.length) {
    openMessageModal("No Data", "There are no participants to export.");
    return;
  }
  downloadCsv("participants.csv", [
    ["id", "participant_id", "phone", "redcap_record_id", "status"],
    ...participantsCache.map((row) => [
      row.id,
      row.participant_id,
      row.phone,
      row.redcap_record_id || "",
      row.status || "",
    ]),
  ]);
}

function exportStudiesCsv() {
  if (!studiesCache.length) {
    openMessageModal("No Data", "There are no studies to export.");
    return;
  }
  downloadCsv("studies.csv", [
    [
      "id",
      "participant_id",
      "participant_code",
      "start_date",
      "end_date",
      "prompts_per_day",
      "comments",
      "windows_json",
      "additional_surveys_json",
    ],
    ...studiesCache.map((row) => [
      row.id,
      row.participant_id,
      row.participant_code || "",
      row.start_date,
      row.end_date,
      row.prompts_per_day,
      row.comments || "",
      JSON.stringify(row.windows || []),
      JSON.stringify(row.additional_surveys || []),
    ]),
  ]);
}

document.getElementById("participantForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    participant_id: document.getElementById("participantCode").value.trim(),
    phone: document.getElementById("phone").value.trim(),
    status: editingParticipant ? editingParticipantStatus : "active",
  };
  try {
    await getJSON(editingParticipant ? `/api/participants/${editingParticipant}` : "/api/participants", {
      method: editingParticipant ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    openMessageModal("Participant ID Exists", "Participant ID already exists. Please use a different Participant ID.");
    return;
  }
  editingParticipant = null;
  editingParticipantStatus = "active";
  e.target.reset();
  document.getElementById("participantModalTitle").textContent = "Add Participant";
  participantSubmitBtn.textContent = "Save";
  closeParticipantModal();
  await Promise.all([loadParticipants(), loadDashboard(), loadLogs()]);
});

document.getElementById("studyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  for (let i = 1; i <= 4; i += 1) {
    if (!windowLinks[i]) {
      activeWindow = i;
      openLinkModal(`Set Link for Window ${i}`, getWindowPreviewLink(i), false);
      windowLinkInput.dataset.rawValue = getWindowRawLink(i);
      return;
    }
  }
  const wakeTime = document.getElementById("studyWakeTime").value || "08:00";
  refreshStudyWindowLabels(wakeTime);
  const payload = {
    participant_id: Number(studyParticipantSelect.value),
    comments: document.getElementById("studyComments").value.trim(),
    start_date: document.getElementById("startDate").value,
    end_date: document.getElementById("endDate").value,
    prompts_per_day: 4,
    windows: [
      { start: windowTimes[1].start, end: windowTimes[1].end, link: windowLinks[1] },
      { start: windowTimes[2].start, end: windowTimes[2].end, link: windowLinks[2] },
      { start: windowTimes[3].start, end: windowTimes[3].end, link: windowLinks[3] },
      { start: windowTimes[4].start, end: windowTimes[4].end, link: windowLinks[4] },
    ],
    additional_surveys: [
      {
        survey_type: "end_of_day",
        time: eodSurveyTimeInput.value || "20:00",
        link: getAdditionalSurveyRawLink("end_of_day"),
      },
      {
        survey_type: "dry_blood_spot",
        time: dbsSurveyTimeInput.value || "19:30",
        link: getAdditionalSurveyRawLink("dry_blood_spot"),
      },
    ],
  };
  if (!payload.participant_id) {
    openMessageModal("Participant Required", "Please select a participant.");
    return;
  }
  if (!payload.additional_surveys[0].link || !payload.additional_surveys[1].link) {
    openMessageModal("Missing Survey URLs", "Please set links for EOD and DBS surveys.");
    return;
  }
  try {
    await getJSON(editingStudy ? `/api/studies/${editingStudy}` : "/api/studies", {
      method: editingStudy ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    openMessageModal("Unable To Save Study", "Each participant can have only one study.");
    return;
  }
  editingStudy = null;
  document.getElementById("studyModalTitle").textContent = "Save Study";
  studySubmitBtn.textContent = "Save";
  closeStudyModal();
  await Promise.all([loadDashboard(), loadLogs(), loadStudies()]);
});

document.getElementById("generateBtn").addEventListener("click", async () => {
  openConfirmModal(
    "Regenerate Random Times",
    "This will overwrite current unsent random times for today. Continue?",
    async () => {
      await getJSON("/api/scheduler/generate", { method: "POST" });
      await Promise.all([loadDashboard(), loadLogs(), loadStudies()]);
    },
    "Generate"
  );
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  try {
    await getJSON("/api/auth/logout", { method: "POST" });
  } catch {
    // Ignore and force logged-out UI either way.
  }
  openAuthModal();
  document.getElementById("authForm").reset();
});

async function bootstrap() {
  const status = await getJSON("/api/auth/status");
  if (!status.authenticated) {
    openAuthModal();
    return;
  }
  closeAuthModal();
  await Promise.all([loadDashboard(), loadParticipants(), loadLogs(), loadStudies(), loadSurveyTemplates()]);
}

bootstrap();
updateWindowBadgeStates();
refreshAdditionalSurveyPreviewLinks();
