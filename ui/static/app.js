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
let activeWindow = null;
let editingParticipant = null;
let editingParticipantStatus = "active";
let editingStudy = null;
let confirmDeleteAction = null;
let authRequired = false;

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
const authSubmitBtn = document.getElementById("authSubmitBtn");
const appRoot = document.getElementById("appRoot");
let smsTargetParticipantId = null;
let smsTargetParticipantLabel = "";

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

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function renderStudyParticipantOptions(participants, selectedId = null) {
  const options = ['<option value="">Select participant</option>'];
  participants.forEach((p) => {
    const selected = Number(selectedId) === p.id ? " selected" : "";
    options.push(`<option value="${p.id}"${selected}>${p.participant_id}</option>`);
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
    openLinkModal(`Set Link for Window ${activeWindow}`, windowLinks[activeWindow], false);
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
  document.getElementById("promptsPerDay").value = 4;
  for (let i = 1; i <= 4; i += 1) windowLinks[i] = "";
  updateWindowBadgeStates();
  document.getElementById("studyModalTitle").textContent = "Save Study";
  studySubmitBtn.textContent = "Save";
  openStudyModal();
});

document.getElementById("closeParticipantModalX").addEventListener("click", closeParticipantModal);
document.getElementById("closeStudyModalX").addEventListener("click", closeStudyModal);
document.getElementById("closeWindowLinkModalX").addEventListener("click", closeLinkModal);
document.getElementById("closeConfirmModalX").addEventListener("click", closeConfirmModal);
document.getElementById("cancelConfirmBtn").addEventListener("click", closeConfirmModal);
document.getElementById("closeMessageModalX").addEventListener("click", closeMessageModal);
document.getElementById("closeMessageBtn").addEventListener("click", closeMessageModal);
document.getElementById("closeSmsModalX").addEventListener("click", closeSmsModal);
document.getElementById("closeSmsBtn").addEventListener("click", closeSmsModal);
document.getElementById("confirmDeleteBtn").addEventListener("click", async () => {
  if (!confirmDeleteAction) return;
  await confirmDeleteAction();
  closeConfirmModal();
});
document.getElementById("closeWindowLinkBtn").addEventListener("click", closeLinkModal);
document.getElementById("saveWindowLinkBtn").addEventListener("click", () => {
  if (!activeWindow) return;
  const value = windowLinkInput.value.trim();
  if (!isValidHttpUrl(value)) {
    openMessageModal("Invalid Link", "Please enter a valid URL starting with http:// or https://");
    return;
  }
  windowLinks[activeWindow] = value;
  updateWindowBadgeStates();
  closeLinkModal();
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
    await Promise.all([loadDashboard(), loadParticipants(), loadLogs(), loadStudies()]);
  } catch {
    openMessageModal("Sign In Failed", "Invalid username or password.");
  } finally {
    authSubmitBtn.disabled = false;
    authSubmitBtn.textContent = "Sign In";
  }
});

async function loadDashboard() {
  const data = await getJSON("/api/dashboard");
  document.getElementById("activeStudies").textContent = data.active_studies;
  document.getElementById("participants").textContent = data.participants_enrolled;
  document.getElementById("sentToday").textContent = data.messages_sent_today;
  document.getElementById("compliance").textContent = `${data.compliance_percent}%`;
}

async function loadParticipants() {
  const rows = await getJSON("/api/participants");
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
          return `<button type="button" class="tag button-tag" data-link="${encodeAttr(w.link || "")}" data-label="Window ${i + 1}" data-schedule="${encodeAttr(JSON.stringify(schedule))}">W${i + 1} ${w.start}-${w.end}</button>`;
        })
        .join("");
      return `<tr>
        <td>${r.participant_code || `#${r.participant_id || "-"}`}</td>
        <td>${r.start_date} to ${r.end_date}</td>
        <td>${r.comments || "-"}</td>
        <td><div class="stacked-tags">${windows}</div></td>
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
      const link = decodeURIComponent(btn.dataset.link || "") || "No link configured";
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
      for (let i = 1; i <= 4; i += 1) {
        windowLinks[i] = study.windows?.[i - 1]?.link || "";
      }
      updateWindowBadgeStates();
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
      openLinkModal(`Set Link for Window ${i}`, windowLinks[i], false);
      return;
    }
  }
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
  };
  if (!payload.participant_id) {
    openMessageModal("Participant Required", "Please select a participant.");
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
  await Promise.all([loadDashboard(), loadParticipants(), loadLogs(), loadStudies()]);
}

bootstrap();
updateWindowBadgeStates();
