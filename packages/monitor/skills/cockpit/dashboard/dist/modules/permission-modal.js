import { store } from "../app.js";
import { raiseAttention, clearAttention } from "./attention.js";

// TTL ceiling: if neither an own-verdict success nor a `resolved` frame arrives,
// the modal dims to a "possibly handled elsewhere" state, then auto-dismisses.
// MANDATORY — the user's PreToolUse auto-approve hook can resolve many requests
// outside cockpit, and the protocol guarantees no cancel notification (see
// docs/permission-relay/tasks/_context/protocol.md). 90s default, module const.
const TTL_MS = 90_000;
const TTL_DIM_MS = 4_000;
const RESOLVED_LINGER_MS = 1_800;

const esc = (t) =>
  String(t ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

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
    if (activeRequestId) clearAttention(activeRequestId);
    activeRequestId = null;
    submitting = false;
    overlay.close();
  }

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

  /** @param {{request_id: string, source: "elsewhere" | "ui"}} frame */
  function handleResolved(frame) {
    if (!overlay.isOpen || frame.request_id !== activeRequestId) return;
    clearTimers();
    overlay.disableActions();
    if (frame.source === "elsewhere") {
      overlay.setDimmed(true);
      overlay.setNote("已在別處處理");
      dismissTimer = setTimeout(closeModal, RESOLVED_LINGER_MS);
    } else {
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
    getToken().then((token) => {
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

  store.subscribe((_project, session) => open(session));
  // subscribe() only fires on LATER changes, and a deep-linked load sets the
  // selection before this module registers (app.js:667-671) — and then
  // fetchSessions skips its default-select, so no notify ever comes. Adopt the
  // current selection explicitly, exactly like transcript.js:970. Without this
  // a deep-linked tab never opens the stream: no permission card, and no
  // presence signal for the broker's wait gate.
  open(store.selectedSessionId);

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

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.isOpen) closeModal();
  });

  return {
    overlay,
    get activeRequestId() {
      return activeRequestId;
    },
    close: closeModal,
  };
}
