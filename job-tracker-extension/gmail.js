// Scans Gmail for rejection emails and reconciles them against the
// Google Sheet: updates matching rows to "Rejected", or adds a new
// row if no matching application is found.

import { getAuthToken, getAllRows, updateRowStatus, appendRow } from "./sheets.js";

const GMAIL_BASE = "https://www.googleapis.com/gmail/v1/users/me";

const REJECTION_QUERY =
  'subject:(application OR position OR role) (rejected OR "not moving forward" OR "decided to move forward with other" OR "we won\'t be moving" OR "unfortunately" OR "other candidates") newer_than:30d';

const PROCESSED_IDS_KEY = "gmailProcessedMessageIds";
const LAST_SCAN_KEY = "lastGmailScanAt";
const MAX_PROCESSED_IDS = 1000;

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

async function gmailRequest(path, token) {
  const response = await fetch(`${GMAIL_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Gmail API error ${response.status}: ${body}`);
  }
  return response.json();
}

async function searchRejectionMessages(token) {
  const data = await gmailRequest(`/messages?q=${encodeURIComponent(REJECTION_QUERY)}&maxResults=50`, token);
  return data.messages || [];
}

async function fetchMessageDetail(token, id) {
  return gmailRequest(
    `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
    token
  );
}

function getHeader(message, name) {
  const header = message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return header?.value || "";
}

function capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}

function extractCompanyFromSender(fromHeader) {
  const angleMatch = fromHeader.match(/<([^>]+)>/);
  const email = angleMatch ? angleMatch[1] : fromHeader.trim();
  const domain = (email.split("@")[1] || "").toLowerCase();
  const domainParts = domain.split(".");
  let name = domainParts.length >= 2 ? domainParts[domainParts.length - 2] : domain;

  if (ATS_DOMAINS.includes(domain)) {
    const displayName = fromHeader.split("<")[0].trim().replace(/"/g, "");
    if (displayName) {
      name = displayName.split(/\s+/)[0];
    }
  }

  return capitalize(name);
}

function parseRejectionEmail(message) {
  const from = getHeader(message, "From");
  const dateHeader = getHeader(message, "Date");
  const company = extractCompanyFromSender(from);
  if (!company) return null;

  const receivedDate = dateHeader ? new Date(dateHeader) : new Date(Number(message.internalDate));
  const isoDate = isNaN(receivedDate.getTime())
    ? new Date().toISOString().slice(0, 10)
    : receivedDate.toISOString().slice(0, 10);

  return {
    id: message.id,
    company,
    date: isoDate,
    snippet: (message.snippet || "").slice(0, 200),
  };
}

function daysBetween(dateA, dateB) {
  const a = new Date(dateA);
  const b = new Date(dateB);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return Infinity;
  return Math.abs((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

async function crossReferenceAndUpdate(rejections) {
  if (rejections.length === 0) return 0;
  const rows = await getAllRows();
  let updatedCount = 0;

  for (const rejection of rejections) {
    const match = rows.find((row) => {
      if (row.status === "Rejected") return false;
      const companyMatches =
        row.company &&
        (row.company.toLowerCase().includes(rejection.company.toLowerCase()) ||
          rejection.company.toLowerCase().includes(row.company.toLowerCase()));
      return companyMatches && daysBetween(row.date, rejection.date) <= 7;
    });

    if (match) {
      await updateRowStatus(match.rowNumber, "Rejected");
      match.status = "Rejected"; // avoid re-matching the same row twice in this batch
    } else {
      await appendRow({
        date: rejection.date,
        company: rejection.company,
        role: "",
        source: "Gmail",
        url: "",
        status: "Rejected",
        notes: rejection.snippet,
      });
    }
    updatedCount += 1;
  }

  return updatedCount;
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

// Searches Gmail for rejection emails, cross-references them against the
// sheet, and returns { count, error }. Safe to call repeatedly — already
// processed messages are skipped.
export async function scanGmailForRejections() {
  try {
    const token = await getAuthToken(true);
    const messages = await searchRejectionMessages(token);
    const processedIds = await getProcessedIds();
    const newMessages = messages.filter((m) => !processedIds.includes(m.id));

    if (newMessages.length === 0) {
      await setLastScanTime();
      return { count: 0 };
    }

    const details = await Promise.all(newMessages.map((m) => fetchMessageDetail(token, m.id)));
    const rejections = details.map(parseRejectionEmail).filter(Boolean);
    const updatedCount = await crossReferenceAndUpdate(rejections);

    await addProcessedIds(newMessages.map((m) => m.id));
    await setLastScanTime();

    return { count: updatedCount };
  } catch (err) {
    console.error("Job Tracker: Gmail scan failed", err);
    return { count: 0, error: err.message };
  }
}
