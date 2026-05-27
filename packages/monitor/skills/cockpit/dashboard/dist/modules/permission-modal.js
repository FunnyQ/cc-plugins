// Permission modal — a reusable, content-agnostic overlay (title / body slot /
// action buttons / close lifecycle) driven here by the permission relay stream.
// Imperative (not petite-vue reactive): the overlay DOM is built once and updated
// directly, matching the discipline of transcript.js / decision-log.js. The shell
// knows nothing about permission fields — callers pass content in via open({…}),
// so a later effort can reuse it for needs_your_call without touching this file.
import { store } from "../app.js";
import { raiseAttention, clearAttention } from "./attention.js";

// TTL ceiling: if neither an own-verdict success nor a `resolved` frame arrives,
// the modal dims to a "possibly handled elsewhere" state, then auto-dismisses.
// MANDATORY — Q runs a PreToolUse auto-approve hook that resolves many requests
// outside cockpit, and the protocol guarantees no cancel notification (see
// docs/permission-relay/tasks/_context/protocol.md). 90s default, module const.
const TTL_MS = 90_000;
// How long the dimmed "maybe handled elsewhere" state lingers before dismissing.
const TTL_DIM_MS = 4_000;
// How long the "已在別處處理" note lingers before the modal closes.
const RESOLVED_LINGER_MS = 1_800;

const esc = (t) =>
  String(t ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

// Daemon token for POST /api/permission-verdict — fetched once, never hardcoded
// (same shape as decision-log.js).
let _tokenPromise = null;
function getToken() {
  if (!_tokenPromise) {
    _tokenPromise = fetch("/api/token")
      .then((r) => r.json())
      .then((j) => j.token)
      .catch(() => null);
  }
  return _tokenPromise;
}

// ── Reusable overlay shell ────────────────────────────────────────────────
// Content-agnostic: title (string), bodyHtml (string), actions ([{label, kind,
// onClick}]), optional note. Owns only its own DOM + close lifecycle. Returns a
// controller the caller drives.
export function createOverlay(rootEl) {
  rootEl.classList.add("perm-overlay");
  rootEl.setAttribute("role", "dialog");
  rootEl.setAttribute("aria-modal", "true");
  rootEl.hidden = true;
  rootEl.innerHTML = `
    <div class="perm-overlay__scrim"></div>
    <div class="perm-modal" role="document">
      <div class="perm-modal__head">
        <span class="perm-modal__kicker"></span>
        <h2 class="perm-modal__title"></h2>
      </div>
      <div class="perm-modal__body"></div>
      <p class="perm-modal__note" hidden></p>
      <div class="perm-modal__actions"></div>
    </div>`;

  const scrimEl = rootEl.querySelector(".perm-overlay__scrim");
  const kickerEl = rootEl.querySelector(".perm-modal__kicker");
  const titleEl = rootEl.querySelector(".perm-modal__title");
  const bodyEl = rootEl.querySelector(".perm-modal__body");
  const noteEl = rootEl.querySelector(".perm-modal__note");
  const actionsEl = rootEl.querySelector(".perm-modal__actions");

  let isOpen = false;
  let onCloseCb = null; // called whenever the overlay leaves the open state

  function renderActions(actions) {
    actionsEl.innerHTML = "";
    for (const a of actions || []) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `perm-btn perm-btn--${a.kind || "neutral"}`;
      btn.textContent = a.label;
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        a.onClick?.(btn);
      });
      actionsEl.appendChild(btn);
    }
  }

  // Open with fresh content. `actions[].onClick` receives its own button so the
  // caller can disable it on click (prevent double-submit).
  function open({ kicker, title, bodyHtml, actions } = {}) {
    kickerEl.textContent = kicker || "";
    kickerEl.hidden = !kicker;
    titleEl.textContent = title || "";
    bodyEl.innerHTML = bodyHtml || "";
    noteEl.hidden = true;
    noteEl.textContent = "";
    renderActions(actions);
    rootEl.classList.remove("is-dimmed");
    rootEl.hidden = false;
    isOpen = true;
    // defer so the transition from hidden runs
    requestAnimationFrame(() => rootEl.classList.add("is-shown"));
  }

  function setNote(text) {
    noteEl.textContent = text || "";
    noteEl.hidden = !text;
  }

  function setDimmed(dimmed) {
    rootEl.classList.toggle("is-dimmed", !!dimmed);
  }

  function disableActions() {
    for (const btn of actionsEl.querySelectorAll(".perm-btn"))
      btn.disabled = true;
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    rootEl.classList.remove("is-shown");
    rootEl.hidden = true;
    rootEl.classList.remove("is-dimmed");
    actionsEl.innerHTML = "";
    onCloseCb?.();
  }

  scrimEl.addEventListener("click", () => {
    // Clicking the scrim is a soft dismiss only — never an implicit verdict.
    if (isOpen) close();
  });

  return {
    open,
    close,
    setNote,
    setDimmed,
    disableActions,
    get isOpen() {
      return isOpen;
    },
    onClose(fn) {
      onCloseCb = fn;
    },
  };
}

