// petite-vue has no `watch`, so column modules subscribe to selection changes.
import { createApp, reactive } from "./vendor/petite-vue.es.js";
import {
  defaultExpanded,
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

// reactive() is idempotent, so `store` is the same proxy the template binds
// to — column modules import it to stay in sync.
export const store = reactive({
  projects: [],
  sessions: [],
  selectedProject: null,
  selectedSessionId: null,
  selectedProvider: null,
  loaded: false,
  // Visibility cannot stand in for this switch: a browser window
  // behind the terminal still reports its tab visible.
  answerHere: false,
  _subscribers: [],
  _sessionSubscribers: [],
  expandedOverrides: {},
  heroCollapsed: false,
  _starfield: null,
  awaitingCall: false,
  manifestOpen: false,
  designSystemOpen: false,
  designDocAvailable: false,
  _loadDesignSystem: null,
  _probeDesignSystem: null,
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

  get selectedStatus() {
    const s = this.selectedSession;
    return s ? s.status : "";
  },

  get statusLabel() {
    return this.selectedStatus === "active" ? "Flying" : "Arrived";
  },

  get selectedLiveStatus() {
    return this.selectedSession?.liveStatus || "ended";
  },

  get statusPillLabel() {
    return this.legStatusLabel(this.selectedSession || {});
  },

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
    if (!s.channel) return "This session is not polling the cockpit";
    return "Send to Claude session";
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

  // A Claude session whose monitor mod is not polling the inbox runs an older plugin; a mod loads only at session start.
  get channelNeedsRelaunch() {
    const s = this.selectedSession;
    return !!s && s.provider === "claude" && s.channel !== true;
  },

  get channelRelaunchCommand() {
    const s = this.selectedSession;
    return s ? `claude --resume ${s.sessionId}` : "";
  },

  get agentBadgeLabel() {
    const n = this.selectedSubagents;
    return `⊕ ${n} ${n === 1 ? "AGENT" : "AGENTS"}`;
  },

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

  get projectGroups() {
    return groupSessionsByProject(this.sessions);
  },

  isProjectExpanded(group) {
    const o = this.expandedOverrides[group.project];
    return o === undefined ? defaultExpanded() : o;
  },

  openDesignSystem() {
    this.designSystemOpen = true;
    if (this._loadDesignSystem) this._loadDesignSystem(this.selectedProject);
  },

  toggleDesignSystem() {
    if (this.designSystemOpen) this.closeDesignSystem();
    else this.openDesignSystem();
  },

  closeDesignSystem() {
    this.designSystemOpen = false;
  },

  async refreshDesignAvailability() {
    const project = this.selectedProject;
    const available = this._probeDesignSystem
      ? await this._probeDesignSystem(project)
      : false;
    if (project !== this.selectedProject) return;
    this.designDocAvailable = available;
    if (!available) {
      if (this.designSystemOpen) this.closeDesignSystem();
    } else if (this.designSystemOpen && this._loadDesignSystem) {
      this._loadDesignSystem(project);
    }
  },

  toggleProject(group) {
    this.expandedOverrides[group.project] = !this.isProjectExpanded(group);
  },

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

  get canNavigate() {
    return this.navTotal > 1;
  },

  get navLabel() {
    if (this.navTotal > 1) {
      const pos = this.navIndex >= 0 ? this.navIndex + 1 : "–";
      return `${pos} / ${this.navTotal}`;
    }
    const n = this.activeProjectCount;
    return `${n} ${n === 1 ? "flight" : "flights"}`;
  },

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

  async fetchAnswerHere() {
    const token = await getToken();
    try {
      const r = await fetch(
        `/api/answer-here?token=${encodeURIComponent(token || "")}`,
      );
      if (!r.ok) return;
      this.answerHere = (await r.json()).answer_here === true;
    } catch {
    }
  },

  async toggleAnswerHere() {
    const next = !this.answerHere;
    this.answerHere = next; // optimistic; reconciled from the response below
    const token = await getToken();
    try {
      const r = await fetch("/api/answer-here", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ on: next, token }),
      });
      if (!r.ok) throw new Error(String(r.status));
      this.answerHere = (await r.json()).answer_here === true;
    } catch {
      this.answerHere = !next; // roll back a write the daemon never took
    }
  },

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
store.fetchAnswerHere();
createApp(store).mount("#app");
startPolling();

store._starfield = initStarfield(document.querySelector(".viewport__warp"));
window.setTimeout(() => {
  if (!store.heroCollapsed && !store.awaitingCall) store.setHeroCollapsed(true);
}, HERO_AUTO_COLLAPSE_MS);

initLead({
  svg: document.querySelector(".viewport__lead"),
  viewport: document.querySelector(".viewport"),
  dest: document.querySelector(".viewport__destination"),
  beacon: document.querySelector(".viewport__beacon"),
  telemetry: document.querySelector(".hud__telemetry"),
});

initTranscript(document.querySelector('[data-column="transcript"]'));
initDecisionLog(document.querySelector('[data-column="decision"]'));
const designSystem = initDesignSystem(
  document.querySelector('[data-column="design-system"]'),
);
store._loadDesignSystem = designSystem && designSystem.load;
store._probeDesignSystem = designSystem && designSystem.probe;
store.subscribe(() => store.refreshDesignAvailability());
store.refreshDesignAvailability();

store._permissionModal = initPermissionModal(
  document.querySelector("#permission-modal"),
);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && store.designSystemOpen) {
    store.closeDesignSystem();
    return;
  }
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
