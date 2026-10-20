export function basename(path) {
  if (!path) return "";
  return path.split("/").filter(Boolean).pop() || path;
}

function lastActivity(sessions) {
  let max = 0;
  for (const s of sessions) {
    const t = s.lastHeartbeat ? new Date(s.lastHeartbeat).getTime() : 0;
    if (t > max) max = t;
  }
  return max;
}

export function groupSessionsByProject(sessions) {
  const byProject = new Map();
  for (const s of sessions) {
    if (!byProject.has(s.project)) byProject.set(s.project, []);
    byProject.get(s.project).push(s);
  }
  const groups = [];
  for (const [project, group] of byProject) {
    const activeCount = group.filter((s) => s.status === "active").length;
    groups.push({
      project,
      name: basename(project),
      activeCount,
      sessionCount: group.length,
      sessions: group, // already active-first from the global sort
      lastActivity: lastActivity(group),
    });
  }
  return orderProjects(groups);
}

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

export function defaultExpanded() {
  return true;
}
