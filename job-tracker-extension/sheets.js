// Thin wrapper around the Google Sheets API v4, authenticated via
// chrome.identity. Used by background.js (logging) and gmail.js
// (cross-referencing rejections).

import { SPREADSHEET_ID, SHEET_NAME } from "./config.js";

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const HEADER_ROW = ["Date", "Company", "Role", "Source", "URL", "Status", "Notes"];

export function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || "No auth token returned"));
        return;
      }
      resolve(token);
    });
  });
}

function removeCachedToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

async function sheetsRequest(path, options = {}, interactive = true) {
  let token = await getAuthToken(interactive);

  const doFetch = async (authToken) =>
    fetch(`${SHEETS_BASE}/${SPREADSHEET_ID}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });

  let response = await doFetch(token);

  if (response.status === 401) {
    await removeCachedToken(token);
    token = await getAuthToken(interactive);
    response = await doFetch(token);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Sheets API error ${response.status}: ${body}`);
  }

  return response.status === 204 ? null : response.json();
}

function rowRange(a1) {
  return encodeURIComponent(`${SHEET_NAME}!${a1}`);
}

let headerEnsured = false;

async function ensureHeaderRow() {
  if (headerEnsured) return;
  const data = await sheetsRequest(`/values/${rowRange("A1:G1")}`, { method: "GET" });
  const hasHeader = data?.values?.[0]?.[0] === "Date";
  if (!hasHeader) {
    await sheetsRequest(
      `/values/${rowRange("A1:G1")}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        body: JSON.stringify({ values: [HEADER_ROW] }),
      }
    );
  }
  headerEnsured = true;
}

export async function appendRow(entry) {
  await ensureHeaderRow();
  const values = [
    [
      entry.date,
      entry.company || "",
      entry.role || "",
      entry.source || "Other",
      entry.url || "",
      entry.status || "Applied",
      entry.notes || "",
    ],
  ];
  await sheetsRequest(
    `/values/${rowRange("A:G")}:append?valueInputOption=USER_ENTERED`,
    {
      method: "POST",
      body: JSON.stringify({ values }),
    }
  );
}

// Returns existing rows (skipping the header) as
// { rowNumber, date, company, role, source, url, status, notes }.
export async function getAllRows() {
  const data = await sheetsRequest(`/values/${rowRange("A2:G")}`, { method: "GET" });
  const rows = data?.values || [];
  return rows.map((row, i) => ({
    rowNumber: i + 2,
    date: row[0] || "",
    company: row[1] || "",
    role: row[2] || "",
    source: row[3] || "",
    url: row[4] || "",
    status: row[5] || "",
    notes: row[6] || "",
  }));
}

export async function updateRowStatus(rowNumber, status) {
  await sheetsRequest(
    `/values/${rowRange(`F${rowNumber}`)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      body: JSON.stringify({ values: [[status]] }),
    }
  );
}
