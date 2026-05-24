// cockpit SPA shell — petite-vue app + shared reactive store.
// The store is exported so per-column modules (./modules/*.js) can read the
// current selection and subscribe to selection changes (no `watch` in petite-vue).
import { createApp, reactive } from "./vendor/petite-vue.es.js";
import {
  defaultExpanded,
  goalSnippet,
  groupSessionsByProject,
} from "./modules/project-rail.js";
import { initDecisionLog } from "./modules/decision-log.js";
import { initTranscript } from "./modules/transcript.js";
import { initStarfield } from "./modules/starfield.js";
import { initLead } from "./modules/lead.js";
import { initDesignSystem } from "./modules/design-system.js";

const POLL_MS = 3000;
const HERO_AUTO_COLLAPSE_MS = 60_000;

function sortActiveFirst(sessions) {
  return [...sessions].sort((a, b) => {
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    return 0;
  });
}

// Shared reactive state + behavior. createApp() uses this object as the root
// scope, and reactive() is idempotent, so `store` is the same proxy the
// template binds to — column modules import it to stay in sync.
export const store = reactive({
  projects: [],
  sessions: [],
  selectedProject: null,
  selectedSessionId: null,
  selectedProvider: null,
  loaded: false,
  // selection-change subscribers (column modules register here)
  _subscribers: [],
  // session-list subscribers (modules register when UI state depends on polled
  // status changes, not just selected id changes).
  _sessionSubscribers: [],
  // per-project expand/collapse overrides (project path → bool); persists
  // across the 3s poll because it lives on the store, not in the render.
  expandedOverrides: {},
  // Hero: clicking the viewport collapses it to a slim bar (a "barrier
  // raised" over the warp) keeping only heading / goal / telemetry, and pauses
  // the warp animation. Toggled by clicking the viewport.
  heroCollapsed: false,
  // Starfield control (set after mount) so toggleHero can pause/resume it.
  _starfield: null,
  // Set true by the decision-log module when the selected (active) session is
  // parked on an open needs_your_call — drives the warm HUD "your turn" alert.
  awaitingCall: false,
  // Manifest drawer: collapsed by default — the viewport already shows the
  // current project + goal, so the project list stays out of the way until
  // opened. Toggled by the manifest bar.
  manifestOpen: false,
  designSystemOpen: false,
  _loadDesignSystem: null,

  get selectedProjectName() {
    if (!this.selectedProject) return "";
    return (
      this.selectedProject.split("/").filter(Boolean).pop() ||
      this.selectedProject
    );
  },

  get selectedProjectGoal() {
    if (!this.selectedProject) return "";
    const p = this.projects.find((x) => x.project === this.selectedProject);
    if (p && p.projectGoal) return p.projectGoal;
    const s = this.sessions.find((x) => x.project === this.selectedProject);
    return s ? s.projectGoal || "" : "";
  },

  // The selected session object + its derived fields drive the viewport hero
  // (the destination we're flying toward and the heading-indicator LED).
  get selectedSession() {
    if (!this.selectedSessionId) return null;
    return (
      this.sessions.find(
        (x) =>
          x.sessionId === this.selectedSessionId &&
          (!this.selectedProvider || x.provider === this.selectedProvider),
      ) || null
    );
  },

  get selectedProviderLabel() {
    return (
      this.selectedSession?.provider ||
      this.selectedProvider ||
      "claude"
    ).toUpperCase();
  },

  get selectedSessionGoal() {
    const s = this.selectedSession;
    return s ? (s.sessionGoal || "").trim() : "";
  },

  // "" when nothing is selected; otherwise the raw session status ("active" /
  // "ended"), used both as the viewport LED modifier class and to pick a label.
  get selectedStatus() {
    const s = this.selectedSession;
    return s ? s.status : "";
  },

  get statusLabel() {
    return this.selectedStatus === "active" ? "Flying" : "Arrived";
  },

  // Short session id for the HUD telemetry readout (first uuid segment).
  get sessionShortId() {
    return this.selectedSessionId
      ? this.selectedSessionId.split("-")[0]
      : "--------";
  },

  toggleManifest() {
    this.manifestOpen = !this.manifestOpen;
  },

  setHeroCollapsed(collapsed) {
    this.heroCollapsed = collapsed;
    if (!this._starfield) return;
    if (this.heroCollapsed) this._starfield.pause();
    else this._starfield.resume();
  },

  toggleHero() {
    this.setHeroCollapsed(!this.heroCollapsed);
  },

  onHeroKeydown(e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    this.toggleHero();
  },

  isSelected(s) {
    return (
      this.selectedSessionId === s.sessionId &&
      this.selectedProvider === (s.provider || "claude")
    );
  },

  // Sessions grouped under their project, ordered active-first then by recency.
  get projectGroups() {
    return groupSessionsByProject(this.sessions, this.projects);
  },

  goalSnippet(text) {
    return goalSnippet(text);
  },

  isProjectExpanded(group) {
    const o = this.expandedOverrides[group.project];
    return o === undefined ? defaultExpanded(group) : o;
  },

  openDesignSystem() {
    this.designSystemOpen = true;
    if (this._loadDesignSystem) this._loadDesignSystem();
  },

  toggleDesignSystem() {
    if (this.designSystemOpen) this.closeDesignSystem();
    else this.openDesignSystem();
  },

  closeDesignSystem() {
    this.designSystemOpen = false;
  },

  toggleProject(group) {
    this.expandedOverrides[group.project] = !this.isProjectExpanded(group);
  },

  shortGoal(s) {
    const g = (s.sessionGoal || "").trim() || "(no session goal)";
    return g.length > 64 ? g.slice(0, 61) + "…" : g;
  },

  selectSession(s) {
    const provider = s.provider || "claude";
    if (
      this.selectedSessionId === s.sessionId &&
      this.selectedProvider === provider
    )
      return;
    this.selectedSessionId = s.sessionId;
    this.selectedProvider = provider;
    this.selectedProject = s.project;
    this._notify();
  },

  // --- session navigator -------------------------------------------------
  // The manifest bar's ‹ › arrows are a remote control for the hero: they
  // step the selection through the *active* (flying) sessions, in the same
  // order the manifest lists them. Ended sessions are skipped.
  get navSessions() {
    const out = [];
    for (const g of this.projectGroups) {
      for (const s of g.sessions) {
        if (s.status === "active") out.push(s);
      }
    }
    return out;
  },

  get navTotal() {
    return this.navSessions.length;
  },

  get navIndex() {
    return this.navSessions.findIndex((s) => this.isSelected(s));
  },

  // Arrows only mean something with more than one session to move between.
  get canNavigate() {
    return this.navTotal > 1;
  },

  // Step by ±1 through active sessions, wrapping at the ends. If the current
  // selection isn't an active session, enter the list from the matching edge.
  stepSession(delta) {
    const list = this.navSessions;
    if (!list.length) return;
    const cur = this.navIndex;
    const next =
      cur < 0
        ? delta > 0
          ? 0
          : list.length - 1
        : (cur + delta + list.length) % list.length;
    this.selectSession(list[next]);
  },

  // Column modules call this to be told when the active session changes.
  // Returns the current selection immediately is the caller's job.
  subscribe(fn) {
    this._subscribers.push(fn);
  },

  subscribeSessions(fn) {
    this._sessionSubscribers.push(fn);
  },

  _notify() {
    for (const fn of this._subscribers) {
      try {
        fn(this.selectedProject, this.selectedSessionId, this.selectedProvider);
      } catch (e) {
        console.error("cockpit: subscriber error", e);
      }
    }
  },

  _notifySessions() {
    for (const fn of this._sessionSubscribers) {
      try {
        fn(this.sessions);
      } catch (e) {
        console.error("cockpit: session subscriber error", e);
      }
    }
  },

  async fetchProjects() {
    try {
      const r = await fetch("/api/projects");
      const j = await r.json();
      this.projects = j.projects || [];
    } catch (e) {
      console.error("cockpit: fetchProjects failed", e);
    }
  },

  async fetchSessions() {
    try {
      const r = await fetch("/api/sessions");
      const j = await r.json();
      this.sessions = sortActiveFirst(j.sessions || []);
      this._notifySessions();
      // First load only: default-select the top (active-first) session.
      if (!this.selectedSessionId && this.sessions.length) {
        this.selectSession(this.sessions[0]);
      }
      this.loaded = true;
    } catch (e) {
      console.error("cockpit: fetchSessions failed", e);
      this.loaded = true;
    }
  },
});

