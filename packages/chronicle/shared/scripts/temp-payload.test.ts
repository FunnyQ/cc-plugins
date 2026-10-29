import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { TEMP_ROOT, tempRoot, writeTempPayload } from "./temp-payload";

const written: string[] = [];

afterEach(() => {
  for (const path of written.splice(0)) rmSync(path, { force: true });
});

describe("tempRoot", () => {
  test("is /tmp/q-lab/chronicle on darwin and linux", () => {
    expect(tempRoot("darwin")).toBe("/tmp/q-lab/chronicle");
    expect(tempRoot("linux")).toBe("/tmp/q-lab/chronicle");
  });

  test("lives under the OS temp dir on win32", () => {
    expect(tempRoot("win32")).toBe(join(tmpdir(), "q-lab", "chronicle"));
  });
});

describe("writeTempPayload", () => {
  test("writes pretty JSON under TEMP_ROOT/<subdir> with a unique name", async () => {
    const path = await writeTempPayload("adr-test", "sample", { a: 1 });
    written.push(path);

    expect(dirname(path)).toBe(join(TEMP_ROOT, "adr-test"));
    expect(basename(path)).toMatch(/^sample-\d+-\d+-\d+\.json$/);
    expect(existsSync(path)).toBe(true);
    expect(await Bun.file(path).text()).toBe('{\n  "a": 1\n}\n');
  });

  test("round-trips an array payload", async () => {
    const path = await writeTempPayload("adr-test", "bodies", [{ id: "x" }]);
    written.push(path);

    expect(await Bun.file(path).json()).toEqual([{ id: "x" }]);
  });

  test("gives two payloads written by one process in the same millisecond distinct paths", async () => {
    const paths = await Promise.all([
      writeTempPayload("adr-test", "twice", 1),
      writeTempPayload("adr-test", "twice", 2),
    ]);
    written.push(...paths);

    expect(new Set(paths).size).toBe(2);
  });
});
