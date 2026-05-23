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
import { initInfo } from "./modules/info.js";

const POLL_MS = 3000;

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
  loaded: false,
  // selection-change subscribers (column modules register here)
  _subscribers: [],
  // per-project expand/collapse overrides (project path → bool); persists
  // across the 3s poll because it lives on the store, not in the render.
  expandedOverrides: {},

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

  isSelected(id) {
    return this.selectedSessionId === id;
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

  toggleProject(group) {
    this.expandedOverrides[group.project] = !this.isProjectExpanded(group);
  },

  shortGoal(s) {
    const g = (s.sessionGoal || "").trim() || "(no session goal)";
    return g.length > 64 ? g.slice(0, 61) + "…" : g;
  },

  selectSession(s) {
    if (this.selectedSessionId === s.sessionId) return;
    this.selectedSessionId = s.sessionId;
    this.selectedProject = s.project;
    this._notify();
  },

  // Column modules call this to be told when the active session changes.
  // Returns the current selection immediately is the caller's job.
  subscribe(fn) {
    this._subscribers.push(fn);
  },

  _notify() {
    for (const fn of this._subscribers) {
      try {
        fn(this.selectedProject, this.selectedSessionId);
      } catch (e) {
        console.error("cockpit: subscriber error", e);
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

await store.fetchProjects();
await store.fetchSessions();
createApp(store).mount("#app");
startPolling();

// Mount the imperative columns (they read the store + subscribe to selection).
initTranscript(document.querySelector('[data-column="transcript"]'));
initDecisionLog(document.querySelector('[data-column="decision"]'));
initInfo(document.querySelector('[data-column="info"]'));