let pollTimer = null;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => store.fetchSessions(), POLL_MS);
}
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling();
  } else {
    store.fetchSessions();
    startPolling();
  }
});

// Deep-link: token-atlas's "Live now" panel links here with
// ?session=&provider=&project= so cockpit opens straight onto that session's
// transcript. Pre-setting the selection makes fetchSessions skip its
// default-select-top, and the transcript column streams by id — so even a
// session cockpit never tracked shows its transcript (its decision log just
// stays on the empty state, since no log file exists for it).
const deepLink = new URLSearchParams(location.search);
const deepLinkSession = deepLink.get("session");
if (deepLinkSession && /^[0-9a-f-]{36}$/i.test(deepLinkSession)) {
  store.selectedSessionId = deepLinkSession;
  store.selectedProvider = deepLink.get("provider") || "claude";
  store.selectedProject = deepLink.get("project") || null;
}

await store.fetchProjects();
await store.fetchSessions();
createApp(store).mount("#app");
startPolling();

// The viewport warp starfield (canvas behind the HUD). Keep the control so the
// hero toggle can pause/resume it.
store._starfield = initStarfield(document.querySelector(".viewport__warp"));
window.setTimeout(() => {
  // Don't lower the barrier over an open needs_your_call — the pilot's turn
  // keeps the viewport raised until they answer (see decision-log hero hooks).
  if (!store.heroCollapsed && !store.awaitingCall) store.setHeroCollapsed(true);
}, HERO_AUTO_COLLAPSE_MS);

// The HUD leader line (underline under the destination → connector to beacon).
initLead({
  svg: document.querySelector(".viewport__lead"),
  viewport: document.querySelector(".viewport"),
  dest: document.querySelector(".viewport__destination"),
  beacon: document.querySelector(".viewport__beacon"),
  telemetry: document.querySelector(".hud__telemetry"),
});

// Mount the imperative columns (they read the store + subscribe to selection).
initTranscript(document.querySelector('[data-column="transcript"]'));
initDecisionLog(document.querySelector('[data-column="decision"]'));
const designSystem = initDesignSystem(
  document.querySelector('[data-column="design-system"]'),
);
store._loadDesignSystem = designSystem && designSystem.load;

// Escape closes drawer overlays; ←/→ step through active sessions.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && store.designSystemOpen) {
    store.closeDesignSystem();
    return;
  }
  // Don't hijack arrows while typing or with a modifier held.
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target?.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || e.target?.isContentEditable)
    return;
  if (e.key === "ArrowLeft") {
    store.stepSession(-1);
  } else if (e.key === "ArrowRight") {
    store.stepSession(1);
  }
});
