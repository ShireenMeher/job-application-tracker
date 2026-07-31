// Detects Handshake's post-submit success state (either a success message
// rendered in-page, or a URL change to a confirmation state) and reports
// it to background.js.

const SUCCESS_PHRASES = [
  "application submitted",
  "your application has been submitted",
  "successfully applied",
  "you've applied",
  "application received",
];

const CONFIRMATION_URL_PATTERN = /\/applied(\/|$|\?)|[?&]applied=true/i;

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

function querySelectorText(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim()) return el.textContent.trim();
  }
  return "";
}

function parseHandshakeJobInfo() {
  const role = querySelectorText(['[data-hook="job-title"]', ".job-title", "h1"]);
  const company = querySelectorText([
    '[data-hook="employer-name"]',
    ".employer-name",
    'a[href*="/employers/"]',
  ]);
  return { company, role };
}

function handleApplySuccess() {
  if (hasFiredForCurrentUrl) return;
  hasFiredForCurrentUrl = true;

  const { company, role } = parseHandshakeJobInfo();

  chrome.runtime.sendMessage(
    {
      type: "APPLICATION_DETECTED",
      company,
      role,
      source: "Handshake",
      url: location.href,
    },
    (response) => {
      if (chrome.runtime.lastError) return;
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
});

observer.observe(document.body, { childList: true, subtree: true });

setInterval(() => {
  if (location.href !== lastHref) {
    const changedTo = location.href;
    lastHref = changedTo;
    hasFiredForCurrentUrl = false;
    if (CONFIRMATION_URL_PATTERN.test(changedTo)) {
      handleApplySuccess();
    }
  }
}, 1000);
