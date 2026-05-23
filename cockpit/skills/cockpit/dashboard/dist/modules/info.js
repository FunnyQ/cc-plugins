// Info column — the project's locked settings: goal + project-meta prose +
// CLAUDE.md, rendered read-only. Also applies per-project theming by setting the
// DESIGN.md-derived tokens as CSS custom properties on :root (reset to the
// shell's neutral defaults when the project has no DESIGN.md).
import { store } from "../app.js";
import { marked } from "../vendor/marked.esm.js";
import DOMPurify from "../vendor/purify.es.mjs";

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const md = (t) =>
  DOMPurify.sanitize(marked.parse(t || "", { gfm: true, breaks: false }));
const esc = (t) =>
  String(t ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

// token key → CSS custom property. Only keys present in the response are set.
const TOKEN_VARS = {
  colorBg: "--color-bg",
  colorSurface: "--color-surface",
  colorFg: "--color-fg",
  colorMuted: "--color-muted",
  colorBorder: "--color-border",
  accent: "--accent",
  fontSans: "--font-sans",
  fontMono: "--font-mono",
  radius: "--radius",
  radiusSm: "--radius-sm",
};

function applyTheme(tokens) {
  const root = document.documentElement;
  // Always clear our previous overrides first so switching projects is clean.
  for (const cssVar of Object.values(TOKEN_VARS))
    root.style.removeProperty(cssVar);
  if (!tokens) return; // no DESIGN.md → keep the stylesheet's :root defaults
  for (const [key, cssVar] of Object.entries(TOKEN_VARS)) {
    if (tokens[key]) root.style.setProperty(cssVar, tokens[key]);
  }
}

export function initInfo(rootEl) {
  if (!rootEl) return;

  rootEl.classList.add("info-col");
  rootEl.innerHTML = `<p class="info-col__empty placeholder">Select a session to see its project.</p>`;

  let lastProject = undefined;

  function renderEmpty() {
    rootEl.innerHTML = `<p class="info-col__empty placeholder">Select a session to see its project.</p>`;
    applyTheme(null);
  }

  function render(info) {
    const claude = info.claudeMd
      ? `<details class="info-col__claude" open>
           <summary>CLAUDE.md</summary>
           <div class="info-col__prose markdown">${md(info.claudeMd)}</div>
         </details>`
      : "";
    const metaProse = info.meta
      ? `<div class="info-col__prose markdown">${md(info.meta)}</div>`
      : "";
    rootEl.innerHTML = `
      <div class="info-col__goal">
        <span class="info-col__goal-label">Project goal</span>
        <span class="info-col__goal-text">${esc(info.projectGoal || "(no project goal)")}</span>
      </div>
      ${metaProse ? `<section class="info-col__section"><h4 class="info-col__title">Project meta</h4>${metaProse}</section>` : ""}
      ${claude ? `<section class="info-col__section">${claude}</section>` : ""}`;
    applyTheme(info.tokens);
  }

  async function load(project) {
    if (project === lastProject) return;
    lastProject = project;
    if (!project) {
      renderEmpty();
      return;
    }
    try {
      const r = await fetch(
        `/api/project-info?project=${encodeURIComponent(project)}`,
      );
      if (!r.ok) {
        renderEmpty();
        return;
      }
      const info = await r.json();
      render(info);
    } catch (e) {
      console.error("cockpit: project-info fetch failed", e);
      renderEmpty();
    }
  }

  store.subscribe((project) => load(project));
  load(store.selectedProject);
}
