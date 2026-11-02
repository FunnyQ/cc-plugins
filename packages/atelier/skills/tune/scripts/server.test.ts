import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, waitForApply } from "./server";

const dir = mkdtempSync(join(tmpdir(), "atelier-server-"));
const specPath = join(dir, "card.json");
const goodSpec = {
  snippet: "card.html",
  params: [
    { id: "blur", type: "range", min: 0, max: 80, default: 24, unit: "px" },
  ],
};
writeFileSync(specPath, JSON.stringify(goodSpec));
writeFileSync(join(dir, "card.html"), '<div class="card">Pro plan</div>');

let srv: ReturnType<typeof startServer>;
let base: string;
beforeAll(() => {
  srv = startServer({ dir, specPath });
  base = `http://127.0.0.1:${srv.port}/${srv.nonce}`;
});
afterAll(() => {
  srv.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("server", () => {
  test("serves the shell, the stage with the snippet, and the parsed spec", async () => {
    expect(await (await fetch(`${base}/`)).text()).toContain("panel.js");
    expect(await (await fetch(`${base}/stage`)).text()).toContain(
      '<div class="card">Pro plan</div>',
    );
    const spec = await (await fetch(`${base}/spec.json`)).json();
    expect(spec.params[0]).toMatchObject({ id: "blur", step: 0.8 });
  });

  test("serves the shared TypeScript modules as browser JavaScript", async () => {
    const res = await fetch(`${base}/lib/format`);
    expect(res.headers.get("content-type")).toContain("javascript");
    const js = await res.text();
    expect(js).toContain("export function cssVars");
    expect(js).not.toContain("import type");
  });

  test("refuses a request without the nonce", async () => {
    expect((await fetch(`http://127.0.0.1:${srv.port}/spec.json`)).status).toBe(
      404,
    );
  });

  test("answers a CORS preflight so an in-situ page can post", async () => {
    const res = await fetch(`${base}/apply`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("Apply writes values.json and a waiting agent receives it once", async () => {
    const waiting = waitForApply(dir, 5000);
    const res = await fetch(`${base}/apply`, {
      method: "POST",
      body: JSON.stringify({ values: { blur: "30px" } }),
    });
    expect(res.status).toBe(200);
    expect(await waiting).toEqual({ blur: "30px" });
    expect(JSON.parse(readFileSync(join(dir, "values.json"), "utf8")).seq).toBe(
      1,
    );
    const status = await (await fetch(`${base}/status`)).json();
    expect(status).toMatchObject({ seq: 1, consumed: 1 });
    expect(await waitForApply(dir, 300)).toBeNull();
  });

  test("an Apply made before the agent waits is still delivered", async () => {
    await fetch(`${base}/apply`, {
      method: "POST",
      body: JSON.stringify({ values: { blur: "40px" } }),
    });
    expect(await waitForApply(dir, 2000)).toEqual({ blur: "40px" });
  });

  test("rejects an Apply body without values", async () => {
    expect(
      (await fetch(`${base}/apply`, { method: "POST", body: "{}" })).status,
    ).toBe(400);
  });

  test("reports a spec that broke after start as a 422 with the reason", async () => {
    writeFileSync(
      specPath,
      JSON.stringify({
        ...goodSpec,
        params: [{ id: "blur", type: "range", min: 80, max: 0 }],
      }),
    );
    const res = await fetch(`${base}/spec.json`);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('"blur"');
    writeFileSync(specPath, JSON.stringify(goodSpec));
  });
});
