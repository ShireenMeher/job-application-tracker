// Heuristic fallback for career pages that aren't LinkedIn or Handshake.
// Only injected on pages whose URL contains /apply, /careers, /jobs, or
// /job (see manifest.json match patterns). Fires once per page load on
// the first form submission.

let hasFired = false;

function parseGenericCompany() {
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

function handleFormSubmit() {
  if (hasFired) return;
  hasFired = true;

  const company = parseGenericCompany();
  const role = parseGenericRole();

  chrome.runtime.sendMessage(
    {
      type: "APPLICATION_DETECTED",
      company,
      role,
      source: "Other",
      url: location.href,
    },
    (response) => {
      if (chrome.runtime.lastError) return;
      showToast(company, role, response?.todayCount);
    }
  );
}

document.addEventListener("submit", handleFormSubmit, true);
