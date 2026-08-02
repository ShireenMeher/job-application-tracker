// Heuristic fallback for career pages that aren't LinkedIn or Handshake.
// Only injected on pages whose URL contains /apply, /careers, /jobs, or
// /job, plus a set of known ATS domains (see manifest.json). Fires once
// per page load.
//
// Primary signal: a post-submit confirmation message appearing in the DOM
// (mirrors linkedin.js / handshake.js). Fallback signal: a form submit
// that looks like a genuine application (not a login/OTP/search form),
// for ATS pages that navigate away instead of rendering a confirmation.

// Keyword co-occurrence rather than exact phrases or positional regexes —
// ATS confirmation copy varies too much word-to-word ("application
// received" vs "thank you for your application" vs "application was
// successfully submitted") for rigid adjacency matching to hold up. A
// match requires every keyword in one set to appear somewhere in the
// text, in any order. "appl" is a deliberate stem match, covering apply /
// applying / applied / application(s) in one go.
//
// This is intentionally only checked against headings/alert/status/
// "success"-classed elements (see SUCCESS_ELEMENT_SELECTOR), not the
// whole page — job descriptions and application-form intro text often
// contain "thank you for your interest in applying" boilerplate too, and
// matching against arbitrary body text caused false positives on the
// application form itself, before anything was actually submitted.
const SUCCESS_KEYWORD_SETS = [
  ["appl", "received"],
  ["appl", "submitted"],
  ["appl", "sent"],
  ["appl", "complete"],
  ["successfully", "appl"],
];

// These also occur as pre-submit boilerplate on some application forms,
// so only trust them shortly after a likely application form was submitted.
const PENDING_ONLY_KEYWORD_SETS = [
  ["thank", "appl"],
  ["thank", "your interest"],
  ["under review"],
  ["being reviewed"],
];

const SUCCESS_ELEMENT_SELECTOR =
  'h1, h2, h3, [role="alert"], [role="status"], [aria-live], ' +
  '[class*="success" i], [id*="confirmation" i], [class*="confirmation" i], ' +
  '[data-qa*="confirmation" i], [data-testid*="success" i], [data-automation-id*="success" i]';
