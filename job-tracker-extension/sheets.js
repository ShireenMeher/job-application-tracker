// Thin wrapper around the Google Sheets API v4, authenticated via
// chrome.identity. Used by background.js (logging) and gmail.js
// (cross-referencing rejections).

import { SPREADSHEET_ID, SHEET_NAME } from "./config.js";

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const HEADER_ROW = ["Date", "Company", "Role", "Source", "URL", "Status", "Notes", "Job ID"];

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

let cachedSheetId = null;

async function getSheetId(interactive = true) {
  if (cachedSheetId !== null) return cachedSheetId;
  const data = await sheetsRequest("?fields=sheets.properties", { method: "GET" }, interactive);
  const sheet = data?.sheets?.find((s) => s.properties.title === SHEET_NAME);
  if (!sheet) throw new Error(`Sheet tab "${SHEET_NAME}" not found`);
  cachedSheetId = sheet.properties.sheetId;
  return cachedSheetId;
}

// Bold, colored, frozen header row plus sane column widths — applied once
// ever (tracked in storage, independent of whether the header text itself
// needed rewriting) so an existing plain-looking sheet gets styled too.
async function applyHeaderFormatting(interactive = true) {
  const sheetId = await getSheetId(interactive);
  await sheetsRequest(":batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      requests: [
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: "gridProperties.frozenRowCount",
          },
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true, foregroundColor: { red: 0.31, green: 0.27, blue: 0.9 } },
                backgroundColor: { red: 0.93, green: 0.94, blue: 1 },
              },
            },
            fields: "userEnteredFormat(textFormat,backgroundColor)",
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
            properties: { pixelSize: 100 },
            fields: "pixelSize",
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 },
            properties: { pixelSize: 140 },
            fields: "pixelSize",
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: "COLUMNS", startIndex: 2, endIndex: 3 },
            properties: { pixelSize: 220 },
            fields: "pixelSize",
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: "COLUMNS", startIndex: 3, endIndex: 4 },
            properties: { pixelSize: 100 },
            fields: "pixelSize",
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: "COLUMNS", startIndex: 4, endIndex: 5 },
            properties: { pixelSize: 260 },
            fields: "pixelSize",
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: "COLUMNS", startIndex: 5, endIndex: 6 },
            properties: { pixelSize: 110 },
            fields: "pixelSize",
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: "COLUMNS", startIndex: 6, endIndex: 7 },
            properties: { pixelSize: 240 },
            fields: "pixelSize",
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: "COLUMNS", startIndex: 7, endIndex: 8 },
            properties: { pixelSize: 150 },
            fields: "pixelSize",
          },
        },
      ],
    }),
  }, interactive);
}

let setupEnsured = false;
const FORMAT_APPLIED_KEY = "dodoSheetFormatted";

async function ensureSheetSetup(interactive = true) {
  if (setupEnsured) return;

  const data = await sheetsRequest(`/values/${rowRange("A1:H1")}`, { method: "GET" }, interactive);
  const existing = data?.values?.[0] || [];
  const needsWrite = HEADER_ROW.some((label, i) => existing[i] !== label);
  if (needsWrite) {
    await sheetsRequest(
      `/values/${rowRange("A1:H1")}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        body: JSON.stringify({ values: [HEADER_ROW] }),
      },
      interactive
    );
  }

  const { [FORMAT_APPLIED_KEY]: alreadyFormatted } = await chrome.storage.local.get(FORMAT_APPLIED_KEY);
  if (!alreadyFormatted) {
    try {
      await applyHeaderFormatting(interactive);
      await chrome.storage.local.set({ [FORMAT_APPLIED_KEY]: true });
    } catch (err) {
      console.error("Dodo: sheet formatting failed (non-fatal)", err);
    }
  }
  setupEnsured = true;
}

export async function appendRow(entry, interactive = true) {
  await ensureSheetSetup(interactive);
  const values = [
    [
      entry.date,
      entry.company || "",
      entry.role || "",
      entry.source || "Other",
      entry.url || "",
      entry.status || "Applied",
      entry.notes || "",
      entry.jobId || "",
    ],
  ];
  await sheetsRequest(
    `/values/${rowRange("A:H")}:append?valueInputOption=USER_ENTERED`,
    {
      method: "POST",
      body: JSON.stringify({ values }),
    },
    interactive
  );
}

// Returns existing rows (skipping the header) as
// { rowNumber, date, company, role, source, url, status, notes, jobId }.
export async function getAllRows(interactive = true) {
  const data = await sheetsRequest(`/values/${rowRange("A2:H")}`, { method: "GET" }, interactive);
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
    jobId: row[7] || "",
  }));
}

export async function updateRowStatus(rowNumber, status, interactive = true) {
  await sheetsRequest(
    `/values/${rowRange(`F${rowNumber}`)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      body: JSON.stringify({ values: [[status]] }),
    },
    interactive
  );
}
