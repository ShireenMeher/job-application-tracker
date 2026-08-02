// Scans Gmail for application status-update emails (rejected, interview,
// assessment, offer) and reconciles them against the Google Sheet: updates
// the matching row's Status. Emails with no matching tracked application
// are skipped — this only marks applications that are already logged,
// never fabricates new rows.
//
// Matching is tiered, strongest signal first:
//   1. Exact Job ID match (extracted from the application URL when logged,
//      and from links/text in the email) — decisive on its own.
//   2. Company match with exactly one open (non-Rejected) application at
//      that company — unambiguous.
//   3. Company match with multiple open applications — disambiguated by
//      how well each row's Role appears in the email text.
//   4. Still ambiguous — skipped rather than guessed.

import { getAuthToken, getAllRows, updateRowStatus } from "./sheets.js";
import { extractJobIdFromText } from "./jobid.js";
import { localDateISO } from "./date.js";

const GMAIL_BASE = "https://www.googleapis.com/gmail/v1/users/me";

const STATUS_UPDATE_QUERY =
  'subject:(application OR position OR role OR interview OR offer OR assessment) ' +
  '(rejected OR "not moving forward" OR "decided to move forward with other" OR "we won\'t be moving" OR ' +
  'unfortunately OR "other candidates" OR "not selected" OR interview OR "next round" OR "phone screen" OR ' +
  'assessment OR offer OR congratulations) newer_than:60d';

const PROCESSED_IDS_KEY = "gmailProcessedMessageIds";
const LAST_SCAN_KEY = "lastGmailScanAt";
const MAX_PROCESSED_IDS = 1000;
const LOG_KEY = "dodoLog";

const ATS_DOMAINS = [
  "greenhouse.io",
  "lever.co",
  "myworkday.com",
  "icims.com",
  "smartrecruiters.com",
  "ashbyhq.com",
  "bamboohr.com",
  "jobvite.com",
  "workable.com",
];

// Checked in priority order — a rejection mention wins even if the email
// also references an earlier interview ("Thanks for interviewing...
// unfortunately we've decided...").
const STATUS_KEYWORDS = [
  {
    status: "Rejected",
    words: [
      "rejected",
      "not moving forward",
      "decided to move forward with other",
      "won't be moving",
      "unfortunately",
      "other candidates",
      "not selected",
      "will not be moving forward",
      "pursue other candidates",
    ],
  },
  {
    status: "Offer",
    words: ["pleased to offer", "excited to offer", "job offer", "offer letter", "extend an offer"],
  },
  {
    status: "OA Received",
    words: ["online assessment", "coding challenge", "technical assessment", "assessment invite", "take-home"],
  },
  {
    status: "Interviewing",
    words: ["interview", "next round", "phone screen", "schedule a call", "schedule a time", "would like to speak"],
  },
];

