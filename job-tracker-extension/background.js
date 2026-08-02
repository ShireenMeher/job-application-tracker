// MV3 service worker: receives detections from content scripts and the
// popup, persists them to chrome.storage.local, logs them to Google
// Sheets (queueing on failure), keeps the badge/counter in sync, and
// runs the periodic Gmail status-update scan.

import { appendRow } from "./sheets.js";
import { scanGmailForUpdates } from "./gmail.js";
import { extractJobIdFromUrl } from "./jobid.js";
import { localDateISO } from "./date.js";

const LOG_KEY = "dodoLog";
const QUEUE_KEY = "dodoQueue";
const BADGE_COLOR = "#4F46E5";
const GMAIL_ALARM = "gmailScan";
const GMAIL_ALARM_PERIOD_MINUTES = 24 * 60;
const REFRESH_ALARM = "refreshCounts";
const REFRESH_ALARM_PERIOD_MINUTES = 30;
const QUEUE_ALARM = "retrySheetQueue";
const QUEUE_ALARM_PERIOD_MINUTES = 15;
const MAX_LOCAL_LOG_ENTRIES = 5000;

function todayISO() {
  return localDateISO();
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

// A page can re-trigger APPLICATION_DETECTED for the same job (refreshing
// an already-confirmed tab, revisiting it later, etc.) — this checks
// whether we've already logged this exact job, so refreshing doesn't
// create a duplicate row every time. Manual entries are never deduped;
// that's an explicit user action.
function isDuplicateDetection(log, fullEntry) {
  return log.some((e) => {
    if (fullEntry.jobId && e.jobId) return e.jobId === fullEntry.jobId && e.company === fullEntry.company;
    return Boolean(fullEntry.url) && e.url === fullEntry.url;
  });
}

// Serializes logApplication calls so two near-simultaneous messages (e.g.
// two tabs detecting around the same time) can't race on the storage
// read-modify-write and clobber each other's entry.
let writeChain = Promise.resolve();
function serialized(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

// Persists an entry, attempts to log it to Sheets (queueing on failure),
// and updates badge/counter everywhere. Returns the updated today count.
async function logApplication(entry) {
  return serialized(async () => {
    const fullEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      date: todayISO(),
      company: entry.company || "",
      role: entry.role || "",
      source: entry.source || "Other",
      url: entry.url || "",
      status: entry.status || "Applied",
      notes: entry.notes || "",
      jobId: extractJobIdFromUrl(entry.url),
      createdAt: Date.now(),
    };

    const log = await getLog();

    if (entry.type === "APPLICATION_DETECTED" && isDuplicateDetection(log, fullEntry)) {
      return { todayCount: countToday(log), queued: false, duplicate: true };
    }

    log.unshift(fullEntry);
    if (log.length > MAX_LOCAL_LOG_ENTRIES) log.length = MAX_LOCAL_LOG_ENTRIES;
    await setLog(log);

    const todayCount = countToday(log);
    await updateBadge(todayCount);
    await broadcastCounterUpdate(todayCount);

    let queued = false;
    try {
      await appendRow(fullEntry);
    } catch (err) {
      console.error("Dodo: Sheets append failed, queueing entry", err);
      const queue = await getQueue();
      queue.push(fullEntry);
      await setQueue(queue);
      queued = true;
    }

    return { todayCount, queued };
  });
}

async function flushQueue() {
  return serialized(async () => {
    const queue = await getQueue();
    if (queue.length === 0) return;

    const remaining = [];
    for (const entry of queue) {
      try {
        await appendRow(entry, false);
      } catch (err) {
        console.error("Dodo: retry failed for queued entry", err);
        remaining.push(entry);
      }
    }
    await setQueue(remaining);
  });
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

async function runGmailScan(interactive = false) {
  const result = await scanGmailForUpdates(interactive);
  return result;
}

async function ensureGmailAlarm() {
  const alarm = await chrome.alarms.get(GMAIL_ALARM);
  if (!alarm) {
    chrome.alarms.create(GMAIL_ALARM, { periodInMinutes: GMAIL_ALARM_PERIOD_MINUTES });
  }
}

async function ensureRefreshAlarm() {
  const alarm = await chrome.alarms.get(REFRESH_ALARM);
  if (!alarm) {
    chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: REFRESH_ALARM_PERIOD_MINUTES });
  }
}

async function ensureQueueAlarm() {
  const alarm = await chrome.alarms.get(QUEUE_ALARM);
  if (!alarm) {
    chrome.alarms.create(QUEUE_ALARM, { periodInMinutes: QUEUE_ALARM_PERIOD_MINUTES });
  }
}

// The badge and floating counter widgets only update in response to an
// event (a new application logged, a page loading). With zero activity
// they'd otherwise sit showing a stale count indefinitely — this makes
// them self-correct at the start of a new day without needing anything
// to happen first.
async function refreshCounts() {
  const log = await getLog();
  const todayCount = countToday(log);
  await updateBadge(todayCount);
  await broadcastCounterUpdate(todayCount);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "APPLICATION_DETECTED" || message?.type === "MANUAL_LOG") {
    logApplication(message)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message?.type === "GET_TODAY_COUNT") {
    getLog()
      .then((log) => sendResponse({ todayCount: countToday(log) }))
      .catch((err) => sendResponse({ todayCount: 0, error: err.message }));
    return true;
  }

  if (message?.type === "OPEN_POPUP") {
    openExtensionPopup();
    return false;
  }

  if (message?.type === "SCAN_GMAIL") {
    runGmailScan(true)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ count: 0, error: err.message }));
    return true;
  }

  return false;
});

// Network-level confirmation for ATS platforms where we know the exact
// submit-application API call — more reliable than DOM text-scraping
// where available, since it's the actual API contract rather than
// rendered copy. Currently just Ashby (its GraphQL endpoint conveniently
// puts the mutation name in the URL's ?op= query param); other ATSs would
// need their own endpoint identified the same way before being added
// here. This only signals the content script to fire its existing
// detection — it doesn't parse company/role itself.
const NETWORK_SUBMIT_SIGNALS = [
  { urlIncludes: "op=ApiSubmitSingleApplicationFormAction", method: "POST" }, // Ashby
];

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0 || details.statusCode !== 200) return;
    const matched = NETWORK_SUBMIT_SIGNALS.some(
      (signal) => details.method === signal.method && details.url.includes(signal.urlIncludes)
    );
    if (!matched) return;
    chrome.tabs.sendMessage(details.tabId, { type: "NETWORK_SUBMIT_DETECTED" }).catch(() => {});
  },
  { urls: ["*://*.ashbyhq.com/*"] }
);

chrome.runtime.onStartup.addListener(async () => {
  await flushQueue();
  const log = await getLog();
  await updateBadge(countToday(log));
  await ensureGmailAlarm();
  await ensureRefreshAlarm();
  await ensureQueueAlarm();
});

chrome.runtime.onInstalled.addListener(async () => {
  await flushQueue();
  const log = await getLog();
  await updateBadge(countToday(log));
  await ensureGmailAlarm();
  await ensureRefreshAlarm();
  await ensureQueueAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === GMAIL_ALARM) {
    runGmailScan(false).catch((err) => console.error("Dodo: scheduled Gmail scan failed", err));
  } else if (alarm.name === REFRESH_ALARM) {
    refreshCounts().catch((err) => console.error("Dodo: count refresh failed", err));
  } else if (alarm.name === QUEUE_ALARM) {
    flushQueue().catch((err) => console.error("Dodo: queue flush failed", err));
  }
});
