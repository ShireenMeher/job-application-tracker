// Shared helper injected before the site-specific detectors. Renders a
// persistent floating counter widget. Like toast.js, this declares plain
// top-level functions that live in the shared content-script scope.

const COUNTER_ID = "dodo-counter";
const COUNTER_DISMISSED_KEY = "dodoCounterDismissed";

function initCounter() {
  if (window.__dodoCounterInitialized) return;
  window.__dodoCounterInitialized = true;

  chrome.storage.local.get(COUNTER_DISMISSED_KEY, ({ [COUNTER_DISMISSED_KEY]: dismissed }) => {
    if (dismissed) return;

    chrome.runtime.sendMessage({ type: "GET_TODAY_COUNT" }, (response) => {
      if (chrome.runtime.lastError) return;
      renderCounter(response?.todayCount || 0);
    });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "COUNTER_UPDATE") {
      updateCounterDisplay(message.count);
    }
  });
}

function renderCounter(count) {
  if (document.getElementById(COUNTER_ID)) return;

  const widget = document.createElement("div");
  widget.id = COUNTER_ID;
  widget.style.cssText = `
    position: fixed;
    bottom: 24px;
    left: 24px;
    z-index: 999998;
    background: #111827;
    color: #ffffff;
    padding: 10px 16px;
    border-radius: 999px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    user-select: none;
  `;

  const label = document.createElement("span");
  label.id = `${COUNTER_ID}-label`;
  label.textContent = `🦤 ${count} today`;

  const dismiss = document.createElement("span");
  dismiss.textContent = "✕";
  dismiss.style.cssText = `
    opacity: 0.5;
    font-size: 11px;
    padding: 2px 4px;
    border-radius: 999px;
  `;
  dismiss.addEventListener("mouseenter", () => (dismiss.style.opacity = "1"));
  dismiss.addEventListener("mouseleave", () => (dismiss.style.opacity = "0.5"));
  dismiss.addEventListener("click", (e) => {
    e.stopPropagation();
    widget.remove();
    chrome.storage.local.set({ [COUNTER_DISMISSED_KEY]: true });
  });

  widget.appendChild(label);
  widget.appendChild(dismiss);

  widget.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "OPEN_POPUP" });
  });

  document.body.appendChild(widget);
}

function updateCounterDisplay(count) {
  const label = document.getElementById(`${COUNTER_ID}-label`);
  if (label) {
    label.textContent = `🦤 ${count} today`;
  } else if (document.body && !document.getElementById(COUNTER_ID)) {
    renderCounter(count);
  }
}

initCounter();
