// Without a class every flowchart node reads as the same accent. Fill is the
// stroke's hue at low alpha so the tint reads over the dark card. Concrete hex, not
// the OKLCH tokens, because this CSS rides inside a downloaded SVG too.
export const SEMANTIC_NODES = {
  start: { stroke: "#777988", fill: "#22253766" }, // neutral entry — --ink-faint
  info: { stroke: "#2ad7d7", fill: "#2ad7d71f" }, // cool note — --aurora
  ok: { stroke: "#4fd6a3", fill: "#4fd6a31f" }, // success path — aurora-green badge
  bad: { stroke: "#e5605f", fill: "#e5605f1f" }, // failure path — --danger
  fix: { stroke: "#feb354", fill: "#feb3541f" }, // the fix / action — --signal
  warn: { stroke: "#feb354", fill: "#feb35414" }, // softer caution — --signal, dimmer
};

// pele puts a `:::name` marker on the node's <g> and paints shapes through
// presentation attributes, which any CSS rule outranks. A second path with
// fill="none" is a shape's outline detail (the cylinder's lid), so it keeps it.
const SEMANTIC_NODE_CSS = Object.entries(SEMANTIC_NODES)
  .map(
    ([name, { stroke, fill }]) => `
.pele-node.${name} > :is(rect, polygon, circle, path) { stroke: ${stroke}; }
.pele-node.${name} > :is(rect, polygon, circle, path):not([fill="none"]) { fill: ${fill}; }`,
  )
  .join("\n");

const FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

let _idSeq = 0;
function nextDiagramId() {
  return `cockpit-pele-${++_idSeq}-`;
}

let _lightbox = null;
let _lightboxSvg = null;
let _lightboxTitle = "";

function onLightboxKey(e) {
  if (e.key === "Escape") closeDiagramLightbox();
}

function ensureLightbox() {
  if (_lightbox) return _lightbox;
  const overlay = document.createElement("div");
  overlay.className = "diagram-lightbox";
  overlay.hidden = true;
  overlay.innerHTML = `
    <button type="button" class="diagram-lightbox__download">SVG ⤓</button>
    <button type="button" class="diagram-lightbox__close" aria-label="Close">✕</button>
    <div class="diagram-lightbox__stage" role="dialog" aria-modal="true" aria-label="Enlarged diagram">
      <div class="diagram-lightbox__canvas"></div>
    </div>`;
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.closest(".diagram-lightbox__close"))
      closeDiagramLightbox();
    else if (e.target.closest(".diagram-lightbox__download"))
      downloadDiagramSvg();
  });
  document.body.appendChild(overlay);
  _lightbox = overlay;
  return overlay;
}

export const PELE_VARS = [
  "--pele-bg",
  "--pele-fg",
  "--pele-muted",
  "--pele-line",
  "--pele-surface",
  "--pele-surface-alt",
  "--pele-border",
  "--pele-accent",
  "--pele-critical",
  "--pele-error",
  ...Array.from({ length: 8 }, (_, i) => `--pele-series-${i + 1}`),
];

// A downloaded file loses the page CSS variables its colours come from, and on
// a white page the Night Flight ink would be unreadable.
function standaloneSvg(svg, live) {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName !== "svg") return svg;
  root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  if (live) {
    const computed = getComputedStyle(live);
    for (const name of PELE_VARS) {
      const value = computed.getPropertyValue(name).trim();
      if (value) root.style.setProperty(name, value);
    }
  }
  root.style.backgroundColor = "#0e101f"; // --space
  return new XMLSerializer().serializeToString(root);
}

function downloadDiagramSvg() {
  if (!_lightboxSvg) return;
  const slug =
    (_lightboxTitle || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "diagram";
  const live = _lightbox.querySelector(".diagram-lightbox__canvas svg");
  const blob = new Blob([standaloneSvg(_lightboxSvg, live)], {
    type: "image/svg+xml",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cockpit-${slug}.svg`;
  a.click();
  URL.revokeObjectURL(url);
}

// card — no re-render). The inline width/height/max-width pele bakes in would
// cap the blow-up, so strip them and let CSS scale the SVG by its viewBox.
export function openDiagramLightbox(svg, title = "") {
  if (!svg) return;
  const overlay = ensureLightbox();
  _lightboxSvg = svg;
  _lightboxTitle = title;
  const canvas = overlay.querySelector(".diagram-lightbox__canvas");
  canvas.innerHTML = svg;
  const svgEl = canvas.querySelector("svg");
  if (svgEl) {
    svgEl.removeAttribute("width");
    svgEl.removeAttribute("height");
    svgEl.style.maxWidth = "none";
    svgEl.style.width = "100%";
    svgEl.style.height = "auto";
  }
  overlay.hidden = false;
  document.addEventListener("keydown", onLightboxKey);
  overlay.querySelector(".diagram-lightbox__close")?.focus();
}

export function closeDiagramLightbox() {
  if (!_lightbox || _lightbox.hidden) return;
  _lightbox.hidden = true;
  _lightbox.querySelector(".diagram-lightbox__canvas").innerHTML = "";
  _lightboxSvg = null;
  _lightboxTitle = "";
  document.removeEventListener("keydown", onLightboxKey);
}

// Defense in depth: pele claims to emit no scripts, handlers, or HTML labels.
async function sanitizeSvg(svg) {
  const { default: DOMPurify } = await import("../vendor/purify.es.mjs");
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["foreignObject", "script"],
  });
}

export async function renderDiagram(text) {
  const src = (text || "").trim();
  if (!src) return { ok: false, error: "empty diagram" };
  try {
    const { render } = await import("../vendor/pele.js");
    const { svg } = render(src, {
      fontFamily: FONT_FAMILY,
      fontSize: 14,
      idPrefix: nextDiagramId(),
    });
    const styled = svg.replace(
      /^<svg[^>]*>/,
      `$&<style>${SEMANTIC_NODE_CSS}</style>`,
    );
    return { ok: true, svg: await sanitizeSvg(styled) };
  } catch (e) {
    return { ok: false, error: e?.message || "could not render diagram" };
  }
}
