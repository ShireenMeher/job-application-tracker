import { SPREADSHEET_ID } from "../config.js";

const LOG_KEY = "dodoLog";

const todayCountEl = document.getElementById("todayCount");
const recentListEl = document.getElementById("recentList");
const emptyStateEl = document.getElementById("emptyState");
const scanGmailBtn = document.getElementById("scanGmailBtn");
const gmailStatusEl = document.getElementById("gmailStatus");
const manualForm = document.getElementById("manualForm");
const openSheetLink = document.getElementById("openSheetLink");

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

async function loadLog() {
  const { [LOG_KEY]: log = [] } = await chrome.storage.local.get(LOG_KEY);
  return log;
}

function renderTodayCount(log) {
  const today = todayISO();
  const count = log.filter((entry) => entry.date === today).length;
  todayCountEl.textContent = String(count);
}

function renderRecentList(log) {
  const recent = log.slice(0, 5);
  recentListEl.innerHTML = "";
  emptyStateEl.hidden = recent.length > 0;

  for (const entry of recent) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="entry-main">
        <div class="entry-company">${escapeHtml(entry.company || "Unknown company")}</div>
        <div class="entry-role">${escapeHtml(entry.role || "")}</div>
      </div>
      <div class="entry-meta">
        <span class="source-tag">${escapeHtml(entry.source || "Other")}</span>
        <div>${escapeHtml(entry.date || "")}</div>
      </div>
    `;
    recentListEl.appendChild(li);
  }
}

async function refreshUI() {
  const log = await loadLog();
  renderTodayCount(log);
  renderRecentList(log);
}

function showGmailStatus(text) {
  gmailStatusEl.textContent = text;
  gmailStatusEl.hidden = false;
}

manualForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const company = document.getElementById("fieldCompany").value.trim();
  const role = document.getElementById("fieldRole").value.trim();
  const source = document.getElementById("fieldSource").value;
  const status = document.getElementById("fieldStatus").value;
  const notes = document.getElementById("fieldNotes").value.trim();

  if (!company || !role) return;

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chrome.runtime.sendMessage(
    {
      type: "MANUAL_LOG",
      company,
      role,
      source,
      status,
      notes,
      url: activeTab?.url || "",
    },
    async () => {
      manualForm.reset();
      document.getElementById("fieldSource").value = "Other";
      document.getElementById("fieldStatus").value = "Applied";
      await refreshUI();
    }
  );
});

scanGmailBtn.addEventListener("click", () => {
  scanGmailBtn.disabled = true;
  scanGmailBtn.textContent = "Scanning…";
  gmailStatusEl.hidden = true;

  chrome.runtime.sendMessage({ type: "SCAN_GMAIL" }, async (response) => {
    scanGmailBtn.disabled = false;
    scanGmailBtn.textContent = "Scan Gmail";

    if (chrome.runtime.lastError) {
      showGmailStatus("Scan failed to start. Try again.");
      return;
    }
    if (response?.error) {
      showGmailStatus(`Scan failed: ${response.error}`);
      return;
    }

    const count = response?.count || 0;
    showGmailStatus(
      count > 0 ? `Found ${count} rejection${count === 1 ? "" : "s"} — Sheet updated` : "No new rejections found"
    );
    await refreshUI();
  });
});

openSheetLink.addEventListener("click", (e) => {
  if (!SPREADSHEET_ID || SPREADSHEET_ID === "YOUR_GOOGLE_SHEET_ID_HERE") {
    e.preventDefault();
    showGmailStatus("Set SPREADSHEET_ID in config.js first.");
  }
});
openSheetLink.href = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`;

refreshUI();
