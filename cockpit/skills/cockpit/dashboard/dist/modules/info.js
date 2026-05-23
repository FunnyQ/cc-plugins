// Info column — the project's locked settings: goal + project-meta prose +
// instruction files, rendered read-only. A project's DESIGN.md tokens are *displayed*
// here as swatches/readouts (they are NOT applied as a theme — the cockpit shell
// keeps its own look across every project).
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

// token key → display label. Colors render as swatches; the rest as readouts.
const COLOR_TOKENS = {
  colorBg: "Background",
  colorSurface: "Surface",
  colorFg: "Foreground",
  colorMuted: "Muted",
  colorBorder: "Border",
  accent: "Accent",
};
const FONT_TOKENS = { fontSans: "Sans", fontMono: "Mono" };
const RADIUS_TOKENS = { radius: "Radius", radiusSm: "Radius · sm" };

// Build the read-only "Design tokens" section as a DOM node, or null when the
// project has no DESIGN.md. Token values come from a hand-written DESIGN.md, so
// they are applied via the DOM style setter (which silently drops anything
// invalid) rather than interpolated into a style="" string — no CSS injection.
function buildTokensSection(tokens) {
  if (!tokens) return null;

  const section = document.createElement("section");
  section.className = "info-col__section info-col__tokens";
  const title = document.createElement("h4");
  title.className = "info-col__title";
  title.textContent = "Design tokens";
  section.append(title);

  const colors = Object.entries(COLOR_TOKENS).filter(([k]) => tokens[k]);
  if (colors.length) {
    const grid = document.createElement("div");
    grid.className = "token-swatches";
    for (const [key, label] of colors) {
      const value = tokens[key];
      const item = document.createElement("div");
      item.className = "token-swatch";
      const chip = document.createElement("span");
      chip.className = "token-swatch__chip";
      chip.style.background = value; // safe DOM setter
      const name = document.createElement("span");
      name.className = "token-swatch__name";
      name.textContent = label;
      const val = document.createElement("span");
      val.className = "token-swatch__value";
      val.textContent = value;
      item.append(chip, name, val);
      grid.append(item);
    }
    section.append(grid);
  }

  const readouts = [];
  for (const [key, label] of Object.entries(FONT_TOKENS)) {
    if (tokens[key]) readouts.push({ label, value: tokens[key], kind: "font" });
  }
  for (const [key, label] of Object.entries(RADIUS_TOKENS)) {
    if (tokens[key])
      readouts.push({ label, value: tokens[key], kind: "radius" });
  }
  if (readouts.length) {
    const list = document.createElement("dl");
    list.className = "token-readouts";
    for (const { label, value, kind } of readouts) {
      const row = document.createElement("div");
      row.className = "token-readout";
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      if (kind === "font") {
        dd.style.fontFamily = value; // safe DOM setter
        dd.textContent = value;
      } else {
        const box = document.createElement("span");
        box.className = "token-radius";
        box.style.borderRadius = value; // safe DOM setter
        const txt = document.createElement("span");
        txt.textContent = value;
        dd.append(box, txt);
      }
      row.append(dt, dd);
      list.append(row);
    }
    section.append(list);
  }

  return section;
}

export function initInfo(rootEl) {
  if (!rootEl) return;

  rootEl.classList.add("info-col");
  rootEl.innerHTML = `<p class="info-col__empty placeholder">Select a session to see its project.</p>`;

  let lastProject = undefined;

  function renderEmpty() {
    rootEl.innerHTML = `<p class="info-col__empty placeholder">Select a session to see its project.</p>`;
  }

  function render(info) {
    const instructionSections = [
      ["AGENTS.md", info.agentsMd],
      ["CLAUDE.md", info.claudeMd],
    ]
      .filter(([, body]) => body)
      .map(
        ([name, body]) => `<details class="info-col__instructions" open>
           <summary>${esc(name)}</summary>
           <div class="info-col__prose markdown">${md(body)}</div>
         </details>`,
      )
      .join("");
    const metaProse = info.meta
      ? `<div class="info-col__prose markdown">${md(info.meta)}</div>`
      : "";
    rootEl.innerHTML = `
      <div class="info-col__goal">
        <span class="info-col__goal-label">Project goal</span>
        <span class="info-col__goal-text">${esc(info.projectGoal || "(no project goal)")}</span>
      </div>
      ${metaProse ? `<section class="info-col__section"><h4 class="info-col__title">Project meta</h4>${metaProse}</section>` : ""}`;
    // Design tokens render before instruction files (which can be long).
    const tokensSection = buildTokensSection(info.tokens);
    if (tokensSection) rootEl.append(tokensSection);
    if (instructionSections) {
      const instructionsSection = document.createElement("section");
      instructionsSection.className = "info-col__section";
      instructionsSection.innerHTML = instructionSections;
      rootEl.append(instructionsSection);
    }
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

  // Modal-driven: app.js calls load(project) from store.openInfo(). No selection
  // subscription — the info modal is opened explicitly per project row.
  return { load };
}
