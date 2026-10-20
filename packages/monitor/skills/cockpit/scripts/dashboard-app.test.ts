import { describe, expect, test } from "bun:test";

const runner = `${import.meta.dir}/dashboard-app.runner.ts`;

// app.js runs its boot sequence at import and its column modules import `store`
// back from it, so each scenario boots in its own bun process, which keeps its
// stubbed window/document/fetch and module stand-ins out of every other test.
const run = (scenario: string) => {
  const p = Bun.spawnSync(["bun", runner, scenario], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return JSON.parse(p.stdout.toString());
};

const UUID = "11111111-2222-3333-4444-555555555555";

describe("app.js refreshDesignAvailability", () => {
  test("a slow probe for a stale project cannot overwrite the current selection's availability", () => {
    expect(run("staleProbe")).toEqual({
      beforeSlowLands: false,
      afterSlowLands: false,
    });
  });

  test("the initial selection from a deep link is probed at boot, before any selection change", () => {
    expect(run("initialProbe")).toEqual({
      probed: ["/deep"],
      available: true,
    });
  });

  test("a later selection change is probed through the subscriber", () => {
    const r = run("subscriberProbe");
    expect(r.probed).toContain("/next");
    expect(r.available).toBe(true);
  });
});

describe("app.js deep link", () => {
  test("a preset selection stops fetchSessions from choosing the top session", () => {
    expect(run("deepLink")).toEqual({
      id: UUID,
      provider: "claude",
      project: "/deep",
    });
  });

  test("without a deep link fetchSessions selects the top session", () => {
    expect(run("noDeepLink")).toEqual({ id: "top" });
  });

  test("an untracked deep-linked id stays selected with no manifest entry", () => {
    expect(run("untracked")).toEqual({
      session: null,
      id: UUID,
      title: "Session is not in cockpit manifest",
    });
  });
});

describe("app.js hero auto-collapse", () => {
  test("the timeout collapses the hero, but not while a needs_your_call is open", () => {
    expect(run("heroTimeout")).toEqual({
      whileAwaiting: false,
      afterAnswer: true,
    });
  });
});
