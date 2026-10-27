import { expect, mock, test } from "claude-code/testing";

import { CONFIG, fakeHost } from "../transcript/test-session";

test("an idle transcript is read once, and read again only when it changes", async ($, on) => {
  const clock = mock.clock(on);
  let spawns = 0;
  let mtimeMs = 1;
  let isFailing = false;
  const out = JSON.stringify({
    path: "/t.jsonl",
    rows: [{ id: "u1", kind: "prompt", size: 20 }],
  });
  fakeHost(on, {
    files: new Map([[CONFIG, "minimap:\n  enabled: true\n"]]),
    run: ({ argv }) => {
      if (argv[0] !== "bun" || !argv[1]?.endsWith("minimap/index.ts"))
        return undefined;
      spawns += 1;
      if (isFailing)
        return {
          value: {
            exitCode: 1,
            stdout: "",
            stderr: "boom",
            isStdoutTruncated: false,
            isStderrTruncated: false,
          },
        };
      return {
        value: {
          exitCode: 0,
          stdout: out,
          stderr: "",
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      };
    },
  } as never);
  on("session.id", () => ({ value: "s1" }) as never);
  on(
    "fs.stat",
    () =>
      ({ value: { kind: "file", size: 10, mtimeMs, isLink: false } }) as never,
  );
  on("session.start", (_$, e) => e as never);
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  await clock.advance(30_000);
  expect(spawns).toBeLessThanOrEqual(2);
  const idle = spawns;
  mtimeMs = 2;
  await clock.advance(5_000);
  expect(spawns).toBe(idle + 1);

  isFailing = true;
  mtimeMs = 3;
  await clock.advance(3_000);
  const failed = spawns;
  await clock.advance(9_000);
  expect(spawns).toBeGreaterThanOrEqual(failed + 3);
});

test("a new session reads its own transcript even when the old one has not changed", async ($, on) => {
  const clock = mock.clock(on);
  let spawns = 0;
  const out = JSON.stringify({
    path: "/t.jsonl",
    rows: [{ id: "u1", kind: "prompt", size: 20 }],
  });
  fakeHost(on, {
    files: new Map([[CONFIG, "minimap:\n  enabled: true\n"]]),
    run: ({ argv }) => {
      if (argv[0] !== "bun" || !argv[1]?.endsWith("minimap/index.ts"))
        return undefined;
      spawns += 1;
      return {
        value: {
          exitCode: 0,
          stdout: out,
          stderr: "",
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      };
    },
  } as never);
  on("session.id", () => ({ value: "s1" }) as never);
  on(
    "fs.stat",
    () =>
      ({
        value: { kind: "file", size: 10, mtimeMs: 1, isLink: false },
      }) as never,
  );
  on("session.start", (_$, e) => e as never);
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  await clock.advance(30_000);
  const before = spawns;
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  await clock.advance(3_000);
  expect(spawns).toBeGreaterThan(before);
});

// the desktop app runs Claude through the SDK, a non-interactive session the desktop attaches to
test("a desktop attach starts reading the transcript", async ($, on) => {
  const clock = mock.clock(on);
  let spawns = 0;
  fakeHost(on, {
    files: new Map([[CONFIG, "minimap:\n  enabled: true\n"]]),
    run: ({ argv }) => {
      if (argv[0] !== "bun" || !argv[1]?.endsWith("minimap/index.ts"))
        return undefined;
      spawns += 1;
      return {
        value: {
          exitCode: 0,
          stdout: JSON.stringify({ path: "/t.jsonl", rows: [] }),
          stderr: "",
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      };
    },
  } as never);
  on("session.id", () => ({ value: "s1" }) as never);
  on("session.start", (_$, e) => e as never);
  on("session.attach", (_$, e) => ({ clientId: e.clientId }) as never);
  await $.session.start({ cwd: "/", surface: null, isInteractive: false });
  await clock.advance(5_000);
  expect(spawns).toBe(0);
  await $.session.attach({ surface: "desktop", clientId: "desktop:default" });
  await clock.advance(5_000);
  expect(spawns).toBeGreaterThan(0);
});
