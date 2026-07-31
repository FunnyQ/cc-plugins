import { describe, expect, test } from "bun:test";
import type { FlightlogEntry } from "../../flightplan/scripts/lib/flightlog";
import {
  createDebouncer,
  decodeLogChunk,
  formatFleetFrame,
} from "./events-api";

const entry: FlightlogEntry = {
  kind: "note",
  ts: "2026-08-01T00:00:00.000Z",
  task: "server/05",
  role: "dev",
  phase: "start",
  message: "開始",
};

describe("formatFleetFrame", () => {
  test("formats the complete fleet payload", () => {
    const frame = formatFleetFrame([entry], true);
    const data = JSON.parse(frame.split("\n")[1]!.slice("data: ".length));

    expect(frame.startsWith("event: fleet\n")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    expect(data).toEqual({
      rows: [
        {
          key: "server/05|dev|-",
          label: "server/05|dev|-",
          role: "dev",
          ref: "server/05",
          status: "in-flight",
          startedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      entryCount: 1,
      logPresent: true,
    });
  });

  test("excludes malformed and blank lines", () => {
    const decoded = decodeLogChunk(
      new TextDecoder(),
      new TextEncoder().encode(`\ninvalid\n${JSON.stringify(entry)}\n`),
      "",
    );

    expect(decoded.entries).toEqual([entry]);
    expect(decoded.partial).toBe("");
  });
});

describe("decodeLogChunk", () => {
  test("reassembles a UTF-8 character split across reads", () => {
    const bytes = new TextEncoder().encode(`${JSON.stringify(entry)}\n`);
    const character = new TextEncoder().encode("開");
    const splitAt = bytes.findIndex((byte, index) =>
      bytes.slice(index, index + character.length).every(
        (candidate, offset) => candidate === character[offset],
      ),
    ) + 1;
    const decoder = new TextDecoder();

    const first = decodeLogChunk(decoder, bytes.slice(0, splitAt), "");
    const second = decodeLogChunk(decoder, bytes.slice(splitAt), first.partial);

    expect(first.entries).toEqual([]);
    expect(second.entries).toEqual([entry]);
    expect(second.partial).toBe("");
  });
});

describe("createDebouncer", () => {
  test("coalesces a burst into one call", async () => {
    let calls = 0;
    const debounce = createDebouncer(() => {
      calls += 1;
    }, 20);

    debounce.schedule();
    debounce.schedule();
    debounce.schedule();
    await Bun.sleep(40);

    expect(calls).toBe(1);
    debounce.cancel();
  });
});
