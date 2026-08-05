import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { basename, dirname } from "node:path";
import { TEMP_ROOT, writeTempPayload } from "./temp-payload";

const written: string[] = [];

afterEach(() => {
  for (const path of written.splice(0)) rmSync(path, { force: true });
});

describe("writeTempPayload", () => {
  test("writes pretty JSON under /tmp/chronicle/<subdir> with a unique name", async () => {
    const path = await writeTempPayload("adr-test", "sample", { a: 1 });
    written.push(path);

    expect(dirname(path)).toBe(`${TEMP_ROOT}/adr-test`);
    expect(basename(path)).toMatch(/^sample-\d+-\d+\.json$/);
    expect(existsSync(path)).toBe(true);
    expect(await Bun.file(path).text()).toBe('{\n  "a": 1\n}\n');
  });

  test("round-trips an array payload", async () => {
    const path = await writeTempPayload("adr-test", "bodies", [{ id: "x" }]);
    written.push(path);

    expect(await Bun.file(path).json()).toEqual([{ id: "x" }]);
  });
});
