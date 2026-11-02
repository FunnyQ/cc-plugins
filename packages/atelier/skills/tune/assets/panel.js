import { cssVars, fits, outputValue, roundToStep } from "./lib/format";
import { springEasing } from "./lib/spring";

const NUMERIC = new Set(["range", "number", "duration"]);
const SPRING_PARTS = [
  { key: "stiffness", label: "Stiffness", min: 1, max: 1000, step: 1 },
  { key: "damping", label: "Damping", min: 1, max: 100, step: 0.5 },
  { key: "mass", label: "Mass", min: 0.1, max: 10, step: 0.1 },
];
const SVG = "http://www.w3.org/2000/svg";

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== false && v !== undefined)
      el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...kids.flat().filter((k) => k !== null && k !== undefined));
  return el;
};
const s = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const time = (iso) => new Date(iso).toTimeString().slice(0, 5);

export async function mount({
  host,
  base,
  target,
  compact = false,
  onStatus = () => {},
  onFoot = () => {},
}) {
  const root = h("div", { class: compact ? "atelier compact" : "atelier" });
  host.append(root);

  let spec;
  const res = await fetch(`${base}spec.json`).catch(() => null);
  if (!res)
    return renderFatal(
      root,
      "Cannot reach atelier.",
      "Ask the agent to run tune.ts open again, then reload.",
    );
  spec = await res.json();
  if (!res.ok)
    return renderFatal(
      root,
      spec.error,
      "Fix the spec and reload; the controls stay off until it parses.",
      "Spec error",
    );

  const key = `atelier:${base}`;
  const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
  const defaults = Object.fromEntries(
    spec.params.map((p) => [p.id, p.default]),
  );
  const values = Object.fromEntries(
    spec.params.map((p) => [
      p.id,
      fits(p, saved.values?.[p.id]) ? saved.values[p.id] : p.default,
    ]),
  );
  let applied = spec.params.every((p) => fits(p, saved.applied?.values?.[p.id]))
    ? saved.applied
    : null;
  let active = spec.params.find((p) => NUMERIC.has(p.type)) ?? spec.params[0];
  let net = "ok";
  let agent = { seq: 0, consumed: 0, waiting: false };

  const byId = Object.fromEntries(spec.params.map((p) => [p.id, p]));
  const rows = {};
  const baseline = () => applied?.values ?? defaults;
  const changed = () =>
    spec.params.filter((p) => !same(values[p.id], baseline()[p.id]));
  const outputs = (from = values) =>
    Object.fromEntries(
      spec.params.map((p) => [p.id, outputValue(p, from[p.id])]),
    );
  const persist = () =>
    localStorage.setItem(key, JSON.stringify({ values, applied }));

  function write(p) {
    const { doc, win } = target();
    if (!doc) return;
    if (p.bind === "css") {
      const els =
        p.target === ":root"
          ? [doc.documentElement]
          : doc.querySelectorAll(p.target);
      for (const el of els)
        for (const [name, css] of Object.entries(cssVars(p, values[p.id])))
          el.style.setProperty(name, css);
    } else {
      const vars = cssVars(p, values[p.id]);
      win?.atelier?.emit(p.id, values[p.id], vars[`--${p.id}`], vars);
    }
  }
  const writeAll = () => spec.params.forEach(write);

  function set(id, value, { from } = {}) {
    values[id] = value;
    active = byId[id];
    write(byId[id]);
    persist();
    rows[id].sync(from);
    renderHead();
    renderFoot();
  }

  const head = h("div", { class: "head" });
  function renderHead() {
    const p = active;
    const v = values[p.id];
    let big;
    if (NUMERIC.has(p.type)) {
      big = h(
        "div",
        {
          class: "n scrub tnum",
          title: "Drag sideways · Shift for fine steps",
        },
        String(roundToStep(v, p.step)),
        p.unit ? h("sup", {}, p.unit) : null,
      );
      big.addEventListener("pointerdown", (e) => scrub(e, p));
    } else if (p.type === "spring")
      big = h(
        "div",
        { class: "n text tnum" },
        `${springEasing(v).durationMs}`,
        h("sup", {}, "ms"),
      );
    else if (p.type === "bezier")
      big = h(
        "div",
        { class: "n text tnum" },
        v.map((n) => n.toFixed(2)).join(" "),
      );
    else if (p.type === "toggle")
      big = h("div", { class: "n text" }, v ? "On" : "Off");
    else big = h("div", { class: "n text" }, String(v).toUpperCase());
    const range = NUMERIC.has(p.type)
      ? `${p.min} – ${p.max}${p.unit ? ` ${p.unit}` : ""}`
      : p.type === "select"
        ? p.options.join(" · ")
        : p.type;
    const fill = NUMERIC.has(p.type)
      ? ((v - p.min) / (p.max - p.min)) * 100
      : 0;
    head.replaceChildren(
      h(
        "div",
        { class: "k" },
        h("span", {}, `${p.folder} / ${p.label}`),
        h("span", { class: "tnum" }, range),
      ),
      h(
        "div",
        {},
        big,
        NUMERIC.has(p.type)
          ? h("div", { class: "h" }, "Drag the number · Shift for fine steps")
          : null,
      ),
      h("div", { class: "sc" }, h("b", { style: `width:${fill}%` })),
    );
  }
  function scrub(e, p) {
    e.preventDefault();
    const x0 = e.clientX;
    const v0 = values[p.id];
    const move = (ev) => {
      const fine = ev.shiftKey ? 0.1 : 1;
      const step = p.step * fine;
      const next = clamp(
        roundToStep(
          v0 + ((ev.clientX - x0) * (p.max - p.min) * fine) / 320,
          step,
        ),
        p.min,
        p.max,
      );
      if (next !== values[p.id]) set(p.id, next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function numberInput(get, put, { min, max, step }) {
    const input = h("input", {
      type: "text",
      inputmode: "decimal",
      spellcheck: "false",
      "aria-label": "value",
    });
    const commit = () => {
      const n = Number(input.value);
      if (Number.isFinite(n)) put(clamp(roundToStep(n, step), min, max));
      else input.value = get();
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      const delta = (e.key === "ArrowUp" ? 1 : -1) * step * mult;
      put(
        clamp(
          roundToStep(Number(get()) + delta, e.altKey ? step / 10 : step),
          min,
          max,
        ),
      );
    });
    return input;
  }

  function numericRow(p) {
    const range = h("input", {
      type: "range",
      min: p.min,
      max: p.max,
      step: p.step,
      "aria-label": p.label,
    });
    const text = numberInput(
      () => values[p.id],
      (n) => set(p.id, n),
      p,
    );
    range.addEventListener("input", () =>
      set(p.id, Number(range.value), { from: range }),
    );
    const el = h(
      "div",
      { class: "p" },
      h(
        "div",
        { class: "t" },
        h("label", {}, p.label),
        h(
          "span",
          { class: "val" },
          text,
          p.unit ? h("small", {}, p.unit) : null,
        ),
      ),
      range,
    );
    el.addEventListener("focusin", () => focus(p));
    return {
      el,
      sync(from) {
        const v = values[p.id];
        if (from !== range) range.value = v;
        range.style.setProperty(
          "--fill",
          `${((v - p.min) / (p.max - p.min)) * 100}%`,
        );
        if (document.activeElement !== text)
          text.value = roundToStep(v, p.step);
      },
    };
  }

  function colorRow(p) {
    const sw = h("input", {
      type: "color",
      class: "sw",
      "aria-label": p.label,
    });
    const hex = h("input", {
      type: "text",
      spellcheck: "false",
      "aria-label": `${p.label} hex`,
    });
    sw.addEventListener("input", () => set(p.id, sw.value, { from: sw }));
    hex.addEventListener("change", () => {
      const v = hex.value.trim().replace(/^#?/, "#").toLowerCase();
      if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(v)) set(p.id, v);
      else hex.value = values[p.id];
    });
    const el = h(
      "div",
      { class: "p" },
      h(
        "div",
        { class: "t" },
        h("label", {}, p.label),
        h("span", { class: "val" }, sw, hex),
      ),
    );
    el.addEventListener("focusin", () => focus(p));
    return {
      el,
      sync(from) {
        const v = values[p.id];
        const six =
          v.length === 4 ? `#${[...v.slice(1)].map((c) => c + c).join("")}` : v;
        if (from !== sw) sw.value = six;
        if (document.activeElement !== hex) hex.value = v;
      },
    };
  }

  function selectRow(p) {
    const sel = h(
      "select",
      { "aria-label": p.label },
      p.options.map((o) => h("option", { value: o }, o)),
    );
    sel.addEventListener("change", () => set(p.id, sel.value));
    const el = h(
      "div",
      { class: "p" },
      h("div", { class: "t" }, h("label", {}, p.label), sel),
    );
    el.addEventListener("focusin", () => focus(p));
    return { el, sync: () => (sel.value = values[p.id]) };
  }

  function toggleRow(p) {
    const box = h("input", {
      type: "checkbox",
      class: "tg",
      "aria-label": p.label,
    });
    box.addEventListener("change", () => set(p.id, box.checked));
    const el = h(
      "div",
      { class: "p" },
      h("div", { class: "t" }, h("label", {}, p.label), box),
    );
    el.addEventListener("focusin", () => focus(p));
    return { el, sync: () => (box.checked = values[p.id]) };
  }

  function bezierRow(p) {
    const W = 112;
    const toY = (y) => W - y * W;
    const svg = s("svg", {
      viewBox: `0 0 ${W} ${W}`,
      role: "img",
      "aria-label": `${p.label} curve`,
    });
    const frame = s("rect", {
      x: 0,
      y: 0,
      width: W,
      height: W,
      fill: "none",
      stroke: "#d9d8d1",
    });
    const l1 = s("line", { stroke: "#6e6e6a" });
    const l2 = s("line", { stroke: "#6e6e6a" });
    const curve = s("path", {
      fill: "none",
      stroke: "#111",
      "stroke-width": 2,
    });
    const h1 = s("rect", { class: "h", width: 10, height: 10, fill: "#111" });
    const h2 = s("rect", { class: "h", width: 10, height: 10, fill: "#111" });
    svg.append(frame, l1, l2, curve, h1, h2);
    const inputs = [0, 1, 2, 3].map((i) =>
      numberInput(
        () => values[p.id][i],
        (n) =>
          set(
            p.id,
            values[p.id].map((v, j) => (j === i ? n : v)),
          ),
        i % 2 === 0
          ? { min: 0, max: 1, step: 0.01 }
          : { min: -1, max: 2, step: 0.01 },
      ),
    );
    for (const [handle, ix] of [
      [h1, 0],
      [h2, 2],
    ]) {
      handle.addEventListener("pointerdown", (e) => {
        handle.setPointerCapture(e.pointerId);
        const box = svg.getBoundingClientRect();
        const move = (ev) => {
          const x = roundToStep(
            clamp((ev.clientX - box.left) / box.width, 0, 1),
            0.01,
          );
          const y = roundToStep(
            clamp(1 - (ev.clientY - box.top) / box.height, -1, 2),
            0.01,
          );
          set(
            p.id,
            values[p.id].map((v, j) => (j === ix ? x : j === ix + 1 ? y : v)),
          );
        };
        const up = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
      });
    }
    const el = h(
      "div",
      { class: "p" },
      h("div", { class: "t" }, h("label", {}, p.label)),
      h("div", { class: "crv" }, svg, h("span", { class: "val" }, inputs)),
    );
    el.addEventListener("focusin", () => focus(p));
    el.addEventListener("pointerdown", () => focus(p));
    return {
      el,
      sync() {
        const [x1, y1, x2, y2] = values[p.id];
        const a = [x1 * W, toY(y1)];
        const b = [x2 * W, toY(y2)];
        (l1.setAttribute("x1", 0),
          l1.setAttribute("y1", W),
          l1.setAttribute("x2", a[0]),
          l1.setAttribute("y2", a[1]));
        (l2.setAttribute("x1", W),
          l2.setAttribute("y1", 0),
          l2.setAttribute("x2", b[0]),
          l2.setAttribute("y2", b[1]));
        curve.setAttribute(
          "d",
          `M0 ${W}C${a[0]} ${a[1]} ${b[0]} ${b[1]} ${W} 0`,
        );
        (h1.setAttribute("x", a[0] - 5), h1.setAttribute("y", a[1] - 5));
        (h2.setAttribute("x", b[0] - 5), h2.setAttribute("y", b[1] - 5));
        inputs.forEach(
          (input, i) =>
            document.activeElement !== input &&
            (input.value = values[p.id][i].toFixed(2)),
        );
      },
    };
  }

  function springRow(p) {
    const parts = SPRING_PARTS.map((part) => {
      const range = h("input", {
        type: "range",
        min: part.min,
        max: part.max,
        step: part.step,
        "aria-label": `${p.label} ${part.label}`,
      });
      const text = numberInput(
        () => values[p.id][part.key],
        (n) => set(p.id, { ...values[p.id], [part.key]: n }),
        part,
      );
      range.addEventListener("input", () =>
        set(
          p.id,
          { ...values[p.id], [part.key]: Number(range.value) },
          { from: range },
        ),
      );
      return {
        part,
        range,
        text,
        el: h(
          "div",
          {},
          h(
            "div",
            { class: "t" },
            h("label", {}, part.label),
            h("span", { class: "val" }, text),
          ),
          range,
        ),
      };
    });
    const settle = h("div", { class: "sub tnum" });
    const el = h(
      "div",
      { class: "p" },
      h("div", { class: "t" }, h("label", {}, p.label)),
      parts.map((x) => x.el),
      settle,
    );
    el.addEventListener("focusin", () => focus(p));
    return {
      el,
      sync(from) {
        for (const { part, range, text } of parts) {
          const v = values[p.id][part.key];
          if (from !== range) range.value = v;
          range.style.setProperty(
            "--fill",
            `${((v - part.min) / (part.max - part.min)) * 100}%`,
          );
          if (document.activeElement !== text) text.value = v;
        }
        settle.textContent = `Settles in ${springEasing(values[p.id]).durationMs} ms`;
      },
    };
  }

  const ROW = {
    range: numericRow,
    number: numericRow,
    duration: numericRow,
    color: colorRow,
    select: selectRow,
    toggle: toggleRow,
    bezier: bezierRow,
    spring: springRow,
  };

  function focus(p) {
    if (active === p) return;
    active = p;
    renderHead();
    markRows();
  }
  function markRows() {
    const dirty = new Set(changed().map((p) => p.id));
    for (const p of spec.params) {
      rows[p.id].el.classList.toggle("c", dirty.has(p.id));
      rows[p.id].el.classList.toggle("on", active === p);
    }
  }

  const body = h("div", { class: "body" });
  const folders = new Map();
  for (const p of spec.params) {
    if (!folders.has(p.folder)) folders.set(p.folder, []);
    folders.get(p.folder).push(p);
    rows[p.id] = ROW[p.type](p);
  }
  for (const [name, params] of folders) {
    const list = h(
      "div",
      { class: "rows" },
      params.map((p) => rows[p.id].el),
    );
    const f = h("section", { class: "f" });
    const btn = h(
      "button",
      {
        type: "button",
        "aria-expanded": "true",
        onclick: () =>
          btn.setAttribute(
            "aria-expanded",
            String(!f.classList.toggle("closed")),
          ),
      },
      name,
      h("span", { class: "tnum" }, String(params.length)),
    );
    f.append(btn, list);
    body.append(f);
  }

  const foot = h("div", { class: "foot" });
  async function apply() {
    const snapshot = structuredClone(values);
    net = "sending";
    renderFoot();
    try {
      const r = await fetch(`${base}apply`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ values: outputs(snapshot) }),
      });
      if (!r.ok) throw new Error(String(r.status));
      const { seq, at } = await r.json();
      applied = { values: snapshot, at, seq };
      net = "ok";
      persist();
    } catch {
      net = "down";
    }
    renderFoot();
    poll();
  }
  function reset() {
    for (const p of spec.params) values[p.id] = structuredClone(p.default);
    writeAll();
    persist();
    spec.params.forEach((p) => rows[p.id].sync());
    renderHead();
    renderFoot();
  }
  function renderFoot() {
    markRows();
    const n = changed().length;
    const count = spec.params.length;
    if (net === "down") {
      foot.replaceChildren(
        h(
          "div",
          { class: "err" },
          h("b", {}, `Cannot reach atelier at ${new URL(base).host}.`),
          " Your values are kept on this page. Ask the agent to run tune.ts open again, then retry, or copy the values.",
        ),
        h(
          "button",
          {
            type: "button",
            class: "rs",
            onclick: () =>
              navigator.clipboard.writeText(JSON.stringify(outputs())),
          },
          "Copy JSON",
        ),
        h(
          "button",
          { type: "button", class: "ap", onclick: apply },
          h("span", {}, "Retry"),
          h("span", { class: "tnum" }, String(n)),
        ),
      );
      onFoot({ net, changed: n, clean: false });
      return status();
    }
    const sending = net === "sending";
    const clean = applied && n === 0;
    const line = clean
      ? h(
          "div",
          { class: "ch" },
          `Sent ${time(applied.at)}`,
          h("span", {}, `${count} values`),
        )
      : n === 0
        ? h("div", { class: "ch" }, "No changes", h("span", {}, "defaults"))
        : h(
            "div",
            { class: "ch" },
            `${n} change${n === 1 ? "" : "s"}`,
            h("span", {}, applied ? `since ${time(applied.at)}` : "since open"),
          );
    const applyBtn = clean
      ? h(
          "button",
          { type: "button", class: "ap ok", disabled: true },
          h("span", {}, "Applied"),
          h("span", { class: "tnum" }, String(count)),
        )
      : h(
          "button",
          {
            type: "button",
            class: n === 0 ? "ap quiet" : "ap",
            disabled: sending,
            onclick: apply,
          },
          h("span", {}, sending ? "Sending…" : "Apply"),
          h("span", { class: "tnum" }, String(n)),
        );
    foot.replaceChildren(
      line,
      h("button", { type: "button", class: "rs", onclick: reset }, "Reset"),
      applyBtn,
    );
    onFoot({ net, changed: n, clean: Boolean(clean) });
    status();
  }

  function status() {
    if (net === "down") return onStatus("Disconnected", "down");
    if (applied && agent.consumed >= applied.seq)
      return onStatus(`Agent received · ${time(applied.at)}`, "ok");
    if (applied && agent.seq >= applied.seq)
      return onStatus(
        agent.waiting
          ? "Agent waiting"
          : `Sent ${time(applied.at)} · agent not waiting yet`,
        "sent",
      );
    onStatus(
      agent.waiting
        ? "Agent waiting"
        : "Agent not waiting · Apply is kept until it asks",
      agent.waiting ? "ok" : "idle",
    );
  }
  async function poll() {
    try {
      const r = await fetch(`${base}status`);
      agent = await r.json();
      if (net === "down") {
        net = "ok";
        renderFoot();
      }
    } catch {
      net = "down";
      renderFoot();
    }
    status();
  }

  root.append(head, body, foot);
  spec.params.forEach((p) => rows[p.id].sync());
  writeAll();
  renderHead();
  renderFoot();
  poll();
  const timer = setInterval(poll, 1500);

  return {
    spec,
    writeAll,
    apply,
    dispose: () => clearInterval(timer),
  };
}

function renderFatal(root, message, help, label = "Disconnected") {
  root.append(
    h(
      "div",
      { class: "head" },
      h("div", { class: "k" }, h("span", {}, label)),
      h(
        "div",
        { class: "n text" },
        label === "Spec error" ? "Spec" : "Offline",
      ),
      h("div", { class: "sc" }),
    ),
    h("div", { class: "body" }),
    h(
      "div",
      { class: "foot" },
      h("div", { class: "err" }, h("b", {}, message), ` ${help}`),
      h(
        "button",
        { type: "button", class: "rs", onclick: () => location.reload() },
        "Reload",
      ),
    ),
  );
  return null;
}
