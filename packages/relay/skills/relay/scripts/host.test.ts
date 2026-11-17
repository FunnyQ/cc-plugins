import { expect, test } from "bun:test";
import { join } from "node:path";

// relay and herdr version apart and import nothing from each other, so the two
// copies stay equal by source text; herdr's host.test.ts covers the behaviour.
test("matches the herdr plugin's copy byte for byte", async () => {
  const here = await Bun.file(join(import.meta.dir, "host.ts")).text();
  const herdr = await Bun.file(
    join(import.meta.dir, "../../../../herdr/skills/shared/host.ts"),
  ).text();
  expect(here).toBe(herdr);
});
