// MV3 service worker: receives detections from content scripts and the
// popup, persists them to chrome.storage.local, logs them to Google
// Sheets (queueing on failure), keeps the badge/counter in sync, and
// runs the periodic Gmail rejection scan.

import { appendRow } from "./sheets.js";
import { scanGmailForRejections } from "./gmail.js";

const LOG_KEY = "jobTrackerLog";
const QUEUE_KEY = "jobTrackerQueue";
const BADGE_COLOR = "#4F46E5";
const GMAIL_ALARM = "gmailScan";
const GMAIL_ALARM_PERIOD_MINUTES = 24 * 60;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

async function getLog() {
  const { [LOG_KEY]: log = [] } = await chrome.storage.local.get(LOG_KEY);
  return log;
}

async function setLog(log) {
  await chrome.storage.local.set({ [LOG_KEY]: log });
}

async function getQueue() {
  const { [QUEUE_KEY]: queue = [] } = await chrome.storage.local.get(QUEUE_KEY);
  return queue;
}

async function setQueue(queue) {
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

function countToday(log) {
  const today = todayISO();
  return log.filter((entry) => entry.date === today).length;
}

async function updateBadge(count) {
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
}

async function broadcastCounterUpdate(count) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    chrome.tabs.sendMessage(tab.id, { type: "COUNTER_UPDATE", count }).catch(() => {
      // No content script listening in this tab — ignore.
    });
  }
}

// Persists an entry, attempts to log it to Sheets (queueing on failure),
// and updates badge/counter everywhere. Returns the updated today count.
async function logApplication(entry) {
  const fullEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    date: todayISO(),
    company: entry.company || "",
    role: entry.role || "",
    source: entry.source || "Other",
    url: entry.url || "",
    status: entry.status || "Applied",
    notes: entry.notes || "",
    createdAt: Date.now(),
  };

  const log = await getLog();
  log.unshift(fullEntry);
  await setLog(log);

  const todayCount = countToday(log);
  await updateBadge(todayCount);
  await broadcastCounterUpdate(todayCount);

  let queued = false;
  try {
    await appendRow(fullEntry);
  } catch (err) {
    console.error("Job Tracker: Sheets append failed, queueing entry", err);
    const queue = await getQueue();
    queue.push(fullEntry);
    await setQueue(queue);
    queued = true;
  }

  return { todayCount, queued };
}

async function flushQueue() {
  const queue = await getQueue();
  if (queue.length === 0) return;

  const remaining = [];
  for (const entry of queue) {
    try {
      await appendRow(entry);
    } catch (err) {
      console.error("Job Tracker: retry failed for queued entry", err);
      remaining.push(entry);
    }
  }
  await setQueue(remaining);
}

async function openExtensionPopup() {
  try {
    await chrome.action.openPopup();
  } catch (err) {
    // chrome.action.openPopup() isn't available on all Chrome versions —
    // fall back to a small popup window.
    chrome.windows.create({
      url: chrome.runtime.getURL("popup/popup.html"),
      type: "popup",
      width: 380,
      height: 560,
    });
  }
}

async function runGmailScan() {
  const result = await scanGmailForRejections();
  return result;
}

async function ensureGmailAlarm() {
  const alarm = await chrome.alarms.get(GMAIL_ALARM);
  if (!alarm) {
    chrome.alarms.create(GMAIL_ALARM, { periodInMinutes: GMAIL_ALARM_PERIOD_MINUTES });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "APPLICATION_DETECTED" || message?.type === "MANUAL_LOG") {
    logApplication(message).then((result) => {
      sendResponse({ success: true, ...result });
    });
    return true;
  }

  if (message?.type === "GET_TODAY_COUNT") {
    getLog().then((log) => {
      sendResponse({ todayCount: countToday(log) });
    });
    return true;
  }

  if (message?.type === "OPEN_POPUP") {
    openExtensionPopup();
    return false;
  }

  if (message?.type === "SCAN_GMAIL") {
    runGmailScan().then((result) => sendResponse(result));
    return true;
  }

  return false;
});

chrome.runtime.onStartup.addListener(async () => {
  await flushQueue();
  const log = await getLog();
  await updateBadge(countToday(log));
  await ensureGmailAlarm();
});

chrome.runtime.onInstalled.addListener(async () => {
  await flushQueue();
  const log = await getLog();
  await updateBadge(countToday(log));
  await ensureGmailAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === GMAIL_ALARM) {
    runGmailScan();
  }
});
