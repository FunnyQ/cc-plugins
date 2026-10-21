// it as cards. Imperative (not petite-vue reactive) so each record's HTML is
// built once on receipt and never re-run on store polls — same discipline as
// the transcript renderer.
import { store } from "../app.js";
import { marked } from "../vendor/marked.esm.js";
import DOMPurify from "../vendor/purify.es.mjs";
import { createLatestIndicator } from "./latest-indicator.js";
import { renderDiagram, openDiagramLightbox } from "./diagram.js";

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const HERO_RECOLLAPSE_MS = 60_000;

const KINDS = ["decision", "rationale", "learning", "caveat"];

const md = (t) =>
  DOMPurify.sanitize(marked.parse(t || "", { gfm: true, breaks: true }));
const mdInline = (t) =>
  DOMPurify.sanitize(marked.parseInline(t || "", { gfm: true }));
const esc = (t) =>
  String(t ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

const FACET_GLYPHS = {
  PROBLEM: "?",
  CONSTRAINT: "⊏",
  REJECTED: "✕",
  ASSUMPTION: "≈",
  RISK: "△",
  PRIORART: "⊚",
  RECOMMEND: "★",
  OPTION: "◈",
};
function facetGlyph(label) {
  const key = String(label || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  return FACET_GLYPHS[key] || "◇";
}

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
  if (rec.type === "decision")
    return `decision|${rec.timestamp || ""}|${rec.decision || ""}`;
  if (rec.type === "response")
    return `response|${rec.ts || ""}|${rec.answer || ""}`;
  return `${rec.type}|${rec.timestamp || rec.ts || ""}`;
}

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

export function formatAnswer(selected, comment) {
  if (selected && comment) {
    return `Selected option: ${selected}\n\nAdditional instructions:\n${comment}`;
  }
  return selected || comment;
}

export function splitAnswer(answer) {
  const combined = (answer || "").match(
    /^Selected option:\s*([\s\S]*?)\n\nAdditional instructions:\n([\s\S]*)$/,
  );
  return combined
    ? { option: combined[1].trim(), instructions: combined[2].trim() }
    : null;
}

export function createHeroCollapse(store, delayMs = HERO_RECOLLAPSE_MS) {
  let timer = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    cancel,
    raise() {
      cancel();
      store.setHeroCollapsed(false);
    },
    schedule() {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        if (!store.awaitingCall) store.setHeroCollapsed(true);
      }, delayMs);
    },
  };
}

