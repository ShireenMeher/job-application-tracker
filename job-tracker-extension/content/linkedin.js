// Detects LinkedIn Easy Apply success (SPA, so we watch the DOM rather
// than navigation events) and reports it to background.js.

const SUCCESS_PHRASES = [
  "your application was sent",
  "application sent",
  "your application has been sent",
  "application submitted",
  "you successfully applied",
];

let hasFiredForCurrentUrl = false;
let lastHref = location.href;

function textOf(node) {
  return (node.innerText || node.textContent || "").toLowerCase();
}

function looksLikeSuccessNode(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const text = textOf(node);
  if (!text || text.length > 4000) return false;
  return SUCCESS_PHRASES.some((phrase) => text.includes(phrase));
}

function pageHasSuccess() {
  const text = textOf(document.body);
  return SUCCESS_PHRASES.some((phrase) => text.includes(phrase));
}

function querySelectorText(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim()) return el.textContent.trim();
  }
  return "";
}

function parseLinkedInJobInfo() {
  const role = querySelectorText([
    ".job-details-jobs-unified-top-card__job-title",
    ".jobs-unified-top-card__job-title",
    "h1.t-24",
    "h1",
  ]);
  const company = querySelectorText([
    ".job-details-jobs-unified-top-card__company-name",
    ".jobs-unified-top-card__company-name",
    'a[href*="/company/"]',
  ]);
  return { company, role };
}

function handleApplySuccess() {
  if (hasFiredForCurrentUrl) return;
  hasFiredForCurrentUrl = true;

  const { company, role } = parseLinkedInJobInfo();

  chrome.runtime.sendMessage(
    {
      type: "APPLICATION_DETECTED",
      company,
      role,
      source: "LinkedIn",
      url: location.href,
    },
    (response) => {
      if (chrome.runtime.lastError || response?.duplicate) return;
      showToast(company, role, response?.todayCount);
    }
  );
}

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (looksLikeSuccessNode(node)) {
        handleApplySuccess();
        return;
      }
    }
  }
  scheduleBroadSuccessCheck();
});

let broadCheckTimer = null;
function scheduleBroadSuccessCheck() {
  if (broadCheckTimer || hasFiredForCurrentUrl) return;
  broadCheckTimer = setTimeout(() => {
    broadCheckTimer = null;
    if (!hasFiredForCurrentUrl && pageHasSuccess()) handleApplySuccess();
  }, 300);
}

observer.observe(document.body, { childList: true, subtree: true, characterData: true });

// Covers confirmations already rendered before the observer starts.
if (pageHasSuccess()) handleApplySuccess();

// LinkedIn is a single-page app; reset the "already fired" guard whenever
// the URL changes so a new job's application can be detected too.
setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    hasFiredForCurrentUrl = false;
    scheduleBroadSuccessCheck();
  }
}, 1000);
