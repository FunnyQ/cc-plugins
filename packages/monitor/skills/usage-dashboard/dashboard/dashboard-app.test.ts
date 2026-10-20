import { beforeEach, expect, test } from "bun:test";

type Stub = Record<string, any>;
const g = globalThis as Stub;
let intervals: Array<() => void> = [];
let opened: unknown[][] = [];

beforeEach(() => {
  intervals = [];
  opened = [];
  g.window = {
    setInterval: (fn: () => void) => intervals.push(fn),
    clearInterval: () => {},
    open: (...args: unknown[]) => opened.push(args),
  };
  g.document = { hidden: false };
  g.localStorage = { getItem: () => null, setItem: () => {} };
});

const appModule: string = "./dist/modules/dashboard-app.js";
const { App } = await import(appModule);

test("the live clock skips the 1Hz re-render while the tab is hidden or has no rows", () => {
  const app = App();
  app.nowTick = 1;
  app.startLiveClock();
  const tick = intervals[0]!;

  app.liveSessions = [];
  tick();
  expect(app.nowTick).toBe(1);

  app.liveSessions = [{ id: "s" }];
  g.document.hidden = true;
  tick();
  expect(app.nowTick).toBe(1);

  g.document.hidden = false;
  tick();
  expect(app.nowTick).not.toBe(1);
});

test("daily rows without costUSD (a stale server) get a token-proportional share of the total cost", () => {
  const app = App();
  app.stats = {
    daily: [{ tokens: 100 }, { tokens: 300 }],
    summary: { estimatedCostUSD: 8 },
  };
  expect(app.summarizeDaily([{ tokens: 100 }]).cost).toBe(2);
});

test("opening a live row does nothing while the cockpit daemon is down, so no dead tab opens", () => {
  const app = App();
  const session = { id: "s", provider: "claude", cwd: "/x" };
  app.cockpitUp = false;
  app.openInCockpit(session);
  expect(opened).toHaveLength(0);

  app.cockpitUp = true;
  app.cockpitPort = 5999;
  app.openInCockpit(session);
  expect(String(opened[0]![0])).toStartWith("http://localhost:5999/?");
});

test("ring arcs are the clamped percent, since the template's r=15.9155 circle has circumference 100", () => {
  const app = App();
  const view = app.usageLimitWindowView("fiveHour", {
    usedPercent: 140,
    elapsedPercent: 33.333,
  });
  expect(view.usedArc).toBe(100);
  expect(view.elapsedArc).toBe(33.33);
});
