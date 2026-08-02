// Shared job/requisition ID extraction so the same posting can be
// recognized both when an application is logged (from the page URL) and
// later when a Gmail status update references it (from a link or an
// explicit "Job ID:" / "Requisition #" mention in the email).

const URL_PATTERNS = [
  /[?&]gh_jid=(\d+)/i, // Greenhouse
  /(?:boards|job-boards)\.greenhouse\.io\/[^/]+\/jobs\/(\d+)/i, // Greenhouse
  /jobs\.lever\.co\/[^/]+\/([a-f0-9-]{36})/i, // Lever
  /ashbyhq\.com\/[^/]+\/([a-f0-9-]{36})/i, // Ashby
  /myworkdayjobs\.com\/.+\/job\/[^/]*\/[^/]*--(R-?\d[\w-]*)/i, // Workday
  /[?&]jk=([a-f0-9]{16,20})/i, // Indeed
  /linkedin\.com\/jobs\/view\/(\d+)/i, // LinkedIn
  /[?&]currentJobId=(\d+)/i, // LinkedIn
  /[?&](?:req|requisition)_?id=([\w-]+)/i, // generic ATS
  /[?&](?:job_?id|posting_?id)=([\w-]+)/i, // generic ATS
];

const TEXT_PATTERNS = [
  /\bjob\s*id[:#]?\s*([\w-]{4,})/i,
  /\brequisition\s*(?:id|#|number)?[:#]?\s*([\w-]{4,})/i,
  /\breq\.?\s*#?\s*([\w-]{4,})/i,
];

export function extractJobIdFromUrl(url) {
  if (!url) return "";
  for (const pattern of URL_PATTERNS) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return "";
}

// Scans free-form text (e.g. an email body, which may contain both
// plain-text "Job ID:" mentions and raw links) for a job ID.
export function extractJobIdFromText(text) {
  if (!text) return "";
  const fromUrl = extractJobIdFromUrl(text);
  if (fromUrl) return fromUrl;
  for (const pattern of TEXT_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return "";
}
