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
const APP_TIME_ZONE = "America/New_York";
const LOG_DATE_TIME_FORMATTER = new Intl.DateTimeFormat([], {
  timeZone: APP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});
const savedWindowLinkStates = { 1: false, 2: false, 3: false, 4: false };
const windowTimes = {
  1: { start: "09:00", end: "11:00" },
  2: { start: "11:30", end: "13:30" },
  3: { start: "14:00", end: "16:00" },
  4: { start: "16:30", end: "19:30" },
};
const additionalSurveyLinks = { morning: "", dbs_reminder: "", evening_diary: "" };
const DBS_REMINDER_DEFAULT_MESSAGE = "Time to collect tonight's blood sample! Quick reminder: you only need to fill two circles on the card. Make sure to let the drops dry completely overnight in a safe spot!";
const savedAdditionalSurveyStates = { morning: false, dbs_reminder: false, evening_diary: false };
let activeWindow = null;
let activeAdditionalSurveyType = "";

function formatTime(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function parseTimeToMinutes(value, fallback = "08:00") {
  const [rawHours, rawMinutes] = (value || fallback).split(":");
  const hours = Number(rawHours);
  const minutes = Number(rawMinutes);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    const [fbHours, fbMinutes] = fallback.split(":").map(Number);
    return fbHours * 60 + fbMinutes;
  }
  return hours * 60 + minutes;
}