const STOPWORDS = new Set(["the", "a", "an", "of", "and", "or", "at", "in", "on", "for", "to", "with"]);
const GMAIL_FETCH_CONCURRENCY = 3;
const MAX_REQUEST_ATTEMPTS = 5;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gmailRequest(path, token) {
  for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
    const response = await fetch(`${GMAIL_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok) return response.json();

    const body = await response.text().catch(() => "");
    const retryable = response.status === 429 || response.status === 408 || response.status >= 500;
    if (!retryable || attempt === MAX_REQUEST_ATTEMPTS - 1) {
      throw new Error(`Gmail API error ${response.status}: ${body}`);
    }

    const retryAfterSeconds = Number(response.headers.get("Retry-After"));
    const serverDelay = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0;
    const exponentialDelay = 750 * 2 ** attempt;
    const jitter = Math.floor(Math.random() * 250);
    await delay(Math.max(serverDelay, exponentialDelay) + jitter);
  }

  throw new Error("Gmail API request failed after retries");
}

async function searchStatusUpdateMessages(token) {
  const data = await gmailRequest(`/messages?q=${encodeURIComponent(STATUS_UPDATE_QUERY)}&maxResults=50`, token);
  return data.messages || [];
}

// format=full (rather than metadata) so we can search the body for
// job-ID links/text, not just the subject/snippet.
async function fetchMessageDetail(token, id) {
  return gmailRequest(`/messages/${id}?format=full`, token);
}

// Avoid a burst of up to 50 simultaneous Gmail requests. A small worker
// pool stays well below the per-user concurrent-request limit while still
// making scans reasonably quick.
async function fetchMessageDetails(token, messages) {
  const details = new Array(messages.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < messages.length) {
      const index = nextIndex;
      nextIndex += 1;
      details[index] = await fetchMessageDetail(token, messages[index].id);
    }
  }

  const workerCount = Math.min(GMAIL_FETCH_CONCURRENCY, messages.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return details;
}

function getHeader(message, name) {
  const header = message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return header?.value || "";
}

function capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}

function decodeBase64Url(data) {
  if (!data) return "";
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return decodeURIComponent(escape(atob(base64)));
  } catch {
    try {
      return atob(base64);
    } catch {
      return "";
    }
  }
}

function extractRawBody(payload) {
  if (!payload) return "";
  if (payload.body?.data && (payload.mimeType === "text/plain" || payload.mimeType === "text/html")) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    return payload.parts.map(extractRawBody).join("\n");
  }
  return "";
}

function extractLinks(html) {
  const links = [];
  const regex = /href=["']([^"']+)["']/gi;
  let match;
  while ((match = regex.exec(html))) links.push(match[1]);
  return links;
}

function extractCompanyFromSender(fromHeader) {
  const angleMatch = fromHeader.match(/<([^>]+)>/);
  const email = angleMatch ? angleMatch[1] : fromHeader.trim();
  const domain = (email.split("@")[1] || "").toLowerCase();
  const domainParts = domain.split(".");
  let name = domainParts.length >= 2 ? domainParts[domainParts.length - 2] : domain;

  if (ATS_DOMAINS.some((atsDomain) => domain === atsDomain || domain.endsWith(`.${atsDomain}`))) {
    const displayName = fromHeader.split("<")[0].trim().replace(/"/g, "");
    if (displayName) {
      name = displayName.split(/\s+/)[0];
    }
  }

  return capitalize(name);
}

function classifyStatus(text) {
  for (const { status, words } of STATUS_KEYWORDS) {
    if (words.some((word) => text.includes(word))) return status;
  }
  return null;
}

function normalizeTokens(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// Fraction of the row's Role tokens that appear in the email text — used
// to disambiguate between multiple open applications at the same company.
function roleMatchScore(role, text) {
  const tokens = normalizeTokens(role);
  if (tokens.length === 0) return 0;
  const found = tokens.filter((t) => text.includes(t)).length;
  return found / tokens.length;
}

function parseStatusEmail(message) {
  const from = getHeader(message, "From");
  const subject = getHeader(message, "Subject");
  const dateHeader = getHeader(message, "Date");
  const company = extractCompanyFromSender(from);
  if (!company) return null;

  const rawBody = extractRawBody(message.payload);
  const links = extractLinks(rawBody).join(" ");
  const plainText = rawBody.replace(/<[^>]+>/g, " ");
  const fullText = `${subject} ${message.snippet || ""} ${plainText} ${links}`;
  const lowerText = fullText.toLowerCase();

  const status = classifyStatus(lowerText);
  if (!status) return null;

  const jobId = extractJobIdFromText(fullText);

  const receivedDate = dateHeader ? new Date(dateHeader) : new Date(Number(message.internalDate));
  const isoDate = isNaN(receivedDate.getTime())
    ? localDateISO()
    : localDateISO(receivedDate);

  return {
    id: message.id,
    company,
    date: isoDate,
    status,
    jobId,
    text: lowerText,
    snippet: (message.snippet || "").slice(0, 200),
  };
}

async function crossReferenceAndUpdate(updates, interactive) {
  if (updates.length === 0) return { count: 0, matchedIds: [] };
  const rows = await getAllRows(interactive);
  let updatedCount = 0;
  const matchedIds = [];

  for (const update of updates) {
    const openRows = rows.filter((row) => row.status !== "Rejected");
    let match = null;

    // Tier 1: exact Job ID match — decisive regardless of company text or date.
    if (update.jobId) {
      match = openRows.find((row) => row.jobId && row.jobId.toLowerCase() === update.jobId.toLowerCase());
    }

    if (!match) {
      const companyCandidates = openRows.filter((row) => {
        if (!row.company) return false;
        const companyMatches =
          row.company.toLowerCase().includes(update.company.toLowerCase()) ||
          update.company.toLowerCase().includes(row.company.toLowerCase());
        return companyMatches && row.date <= update.date;
      });

      if (companyCandidates.length === 1) {
        // Tier 2: only one open application at this company — unambiguous.
        match = companyCandidates[0];
      } else if (companyCandidates.length > 1) {
        // Tier 3: multiple open applications — disambiguate by Role overlap.
        const scored = companyCandidates
          .map((row) => ({ row, score: roleMatchScore(row.role, update.text) }))
          .sort((a, b) => b.score - a.score);
        const [best, second] = scored;
        if (best.score >= 0.75 && best.score > (second?.score ?? 0)) {
          match = best.row;
        } else {
          console.warn(
            `Dodo: ambiguous status update for "${update.company}" (${companyCandidates.length} open applications) — couldn't tell which Role it's for, skipping.`
          );
        }
      }
    }

    // Tier 4: no match found — skip rather than guess.
    if (!match) continue;

    await updateRowStatus(match.rowNumber, update.status, interactive);
    match.status = update.status; // avoid re-matching the same row twice in this batch
    await updateLocalStatus(match, update.status);
    matchedIds.push(update.id);
    updatedCount += 1;
  }

  return { count: updatedCount, matchedIds };
}

// Keep the popup/local cache consistent with status changes written to the
// sheet. Job ID is strongest; the remaining fields mirror the matching row.
async function updateLocalStatus(sheetRow, status) {
  const { [LOG_KEY]: log = [] } = await chrome.storage.local.get(LOG_KEY);
  const localEntry = log.find((entry) => {
    if (sheetRow.jobId && entry.jobId) {
      return sheetRow.jobId.toLowerCase() === entry.jobId.toLowerCase();
    }
    return (
      entry.date === sheetRow.date &&
      entry.company?.toLowerCase() === sheetRow.company?.toLowerCase() &&
      entry.role?.toLowerCase() === sheetRow.role?.toLowerCase()
    );
  });
  if (!localEntry) return;
  localEntry.status = status;
  await chrome.storage.local.set({ [LOG_KEY]: log });
}

async function getProcessedIds() {
  const { [PROCESSED_IDS_KEY]: ids = [] } = await chrome.storage.local.get(PROCESSED_IDS_KEY);
  return ids;
}

async function addProcessedIds(newIds) {
  const existing = await getProcessedIds();
  const merged = [...existing, ...newIds].slice(-MAX_PROCESSED_IDS);
  await chrome.storage.local.set({ [PROCESSED_IDS_KEY]: merged });
}

async function setLastScanTime() {
  await chrome.storage.local.set({ [LAST_SCAN_KEY]: Date.now() });
}

// Searches Gmail for status-update emails from the last 60 days,
// cross-references them against the sheet, and returns { count, error }.
// Safe to call repeatedly — already processed messages are skipped.
let activeScan = null;

async function performGmailScan(interactive) {
  try {
    const token = await getAuthToken(interactive);
    const messages = await searchStatusUpdateMessages(token);
    const processedIds = await getProcessedIds();
    const newMessages = messages.filter((m) => !processedIds.includes(m.id));

    if (newMessages.length === 0) {
      await setLastScanTime();
      return { count: 0 };
    }

    const details = await fetchMessageDetails(token, newMessages);
    const updates = details.map(parseStatusEmail).filter(Boolean);
    const { count: updatedCount, matchedIds } = await crossReferenceAndUpdate(updates, interactive);

    // Unmatched messages stay eligible for a later scan: the application
    // may be logged afterward or become matchable after Sheet corrections.
    const irrelevantIds = details
      .filter((message) => !updates.some((update) => update.id === message.id))
      .map((message) => message.id);
    await addProcessedIds([...matchedIds, ...irrelevantIds]);
    await setLastScanTime();

    return { count: updatedCount };
  } catch (err) {
    console.error("Dodo: Gmail scan failed", err);
    return { count: 0, error: err.message };
  }
}

// Manual clicks and the daily alarm can land close together. Share the
// in-flight result instead of starting a second scan against the same user.
export function scanGmailForUpdates(interactive = false) {
  if (activeScan) return activeScan;
  activeScan = performGmailScan(interactive).finally(() => {
    activeScan = null;
  });
  return activeScan;
}