const CONFIRMATION_URL_PATTERN = /(?:thank[-_]?you|application[-_]?submitted|application[-_]?complete|submission[-_]?complete|\/applied)(?:[/?#]|$)/i;
const PENDING_KEY = "dodoPendingApplication";
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;

const NEGATIVE_BUTTON_WORDS = [
  "verify",
  "send code",
  "resend",
  "continue",
  "next",
  "log in",
  "sign in",
  "sign up",
  "search",
];

const NEGATIVE_FORM_TEXT = ["security code", "verification code", "one-time code", "one time code"];

// Company slug is the first path segment on these ATS-hosted domains
// (e.g. job-boards.greenhouse.io/figma/..., jobs.ashbyhq.com/ramp/...),
// which is far more reliable than the page <title> — confirmation pages
// often have generic titles like "Thank you for applying" with no
// company name in them at all.
const ATS_HOST_PATTERNS = [
  /greenhouse\.io$/i,
  /lever\.co$/i,
  /ashbyhq\.com$/i,
  /myworkdayjobs\.com$/i,
  /icims\.com$/i,
  /smartrecruiters\.com$/i,
  /bamboohr\.com$/i,
  /jobvite\.com$/i,
  /workable\.com$/i,
];

let hasFired = false;

function getPendingApplication() {
  try {
    const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null");
    if (!pending || Date.now() - pending.savedAt > PENDING_MAX_AGE_MS) {
      sessionStorage.removeItem(PENDING_KEY);
      return null;
    }
    return pending;
  } catch {
    return null;
  }
}

function rememberPendingApplication() {
  try {
    sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({
        company: parseGenericCompany(),
        role: parseGenericRole(),
        url: location.href,
        savedAt: Date.now(),
      })
    );
  } catch {
    // Storage can be unavailable in sandboxed frames; DOM detection still works.
  }
}

function parseCompanyFromAtsPath() {
  const host = location.hostname.toLowerCase();
  if (!ATS_HOST_PATTERNS.some((pattern) => pattern.test(host))) return "";

  let slug = location.pathname.split("/").filter(Boolean)[0] || "";

  // Workday, BambooHR, and many iCIMS tenants identify the employer in
  // their subdomain; their first path component is commonly a locale or
  // generic route such as /en-US/job/... or /careers/....
  if (/myworkdayjobs\.com$/i.test(host) || /bamboohr\.com$/i.test(host) || /icims\.com$/i.test(host)) {
    slug = host.split(".")[0].replace(/^(?:careers?|jobs?)-?/, "");
  }
  if (!slug) return "";

  return slug
    .split(/[-_.]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function parseGenericCompany() {
  const atsCompany = parseCompanyFromAtsPath();
  if (atsCompany) return atsCompany;

  const siteName = document.querySelector('meta[property="og:site_name"]')?.content?.trim();
  if (siteName && !/linkedin|handshake/i.test(siteName)) return siteName;

  const title = document.title || "";
  const parts = title
    .split(/[-|–—]/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length > 1) {
    // Titles are commonly "Job Title - Company Name" or "Company - Job Title".
    // Prefer the last segment, which is usually the company/brand name.
    return parts[parts.length - 1];
  }
  if (parts.length === 1) return parts[0];

  const host = location.hostname.replace(/^www\./, "");
  const domainParts = host.split(".");
  const name = domainParts.length >= 2 ? domainParts[domainParts.length - 2] : host;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function parseGenericRole() {
  const h1 = document.querySelector("h1");
  return h1 && h1.textContent.trim() ? h1.textContent.trim() : "";
}

function reportDetection() {
  if (hasFired) return;
  hasFired = true;

  const pending = getPendingApplication();
  const company = pending?.company || parseGenericCompany();
  const role = pending?.role || parseGenericRole();
  const applicationUrl = pending?.url || location.href;

  chrome.runtime.sendMessage(
    {
      type: "APPLICATION_DETECTED",
      company,
      role,
      source: "Other",
      url: applicationUrl,
    },
    (response) => {
      if (chrome.runtime.lastError || !response?.success || response?.duplicate) return;
      try { sessionStorage.removeItem(PENDING_KEY); } catch {}
      showToast(company, role, response?.todayCount);
    }
  );
}

function textOf(node) {
  return (node.innerText || node.textContent || "").toLowerCase();
}

// A matched heading is sometimes just a short label ("Success") with the
// actual descriptive text in a sibling paragraph, both wrapped in one
// alert/status/success-classed container — check that container's
// combined text when there is one, so the label + description are read
// together rather than the label alone failing every keyword set.
function relevantTextFor(el) {
  const container = el.closest?.('[role="alert"], [role="status"], [class*="success" i]');
  return textOf(container || el);
}

function elementMatchesKeywords(el) {
  const text = relevantTextFor(el);
  if (!text || text.length > 4000) return false;
  if (SUCCESS_KEYWORD_SETS.some((words) => words.every((word) => text.includes(word)))) return true;
  return (
    Boolean(getPendingApplication()) &&
    PENDING_ONLY_KEYWORD_SETS.some((words) => words.every((word) => text.includes(word)))
  );
}

// Checks root itself (if it's a heading/alert/success element) plus any
// matching descendants — used both for newly-added mutation nodes and for
// a from-scratch scan of the whole page.
function containsSuccessSignal(root) {
  if (!root || root.nodeType !== Node.ELEMENT_NODE) return false;
  if (root.matches?.(SUCCESS_ELEMENT_SELECTOR) && elementMatchesKeywords(root)) return true;

  const candidates = root.querySelectorAll ? root.querySelectorAll(SUCCESS_ELEMENT_SELECTOR) : [];
  for (const el of candidates) {
    if (elementMatchesKeywords(el)) return true;
  }
  return false;
}

// Excludes login/OTP/verification/search forms so a submit on those
// doesn't get mistaken for an actual application submission.
function isLikelyApplicationForm(form) {
  if (form.querySelector('input[type="password"]')) return false;
  if (form.querySelector('input[autocomplete="one-time-code"]')) return false;

  const formText = textOf(form);
  if (NEGATIVE_FORM_TEXT.some((phrase) => formText.includes(phrase))) return false;

  const inputs = Array.from(form.querySelectorAll("input, textarea, select"));

  // Multi-box verification codes: several single-character text/tel inputs.
  const otpLike =
    inputs.length >= 4 &&
    inputs.every((el) => el.tagName === "INPUT" && (el.maxLength === 1 || el.getAttribute("maxlength") === "1"));
  if (otpLike) return false;

  const submitEl = form.querySelector('[type="submit"], button:not([type="button"])');
  const submitText = textOf(submitEl) || (submitEl?.value || "").toLowerCase();
  if (NEGATIVE_BUTTON_WORDS.some((word) => submitText.includes(word))) return false;

  const hasFileInput = !!form.querySelector('input[type="file"]');
  const hasPositiveButtonText = /apply|submit application|submit your application/.test(submitText);

  return hasFileInput || hasPositiveButtonText || inputs.length >= 4;
}

function handleFormSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (!isLikelyApplicationForm(form)) return;
  // Submission itself is not proof of acceptance: validation or the server
  // may reject it. Preserve the job details while waiting for a success DOM,
  // URL, or known ATS network response.
  rememberPendingApplication();
  scheduleBroadCheck();
}

// background.js observed a known ATS's actual submit-application API call
// succeed (currently just Ashby) — a stronger signal than DOM text, so
// fire immediately rather than waiting for confirmation copy to render.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "NETWORK_SUBMIT_DETECTED") {
    reportDetection();
  }
});

// Debounced fallback for confirmation content that shows up via a
// text-only update (e.g. React reusing an existing element and only
// changing its text node) rather than a fresh element being added — the
// fast-path addedNodes check below wouldn't catch that, and re-scanning
// the whole page on every single mutation would be wasteful while the
// user is still typing into the form, so this only actually runs the
// check at most every 400ms.
let broadCheckScheduled = false;
function scheduleBroadCheck() {
  if (broadCheckScheduled || hasFired) return;
  broadCheckScheduled = true;
  setTimeout(() => {
    broadCheckScheduled = false;
    if (!hasFired && containsSuccessSignal(document.body)) {
      reportDetection();
    }
  }, 400);
}

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (containsSuccessSignal(node)) {
        reportDetection();
        return;
      }
    }
  }
  scheduleBroadCheck();
});

observer.observe(document.body, { childList: true, subtree: true, characterData: true });
document.addEventListener("submit", handleFormSubmit, true);

// Covers the case where the confirmation content is already present by
// the time this script runs at all — e.g. refreshing an already-confirmed
// URL, where React renders it on initial mount rather than via a mutation
// this script is around to see.
if (containsSuccessSignal(document.body)) {
  reportDetection();
}

// Some ATSs navigate to a clean confirmation route without rendering an
// accessible alert/heading. Require a recognizable confirmation URL; the
// saved pre-submit context preserves the job title across the navigation.
let lastHref = location.href;
setInterval(() => {
  if (location.href === lastHref) return;
  lastHref = location.href;
  if (CONFIRMATION_URL_PATTERN.test(location.href)) reportDetection();
}, 500);

if (CONFIRMATION_URL_PATTERN.test(location.href)) {
  reportDetection();
}
