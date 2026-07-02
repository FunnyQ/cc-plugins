// Cockpit design-system instrument: renders this plugin's DESIGN.md visual
// tokens as a native Night Flight panel. No raw markdown view by design.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function tokenSection(title, items, renderItem) {
  if (!items || items.length === 0) return null;
  const section = el("section", "design-system__section");
  section.append(el("h3", "design-system__title", title));
  const grid = el("div", "design-system__grid");
  for (const item of items) grid.append(renderItem(item));
  section.append(grid);
  return section;
}

function colorTile(token) {
  const item = el("div", "design-token design-token--color");
  const chip = el("span", "design-token__chip");
  chip.style.background = token.value;
  const meta = el("span", "design-token__meta");
  meta.append(el("span", "design-token__name", token.name));
  meta.append(el("span", "design-token__value", token.value));
  item.append(chip, meta);
  return item;
}

function typeTile(token) {
  const item = el("div", "design-token design-token--type");
  const sample = el("span", "design-token__sample", token.name);
  sample.style.fontFamily = token.value;
  if (token.fontSize) sample.style.fontSize = token.fontSize;
  if (token.fontWeight) sample.style.fontWeight = token.fontWeight;
  if (token.lineHeight) sample.style.lineHeight = token.lineHeight;
  if (token.letterSpacing) sample.style.letterSpacing = token.letterSpacing;
  const stack = el("span", "design-token__value", token.value);
  item.append(sample, stack);
  return item;
}

function compactTile(token) {
  const item = el("div", "design-token design-token--compact");
  item.append(el("span", "design-token__name", token.name));
  item.append(el("span", "design-token__value", token.value));
  return item;
}

function componentTile(component) {
  const item = el("div", "design-component");
  item.append(el("h4", "design-component__name", component.name));

  const rows = [
    ["BG", component.backgroundColor],
    ["Text", component.textColor],
    ["Radius", component.rounded],
    ["Padding", component.padding],
    ["Height", component.height],
  ].filter(([, value]) => value);

  if (rows.length) {
    const dl = el("dl", "design-component__readouts");
    for (const [label, value] of rows) {
      dl.append(el("dt", "", label));
      dl.append(el("dd", "", value));
    }
    item.append(dl);
  }

  if (component.note) {
    item.append(el("p", "design-component__note", component.note));
  }
  return item;
}

function renderRules(root, rules) {
  if (!rules || rules.length === 0) return;
  const section = el("section", "design-system__section");
  section.append(el("h3", "design-system__title", "Flight Rules"));
  const list = el("div", "design-rules");
  for (const rule of rules.slice(0, 8)) {
    const item = el("article", "design-rule");
    item.append(el("h4", "design-rule__name", rule.name));
    item.append(el("p", "design-rule__body", rule.body));
    list.append(item);
  }
  section.append(list);
  root.append(section);
}

function renderDesignSystem(rootEl, data) {
  rootEl.innerHTML = "";
  rootEl.classList.add("design-system");

  const intro = el("section", "design-system__intro");
  intro.append(el("p", "design-system__kicker", "Design System"));
  intro.append(el("h2", "design-system__name", data.name || "Night Flight"));
  if (data.description) {
    intro.append(el("p", "design-system__description", data.description));
  }
  rootEl.append(intro);

  const colorSection = tokenSection("Color Ramp", data.colors, colorTile);
  if (colorSection) rootEl.append(colorSection);

  const typeSection = tokenSection("Typography", data.typography, typeTile);
  if (typeSection) rootEl.append(typeSection);

  const roundedSection = tokenSection("Radius", data.rounded, compactTile);
  if (roundedSection) rootEl.append(roundedSection);

  const spacingSection = tokenSection("Spacing", data.spacing, compactTile);
  if (spacingSection) rootEl.append(spacingSection);

  const componentSection = tokenSection(
    "Component Readouts",
    data.components,
    componentTile,
  );
  if (componentSection) rootEl.append(componentSection);

  renderRules(rootEl, data.rules);
}

export function initDesignSystem(rootEl) {
  if (!rootEl) return null;
  // Cache only positive hits (a project's parsed design doc); a missing doc is
  // re-probed on each selection so a DESIGN.md added mid-session still surfaces.
  const cache = new Map();
  let renderedProject = null;

  async function fetchFor(project) {
    if (cache.has(project)) return cache.get(project);
    let data = null;
    try {
      const res = await fetch(
        `/api/design-system?project=${encodeURIComponent(project)}`,
      );
      if (res.ok) data = await res.json();
    } catch (e) {
      console.error("cockpit: design-system fetch failed", e);
    }
    if (data) cache.set(project, data);
    return data;
  }

  // Availability probe for the DESIGN toggle — true iff the project has a doc.
  async function probe(project) {
    if (!project) return false;
    return (await fetchFor(project)) !== null;
  }

  async function load(project) {
    if (!project) return;
    if (renderedProject === project && cache.get(project)) return;
    rootEl.classList.add("design-system");
    rootEl.innerHTML = `<p class="placeholder">Loading design system.</p>`;
    const data = await fetchFor(project);
    if (data) {
      renderDesignSystem(rootEl, data);
      renderedProject = project;
    } else {
      renderedProject = null;
      rootEl.innerHTML = `<p class="placeholder">No design doc for this project.</p>`;
    }
  }

  return { load, probe };
}
