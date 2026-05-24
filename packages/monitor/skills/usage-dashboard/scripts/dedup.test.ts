// Run: bun test packages/monitor/skills/usage-dashboard/scripts/dedup.test.ts
import { describe, expect, test } from "bun:test";
import { dedupKey } from "./dedup";

describe("dedupKey", () => {
  test("uses requestId:messageId when both present", () => {
    expect(
      dedupKey({ requestId: "req1", message: { id: "msg1" } }, "f.jsonl", 0),
    ).toBe("req1:msg1");
  });

  test("two snapshots of the same request collapse to one key", () => {
    const a = dedupKey({ requestId: "r", message: { id: "m" } }, "f", 0);
    const b = dedupKey({ requestId: "r", message: { id: "m" } }, "f", 1);
    expect(a).toBe(b);
  });

  test("falls back to uuid when requestId or messageId is missing", () => {
    expect(dedupKey({ uuid: "u1", message: {} }, "f", 0)).toBe("u1");
    expect(dedupKey({ requestId: "r", uuid: "u2" }, "f", 0)).toBe("u2");
  });

  test("falls back to file:index when nothing identifies the entry", () => {
    expect(dedupKey({}, "proj/a.jsonl", 7)).toBe("proj/a.jsonl:7");
  });

  test("unkeyed distinct lines never collapse (index differs)", () => {
    expect(dedupKey({}, "f", 0)).not.toBe(dedupKey({}, "f", 1));
  });
});
