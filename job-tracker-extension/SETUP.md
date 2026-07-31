
# Job Tracker — Setup

## 1. Load the extension (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `job-tracker-extension/` folder.
4. Copy the **extension ID** shown on the card — you'll need it below.


## 2. Create a Google Cloud project + OAuth client

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create a new project (or reuse one).
2. Under **APIs & Services → Library**, enable:
   - **Google Sheets API**
   - **Gmail API** (needed for the rejection scanner — see step 5)
3. Under **APIs & Services → OAuth consent screen**, configure an External (or Internal, if using Workspace) consent screen. Add these scopes:
   - `https://www.googleapis.com/auth/spreadsheets`
   - `https://www.googleapis.com/auth/gmail.readonly`
   Add your own Google account as a test user if the app is in "Testing" status.
4. Under **APIs & Services → Credentials**, click **Create Credentials → OAuth client ID**.
   - Application type: **Chrome Extension**
   - Item ID: paste the extension ID from step 1.
5. Copy the generated **Client ID**.

## 3. Configure the extension

1. Open `manifest.json` and replace:
   ```json
   "client_id": "YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com"
   ```
   with the client ID from the previous step.
2. Reload the extension at `chrome://extensions` (click the refresh icon) so the manifest change takes effect.

## 4. Create and configure the Google Sheet

1. Create a new Google Sheet (or use an existing one).
2. Add a tab named `Applications` (or update `SHEET_NAME` in `config.js` to match your tab name).
3. Copy the spreadsheet ID from the sheet's URL:
   `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`
4. Open `config.js` and set:
   ```js
   export const SPREADSHEET_ID = "<your spreadsheet id>";
   export const SHEET_NAME = "Applications";
   ```
5. Reload the extension again.

The extension will automatically create the header row (`Date | Company | Role | Source | URL | Status | Notes`) the first time it logs an entry.

## 5. Gmail rejection scanning

The Gmail API must be enabled in the same Cloud project (step 2 above) for this feature to work. The extension requests read-only Gmail access (`gmail.readonly`) — it only searches subjects/snippets for likely rejection emails and never sends or modifies mail.

The first time you click **Scan Gmail** in the popup (or the first time the daily background scan runs), Chrome will show a permission prompt asking you to sign in and approve Gmail access. Approve it to enable scanning. After that, scans run silently:
- On demand, via the **Scan Gmail** button in the popup.
- Automatically once every 24 hours in the background (`chrome.alarms`).

## 6. Try it out

- Visit a LinkedIn job posting and use Easy Apply — a toast should appear bottom-right, and the floating counter (bottom-left) should tick up.
- Visit a Handshake job posting and submit an application.
- Visit any other company careers page with `/apply`, `/careers`, `/jobs`, or `/job` in the URL and submit the application form.
- Click the extension icon to see today's count, your last 5 applications, and to log entries manually.
- Check your Google Sheet — rows should appear within a few seconds of each detected application.

## Notes / limitations

- The generic detector is heuristic (form-submit + URL pattern based) since career sites vary widely; company/role parsing from `<title>`/`<h1>` won't always be perfect.
- If a Sheets API call fails (e.g. offline), the entry is queued in `chrome.storage.local` and retried automatically the next time the extension's service worker wakes up.
- The extension requests broad host permissions (`https://sheets.googleapis.com/*`, `https://www.googleapis.com/*`) for API calls, and content-script access to pages matching `/apply`, `/careers`, `/jobs`, `/job` on any site, in order to support arbitrary company career pages.
