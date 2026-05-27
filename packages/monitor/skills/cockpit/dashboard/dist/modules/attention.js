// Attention — pull the pilot back when a tool-permission request is pending.
// Three escalations layered on the modal's open/close lifecycle:
//   1. a one-shot browser notification (Notification API, permission cached),
//   2. a flashing tab title (only while the tab is hidden/unfocused),
//   3. a favicon badge reflecting the count of pending requests.
// Imperative module (no petite-vue reactivity) — matches transcript.js /
// permission-modal.js discipline. Both exports are idempotent: raising twice for
// the same request_id is a no-op; clearing an unknown id is a no-op.

// ── Pending set (drives count → badge, presence → flash) ───────────────────
const pending = new Set(); // request_ids currently awaiting a verdict

// ── Browser notification permission (one-shot, cached) ─────────────────────
let permissionAsked = false; // requestPermission() fired at most once

function notifySupported() {
  return typeof Notification !== "undefined";
}

function ensureNotificationPermission() {
  if (!notifySupported() || permissionAsked) return;
  permissionAsked = true;
  // Already-decided permissions ("granted"/"denied") need no prompt; only ask on
  // the still-"default" state. Never re-prompt regardless of the outcome.
  if (Notification.permission === "default") {
    try {
      Notification.requestPermission().catch(() => {});
    } catch {
      // older sync API or hostile environment — degrade silently
    }
  }
}

function showNotification({ request_id, tool_name, description }) {
  if (!notifySupported() || Notification.permission !== "granted") return;
  try {
    const n = new Notification("Tool permission needed", {
      body: `${tool_name || "Tool"}: ${description || ""}`.trim(),
      tag: request_id, // coalesce re-renders of the same request
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // notification construction can throw (permissions, browser quirks) — the
    // title flash + badge still carry the signal, so swallow it.
  }
}

// ── Tab-title flash ────────────────────────────────────────────────────────
const FLASH_TITLE = "🔔 Permission needed";
const FLASH_INTERVAL_MS = 1_000;
let originalTitle = null; // exact title captured at first flash; restored verbatim
let flashTimer = null;
let flashShowingAlert = false;

function tabUnfocused() {
  return document.visibilityState === "hidden" || !document.hasFocus();
}

function startFlash() {
  if (flashTimer || !tabUnfocused()) return;
  originalTitle = document.title;
  flashShowingAlert = false;
  flashTimer = setInterval(() => {
    flashShowingAlert = !flashShowingAlert;
    document.title = flashShowingAlert ? FLASH_TITLE : originalTitle;
  }, FLASH_INTERVAL_MS);
  // show the alert immediately rather than waiting a full interval
  flashShowingAlert = true;
  document.title = FLASH_TITLE;
}

function stopFlash() {
  if (!flashTimer) return;
  clearInterval(flashTimer);
  flashTimer = null;
  if (originalTitle !== null) document.title = originalTitle; // restore exactly
  originalTitle = null;
  flashShowingAlert = false;
}

// ── Favicon badge ──────────────────────────────────────────────────────────
// The page ships no <link rel="icon">; we synthesize a badged favicon onto a
// canvas and inject (or swap) the link. We remember the original href (or its
// absence) so clear restores exactly.
let faviconLink = null; // the <link rel="icon"> we manage
let originalFaviconHref = null; // its href before we touched it
let faviconInjected = false; // true if we created the link (remove on clear)

function findFaviconLink() {
  return (
    document.querySelector('link[rel~="icon"]') ||
    document.querySelector('link[rel="shortcut icon"]')
  );
}

function drawBadge(count) {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // base disc (the page has no real favicon to draw under the badge)
  ctx.fillStyle = "#1a2238";
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  // alert badge
  ctx.fillStyle = "#ff5a5a";
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.42, 0, Math.PI * 2);
  ctx.fill();
  // count (only when >1; a single pending request is just a dot)
  if (count > 1) {
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 38px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(count > 9 ? "9+" : count), size / 2, size / 2 + 2);
  }
  try {
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

function showBadge(count) {
  const href = drawBadge(count);
  if (!href) return;
  if (!faviconLink) {
    const existing = findFaviconLink();
    if (existing) {
      faviconLink = existing;
      originalFaviconHref = existing.getAttribute("href");
      faviconInjected = false;
    } else {
      faviconLink = document.createElement("link");
      faviconLink.rel = "icon";
      document.head.appendChild(faviconLink);
      originalFaviconHref = null;
      faviconInjected = true;
    }
  }
  faviconLink.setAttribute("href", href);
}

function restoreFavicon() {
  if (!faviconLink) return;
  if (faviconInjected) {
    faviconLink.remove();
  } else if (originalFaviconHref !== null) {
    faviconLink.setAttribute("href", originalFaviconHref);
  } else {
    faviconLink.removeAttribute("href");
  }
  faviconLink = null;
  originalFaviconHref = null;
  faviconInjected = false;
}

// ── Aggregate render: reflect the current pending set onto title + favicon ──
function render() {
  if (pending.size > 0) {
    startFlash(); // no-op when the tab is focused, or already flashing
    showBadge(pending.size);
  } else {
    stopFlash();
    restoreFavicon();
  }
}

// ── Public API ─────────────────────────────────────────────────────────────
export function raiseAttention(req) {
  const id = req && req.request_id;
  if (!id || pending.has(id)) return; // idempotent on the same request_id
  ensureNotificationPermission(); // one-shot prompt on the first ever request
  pending.add(id);
  showNotification(req);
  render();
}

export function clearAttention(request_id) {
  if (!request_id || !pending.has(request_id)) return; // idempotent on unknown id
  pending.delete(request_id);
  render();
}

// When the pilot returns to the tab, stop flashing immediately (the badge stays
// until the request actually closes, but the title shouldn't nag a visible tab).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") stopFlash();
});