function formatMinutesToTime(totalMinutes) {
  const minutesInDay = 24 * 60;
  const normalized = ((Math.round(totalMinutes) % minutesInDay) + minutesInDay) % minutesInDay;
  const hh = Math.floor(normalized / 60);
  const mm = normalized % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function parseTimeToDate(timeValue, fallback = "08:00") {
  const [hours, minutes] = (timeValue || fallback).split(":").map(Number);
  const date = new Date();
  date.setHours(Number.isFinite(hours) ? hours : 8, Number.isFinite(minutes) ? minutes : 0, 0, 0);
  return date;
}

function shiftTime(timeValue, minutesDelta, fallback = "08:00") {
  const dt = parseTimeToDate(timeValue, fallback);
  dt.setMinutes(dt.getMinutes() + minutesDelta);
  return formatTime(dt);
}

function computeStudyWindowsFromWake(wakeTime, emaEndTime = "18:30") {
  const intervalStart = parseTimeToDate(wakeTime, "08:00");
  intervalStart.setMinutes(intervalStart.getMinutes() + 90);
  const intervalEnd = parseTimeToDate(emaEndTime, "18:30");
  if (intervalEnd <= intervalStart) {
    intervalEnd.setTime(intervalStart.getTime() + 30 * 60 * 1000);
  }

  const intervalLength = intervalEnd.getTime() - intervalStart.getTime();
  const windowFractions = [
    [0.00, 0.25],
    [0.25, 0.50],
    [0.50, 0.75],
    [0.75, 1.00],
  ];
  const windows = [];
  for (const [startFraction, endFraction] of windowFractions) {
    const start = new Date(intervalStart.getTime() + intervalLength * startFraction);
    const end = new Date(intervalStart.getTime() + intervalLength * endFraction);
    windows.push({ start: formatTime(start), end: formatTime(end) });
  }
  return windows;
}

function inferWakeTimeFromFirstWindowStart(firstWindowStart, eodTime = "20:30") {
  if (!firstWindowStart) return "08:00";

  const firstWindowMinutes = parseTimeToMinutes(firstWindowStart, "09:00");
  // With 25/25/25/25 windows, window 1 starts exactly at intervalStart = wake + 90.
  const wakeMinutes = firstWindowMinutes - 90;
  return formatMinutesToTime(wakeMinutes);
}

function getDisplayWindowsForStudy(study) {
  const persistedWindows = Array.isArray(study?.windows) ? study.windows : [];
  const firstStart = persistedWindows[0]?.start;
  if (!firstStart) return persistedWindows;

  const wakeTime = inferWakeTimeFromFirstWindowStart(firstStart, "20:30");
  const emaEndTime = persistedWindows[3]?.end || "18:30";
  const dynamicWindows = computeStudyWindowsFromWake(wakeTime, emaEndTime);
  return dynamicWindows.map((windowRange, idx) => ({
    start: windowRange.start,
    end: windowRange.end,
    link: persistedWindows[idx]?.link || "",
  }));
}

function playRangeUpdatedAnimation(el) {
  if (!el) return;
  el.classList.remove("range-updated");
  void el.offsetWidth;
  el.classList.add("range-updated");
}

function refreshStudyWindowLabels(
  wakeTime = document.getElementById("studyWakeTime")?.value || "08:00",
  emaEndTime = emaEndTimeInput?.value || "18:30",
  animate = false
) {
  const windows = computeStudyWindowsFromWake(wakeTime, emaEndTime);
  for (let i = 1; i <= 4; i += 1) {
    windowTimes[i] = { start: windows[i - 1].start, end: windows[i - 1].end };
    const btn = document.querySelector(`#studyModal .window-badge[data-window="${i}"]`);
    if (!btn) continue;
    const nextRange = `${windowTimes[i].start}-${windowTimes[i].end}`;
    const prevRange = btn.dataset.rangeLabel || "";
    btn.innerHTML = `<strong>Window ${i}:</strong> ${windowTimes[i].start} - ${windowTimes[i].end} <span class="window-status"></span>`;
    btn.dataset.rangeLabel = nextRange;
    if (animate && prevRange && prevRange !== nextRange) {
      playRangeUpdatedAnimation(btn);
    }
  }
}

function updateVisibleStudyTableRanges(wakeTime, animate = false) {
  if (!studyModal || studyModal.classList.contains("hidden")) return;
  if (!editingStudy) return;
  const studyRows = document.getElementById("studyRows");
  if (!studyRows) return;
  const targetRow = studyRows.querySelector(`tr[data-study-id="${editingStudy}"]`);
  if (!targetRow) return;
  const emaEndTime = emaEndTimeInput?.value || "18:30";
  const windows = computeStudyWindowsFromWake(wakeTime, emaEndTime);
  const tags = targetRow.querySelectorAll(".tag-window");
  tags.forEach((tag) => {
    const idx = Number(tag.dataset.windowIndex || "0");
    if (!idx || !windows[idx - 1]) return;
    const range = windows[idx - 1];
    const nextLabel = `W${idx} ${range.start}-${range.end}`;
    const changed = tag.textContent !== nextLabel;
    tag.textContent = nextLabel;
    if (animate && changed) {
      playRangeUpdatedAnimation(tag);
    }
  });
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
const templateMorning = document.getElementById("templateMorning");
const templateEveningDiary = document.getElementById("templateEveningDiary");
const dbsReminderTimeInput = document.getElementById("dbsReminderTime");
const openDbsReminderBtn = document.getElementById("openDbsReminderBtn");
const eveningDiaryTimeInput = document.getElementById("eveningDiaryTime");
const openMorningLinkBtn = document.getElementById("openMorningLinkBtn");
const openEveningDiaryLinkBtn = document.getElementById("openEveningDiaryLinkBtn");
const openSurveyTemplatesBtn = document.getElementById("openSurveyTemplatesBtn");
const closeSurveyTemplateModalX = document.getElementById("closeSurveyTemplateModalX");
const saveSurveyTemplatesBtn = document.getElementById("saveSurveyTemplatesBtn");
const closeSurveyTemplatesBtn = document.getElementById("closeSurveyTemplatesBtn");
const studyWakeTimeInput = document.getElementById("studyWakeTime");
const emaEndTimeInput = document.getElementById("emaEndTime");
let smsTargetParticipantId = null;
let smsTargetParticipantLabel = "";
let surveyTemplateDefaults = {
  window_1: "",
  window_2: "",
  window_3: "",
  window_4: "",
  morning: "",
  evening_diary: "",
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
}

function clearSavedStudyLinkStates() {
  for (let i = 1; i <= 4; i += 1) {
    savedWindowLinkStates[i] = false;
  }
  savedAdditionalSurveyStates.morning = false;
  savedAdditionalSurveyStates.dbs_reminder = false;
  savedAdditionalSurveyStates.evening_diary = false;
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
  clearPendingLinkSelection();
}

function playJustFilledAnimation(el) {
  if (!el) return;
  el.classList.remove("just-filled");
  void el.offsetWidth;
  el.classList.add("just-filled");
}

function updateStudyLinkButtonStates() {
  windowBadges.forEach((btn) => {
    const windowNumber = Number(btn.dataset.window);
    const isSaved = Boolean(savedWindowLinkStates[windowNumber]);
    const wasSaved = btn.classList.contains("filled");
    btn.classList.toggle("filled", isSaved);
    btn.classList.remove("missing");
    if (isSaved && !wasSaved) {
      playJustFilledAnimation(btn);
    }
  });
  const wasMorningSaved = openMorningLinkBtn?.classList.contains("filled");
  const isMorningSaved = Boolean(savedAdditionalSurveyStates.morning);
  openMorningLinkBtn?.classList.toggle("filled", isMorningSaved);
  if (isMorningSaved && !wasMorningSaved) {
    playJustFilledAnimation(openMorningLinkBtn);
  }

  const wasEveningDiarySaved = openEveningDiaryLinkBtn?.classList.contains("filled");
  const isEveningDiarySaved = Boolean(savedAdditionalSurveyStates.evening_diary);
  openEveningDiaryLinkBtn?.classList.toggle("filled", isEveningDiarySaved);
  if (isEveningDiarySaved && !wasEveningDiarySaved) {
    playJustFilledAnimation(openEveningDiaryLinkBtn);
  }
  const wasDbsReminderSaved = openDbsReminderBtn?.classList.contains("filled");
  const isDbsReminderSaved = Boolean(savedAdditionalSurveyStates.dbs_reminder);
  openDbsReminderBtn?.classList.toggle("filled", isDbsReminderSaved);
  if (isDbsReminderSaved && !wasDbsReminderSaved) {
    playJustFilledAnimation(openDbsReminderBtn);
  }
}

function clearPendingLinkSelection() {
  windowBadges.forEach((btn) => btn.classList.remove("pending"));
  openMorningLinkBtn?.classList.remove("pending");
  openDbsReminderBtn?.classList.remove("pending");
  openEveningDiaryLinkBtn?.classList.remove("pending");
}

function setPendingLinkSelection() {
  clearPendingLinkSelection();
  if (activeWindow) {
    const activeBadge = windowBadges.find((btn) => Number(btn.dataset.window) === activeWindow);
    activeBadge?.classList.add("pending");
    return;
  }
  if (activeAdditionalSurveyType === "morning") {
    openMorningLinkBtn?.classList.add("pending");
    return;
  }
  if (activeAdditionalSurveyType === "evening_diary") {
    openEveningDiaryLinkBtn?.classList.add("pending");
    return;
  }
  if (activeAdditionalSurveyType === "dbs_reminder") {
    openDbsReminderBtn?.classList.add("pending");
  }
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
      const [, month, day] = item.date.split("-").map(Number);
      const [hours24, minutes] = item.time.split(":").map(Number);
      const monthLabel = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
        Math.max(1, month) - 1
      ];
      const meridiem = hours24 >= 12 ? "PM" : "AM";
      const hours12 = ((hours24 + 11) % 12) + 1;
      const dateLabel = `${monthLabel} ${day}`;
      const timeLabel = `${hours12}:${String(minutes).padStart(2, "0")} ${meridiem}`;
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
  const saveWindowLinkBtn = document.getElementById("saveWindowLinkBtn");
  saveWindowLinkBtn.textContent = activeAdditionalSurveyType === "dbs_reminder" ? "Save Message" : "Save Link";
  saveWindowLinkBtn.style.display = readonly ? "none" : "inline-block";
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
  clearPendingLinkSelection();
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
  if (surveyType === "morning") {
    return stripPidFromUrl(additionalSurveyLinks.morning || surveyTemplateDefaults.morning || "");
  }
  if (surveyType === "evening_diary") {
    return stripPidFromUrl(additionalSurveyLinks.evening_diary || surveyTemplateDefaults.evening_diary || "");
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

function refreshAdditionalSurveyPreviewLinks() {
  // Additional survey links are edited through their buttons only.
}

function openAdditionalSurveyLinkEditor(surveyType) {
  if (authRequired) return;
  activeWindow = null;
  activeAdditionalSurveyType = surveyType;
  setPendingLinkSelection();
  const titles = {
    morning: "Set Link for Morning Survey",
    dbs_reminder: "Set Message for DBS Reminder",
    evening_diary: "Set Link for Evening Diary",
  };
  const value = surveyType === "dbs_reminder"
    ? additionalSurveyLinks.dbs_reminder || DBS_REMINDER_DEFAULT_MESSAGE
    : getAdditionalSurveyPreviewLink(surveyType);
  openLinkModal(titles[surveyType] || "Set Link for Survey", value, false);
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
    activeAdditionalSurveyType = "";
    setPendingLinkSelection();
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
  document.getElementById("promptsPerDay").value = 4;
  eveningDiaryTimeInput.value = "20:30";
  dbsReminderTimeInput.value = "20:00";
  emaEndTimeInput.value = "18:30";
  refreshStudyWindowLabels("08:00", emaEndTimeInput.value);
  additionalSurveyLinks.morning = "";
  additionalSurveyLinks.dbs_reminder = DBS_REMINDER_DEFAULT_MESSAGE;
  additionalSurveyLinks.evening_diary = "";
  applySurveyTemplateDefaultsToStudy();
  clearSavedStudyLinkStates();
  updateStudyLinkButtonStates();
  refreshAdditionalSurveyPreviewLinks();
  document.getElementById("studyModalTitle").textContent = "Save Study";
  studySubmitBtn.textContent = "Save";
  openStudyModal();
});

openMorningLinkBtn?.addEventListener("click", () => {
  openAdditionalSurveyLinkEditor("morning");
});

openDbsReminderBtn?.addEventListener("click", () => {
  openAdditionalSurveyLinkEditor("dbs_reminder");
});

openEveningDiaryLinkBtn.addEventListener("click", () => {
  openAdditionalSurveyLinkEditor("evening_diary");
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
      morning: templateMorning.value.trim(),
      evening_diary: templateEveningDiary.value.trim(),
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
  try {
    await confirmDeleteAction();
    closeConfirmModal();
  } catch (err) {
    const message = err?.message || "Unable to complete this action.";
    openMessageModal("Action Failed", message);
  }
});
document.getElementById("closeWindowLinkBtn").addEventListener("click", closeLinkModal);
document.getElementById("saveWindowLinkBtn").addEventListener("click", () => {
  const value = windowLinkInput.value.trim();
  if (activeAdditionalSurveyType === "dbs_reminder") {
    if (!value) {
      openMessageModal("Missing Message", "Please enter a message for the DBS reminder.");
      return;
    }
    additionalSurveyLinks.dbs_reminder = value;
    savedAdditionalSurveyStates.dbs_reminder = true;
    updateStudyLinkButtonStates();
    closeLinkModal();
    return;
  }
  if (!isValidHttpUrl(value)) {
    openMessageModal("Invalid Link", "Please enter a valid URL starting with http:// or https://");
    return;
  }
  if (activeAdditionalSurveyType) {
    additionalSurveyLinks[activeAdditionalSurveyType] = stripPidFromUrl(value);
    savedAdditionalSurveyStates[activeAdditionalSurveyType] = true;
    updateStudyLinkButtonStates();
    refreshAdditionalSurveyPreviewLinks();
    closeLinkModal();
    return;
  }
  if (!activeWindow) return;
  windowLinks[activeWindow] = stripPidFromUrl(value);
  savedWindowLinkStates[activeWindow] = true;
  updateStudyLinkButtonStates();
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

studyWakeTimeInput?.addEventListener("input", () => {
  const wakeTime = studyWakeTimeInput.value || "08:00";
  const emaEndTime = emaEndTimeInput?.value || "18:30";
  refreshStudyWindowLabels(wakeTime, emaEndTime, true);
  updateVisibleStudyTableRanges(wakeTime, true);
});

studyWakeTimeInput?.addEventListener("change", () => {
  const wakeTime = studyWakeTimeInput.value || "08:00";
  const emaEndTime = emaEndTimeInput?.value || "18:30";
  refreshStudyWindowLabels(wakeTime, emaEndTime, true);
  updateVisibleStudyTableRanges(wakeTime, true);
});

emaEndTimeInput?.addEventListener("input", () => {
  const wakeTime = studyWakeTimeInput?.value || "08:00";
  refreshStudyWindowLabels(wakeTime, emaEndTimeInput.value || "18:30", true);
  updateVisibleStudyTableRanges(wakeTime, true);
});

emaEndTimeInput?.addEventListener("change", () => {
  const wakeTime = studyWakeTimeInput?.value || "08:00";
  refreshStudyWindowLabels(wakeTime, emaEndTimeInput.value || "18:30", true);
  updateVisibleStudyTableRanges(wakeTime, true);
});

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
  templateMorning.value = data.morning || "";
  templateEveningDiary.value = data.evening_diary || "";
  refreshAdditionalSurveyPreviewLinks();
}

async function loadDashboard() {
  const data = await getJSON("/api/dashboard");
  document.getElementById("activeStudies").textContent = data.active_studies;
  document.getElementById("participants").textContent = data.participants_enrolled;
  document.getElementById("sentToday").textContent = data.messages_sent_today;
  document.getElementById("completedStudies").textContent = data.completed_studies;
  document.getElementById("registeredStudies").textContent = data.registered_studies;
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
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.id);
      if (!studiesCache.length) {
        try {
          studiesCache = await getJSON("/api/studies");
        } catch {
          studiesCache = [];
        }
      }
      const participantStudies = studiesCache.filter((study) => Number(study.participant_id) === id);
      const today = toYmd(new Date());
      const hasActiveStudy = participantStudies.some(
        (study) =>
          study.start_date <= today &&
          study.end_date >= today
      );
      const hasAnyStudy = participantStudies.length > 0;
      const confirmText = hasActiveStudy
        ? "⚠ This participant has an active study. If you remove this participant, the active study will also be removed. Continue?"
        : hasAnyStudy
          ? "⚠ This participant has a linked study. If you remove this participant, the linked study will also be removed. Continue?"
          : "This participant will be removed. Continue?";
      openConfirmModal("Remove Participant", confirmText, async () => {
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
    .map((r) => {
      const timestamp = new Date(r.timestamp);
      const formatted = Number.isNaN(timestamp.getTime()) ? String(r.timestamp || "") : LOG_DATE_TIME_FORMATTER.format(timestamp);
      return `<li>${formatted} ET ${r.event}: ${r.details}</li>`;
    })
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
      const displayWindows = getDisplayWindowsForStudy(r);
      const windows = displayWindows
        .map((w, i) => {
          const schedule = r.window_schedules?.[String(i + 1)] || [];
          const start = w?.start || "--:--";
          const end = w?.end || "--:--";
          return `<button type="button" class="tag button-tag tag-window" data-window-index="${i + 1}" data-link="${encodeAttr(r.windows?.[i]?.link || "")}" data-participant-pid="${encodeAttr(r.participant_code || "")}" data-label="Window ${i + 1}" data-schedule="${encodeAttr(JSON.stringify(schedule))}">W${i + 1} ${start}-${end}</button>`;
        })
        .join("");
      const additionalTagConfig = {
        morning: { short: "M", label: "Morning Survey", className: "tag-morning" },
        dbs_reminder: { short: "DBS", label: "DBS Reminder", className: "tag-dbs" },
        evening_diary: { short: "ED", label: "Evening Diary", className: "tag-evening" },
      };
      const additionalTags = (r.additional_surveys || [])
        .map((survey) => {
          const cfg = additionalTagConfig[survey?.survey_type || ""];
          if (!cfg) return "";
          const schedule = r.additional_schedules?.[survey.survey_type] || [];
          const timeLabel = survey?.time
            ? survey.survey_type === "morning"
              ? shiftTime(survey.time, 15)
              : survey.time
            : survey?.survey_type === "dbs_reminder"
              ? "Random"
              : "--:--";
          return `<button type="button" class="tag button-tag ${cfg.className}" data-link="${encodeAttr(survey.link || "")}" data-participant-pid="${encodeAttr(r.participant_code || "")}" data-label="${cfg.label}" data-schedule="${encodeAttr(JSON.stringify(schedule))}">${cfg.short} ${timeLabel}</button>`;
        })
        .join("");
      return `<tr data-study-id="${r.id}">
        <td>${r.participant_code || `#${r.participant_id || "-"}`}</td>
        <td>${r.start_date} to ${r.end_date}</td>
        <td>${r.comments || "-"}</td>
        <td><div class="stacked-tags">${windows}${additionalTags}</div></td>
        <td>
          <button type="button" class="secondary action edit-study" data-id="${r.id}">Edit</button>
          <button type="button" class="secondary action regenerate-study" data-participant-id="${r.participant_id}" data-participant-code="${encodeAttr(r.participant_code || `#${r.participant_id || "-"}`)}">Regenerate Times</button>
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
      const link = btn.dataset.label === "DBS Reminder" ? "Message sent without a link" : previewLink || rawLink || "No link configured";
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
      document.getElementById("studyWakeTime").value = inferWakeTimeFromFirstWindowStart(
        study.windows?.[0]?.start || "09:00",
        "20:30"
      );
      const morningSurvey = (study.additional_surveys || []).find((s) => s?.survey_type === "morning");
      const dbsReminder = (study.additional_surveys || []).find((s) => s?.survey_type === "dbs_reminder");
      const eveningDiarySurvey = (study.additional_surveys || []).find((s) => s?.survey_type === "evening_diary");
      dbsReminderTimeInput.value = dbsReminder?.time || "20:00";
      emaEndTimeInput.value = study.windows?.[3]?.end || "18:30";
      eveningDiaryTimeInput.value = eveningDiarySurvey?.time || "20:30";
      additionalSurveyLinks.morning = stripPidFromUrl(morningSurvey?.link || "");
      additionalSurveyLinks.dbs_reminder = dbsReminder?.message || DBS_REMINDER_DEFAULT_MESSAGE;
      additionalSurveyLinks.evening_diary = stripPidFromUrl(eveningDiarySurvey?.link || "");
      clearSavedStudyLinkStates();
      for (let i = 1; i <= 4; i += 1) {
        windowLinks[i] = stripPidFromUrl(study.windows?.[i - 1]?.link || getDefaultWindowTemplate(i));
      }
      refreshStudyWindowLabels(
        document.getElementById("studyWakeTime").value || "08:00",
        emaEndTimeInput.value || "18:30"
      );
      updateStudyLinkButtonStates();
      refreshAdditionalSurveyPreviewLinks();
      document.getElementById("studyModalTitle").textContent = "Edit Study";
      studySubmitBtn.textContent = "Save";
      openStudyModal();
    });
  });
  body.querySelectorAll(".regenerate-study").forEach((btn) => {
    btn.addEventListener("click", () => {
      const participantId = Number(btn.dataset.participantId);
      const participantCode = decodeURIComponent(btn.dataset.participantCode || "participant");
      if (!participantId) return;
      openConfirmModal(
        "Regenerate Random Times",
        `This will overwrite current unsent random times for ${participantCode}. Continue?`,
        async () => {
          await getJSON(`/api/scheduler/generate/${participantId}`, { method: "POST" });
          await Promise.all([loadDashboard(), loadLogs(), loadStudies()]);
        },
        "Generate"
      );
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
          clearSavedStudyLinkStates();
          updateStudyLinkButtonStates();
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
    ["participant_id", "phone", "status"],
    ...participantsCache.map((row) => [
      row.participant_id,
      row.phone,
      row.status || "",
    ]),
  ]);
}

function exportStudiesCsv() {
  if (!studiesCache.length) {
    openMessageModal("No Data", "There are no studies to export.");
    return;
  }

  const longRows = [];

  studiesCache.forEach((row) => {
    const participantId = row.participant_code || row.participant_id || "";
    const comments = row.comments || "";
    const displayWindows = getDisplayWindowsForStudy(row);
    const wakingTime = row.windows?.[0]?.start
      ? inferWakeTimeFromFirstWindowStart(row.windows[0].start, "20:30")
      : "";
    const morningSurveyTime = wakingTime ? shiftTime(wakingTime, 15) : "";

    const windowRangeByIndex = {};
    displayWindows.forEach((window, idx) => {
      const windowIndex = String(idx + 1);
      windowRangeByIndex[windowIndex] = `${window.start || ""}-${window.end || ""}`;
    });

    const dailyWindowTimeByIndex = {};
    const windowSchedules = row.window_schedules || {};
    Object.keys(windowSchedules).forEach((windowIndex) => {
      const byDate = {};
      (windowSchedules[windowIndex] || []).forEach((item) => {
        if (!item?.date || !item?.time) return;
        if (!byDate[item.date]) {
          byDate[item.date] = item.time;
        }
      });
      dailyWindowTimeByIndex[windowIndex] = byDate;
    });

    const additionalSurveyTimes = {};
    (row.additional_surveys || []).forEach((survey) => {
      if (survey?.survey_type && survey?.time) {
        additionalSurveyTimes[survey.survey_type] = survey.time;
      }
    });

    const dailyAdditionalTimes = { dbs_reminder: {}, morning: {}, evening_diary: {} };
    const additionalSchedules = row.additional_schedules || {};
    ["dbs_reminder", "evening_diary"].forEach((surveyType) => {
      (additionalSchedules[surveyType] || []).forEach((item) => {
        if (!item?.date || !item?.time) return;
        if (!dailyAdditionalTimes[surveyType][item.date]) {
          dailyAdditionalTimes[surveyType][item.date] = item.time;
        }
      });
    });

    const start = new Date(`${row.start_date}T00:00:00`);
    const end = new Date(`${row.end_date}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
      return;
    }

    for (let d = new Date(start), dayNumber = 1; d <= end; d.setDate(d.getDate() + 1), dayNumber += 1) {
      const studyDate = toYmd(d);
      longRows.push([
        participantId,
        studyDate,
        dayNumber,
        wakingTime,
        morningSurveyTime,
        dailyWindowTimeByIndex["1"]?.[studyDate] || windowRangeByIndex["1"] || "",
        dailyWindowTimeByIndex["2"]?.[studyDate] || windowRangeByIndex["2"] || "",
        dailyWindowTimeByIndex["3"]?.[studyDate] || windowRangeByIndex["3"] || "",
        dailyWindowTimeByIndex["4"]?.[studyDate] || windowRangeByIndex["4"] || "",
        dailyAdditionalTimes.dbs_reminder[studyDate] || "",
        dailyAdditionalTimes.evening_diary[studyDate] || additionalSurveyTimes.evening_diary || "",
        comments,
      ]);
    }
  });

  if (!longRows.length) {
    openMessageModal("No Data", "There are no valid study dates to export.");
    return;
  }

  downloadCsv("studies.csv", [
    [
      "Participant_ID",
      "Study_Date",
      "Day_Number",
      "Waking_Time",
      "Morning_Survey_Time",
      "Window_1_Time",
      "Window_2_Time",
      "Window_3_Time",
      "Window_4_Time",
      "DBS_Reminder_Time",
      "Evening_Diary_Time",
      "Comments",
    ],
    ...longRows,
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
  const eveningDiaryTime = eveningDiaryTimeInput.value || "20:30";
  refreshStudyWindowLabels(wakeTime, emaEndTimeInput.value || "18:30");
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
        survey_type: "morning",
        time: document.getElementById("studyWakeTime").value || "08:00",
        link: getAdditionalSurveyRawLink("morning"),
      },
        {
          survey_type: "dbs_reminder",
          time: dbsReminderTimeInput.value || "20:00",
          message: additionalSurveyLinks.dbs_reminder.trim(),
        },
      {
        survey_type: "evening_diary",
        time: eveningDiaryTime,
        link: getAdditionalSurveyRawLink("evening_diary"),
      },
    ],
  };
  if (!payload.participant_id) {
    openMessageModal("Participant Required", "Please select a participant.");
    return;
  }
  if (!payload.additional_surveys[0].link || !payload.additional_surveys[2].link) {
    openMessageModal("Missing Survey URLs", "Please set links for Morning and Evening Diary surveys.");
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
updateStudyLinkButtonStates();
refreshAdditionalSurveyPreviewLinks();
