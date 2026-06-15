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
import { initPermissionModal } from "./modules/permission-modal.js";

const POLL_MS = 3000;
const HERO_AUTO_COLLAPSE_MS = 60_000;

let _tokenPromise = null;
function getToken(force = false) {
  if (force) _tokenPromise = null;
  if (!_tokenPromise) {
    _tokenPromise = fetch("/api/token")
      .then((r) => r.json())
      .then((j) => j.token)
      .catch(() => null);
  }
  return _tokenPromise;
}

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
  channelMessage: "",
  channelSending: false,
  channelError: "",
  codexControl: {},
  opencodeControl: {},
  relaunchCopied: false,

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

  // Fine-grained status of the selected session (registry.ts LiveStatus) —
  // drives the transcript panel's breathing status bar. "ended" when nothing is
  // selected or the field is absent, so the bar rests dim rather than glowing.
  get selectedLiveStatus() {
    return this.selectedSession?.liveStatus || "ended";
  },

  get statusPillLabel() {
    return this.legStatusLabel(this.selectedSession || {});
  },

  // In-flight subagent delegations on the selected session (0 when none/ended).
  get selectedSubagents() {
    return this.selectedSession?.subagents || 0;
  },

  get canUseChannel() {
    const s = this.selectedSession;
    if (!s) return false;
    if (s.provider === "codex") {
      return s.status === "active" && this.selectedCodexControlReady;
    }
    if (s.provider === "opencode") {
      return s.status === "active" && this.selectedOpenCodeControlReady;
    }
    return s.provider === "claude" && s.channel === true;
  },

  get selectedCodexControl() {
    const s = this.selectedSession;
    if (!s || s.provider !== "codex") return null;
    return this.codexControl[this.codexControlKey(s)] || null;
  },

  get selectedCodexControlReady() {
    return this.selectedCodexControl?.ready === true;
  },

  get selectedOpenCodeControl() {
    const s = this.selectedSession;
    if (!s || s.provider !== "opencode") return null;
    return this.opencodeControl[this.controlKey(s)] || null;
  },

  get selectedOpenCodeControlReady() {
    return this.selectedOpenCodeControl?.ready === true;
  },

  get channelDisabledTitle() {
    const s = this.selectedSession;
    if (!s) {
      return this.selectedSessionId
        ? "Session is not in cockpit manifest"
        : "Select a session";
    }
    if (s.provider === "codex") {
      if (s.status !== "active") return "Codex thread is not active";
      const control = this.selectedCodexControl;
      if (!control) return "Checking Codex control";
      if (control.checking) return "Checking Codex control";
      if (!control.ready) return control.error || "Codex control unavailable";
      return "Send to Codex thread";
    }
    if (s.provider === "opencode") {
      if (s.status !== "active") return "OpenCode session is not active";
      const control = this.selectedOpenCodeControl;
      if (!control) return "Checking OpenCode bridge";
      if (control.checking) return "Checking OpenCode bridge";
      if (!control.ready) return control.error || "OpenCode bridge unavailable";
      return "Send to OpenCode session";
    }
    if (!s.channel) return "Launch this session with the cockpit channel";
    return "Send to cockpit channel";
  },

  get channelPlaceholder() {
    const s = this.selectedSession;
    if (!this.canUseChannel) return this.channelDisabledTitle;
    return s?.provider === "codex"
      ? "Message this Codex thread"
      : s?.provider === "opencode"
        ? "Message this OpenCode session"
        : "Message this Claude session";
  },

  get channelSendDisabled() {
    return (
      !this.canUseChannel ||
      this.channelSending ||
      this.channelMessage.trim() === ""
    );
  },

  // A Claude session in the manifest but without a live channel was launched
  // without --dangerously-load-development-channels. The channel can't
  // retro-attach, so the only fix is to relaunch via the channel-aware
  // launcher — surfaced as an inline hint with a copyable command.
  get channelNeedsRelaunch() {
    const s = this.selectedSession;
    return !!s && s.provider === "claude" && s.channel !== true;
  },

  get channelRelaunchCommand() {
    return "claude --dangerously-load-development-channels plugin:monitor@q-lab-marketplace";
  },

  get agentBadgeLabel() {
    const n = this.selectedSubagents;
    return `⊕ ${n} ${n === 1 ? "AGENT" : "AGENTS"}`;
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
    return o === undefined ? defaultExpanded() : o;
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

  // Human label for a leg's fine-grained status (see registry.ts LiveStatus).
  // Falls back to the coarse active/ended for any unexpected value.
  legStatusLabel(s) {
    return (
      {
        working: "Working",
        waiting: "Waiting",
        "your-call": "Your call",
        idle: "Idle",
        shell: "Shell",
        ended: "Ended",
      }[s.liveStatus] ?? (s.status === "active" ? "Active" : "Ended")
    );
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
    this.ensureCodexControl(s);
    this.ensureOpenCodeControl(s);
  },

  controlKey(s) {
    return `${s.provider || "claude"}:${s.sessionId}`;
  },

  codexControlKey(s) {
    return this.controlKey(s);
  },

  async ensureCodexControl(s = this.selectedSession, force = false) {
    if (!s || s.provider !== "codex") return;
    const key = this.codexControlKey(s);
    const existing = this.codexControl[key];
    if (!force && (existing?.ready || existing?.checking)) return;
    this.codexControl = {
      ...this.codexControl,
      [key]: { ready: false, checking: true, error: "" },
    };
    try {
      const token = await getToken();
      if (!token) throw new Error("token unavailable");
      const params = new URLSearchParams({
        session: s.sessionId,
        token,
      });
      const r = await fetch(`/api/codex-control/status?${params}`);
      if (!r.ok) throw new Error(`Codex control check failed: ${r.status}`);
      const j = await r.json();
      const error =
        Array.isArray(j.errors) && j.errors.length ? j.errors.join("; ") : "";
      this.codexControl = {
        ...this.codexControl,
        [key]: {
          ready: j.ready === true,
          checking: false,
          error: j.ready === true ? "" : error || "Codex control unavailable",
        },
      };
    } catch (e) {
      this.codexControl = {
        ...this.codexControl,
        [key]: {
          ready: false,
          checking: false,
          error: (e && e.message) || "Codex control unavailable",
        },
      };
    }
  },

  async ensureOpenCodeControl(s = this.selectedSession, force = false) {
    if (!s || s.provider !== "opencode") return;
    const key = this.controlKey(s);
    const existing = this.opencodeControl[key];
    if (!force && (existing?.ready || existing?.checking)) return;
    this.opencodeControl = {
      ...this.opencodeControl,
      [key]: { ready: false, checking: true, error: "" },
    };
    try {
      const token = await getToken();
      if (!token) throw new Error("token unavailable");
      const params = new URLSearchParams({
        session: s.sessionId,
        token,
      });
      let r = await fetch(`/api/opencode-control/status?${params}`);
      if (r.status === 401) {
        const freshToken = await getToken(true);
        if (!freshToken) throw new Error("token unavailable");
        params.set("token", freshToken);
        r = await fetch(`/api/opencode-control/status?${params}`);
      }
      if (!r.ok) throw new Error(`OpenCode bridge check failed: ${r.status}`);
      const j = await r.json();
      const error =
        Array.isArray(j.errors) && j.errors.length ? j.errors.join("; ") : "";
      this.opencodeControl = {
        ...this.opencodeControl,
        [key]: {
          ready: j.ready === true,
          checking: false,
          error: j.ready === true ? "" : error || "OpenCode bridge unavailable",
          serverUrl: j.serverUrl || "",
        },
      };
    } catch (e) {
      this.opencodeControl = {
        ...this.opencodeControl,
        [key]: {
          ready: false,
          checking: false,
          error: (e && e.message) || "OpenCode bridge unavailable",
        },
      };
    }
  },

  async sendChannelMessage() {
    if (this.channelSendDisabled) return;
    const text = this.channelMessage.trim();
    this.channelSending = true;
    this.channelError = "";
    try {
      let token = await getToken();
      if (!token) throw new Error("token unavailable");
      const endpoint =
        this.selectedSession?.provider === "codex"
          ? "/api/send-codex-message"
          : this.selectedSession?.provider === "opencode"
            ? "/api/send-opencode-message"
            : "/api/send-message";
      let r = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session: this.selectedSessionId,
          text,
          token,
        }),
      });
      if (r.status === 401) {
        token = await getToken(true);
        if (!token) throw new Error("token unavailable");
        r = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session: this.selectedSessionId,
            text,
            token,
          }),
        });
      }
      if (!r.ok) throw new Error(`send failed: ${r.status}`);
      this.channelMessage = "";
    } catch (e) {
      this.channelError = (e && e.message) || "Send failed";
    } finally {
      this.channelSending = false;
    }
  },

  onChannelKeydown(e) {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    this.sendChannelMessage();
  },

  async copyRelaunchCommand() {
    const cmd = this.channelRelaunchCommand;
    if (!cmd) return;
    try {
      await navigator.clipboard.writeText(cmd);
      this.relaunchCopied = true;
      setTimeout(() => {
        this.relaunchCopied = false;
      }, 2000);
    } catch (e) {
      console.error("cockpit: copy relaunch command failed", e);
    }
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

  get activeProjectCount() {
    return this.projectGroups.filter((g) => g.activeCount > 0).length;
  },

  get navIndex() {
    return this.navSessions.findIndex((s) => this.isSelected(s));
  },

  // Arrows only mean something with more than one session to move between.
  get canNavigate() {
    return this.navTotal > 1;
  },

  // Bar readout: position among active sessions while navigable ("2 / 3", an
  // instrument gauge), else the active project (flight) count. Ended-only
  // projects are intentionally filtered out.
  get navLabel() {
    if (this.navTotal > 1) {
      const pos = this.navIndex >= 0 ? this.navIndex + 1 : "–";
      return `${pos} / ${this.navTotal}`;
    }
    const n = this.activeProjectCount;
    return `${n} ${n === 1 ? "flight" : "flights"}`;
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
      if (this.selectedSession?.provider === "codex") {
        this.ensureCodexControl(this.selectedSession);
      }
      if (this.selectedSession?.provider === "opencode") {
        this.ensureOpenCodeControl(this.selectedSession);
      }
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
const rawDeepLinkProvider = deepLink.get("provider") || "claude";
const deepLinkProvider = ["claude", "codex", "opencode"].includes(
  rawDeepLinkProvider,
)
  ? rawDeepLinkProvider
  : "claude";
const deepLinkSessionOk =
  deepLinkProvider === "opencode"
    ? /^[A-Za-z0-9_.:-]{1,160}$/.test(deepLinkSession || "")
    : /^[0-9a-f-]{36}$/i.test(deepLinkSession || "");
if (deepLinkSession && deepLinkSessionOk) {
  store.selectedSessionId = deepLinkSession;
  store.selectedProvider = deepLinkProvider;
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

// Permission relay overlay — subscribes to /api/permission-stream for the
// selected session and drives the reusable modal (own DOM, outside the columns).
store._permissionModal = initPermissionModal(
  document.querySelector("#permission-modal"),
);

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
