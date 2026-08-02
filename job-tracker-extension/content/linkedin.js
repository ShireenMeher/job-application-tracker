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
  return Boolean(findSuccessText());
}

function findSuccessText() {
  const containers = document.querySelectorAll('[role="dialog"], [aria-modal="true"], .artdeco-modal');
  for (const container of containers) {
    const text = textOf(container);
    if (SUCCESS_PHRASES.some((phrase) => text.includes(phrase))) {
      return container.innerText || container.textContent || "";
    }
  }
  return "";
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
    ".job-details-jobs-unified-top-card__job-title h1",
    ".job-details-jobs-unified-top-card__job-title",
    ".jobs-unified-top-card__job-title",
    ".jobs-details__main-content h1",
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

function rememberLinkedInContext() {
  const { company, role } = parseLinkedInJobInfo();
  if (!company && !role) return;
  sendDodoMessage(
    {
      type: "REMEMBER_APPLICATION_CONTEXT",
      company,
      role,
      url: location.href,
      savedAt: Date.now(),
    }
  );
}

function handleLinkedInClick(event) {
  if (!isDodoContextValid()) return;
  const control = event.target.closest?.("button, [role=button]");
  if (!control) return;
  const label = textOf(control).replace(/\s+/g, " ").trim();
  if (/^(?:easy apply|submit application)$/i.test(label)) rememberLinkedInContext();
}

document.addEventListener("click", handleLinkedInClick, true);

function handleApplySuccess() {
  if (hasFiredForCurrentUrl || !isDodoContextValid()) return;
  hasFiredForCurrentUrl = true;

  let { company, role } = parseLinkedInJobInfo();
  const successText = findSuccessText();
  const companyMatch = successText.match(/application was sent to\s+([^!\n.]+)/i);
  if (companyMatch?.[1]) company = companyMatch[1].trim();

  const sent = sendDodoMessage(
    {
      type: "APPLICATION_DETECTED",
      company,
      role,
      source: "LinkedIn",
      url: location.href,
    },
    (response) => {
      if (!response?.success || response?.duplicate) return;
      showToast(company, role, response?.todayCount);
    }
  );
  if (!sent) hasFiredForCurrentUrl = false;
}

const observer = new MutationObserver((mutations) => {
  if (!isDodoContextValid()) {
    observer.disconnect();
    return;
  }
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
    if (!isDodoContextValid()) {
      observer.disconnect();
      return;
    }
    if (!hasFiredForCurrentUrl && pageHasSuccess()) handleApplySuccess();
  }, 300);
}

observer.observe(document.body, { childList: true, subtree: true, characterData: true });

// Covers confirmations already rendered before the observer starts.
if (pageHasSuccess()) handleApplySuccess();

// LinkedIn sometimes reuses an already-mounted modal and changes its state
// without mutations our observer can reliably associate with the success
// message. Poll the small modal subtree as a final safety net.
const successPoll = setInterval(() => {
  if (!isDodoContextValid()) {
    clearInterval(successPoll);
    observer.disconnect();
    document.removeEventListener("click", handleLinkedInClick, true);
    return;
  }
  if (location.href !== lastHref) {
    lastHref = location.href;
    hasFiredForCurrentUrl = false;
  }
  if (!hasFiredForCurrentUrl && pageHasSuccess()) handleApplySuccess();
}, 500);
