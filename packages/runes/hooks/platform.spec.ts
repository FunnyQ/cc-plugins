import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

const CHILD = `
import { homedir, tmpdir } from "node:os";
import { realpathSync } from "node:fs";
const { inherited, ...payload } = JSON.parse(await Bun.stdin.text());
const names = ["HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "PATH", "Path", "RUNES_FIXTURE_MARKER"];
process.stdout.write(JSON.stringify({
  env: Object.fromEntries(names.map(name => [name, process.env[name] ?? null])),
  home: payload.resolveHome ? realpathSync.native(homedir()) : null,
  tmp: realpathSync.native(tmpdir()),
  payload,
  inherited: Object.entries(inherited).every(([name, value]) => process.env[name] === value),
}));
`;

for (const homeState of ["supplied", "absent", "empty"] as const) {
  test(`a Bun child preserves ${homeState} home values, isolated temp and JSON transport`, async () => {
    const root = mkdtempSync(join(import.meta.dir, ".platform-fixture-"));
    try {
      const home = join(root, "home 空間 & %#'");
      const tmp = join(root, "temp 空間 & %#'");
      mkdirSync(home);
      mkdirSync(tmp);
      const env = { ...process.env };
      for (const name of Object.keys(env)) {
        if (
          ["HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP"].includes(
            name.toUpperCase(),
          )
        ) {
          delete env[name];
        }
      }
      if (process.platform !== "win32" && env.Path === undefined) {
        env.Path = "fixture Windows Path spelling";
      }
      if (homeState !== "absent") {
        env.HOME = homeState === "empty" ? "" : home;
        env.USERPROFILE = env.HOME;
      }
      Object.assign(env, {
        TMPDIR: tmp,
        TEMP: tmp,
        TMP: tmp,
        RUNES_FIXTURE_MARKER: "inherited 空間",
      });
      const payload = {
        resolveHome: homeState === "supplied",
        runtime: {
          platform: "win32",
          wsl: false,
          home: "C:\\Users\\Q 空間",
          tmp: "C:\\Temp\\& %#'",
        },
        unc: "\\\\server\\share\\Q 空間",
        text: "quotes \" and apostrophes ' and newline\n",
      };
      const child = Bun.spawn([process.execPath, "-e", CHILD], {
        env,
        stdin: new TextEncoder().encode(
          JSON.stringify({ ...payload, inherited: env }),
        ),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      const result = JSON.parse(stdout);
      const expectedHome =
        homeState === "absent" ? null : homeState === "empty" ? "" : home;
      expect(result.env.HOME).toBe(expectedHome);
      expect(result.env.USERPROFILE).toBe(expectedHome);
      for (const name of ["TMPDIR", "TEMP", "TMP"])
        expect(result.env[name]).toBe(tmp);
      for (const name of ["PATH", "Path"]) {
        if (env[name] !== undefined || process.platform !== "win32") {
          expect(result.env[name]).toBe(env[name] ?? null);
        }
      }
      expect(result.inherited).toBe(true);
      expect(result.env.RUNES_FIXTURE_MARKER).toBe("inherited 空間");
      expect(result.home).toBe(
        homeState === "supplied" ? realpathSync.native(home) : null,
      );
      expect(result.tmp).toBe(realpathSync.native(tmp));
      expect(result.payload).toEqual(payload);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
