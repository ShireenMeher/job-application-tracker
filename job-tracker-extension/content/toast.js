// Shared helper injected before the site-specific detectors. Declares
// showToast() as a plain top-level function so linkedin.js / handshake.js /
// generic.js (loaded after this file in the same content script bundle)
// can call it directly — content scripts listed together in manifest.json
// share one global scope.

const TOAST_ID = "dodo-toast";

function showToast(company, role, todayCount) {
  const existing = document.getElementById(TOAST_ID);
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = TOAST_ID;
  toast.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 999999;
    background: #111827;
    color: #ffffff;
    padding: 12px 20px;
    border-radius: 16px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    line-height: 1.4;
    max-width: 280px;
    opacity: 0;
    transform: translateY(16px);
    transition: opacity 0.3s ease, transform 0.3s ease;
    pointer-events: none;
  `;

  const countLabel = typeof todayCount === "number" ? `+1 today (${todayCount})` : "+1 today";
  let html = `<div style="font-weight:600;">🦤 ${countLabel} — logged and waddled to your sheet ✓</div>`;
  if (company || role) {
    const sub = [company, role].filter(Boolean).join(" · ");
    html += `<div style="margin-top:4px;color:#9CA3AF;font-size:12px;">${escapeHtml(sub)}</div>`;
  }
  toast.innerHTML = html;

  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.opacity = "1";
    toast.style.transform = "translateY(0)";
  });

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(16px)";
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