export function initDecisionLog(rootEl) {
  if (!rootEl) return;

  let es = null;
  const seen = new Set(); // dedupe reconnect resends by stable record key
  let lastOpenCall = null; // most recent unresolved needs_your_call card
  let currentSession = null;
  const instrumentsEl = rootEl.closest(".instruments");
  const decisionInstrumentEl = rootEl.closest(".instrument");
  const mobileLayout = window.matchMedia("(max-width: 1100px)");
  let touchStartY = 0;
  let decisionExpanded = false;
  let lastScrollTop = 0;
  let backlogReplayed = false;

  const hero = createHeroCollapse(store);
  const raiseHeroForCall = hero.raise;
  const scheduleHeroCollapse = hero.schedule;

  // Only the selected session's *active* status makes a call answerable —
  // an ended/idle session has no live `cockpit wait` to wake.
  const sessionActive = () => {
    const s = store.sessions.find((x) => x.sessionId === currentSession);
    return !!s && s.status === "active";
  };

  rootEl.classList.add("decision-log");
  rootEl.innerHTML = `
    <div class="decision-log__cards"></div>
    <p class="decision-log__empty placeholder">No decisions logged yet.</p>`;
  const cardsEl = rootEl.querySelector(".decision-log__cards");
  const emptyEl = rootEl.querySelector(".decision-log__empty");
  const latest = createLatestIndicator(rootEl, {
    single: "New",
    plural: "new",
  });

  function updateCompactDecisionSize() {
    if (!decisionInstrumentEl || !mobileLayout.matches) return;
    const latestCard = cardsEl.lastElementChild;
    if (!latestCard) {
      instrumentsEl?.style.removeProperty("--decision-row-block-size");
      return;
    }

    const headEl = decisionInstrumentEl.querySelector(".instrument__head");
    const rootStyle = getComputedStyle(rootEl);
    const cardsStyle = getComputedStyle(cardsEl);
    const padding =
      parseFloat(rootStyle.paddingBlockStart || rootStyle.paddingTop || "0") +
      parseFloat(rootStyle.paddingBlockEnd || rootStyle.paddingBottom || "0");
    const gap = parseFloat(cardsStyle.rowGap || cardsStyle.gap || "0") || 0;
    const headHeight = headEl?.getBoundingClientRect().height || 0;
    const cardHeight = latestCard.getBoundingClientRect().height;
    const reserve = instrumentsEl
      ? parseFloat(
          getComputedStyle(instrumentsEl).getPropertyValue(
            "--transcript-mobile-reserve",
          ),
        ) || 0
      : 0;
    const min = 230;
    const containerCap = instrumentsEl
      ? instrumentsEl.getBoundingClientRect().height - reserve
      : 0;
    const max = Math.max(min, Math.min(window.innerHeight * 0.5, containerCap));
    const next = Math.min(
      max,
      Math.max(min, headHeight + padding + gap + cardHeight),
    );
    instrumentsEl?.style.setProperty(
      "--decision-row-block-size",
      `${Math.round(next)}px`,
    );
  }

  function setDecisionExpanded(expanded) {
    decisionExpanded = expanded && mobileLayout.matches;
    instrumentsEl?.classList.toggle("is-decision-expanded", decisionExpanded);
    if (!decisionExpanded) requestAnimationFrame(updateCompactDecisionSize);
  }

  function expandDecisionPanel() {
    lastScrollTop = rootEl.scrollTop;
    setDecisionExpanded(true);
  }

  function atLayoutBottom() {
    return rootEl.scrollHeight - rootEl.scrollTop - rootEl.clientHeight <= 2;
  }

  function pinDecisionToBottom(duration = 320) {
    const end = performance.now() + duration;
    const pin = () => {
      rootEl.scrollTop = rootEl.scrollHeight;
      lastScrollTop = rootEl.scrollTop;
      if (performance.now() < end) requestAnimationFrame(pin);
    };
    requestAnimationFrame(pin);
  }

  function collapseDecisionPanelToBottom() {
    updateCompactDecisionSize();
    setDecisionExpanded(false);
    store.setHeroCollapsed(true);
    latest.scrollToBottom(false);
    pinDecisionToBottom();
  }

  function handleWheel(e) {
    if (!mobileLayout.matches) return;
    if (decisionExpanded && e.deltaY > 0 && atLayoutBottom()) {
      collapseDecisionPanelToBottom();
      return;
    }
    if (e.deltaY < 0) expandDecisionPanel();
  }

  function handleTouchStart(e) {
    touchStartY = e.touches?.[0]?.clientY || 0;
  }

  function handleTouchMove(e) {
    if (!mobileLayout.matches) return;
    const y = e.touches?.[0]?.clientY || touchStartY;
    const movingTowardHistory = y > touchStartY;
    const movingTowardBottom = y < touchStartY;
    if (decisionExpanded && movingTowardBottom && atLayoutBottom()) {
      collapseDecisionPanelToBottom();
      touchStartY = y;
      return;
    }
    if (movingTowardHistory) expandDecisionPanel();
    touchStartY = y;
  }

  function fitDecisionPanelOnScroll() {
    const scrollTop = rootEl.scrollTop;
    const movingDown = scrollTop > lastScrollTop;
    const movingUp = scrollTop < lastScrollTop;
    lastScrollTop = scrollTop;
    if (!mobileLayout.matches) return;
    if (movingUp) {
      expandDecisionPanel();
      return;
    }
    if (!decisionExpanded || !movingDown) return;
    if (!atLayoutBottom()) return;
    collapseDecisionPanelToBottom();
  }

  mobileLayout.addEventListener("change", () => {
    setDecisionExpanded(false);
  });

  rootEl.addEventListener("wheel", handleWheel, { passive: true });
  rootEl.addEventListener("touchstart", handleTouchStart, { passive: true });
  rootEl.addEventListener("touchmove", handleTouchMove, { passive: true });
  rootEl.addEventListener("scroll", fitDecisionPanelOnScroll, {
    passive: true,
  });
  window.addEventListener("resize", updateCompactDecisionSize);

  cardsEl.addEventListener("click", (e) => {
    const card = e.target.closest(".decision-card");
    if (!card || card !== lastOpenCall || !sessionActive()) return;
    if (e.target.matches(".respond__opt")) {
      selectOption(card, e.target);
    } else if (e.target.matches(".respond__send")) {
      if (card.dataset.responseState === "sent") return;
      const answer = composeAnswer(card);
      if (!answer) return;
      submitAnswer(card, answer);
    } else {
      return;
    }
  });

  cardsEl.addEventListener("input", (e) => {
    if (!e.target.matches(".respond__input")) return;
    const card = e.target.closest(".decision-card");
    if (!card || card !== lastOpenCall) return;
    autosizeInput(e.target);
    updateSendState(card);
  });

  cardsEl.addEventListener("keydown", (e) => {
    if (!e.target.matches(".respond__input")) return;
    if (e.key !== "Enter" || e.shiftKey) return;
    const card = e.target.closest(".decision-card");
    if (!card || card !== lastOpenCall || !sessionActive()) return;
    if (card.dataset.responseState === "sent") return;
    const answer = composeAnswer(card);
    if (!answer) return;
    e.preventDefault();
    submitAnswer(card, answer);
  });

  const isUntracked = () => {
    const s = store.sessions.find((x) => x.sessionId === currentSession);
    return !!s && s.tracked === false;
  };

  function renderEmptyState() {
    if (isUntracked()) {
      emptyEl.classList.remove("placeholder");
      emptyEl.classList.add("decision-log__invite");
      emptyEl.innerHTML = `
        <span class="decision-log__invite-badge">Off the cockpit</span>
        <span class="decision-log__invite-title">Flying without a flight plan</span>
        <span class="decision-log__invite-body">This session isn’t tracked by cockpit, so there’s no decision trail to show.</span>
        <span class="decision-log__invite-cta">Run <code>/cockpit</code> or <code>/thoughtful</code> to auto-log as you work. Either way, decisions worth remembering land here.</span>`;
    } else {
      emptyEl.classList.remove("decision-log__invite");
      emptyEl.classList.add("placeholder");
      emptyEl.textContent = "No decisions logged yet.";
    }
  }

  function reset() {
    seen.clear();
    lastOpenCall = null;
    store.awaitingCall = false;
    backlogReplayed = false;
    setDecisionExpanded(false);
    instrumentsEl?.style.removeProperty("--decision-row-block-size");
    hero.cancel();
    cardsEl.innerHTML = "";
    emptyEl.hidden = false;
    latest.reset();
  }

  function decisionCard(rec) {
    const card = document.createElement("article");
    card.className = "decision-card";
    if (rec.id) card.dataset.callId = rec.id;
    if (rec.needs_your_call) card.classList.add("is-call", "is-open");
    else card.classList.add("is-lit");
    // Whitelist kind values before passing to classList to prevent
    // InvalidCharacterError from malformed/space-containing values.
    const kind = KINDS.includes(rec.kind) ? rec.kind : "decision";
    card.classList.add("is-kind-" + kind);

    const files = (rec.files || [])
      .map((f) => `<code class="decision-card__file">${esc(f)}</code>`)
      .join("");
    const facetRows = (rec.facets || [])
      .filter((f) => f && (f.text || f.label))
      .map((f) => {
        const label = f.label
          ? `<span class="decision-card__facet-label"><span class="decision-card__facet-glyph">${esc(facetGlyph(f.label))}</span>${esc(f.label)}</span>`
          : "";
        return `<p class="decision-card__facet">${label}<span class="decision-card__facet-text">${mdInline(f.text)}</span></p>`;
      })
      .join("");
    const facets = facetRows
      ? `<div class="decision-card__facets">${facetRows}</div>`
      : "";
    const options = (rec.options || [])
      .map((o) => `<li>${esc(o)}</li>`)
      .join("");
    const diagram = rec.diagram
      ? `<figure class="decision-card__diagram" data-pending>
           <pre class="decision-card__diagram-src">${esc(rec.diagram)}</pre>
         </figure>`
      : "";

    card.innerHTML = `
      ${rec.needs_your_call ? '<div class="decision-card__badge">🕹 needs your call</div>' : ""}
      <header class="decision-card__head">
        <div class="decision-card__decision">${mdInline(rec.decision)}</div>
        <time class="decision-card__time" datetime="${esc(rec.timestamp || "")}">${relTime(rec.timestamp)}</time>
      </header>
      <div class="decision-card__reason">${md(rec.reason)}</div>
      ${facets}
      ${diagram}
      ${rec.tradeoff ? `<p class="decision-card__tradeoff">${esc(rec.tradeoff)}</p>` : ""}
      ${files ? `<div class="decision-card__files">${files}</div>` : ""}
      ${options ? `<ul class="decision-card__options">${options}</ul>` : ""}
      ${rec.needs_your_call ? respondForm(rec) : ""}
      <div class="decision-card__answer" hidden></div>`;
    if (rec.diagram) mountDiagram(card, rec.diagram);
    return card;
  }

  async function mountDiagram(card, source) {
    const figure = card.querySelector(".decision-card__diagram");
    if (!figure) return;
    const result = await renderDiagram(source);
    if (result.ok) {
      figure.innerHTML = result.svg;
      figure.removeAttribute("data-pending");
      figure.classList.add("is-zoomable");
      figure.setAttribute("role", "button");
      figure.setAttribute("tabindex", "0");
      figure.setAttribute("aria-label", "Enlarge diagram");
      const title =
        card.querySelector(".decision-card__decision")?.textContent || "";
      figure.addEventListener("click", () =>
        openDiagramLightbox(result.svg, title),
      );
      figure.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openDiagramLightbox(result.svg, title);
        }
      });
      requestAnimationFrame(updateCompactDecisionSize);
    } else {
      figure.removeAttribute("data-pending");
      figure.setAttribute("data-failed", "");
    }
  }

  function respondForm(rec) {
    const btns = (rec.options || [])
      .map(
        (o) =>
          `<button type="button" class="respond__opt" data-answer="${esc(o)}" aria-pressed="false">${esc(o)}</button>`,
      )
      .join("");
    return `
      <div class="decision-card__respond" hidden>
        ${btns ? `<div class="respond__opts">${btns}</div>` : ""}
        <div class="respond__free">
          <textarea rows="1" class="respond__input" placeholder="Add instructions or type a custom answer…"></textarea>
          <button type="button" class="respond__send" disabled>Send</button>
        </div>
        <p class="respond__note" hidden></p>
      </div>`;
  }

  function showRespond(card) {
    if (!card) return;
    card.classList.add("is-answerable");
    const form = card.querySelector(".decision-card__respond");
    if (form) {
      form.hidden = false;
      const input = form.querySelector(".respond__input");
      if (input) autosizeInput(input);
      updateSendState(card);
    }
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
      .querySelectorAll("button, textarea")
      .forEach((el) => (el.disabled = disabled));
  }

  function selectOption(card, button) {
    const form = card.querySelector(".decision-card__respond");
    for (const opt of form.querySelectorAll(".respond__opt")) {
      const selected = opt === button;
      opt.classList.toggle("is-selected", selected);
      opt.setAttribute("aria-pressed", selected ? "true" : "false");
    }
    card.dataset.selectedAnswer = button.dataset.answer || "";
    updateSendState(card);
  }

  function composeAnswer(card) {
    const selected = (card.dataset.selectedAnswer || "").trim();
    const input = card.querySelector(".respond__input");
    const comment = input ? input.value.trim() : "";
    return formatAnswer(selected, comment);
  }

  function updateSendState(card) {
    const send = card.querySelector(".respond__send");
    if (!send) return;
    send.disabled =
      card.dataset.responseState === "sent" || !composeAnswer(card);
  }

  function autosizeInput(input) {
    input.style.height = "auto";
    const max = Math.round(parseFloat(getComputedStyle(input).lineHeight) * 6);
    const next = Math.min(input.scrollHeight, max);
    input.style.height = `${next}px`;
    input.style.overflowY = input.scrollHeight > max ? "auto" : "hidden";
  }

  async function submitAnswer(card, answer) {
    const form = card.querySelector(".decision-card__respond");
    const note = form.querySelector(".respond__note");
    if (card.dataset.responseState === "sent") return;
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
        body: JSON.stringify({
          session: currentSession,
          answer,
          call: card.dataset.callId || null,
          token,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "respond failed");
      card.dataset.responseState = "sent";
      resolveCallCard(
        card,
        answer,
        j && j.delivered === false
          ? "logged, session not listening right now"
          : "",
      );
    } catch {
      note.hidden = false;
      note.textContent = "Failed to send. Try again.";
      delete card.dataset.responseState;
      setFormDisabled(form, false);
      updateSendState(card);
    }
  }

  function resolveCallCard(card, answer, detail = "") {
    hideRespond(card); // answered → retire the buttons

    const opts = card.querySelector(".decision-card__options");
    const lis = opts ? [...opts.querySelectorAll("li")] : [];
    let option = "";
    let instructions = "";
    const combined = splitAnswer(answer);
    if (combined) {
      option = combined.option;
      instructions = combined.instructions;
    } else {
      const a = (answer || "").trim();
      if (lis.some((li) => li.textContent.trim() === a)) option = a;
      else instructions = a;
    }

    if (option) {
      const pick = lis.find((li) => li.textContent.trim() === option);
      if (pick) pick.classList.add("is-chosen");
    }

    const slot = card.querySelector(".decision-card__answer");
    if (instructions || detail) {
      slot.hidden = false;
      const suffix = detail
        ? ` <span class="decision-card__answer-detail">(${esc(detail)})</span>`
        : "";
      const body = instructions ? ` ${esc(instructions)}` : "";
      slot.innerHTML = `<span class="decision-card__answer-label">💬</span>${suffix}${body}`;
    } else {
      slot.hidden = true;
      slot.innerHTML = "";
    }

    card.classList.remove("is-open");
    card.classList.add("is-resolved");
    if (lastOpenCall === card) lastOpenCall = null;
    store.awaitingCall = false; // pilot answered → clear the HUD alert
    requestAnimationFrame(updateCompactDecisionSize);
    if (backlogReplayed) scheduleHeroCollapse();
  }

  function appendResponse(rec) {
    let card = null;
    if (rec.call) {
      card =
        cardsEl.querySelector(`.decision-card[data-call-id="${rec.call}"]`) ||
        null;
    }
    card = card || lastOpenCall;
    if (!card) return false;
    resolveCallCard(card, rec.answer);
    return true;
  }

  function handle(rec) {
    const key = recordKey(rec);
    if (seen.has(key)) return;
    seen.add(key);

    // Legacy tolerance: silently skip retired goal records from old logs.
    if (rec.type === "goal") return;
    if (rec.type === "decision") {
      const pinned = latest.atBottom();
      const card = decisionCard(rec);
      cardsEl.appendChild(card);
      emptyEl.hidden = true;
      requestAnimationFrame(updateCompactDecisionSize);
      if (rec.needs_your_call) {
        if (lastOpenCall) hideRespond(lastOpenCall); // older call isn't latest
        lastOpenCall = card;
        refreshCallState();
        if (backlogReplayed && store.awaitingCall) raiseHeroForCall();
      }
      latest.notify(pinned);
      return;
    }
    if (rec.type === "response") {
      const pinned = latest.atBottom();
      if (appendResponse(rec)) {
        requestAnimationFrame(updateCompactDecisionSize);
        latest.notify(pinned);
      }
    }
  }

  function open(project, session) {
    if (es) {
      es.close();
      es = null;
    }
    reset();
    currentSession = session;
    renderEmptyState();
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
      latest.scrollToBottom(false);
      latest.setEnabled(true);
      requestAnimationFrame(() => {
        updateCompactDecisionSize();
        setDecisionExpanded(false);
      });
      backlogReplayed = true;
      if (store.awaitingCall) raiseHeroForCall();
    });
    es.onerror = () => {
      // EventSource auto-reconnects; dedupe guards against backlog resends.
    };
  }

  setInterval(() => {
    for (const el of cardsEl.querySelectorAll(".decision-card__time[datetime]"))
      el.textContent = relTime(el.getAttribute("datetime"));
  }, 15_000);

  store.subscribe((project, session) => open(project, session));
  store.subscribeSessions(refreshCallState);
  // A deep-linked session may only appear in the list after a poll — refresh the
  // empty-state copy so its untracked invite resolves once the flag arrives.
  store.subscribeSessions(() => {
    if (!emptyEl.hidden) renderEmptyState();
  });
  open(store.selectedProject, store.selectedSessionId);
}
