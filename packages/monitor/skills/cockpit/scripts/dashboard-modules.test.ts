import { describe, expect, test } from "bun:test";
import { PELE_VARS } from "../dashboard/dist/modules/diagram.js";
import { initDesignSystem } from "../dashboard/dist/modules/design-system.js";

const dist = `${import.meta.dir}/../dashboard/dist`;
const read = (path: string) => Bun.file(path).text();

describe("decision-log.js", () => {
  test("KINDS matches the kinds cockpit-rs trail.rs accepts, since the no-build SPA cannot import them", async () => {
    const js = await read(`${dist}/modules/decision-log.js`);
    const rs = await read(
      `${import.meta.dir}/../../../cockpit-rs/src/cli/trail.rs`,
    );
    const list = (m: RegExpMatchArray | null) =>
      JSON.parse(`[${m![1]}]`.replace(/,\s*]$/, "]"));
    const jsKinds = list(js.match(/const KINDS = \[([^\]]*)\]/));
    const rsKinds = list(rs.match(/if !\[([^\]]*)\]\.contains\(&kind\)/));
    expect(jsKinds).toEqual(rsKinds);
  });

  test("style.css hides the read-only options list on an answerable card, so the respond form never shows beside it", async () => {
    const css = await read(`${dist}/style.css`);
    expect(css).toMatch(
      /\.decision-card\.is-answerable \.decision-card__options \{\s*display: none;/,
    );
  });
});

describe("diagram.js", () => {
  test("imports under plain Bun with no DOM, because pele and DOMPurify load lazily on first render", () => {
    expect(typeof document).toBe("undefined");
    expect(PELE_VARS.length).toBeGreaterThan(0);
  });

  test("every PELE_VARS name is defined in style.css", async () => {
    const css = await read(`${dist}/style.css`);
    const missing = PELE_VARS.filter((v) => !css.includes(`${v}:`));
    expect(missing).toEqual([]);
  });
});

describe("design-system.js", () => {
  test("probe caches a found doc but re-fetches a missing one, so a DESIGN.md added mid-session surfaces", async () => {
    const real = globalThis.fetch;
    let calls = 0;
    let found = false;
    globalThis.fetch = (async () => {
      calls++;
      return found
        ? new Response(JSON.stringify({ tokens: [] }))
        : new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    try {
      const ds = initDesignSystem({})!;
      expect(await ds.probe("p")).toBe(false);
      found = true;
      expect(await ds.probe("p")).toBe(true);
      expect(await ds.probe("p")).toBe(true);
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = real;
    }
  });
});