// ── Permission relay binding ──────────────────────────────────────────────
// Subscribes to /api/permission-stream for the selected session, drives the
// overlay on `request` frames, and enforces the three-way auto-close lifecycle.
export function initPermissionModal(rootEl) {
  if (!rootEl) return;

  const overlay = createOverlay(rootEl);

  let es = null;
  let currentSession = null;
  let activeRequestId = null; // the request the modal is currently showing
  let ttlTimer = null;
  let dismissTimer = null;
  let submitting = false;

  function clearTimers() {
    if (ttlTimer) {
      clearTimeout(ttlTimer);
      ttlTimer = null;
    }
    if (dismissTimer) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }
  }

  function closeModal() {
    clearTimers();
    // Single close path for every lifecycle case (own-verdict, resolved, TTL,
    // scrim/escape) — clear attention here so it always unwinds with the modal.
    if (activeRequestId) clearAttention(activeRequestId);
    activeRequestId = null;
    submitting = false;
    overlay.close();
  }

  // TTL fallback (lifecycle case 3): dim, show the "maybe elsewhere" hint, then
  // auto-dismiss. Guarantees no zombie card when no resolved signal ever comes.
  function armTtl() {
    if (ttlTimer) clearTimeout(ttlTimer);
    ttlTimer = setTimeout(() => {
      ttlTimer = null;
      if (!overlay.isOpen) return;
      overlay.setDimmed(true);
      overlay.disableActions();
      overlay.setNote("可能已在別處處理");
      dismissTimer = setTimeout(closeModal, TTL_DIM_MS);
    }, TTL_MS);
  }

  async function submitVerdict(requestId, behavior, btn) {
    if (submitting) return;
    submitting = true;
    overlay.disableActions();
    const token = await getToken();
    if (!token) {
      overlay.setNote("無法連線 daemon，請稍後再試");
      // re-enable so the pilot can retry
      submitting = false;
      for (const b of rootEl.querySelectorAll(".perm-btn")) b.disabled = false;
      return;
    }
    try {
      const r = await fetch("/api/permission-verdict", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session: currentSession,
          token,
          request_id: requestId,
          behavior,
        }),
      });
      if (!r.ok) throw new Error(`verdict failed: ${r.status}`);
      // Lifecycle case 1: own verdict succeeded → close (the matching `resolved`
      // frame may also arrive; whichever lands first wins, and closeModal clears
      // activeRequestId so the later one is ignored).
      closeModal();
    } catch (e) {
      overlay.setNote((e && e.message) || "送出失敗，請再試一次");
      submitting = false;
      for (const b of rootEl.querySelectorAll(".perm-btn")) b.disabled = false;
    }
  }

  // A `request` frame → open the modal with permission-specific content. The
  // overlay shell stays generic; we assemble the content here.
  function openRequest(frame) {
    clearTimers();
    submitting = false;
    activeRequestId = frame.request_id;
    const preview = String(frame.input_preview ?? "");
    overlay.open({
      kicker: "Permission",
      title: frame.tool_name || "Tool permission",
      bodyHtml: `
        ${frame.description ? `<p class="perm-modal__desc">${esc(frame.description)}</p>` : ""}
        ${preview ? `<pre class="perm-modal__preview"><code>${esc(preview)}</code></pre>` : ""}`,
      actions: [
        {
          label: "Deny",
          kind: "deny",
          onClick: (btn) => submitVerdict(frame.request_id, "deny", btn),
        },
        {
          label: "Allow",
          kind: "allow",
          onClick: (btn) => submitVerdict(frame.request_id, "allow", btn),
        },
      ],
    });
    raiseAttention(frame);
    armTtl();
  }

  // A `resolved` frame (lifecycle case 2). Only acts on the request currently
  // shown. `elsewhere` = the channel forwarded a cancel (terminal/hook answered);
  // `ui` = another tab answered.
  function handleResolved(frame) {
    if (!overlay.isOpen || frame.request_id !== activeRequestId) return;
    clearTimers();
    overlay.disableActions();
    if (frame.source === "elsewhere") {
      overlay.setDimmed(true);
      overlay.setNote("已在別處處理");
      dismissTimer = setTimeout(closeModal, RESOLVED_LINGER_MS);
    } else {
      // another tab answered — close promptly, no lingering note
      closeModal();
    }
  }

  function handleFrame(frame) {
    if (!frame || typeof frame !== "object") return;
    if (frame.type === "request") openRequest(frame);
    else if (frame.type === "resolved") handleResolved(frame);
  }

  function open(session) {
    if (es) {
      es.close();
      es = null;
    }
    closeModal();
    currentSession = session || null;
    if (!session) return;
    // token in the query — GET endpoints authenticate via ?token=<t> (shared.md)
    getToken().then((token) => {
      // a session switch may have raced ahead while the token resolved
      if (currentSession !== session) return;
      const url =
        `/api/permission-stream?session=${encodeURIComponent(session)}` +
        `&token=${encodeURIComponent(token || "")}`;
      es = new EventSource(url);
      es.onmessage = (e) => {
        if (!e.data) return;
        let frame;
        try {
          frame = JSON.parse(e.data);
        } catch {
          return; // skip malformed
        }
        handleFrame(frame);
      };
      es.onerror = () => {
        // EventSource auto-reconnects; activeRequestId guards stale resends.
      };
    });
  }

  // Re-subscribe on session switch (tied to the selected session like the other
  // streams). Close any open modal first so a request never leaks across sessions.
  store.subscribe((_project, session) => open(session));

  // Close the stream when the tab is hidden; reopen on return (mirrors app.js
  // polling lifecycle so no EventSource leaks while backgrounded).
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (es) {
        es.close();
        es = null;
      }
      closeModal();
    } else if (currentSession) {
      open(currentSession);
    }
  });

  // Escape dismisses the modal (soft — never an implicit verdict).
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.isOpen) closeModal();
  });

  // Open immediately for the current selection (set before this mounts).
  open(store.selectedSessionId);

  // Expose the open/close path so the attention task (ui/02) can hook it without
  // re-deriving the lifecycle. Returns the controller.
  return {
    overlay,
    get activeRequestId() {
      return activeRequestId;
    },
    close: closeModal,
  };
}
