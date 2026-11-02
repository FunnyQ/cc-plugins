---
name: tune
description: >-
  Let the user fine-tune a visual effect or animation with live controls —
  sliders, colour, select, toggle, cubic-bezier, spring, duration — then hand
  the final values back. You write a small JSON spec; prebuilt pages render the
  controls.
when_to_use: >-
  Use when the user wants to adjust how something looks or moves by eye: a
  glow, a shadow, a radius, an easing, a duration, a spring, a colour. Also
  when they say "let me tweak it", "give me sliders", "playground", "調一下".
  Do not use for layout or copy changes, or when the user has given exact values.
version: 1
---

# Tune

You write a spec of tunable values. atelier serves the page, the controls, and
the return path. You never write UI for a tuning run.

Resolve the script from the load-time **"Base directory for this skill"**
banner:

```bash
T="$SKILL_DIR/scripts/tune.ts"
```

Written `T <command>` below; expand it to `bun "$T" <command>`.

## Pick the mode

- **isolated** — the effect renders alone on a stage beside the panel. Use it
  for a self-contained HTML/CSS/JS fragment.
- **in-situ** — the panel is injected into the user's running dev-server page
  and tunes the real component. Use it for `.vue` / `.jsx` / `.svelte`
  components, Tailwind, and anything that needs a build. Isolated cannot render
  those.

## 1. Make the values tunable

Every tuned value must read a CSS custom property named after the param id:

```css
box-shadow: 0 0 var(--blur) var(--spread) var(--glow);
animation: enter var(--enter) var(--ease) both;
border-width: calc(var(--border) * 1px); /* toggle is 1 or 0 */
```

- Tailwind arbitrary values: rewrite `blur-[12px]` to `blur-[var(--blur)]`.
- In-situ, keep the current value as the fallback, `var(--blur, 12px)`, so the
  page looks unchanged before the panel loads.
- A value CSS cannot reach (GSAP, canvas, a component prop) takes
  `"bind": "js"` and a listener in the page:

  ```js
  atelier.on("tint", (value, css, vars) => {
    /* apply it */
  });
  // in-situ, when your code may run before the panel loads:
  window.addEventListener("atelier", (e) => {
    const { id, value, css, vars } = e.detail;
  });
  ```

  `value` is the raw control value; `css` is the string the page would write
  for `--id`; `vars` holds every variable, so a spring also gives
  `vars["--pop-duration"]`. **Replay** fires `atelier.on("replay", …)`; start a
  JavaScript-driven animation there.

## 2. Write the spec

Write the spec, and for isolated the snippet, into a `mktemp -d` directory under
`/tmp/q-lab/atelier/tune/`.

```json
{
  "mode": "isolated",
  "snippet": "card.html",
  "target": ":root",
  "params": [
    {
      "id": "blur",
      "type": "range",
      "min": 0,
      "max": 80,
      "step": 1,
      "unit": "px",
      "default": 24,
      "folder": "Glow"
    },
    {
      "id": "glow",
      "type": "color",
      "default": "#ff7a59",
      "folder": "Glow",
      "label": "Color"
    },
    { "id": "enter", "type": "duration", "default": 420, "folder": "Motion" },
    {
      "id": "ease",
      "type": "bezier",
      "default": [0.2, 0.8, 0.2, 1],
      "folder": "Motion"
    },
    {
      "id": "pop",
      "type": "spring",
      "default": { "stiffness": 170, "damping": 26, "mass": 1 }
    },
    { "id": "border", "type": "toggle", "default": true },
    {
      "id": "tint",
      "type": "select",
      "options": ["warm", "cool"],
      "bind": "js"
    }
  ]
}
```

| type              | needs                                              | writes `--id` as                  |
| ----------------- | -------------------------------------------------- | --------------------------------- |
| `range`, `number` | `min`, `max`; `step` defaults to 1/100 of the span | `24px` (value + `unit`)           |
| `duration`        | nothing; 0–2000 ms, step 10                        | `420ms`                           |
| `color`           | `#rgb` or `#rrggbb`                                | `#ff7a59`                         |
| `select`          | `options`                                          | the option                        |
| `toggle`          | —                                                  | `1` or `0`                        |
| `bezier`          | `[x1, y1, x2, y2]`, x within 0–1                   | `cubic-bezier(…)`                 |
| `spring`          | `stiffness`, `damping`, `mass`                     | `linear(…)`, plus `--id-duration` |

Optional on every param: `label` (defaults from the id), `folder` (groups
rows), `bind` (`css` or `js`), `target` (a selector; defaults to the spec's
`target`, then `:root`). In isolated mode keep the target `:root`: the values
are then in place before the snippet's first frame. Default every param to the
value the code has now.

## 3. Open it

```bash
T open /tmp/q-lab/atelier/tune/<dir>/spec.json   # isolated: opens the page
```

It prints `url:`, `dir:`, and for in-situ an `inject:` line. A broken spec
exits 2 with the reason; fix it and open again.

**In-situ:** hand the user the `inject:` line to paste into the DevTools console
of the browser tab where they already have the dev server open. That keeps their
real browser, HMR, and login. If they would rather not paste, run it yourself:
`herdr:herdr-browser` `eval` when Herdr runs, otherwise `browsers:chrome`
`open <url> --headed` then `eval`. A reload removes the panel; inject again,
and the values come back. The in-situ panel has Replay and speed; Loop is
isolated only.

Tell the user what to tune and to press **Apply** when it feels right.

## 4. Wait for Apply

```bash
T wait          # run with the Bash timeout at 600000
```

It prints one JSON line with every value, ready to paste into source:

```json
{
  "blur": "24px",
  "glow": "#ff7a59",
  "enter": "420ms",
  "ease": "cubic-bezier(0.2, 0.8, 0.2, 1)",
  "pop": {
    "stiffness": 170,
    "damping": 26,
    "mass": 1,
    "easing": "linear(…)",
    "duration": "620ms"
  },
  "border": true,
  "tint": "warm"
}
```

Exit 3 means nobody pressed Apply within 540 s: run `T wait` again. An Apply
made while you were not waiting is kept and delivered by the next `wait`.

## 5. Write it back

Write the values into source as literals and remove the temporary `var(--id)`
indirection and any `atelier.on` listener you added. Then ask whether to keep
tuning: if yes, `T wait` again; the page stays open with the same values. When
done:

```bash
T stop
```

The page keeps the user's values in the browser across reloads, so after you
change the spec or the snippet, ask them to reload.

`T url` reprints the page URL. Every command takes `--dir <dir>` to address a
session other than the last one opened.

## Limits

- An `https` dev server, or one whose Content-Security-Policy blocks
  `http://127.0.0.1`, refuses the inject line. Fall back to isolated with a
  copy of the component's markup and styles.
- The server stops after 4 hours idle. `T open` starts a new session.
