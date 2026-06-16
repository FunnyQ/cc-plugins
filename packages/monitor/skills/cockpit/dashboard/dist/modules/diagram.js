// Mermaid diagram rendering for the cockpit. A decision entry can carry Mermaid
// text; this module turns it into a themed, sanitized SVG. Everything DOM-bound
// (the Mermaid bundle, DOMPurify) is loaded lazily on first render, so a session
// with no diagrams never pays the ~3.3MB bundle cost and the module's static
// surface (the theme) stays importable under plain Bun for tests.

// Mermaid's colour engine (khroma) derives shades from these seed colours and
// can't parse oklch(), so the Night Flight palette is mirrored here as concrete
// hex. Keep in lockstep with the OKLCH tokens in style.css — the values below
// are the sRGB renderings of --void/--hull/--aurora/… (see the conversion noted
// in the cockpit diagram feature work). Drift here just means an off-theme
// diagram, never a broken one.
export const NIGHT_FLIGHT_THEME = {
  darkMode: true,
  background: "transparent",
  // Surface ramp — nodes read as raised hull panels against the card.
  mainBkg: "#222537", // --hull-2
  secondBkg: "#171929", // --hull
  tertiaryColor: "#0e101f", // --space
  // Primary node
  primaryColor: "#222537", // --hull-2
  primaryBorderColor: "#2ad7d7", // --aurora (cool navigation accent)
  primaryTextColor: "#edeef4", // --starlight
  nodeTextColor: "#edeef4", // flowchart label text (SVG <text>, htmlLabels off)
  // Secondary / tertiary nodes
  secondaryColor: "#171929", // --hull
  secondaryBorderColor: "#393c4d", // --edge
  secondaryTextColor: "#edeef4",
  tertiaryBorderColor: "#393c4d",
  tertiaryTextColor: "#a8aab6", // --ink-muted
  // Edges and arrows — quiet, off the accent.
  lineColor: "#777988", // --ink-faint
  // Text
  textColor: "#edeef4",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  fontSize: "14px",
  // Notes — the one warm reserve, matched to --signal.
  noteBkgColor: "#feb35422",
  noteBorderColor: "#feb354", // --signal
  noteTextColor: "#edeef4",
  // Clusters / subgraphs
  clusterBkg: "#0e101f", // --space
  clusterBorder: "#393c4d", // --edge
  // Labels riding on edges
  edgeLabelBackground: "#171929",
  // State/flow accents reuse the semantic palette.
  nodeBorder: "#2ad7d7",
  defaultLinkColor: "#777988",
  titleColor: "#edeef4",
  // Sequence diagram actor styling
  actorBkg: "#222537",
  actorBorder: "#2ad7d7",
  actorTextColor: "#edeef4",
  activationBkgColor: "#222537",
  signalColor: "#a8aab6",
  signalTextColor: "#edeef4",
};

// Deterministic per-render id (no Math.random) so Mermaid's id-scoped <style>
// block can't collide across cards.
let _idSeq = 0;
function nextDiagramId() {
  return `cockpit-mmd-${++_idSeq}`;
}

let _mermaidPromise = null;

// Inject the vendored UMD bundle once. It assigns globalThis.mermaid; resolve to
// a configured instance. Subsequent calls reuse the same promise — but a failed
// load drops the cached promise so a later render can retry instead of being
// permanently stuck behind a one-time failure.
function loadMermaid() {
  if (_mermaidPromise) return _mermaidPromise;
  _mermaidPromise = new Promise((resolve, reject) => {
    if (globalThis.mermaid) return resolve(globalThis.mermaid);
    const script = document.createElement("script");
    script.src = new URL("../vendor/mermaid.min.js", import.meta.url).href;
    script.onload = () =>
      globalThis.mermaid
        ? resolve(globalThis.mermaid)
        : reject(new Error("mermaid global missing after load"));
    script.onerror = () => reject(new Error("failed to load mermaid bundle"));
    document.head.appendChild(script);
  }).then((mermaid) => {
    mermaid.initialize({
      startOnLoad: false,
      // strict: no click handlers, no embedded scripts. htmlLabels:false (set both
      // top-level and per-diagram) forces labels to render as SVG <text> rather
      // than <foreignObject> HTML — so they survive the SVG-profile sanitize below
      // (which strips foreignObject). The DOMPurify pass is defense-in-depth.
      securityLevel: "strict",
      htmlLabels: false,
      theme: "base",
      themeVariables: NIGHT_FLIGHT_THEME,
      flowchart: { htmlLabels: false, curve: "basis" },
      fontFamily: NIGHT_FLIGHT_THEME.fontFamily,
    });
    return mermaid;
  });
  _mermaidPromise.catch(() => {
    _mermaidPromise = null; // let the next render retry a failed load
  });
  return _mermaidPromise;
}

// SVG-profile sanitization. Mermaid (strict) emits SVG + an id-scoped <style>;
// DOMPurify's svg profile keeps those and strips scripts/event handlers. Loaded
// lazily so the static module surface needs no DOM.
async function sanitizeSvg(svg) {
  const { default: DOMPurify } = await import("../vendor/purify.es.mjs");
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // strict mode shouldn't produce these, but never let one through.
    FORBID_TAGS: ["foreignObject", "script"],
  });
}

// Render Mermaid text → sanitized SVG string. Never throws: a parse error or a
// bundle that won't load resolves to { ok:false, error } so the card can show a
// graceful fallback instead of breaking the column.
export async function renderDiagram(text) {
  const src = (text || "").trim();
  if (!src) return { ok: false, error: "empty diagram" };
  let mermaid;
  try {
    mermaid = await loadMermaid();
  } catch (e) {
    return { ok: false, error: e?.message || "mermaid failed to load" };
  }
  try {
    const { svg } = await mermaid.render(nextDiagramId(), src);
    return { ok: true, svg: await sanitizeSvg(svg) };
  } catch (e) {
    // mermaid.render can inject a stray error node into <body> on parse failure.
    document
      .querySelectorAll('[id^="dcockpit-mmd-"]')
      .forEach((n) => n.remove());
    return { ok: false, error: e?.message || "could not render diagram" };
  }
}
