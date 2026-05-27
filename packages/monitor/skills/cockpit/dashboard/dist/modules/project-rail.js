// cockpit — nested project→session rail (ui/05).
// Pure layout helpers: group the flat /api/sessions list under their project,
// order projects (active first, then most-recent activity), and derive the
// per-project counts + goal snippet the rail renders. State (expand/collapse,
// selection) lives in the shared store in app.js; this module only computes.

export function basename(path) {
  if (!path) return "";
  return path.split("/").filter(Boolean).pop() || path;
}

export function goalSnippet(text, max = 48) {
  const g = (text || "").trim();
  if (!g) return "";
  return g.length > max ? g.slice(0, max - 1) + "…" : g;
}

function lastActivity(sessions) {
  let max = 0;
  for (const s of sessions) {
    const t = s.lastHeartbeat ? new Date(s.lastHeartbeat).getTime() : 0;
    if (t > max) max = t;
  }
  return max;
}

// Group sessions by project, attaching the project's goal (from /api/projects
// when available, else the session's own projectGoal) and active/total counts.
export function groupSessionsByProject(sessions, projects) {
  const byProject = new Map();
  for (const s of sessions) {
    if (!byProject.has(s.project)) byProject.set(s.project, []);
    byProject.get(s.project).push(s);
  }
  const projectGoalOf = (path) => {
    const p = (projects || []).find((x) => x.project === path);
    if (p && p.projectGoal) return p.projectGoal;
    const s = (byProject.get(path) || [])[0];
    return s ? s.projectGoal || "" : "";
  };
  const groups = [];
  for (const [project, group] of byProject) {
    const activeCount = group.filter((s) => s.status === "active").length;
    groups.push({
      project,
      name: basename(project),
      goal: projectGoalOf(project),
      activeCount,
      sessionCount: group.length,
      sessions: group, // already active-first from the global sort
      lastActivity: lastActivity(group),
    });
  }
  return orderProjects(groups);
}

// Active projects first, then by most-recent activity (desc), then by name.
export function orderProjects(groups) {
  return groups.sort((a, b) => {
    const aActive = a.activeCount > 0;
    const bActive = b.activeCount > 0;
    if (aActive !== bActive) return aActive ? -1 : 1;
    if (b.lastActivity !== a.lastActivity)
      return b.lastActivity - a.lastActivity;
    return a.name.localeCompare(b.name);
  });
}

// Default expansion: keep project groups open so ended-only projects still show
// their history at a glance. The store overrides this per user toggle.
export function defaultExpanded(group) {
  return true;
}
