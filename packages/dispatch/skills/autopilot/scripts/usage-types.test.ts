import { expect, test } from "bun:test";

test("usage-types.ts imports nothing, so fleet.ts can import it without a cycle", async () => {
  const source = await Bun.file(
    new URL("./usage-types.ts", import.meta.url),
  ).text();
  expect(source).not.toMatch(/^\s*(import|export\s.*\sfrom)\s/m);
});
