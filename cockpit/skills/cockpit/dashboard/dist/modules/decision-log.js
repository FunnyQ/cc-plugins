// Decision-log column — streams a session's decision trail over SSE and renders
// it as cards. Imperative (not petite-vue reactive) so each record's HTML is
// built once on receipt and never re-run on store polls — same discipline as
// the transcript renderer.
import { store } from "../app.js";
import { marked } from "../vendor/marked.esm.js";
import DOMPurify from "../vendor/purify.es.mjs";

// new-tab-safe links (matches token-atlas)
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const md = (t) =>
  DOMPurify.sanitize(marked.parse(t || "", { gfm: true, breaks: true }));
const mdInline = (t) =>
  DOMPurify.sanitize(marked.parseInline(t || "", { gfm: true }));
const esc = (t) =>
  String(t ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

function relTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Stable dedupe key — NOT receive order. New records carry ids; old JSONL logs
// fall back to content-derived keys so reconnects still avoid duplicate cards.
function recordKey(rec) {
  if (rec.id) return `${rec.type}|${rec.id}`;
  if (rec.type === "goal") return "goal"; // one goal record per session (singleton)
  if (rec.type === "decision")
    return `decision|${rec.timestamp || ""}|${rec.decision || ""}`;
  if (rec.type === "response")
    return `response|${rec.ts || ""}|${rec.answer || ""}`;
  return `${rec.type}|${rec.timestamp || rec.ts || ""}`;
}

// Daemon token for POST /api/respond — fetched once at runtime, never hardcoded.
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

export function initDecisionLog(rootEl) {
  if (!rootEl) return;

  let es = null;
  const seen = new Set(); // dedupe reconnect resends by stable record key
  let lastOpenCall = null; // most recent unresolved needs_your_call card
  let currentSession = null;

  // Only the selected session's *active* status makes a call answerable —
  // an ended/idle session has no live `cockpit wait` to wake.
  const sessionActive = () => {
    const s = store.sessions.find((x) => x.sessionId === currentSession);
    return !!s && s.status === "active";
  };

  // Structure: goal header + scrollable cards list + empty state.
  rootEl.classList.add("decision-log");
  rootEl.innerHTML = `
    <div class="decision-log__goal" hidden></div>
    <div class="decision-log__cards"></div>
    <p class="decision-log__empty placeholder">No decisions logged yet.</p>`;
  const goalEl = rootEl.querySelector(".decision-log__goal");
  const cardsEl = rootEl.querySelector(".decision-log__cards");
  const emptyEl = rootEl.querySelector(".decision-log__empty");

  // One delegated listener (cardsEl survives innerHTML resets). Only the latest
  // open call is answerable; a click resolves to either a picked option or the
  // free-text value.
  cardsEl.addEventListener("click", (e) => {
    const card = e.target.closest(".decision-card");
    if (!card || card !== lastOpenCall || !sessionActive()) return;
    let answer = null;
    if (e.target.matches(".respond__opt")) {
      answer = e.target.dataset.answer;
    } else if (e.target.matches(".respond__send")) {
      const input = card.querySelector(".respond__input");
      answer = input ? input.value.trim() : "";
      if (!answer) return;
    } else {
      return;
    }
    submitAnswer(card, answer);
  });

  const isPinned = () =>
    rootEl.scrollHeight - rootEl.scrollTop - rootEl.clientHeight < 48;

  function reset() {
    seen.clear();
    lastOpenCall = null;
    store.awaitingCall = false;
    goalEl.hidden = true;
    goalEl.innerHTML = "";
    cardsEl.innerHTML = "";
    emptyEl.hidden = false;
  }

  function renderGoal(rec) {
    goalEl.hidden = false;
    goalEl.innerHTML = `
      <span class="decision-log__goal-label">Session goal</span>
      <span class="decision-log__goal-text">${esc(rec.session_goal || "(no session goal)")}</span>`;
  }

  function decisionCard(rec) {
    const card = document.createElement("article");
    card.className = "decision-card";
    if (rec.needs_your_call) card.classList.add("is-call", "is-open");

    const files = (rec.files || [])
      .map((f) => `<code class="decision-card__file">${esc(f)}</code>`)
      .join("");
    const options = (rec.options || [])
      .map((o) => `<li>${esc(o)}</li>`)
      .join("");

    card.innerHTML = `
      ${rec.needs_your_call ? '<div class="decision-card__badge">🕹 needs your call</div>' : ""}
      <header class="decision-card__head">
        <div class="decision-card__decision">${mdInline(rec.decision)}</div>
        <time class="decision-card__time" datetime="${esc(rec.timestamp || "")}">${relTime(rec.timestamp)}</time>
      </header>
      <div class="decision-card__reason">${md(rec.reason)}</div>
      ${rec.tradeoff ? `<p class="decision-card__tradeoff">tradeoff: ${esc(rec.tradeoff)}</p>` : ""}
      ${files ? `<div class="decision-card__files">${files}</div>` : ""}
      ${options ? `<ul class="decision-card__options">${options}</ul>` : ""}
      ${rec.needs_your_call ? respondForm(rec) : ""}
      <div class="decision-card__answer" hidden></div>`;
    return card;
  }

  // Interactive answer surface for an open needs_your_call (active sessions
  // only). Hidden by default; revealed by showRespond() on the latest open
  // call. The read-only <ul> stays for ended/history sessions (CSS hides it
  // when .is-answerable is set, so we never show both).
  function respondForm(rec) {
    const btns = (rec.options || [])
      .map(
        (o) =>
          `<button type="button" class="respond__opt" data-answer="${esc(o)}">${esc(o)}</button>`,
      )
      .join("");
    return `
      <div class="decision-card__respond" hidden>
        ${btns ? `<div class="respond__opts">${btns}</div>` : ""}
        <div class="respond__free">
          <input type="text" class="respond__input" placeholder="Type a custom answer…" />
          <button type="button" class="respond__send">Send</button>
        </div>
        <p class="respond__note" hidden></p>
      </div>`;
  }

  function showRespond(card) {
    if (!card) return;
    card.classList.add("is-answerable");
    const form = card.querySelector(".decision-card__respond");
    if (form) form.hidden = false;
  }

  function hideRespond(card) {
    if (!card) return;
    card.classList.remove("is-answerable");
    const form = card.querySelector(".decision-card__respond");
    if (form) form.hidden = true;
  }

  function refreshCallState() {
    if (!lastOpenCall) {
      store.awaitingCall = false;
      return;
    }
    if (sessionActive()) {
      showRespond(lastOpenCall);
      store.awaitingCall = true;
    } else {
      hideRespond(lastOpenCall);
      store.awaitingCall = false;
    }
  }

  function setFormDisabled(form, disabled) {
    form
      .querySelectorAll("button, input")
      .forEach((el) => (el.disabled = disabled));
  }

  async function submitAnswer(card, answer) {
    const form = card.querySelector(".decision-card__respond");
    const note = form.querySelector(".respond__note");
    setFormDisabled(form, true); // optimistic
    const token = await getToken();
    if (!token) {
      note.hidden = false;
      note.textContent = "Could not reach the daemon.";
      setFormDisabled(form, false);
      return;
    }
    try {
      const r = await fetch("/api/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: currentSession, answer, token }),
      });
      const j = await r.json();
      if (j && j.delivered === false) {
        note.hidden = false;
        note.textContent =
          "Logged, but this session isn't listening right now.";
      }
      // delivered:true → stay disabled; the authoritative `response` record
      // arrives over the log SSE and flips the card to resolved.
    } catch {
      note.hidden = false;
      note.textContent = "Failed to send — try again.";
      setFormDisabled(form, false);
    }
  }

  function appendResponse(rec) {
    // Resolve the most recent open needs_your_call card.
    if (!lastOpenCall) return;
    hideRespond(lastOpenCall); // answered → retire the buttons
    const slot = lastOpenCall.querySelector(".decision-card__answer");
    slot.hidden = false;
    slot.innerHTML = `<span class="decision-card__answer-label">✅ answered</span> ${esc(rec.answer)}`;
    lastOpenCall.classList.remove("is-open");
    lastOpenCall.classList.add("is-resolved");
    lastOpenCall = null;
    store.awaitingCall = false; // pilot answered → clear the HUD alert
  }

  function handle(rec) {
    const key = recordKey(rec);
    if (seen.has(key)) return;
    seen.add(key);

    if (rec.type === "goal") {
      renderGoal(rec);
      return;
    }
    if (rec.type === "decision") {
      const pinned = isPinned();
      const card = decisionCard(rec);
      cardsEl.appendChild(card);
      emptyEl.hidden = true;
      if (rec.needs_your_call) {
        if (lastOpenCall) hideRespond(lastOpenCall); // older call isn't latest
        lastOpenCall = card;
        refreshCallState();
      }
      if (pinned) rootEl.scrollTop = rootEl.scrollHeight;
      return;
    }
    if (rec.type === "response") {
      const pinned = isPinned();
      appendResponse(rec);
      if (pinned) rootEl.scrollTop = rootEl.scrollHeight;
    }
  }

  function open(project, session) {
    if (es) {
      es.close();
      es = null;
    }
    reset();
    currentSession = session;
    if (!project || !session) return;
    const url = `/api/log/stream?project=${encodeURIComponent(project)}&session=${encodeURIComponent(session)}`;
    es = new EventSource(url);
    es.onmessage = (e) => {
      if (!e.data) return;
      let rec;
      try {
        rec = JSON.parse(e.data);
      } catch {
        return; // skip malformed
      }
      handle(rec);
    };
    es.addEventListener("backlog-done", () => {
      rootEl.scrollTop = rootEl.scrollHeight;
    });
    es.onerror = () => {
      // EventSource auto-reconnects; dedupe guards against backlog resends.
    };
  }

  // Each card's relative time ("3m ago") is rendered once when the card is
  // created, so without a ticker it freezes — a live-logged card stays at
  // "0s ago" forever. Refresh all cards periodically from each <time>'s
  // datetime attribute (the source-of-truth ISO timestamp).
  setInterval(() => {
    for (const el of cardsEl.querySelectorAll(".decision-card__time[datetime]"))
      el.textContent = relTime(el.getAttribute("datetime"));
  }, 15_000);

  store.subscribe((project, session) => open(project, session));
  store.subscribeSessions(refreshCallState);
  // Open immediately for the current selection (set before this mounts).
  open(store.selectedProject, store.selectedSessionId);
}
