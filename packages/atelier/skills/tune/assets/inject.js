import "./runtime.js";
import { mount } from "./panel.js";

const base = new URL(".", import.meta.url).href;
const HOST_ID = "atelier-host";

window.__atelierDispose?.();

const fonts = document.createElement("style");
fonts.id = `${HOST_ID}-fonts`;
fonts.textContent = [400, 500, 700, 900]
  .map(
    (w) =>
      `@font-face{font-family:"Atelier Schibsted";font-weight:${w};font-display:swap;src:url(${base}fonts/schibsted-${w}.woff2) format("woff2")}`,
  )
  .join("");
document.head.append(fonts);

const host = document.createElement("div");
host.id = HOST_ID;
host.style.cssText = "position:fixed;top:88px;right:24px;z-index:2147483647;";
document.body.append(host);
const shadow = host.attachShadow({ mode: "open" });

shadow.innerHTML = `
<link rel="stylesheet" href="${base}panel.css">
<style>
  :host { all: initial; }
  .float, .pill { border: 1px solid #111; background: #f2f1ec; box-shadow: 0 8px 32px rgba(0,0,0,.22); font: 400 13px/1.35 "Atelier Schibsted", Helvetica, Arial, sans-serif; color: #111; }
  .float { width: 340px; max-height: calc(100vh - 112px); display: grid; grid-template-rows: auto auto 1fr; }
  .grip { display: grid; grid-template-columns: 1fr auto auto; gap: 16px; align-items: center; padding: 8px 12px; border-bottom: 1px solid #111; cursor: grab; user-select: none; }
  .grip b { font-weight: 900; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button { all: unset; cursor: pointer; font-weight: 500; color: #6e6e6a; }
  button:focus-visible, .pill b:focus-visible { outline: 2px solid #111; outline-offset: 2px; }
  .status { grid-column: 1 / -1; color: #6e6e6a; font-weight: 500; }
  .anim { display: grid; grid-template-columns: auto 1fr repeat(4, auto); gap: 12px; align-items: center; padding: 8px 12px; border-bottom: 1px solid #111; }
  .anim .rp { color: #111; font-weight: 700; border: 1px solid #111; padding: 4px 10px; }
  .anim span { color: #6e6e6a; font-weight: 500; justify-self: end; }
  .anim [aria-pressed="true"] { color: #111; font-weight: 700; }
  .pill { display: none; grid-auto-flow: column; align-items: stretch; }
  .pill > * { padding: 10px 14px; }
  .pill b { font-weight: 900; cursor: pointer; }
  .pill .n { border-left: 1px solid #111; color: #e2231a; font-weight: 700; }
  .pill .ap { background: #e2231a; color: #f2f1ec; font-weight: 900; }
  .pill .ap:disabled { background: #111; cursor: default; }
  :host(.collapsed) .float { display: none; }
  :host(.collapsed) .pill { display: grid; }
</style>
<div class="float">
  <div class="grip"><b>atelier</b><button type="button" data-act="collapse">Collapse</button><button type="button" data-act="close">Close</button><span class="status"></span></div>
  <div class="anim"><button type="button" class="rp" data-act="replay">Replay</button><span>Speed</span>${[
    0.1, 0.25, 0.5, 1,
  ]
    .map(
      (r) =>
        `<button type="button" data-speed="${r}" aria-pressed="${r === 1}">${r}×</button>`,
    )
    .join("")}</div>
  <div class="mount" style="min-height:0"></div>
</div>
<div class="pill"><b data-act="expand" tabindex="0">atelier</b><span class="n"></span><button type="button" class="ap" data-act="apply">Apply</button></div>`;

const grip = shadow.querySelector(".grip");
const statusEl = shadow.querySelector(".status");
const pillCount = shadow.querySelector(".pill .n");
const pillApply = shadow.querySelector(".pill .ap");
let speed = 1;
let panel = null;

const pageAnimations = () =>
  document
    .getAnimations()
    .filter((a) => !host.contains(a.effect?.target ?? null));

function replay() {
  for (const a of pageAnimations()) {
    a.cancel();
    a.play();
  }
  window.atelier.emit("replay", Date.now());
}

const speedTimer = setInterval(() => {
  for (const a of pageAnimations())
    if (a.playbackRate !== speed) a.playbackRate = speed;
}, 200);

function dispose() {
  clearInterval(speedTimer);
  panel?.dispose();
  host.remove();
  fonts.remove();
  if (window.__atelierDispose === dispose) delete window.__atelierDispose;
}
window.__atelierDispose = dispose;

shadow.addEventListener("click", (e) => {
  const el = e.target.closest?.("[data-act], [data-speed]");
  if (!el) return;
  if (el.dataset.speed) {
    speed = Number(el.dataset.speed);
    for (const b of shadow.querySelectorAll("[data-speed]"))
      b.setAttribute("aria-pressed", String(b === el));
    return;
  }
  const act = el.dataset.act;
  if (act === "close") dispose();
  else if (act === "collapse") host.classList.add("collapsed");
  else if (act === "expand") host.classList.remove("collapsed");
  else if (act === "replay") replay();
  else if (act === "apply") panel?.apply();
});

grip.addEventListener("pointerdown", (e) => {
  if (e.target.closest("button")) return;
  grip.setPointerCapture(e.pointerId);
  const box = host.getBoundingClientRect();
  const dx = e.clientX - box.left;
  const dy = e.clientY - box.top;
  const move = (ev) => {
    host.style.left = `${Math.max(0, Math.min(innerWidth - 80, ev.clientX - dx))}px`;
    host.style.top = `${Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy))}px`;
    host.style.right = "auto";
  };
  const up = () => {
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", up);
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", up);
});

panel = await mount({
  host: shadow.querySelector(".mount"),
  base,
  compact: true,
  target: () => ({ doc: document, win: window }),
  onStatus: (text) => (statusEl.textContent = text),
  onFoot({ net, changed, clean }) {
    pillCount.textContent =
      net === "down"
        ? "Disconnected"
        : clean
          ? "Applied"
          : `${changed} change${changed === 1 ? "" : "s"}`;
    pillApply.textContent =
      net === "down"
        ? "Retry"
        : net === "sending"
          ? "Sending…"
          : clean
            ? "Applied"
            : "Apply";
    pillApply.disabled = clean || net === "sending";
  },
});
if (panel)
  grip.querySelector("b").textContent = `atelier · ${panel.spec.title}.json`;
