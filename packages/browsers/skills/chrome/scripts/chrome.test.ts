import { describe, expect, test } from "bun:test";
import { type Page, settle } from "./cdp";
import { interacted, parseArgs } from "./chrome";

describe("parseArgs", () => {
  test("splits the command, positionals, and flags", () => {
    expect(
      parseArgs([
        "open",
        "http://a",
        "--new",
        "--headed",
        "--size",
        "800x600",
        "--id",
        "k",
      ]),
    ).toMatchObject({
      command: "open",
      args: ["http://a"],
      fresh: true,
      headed: true,
      size: "800x600",
      id: "k",
    });
  });

  test("rejects --zen, which belongs to the firefox skill", () => {
    expect(() => parseArgs(["open", "http://a", "--zen"])).toThrow(
      "chrome has no --zen: use the firefox skill",
    );
  });
});

describe("settle", () => {
  test("returns the result of a successful reply", () => {
    expect(
      settle("Page.navigate", { id: 1, result: { frameId: "f" } }),
    ).toEqual({ frameId: "f" });
  });

  // Measured on Chrome 154: an unknown method answers with code -32601.
  test("throws the method and message of a protocol error", () => {
    expect(() =>
      settle("Nope.method", {
        id: 2,
        error: { code: -32601, message: "'Nope.method' wasn't found" },
      }),
    ).toThrow("Nope.method: 'Nope.method' wasn't found");
  });
});

function fakePage(): { page: Page; emit: (method: string) => void } {
  const listeners = new Set<(method: string) => void>();
  const page: Page = {
    send: async () => ({}),
    nextEvent: (events, timeoutMs) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(new Error("timeout"));
        }, timeoutMs);
        const listener = (method: string) => {
          if (!events.includes(method)) return;
          clearTimeout(timer);
          listeners.delete(listener);
          resolve(method);
        };
        listeners.add(listener);
      }),
    close: () => {},
  };
  return { page, emit: (method) => [...listeners].forEach((l) => l(method)) };
}

describe("interacted", () => {
  test("waits for a navigation that starts while a slow click is still running", async () => {
    const { page, emit } = fakePage();
    let stoppedAt = 0;
    const slowClick = async () => {
      setTimeout(() => emit("Page.frameStartedLoading"), 80);
      setTimeout(() => {
        stoppedAt = performance.now();
        emit("Page.frameStoppedLoading");
      }, 300);
      await Bun.sleep(100);
    };
    await interacted(page, slowClick);
    expect(stoppedAt).toBeGreaterThan(0);
  });

  test("returns soon after a click that starts no navigation", async () => {
    const { page } = fakePage();
    const started = performance.now();
    await interacted(page, () => Bun.sleep(100));
    expect(performance.now() - started).toBeLessThan(400);
  });
});
