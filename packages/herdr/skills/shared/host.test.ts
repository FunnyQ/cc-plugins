import { describe, expect, test } from "bun:test";
import { hostOf, type HostProbe } from "./host";

const SOCKET = "/tmp/herdr.sock";

function probe(alive: boolean, ancestors: string[] = []): HostProbe {
  return {
    socketAlive: (path) => alive && path === SOCKET,
    ancestors: () => ancestors,
  };
}

const herdrEnv = { HERDR_ENV: "1", HERDR_SOCKET_PATH: SOCKET };
const both = { ...herdrEnv, HC_TERMINAL_ID: "t1" };

describe("hostOf", () => {
  test("herdr when its socket is alive", () => {
    expect(hostOf(herdrEnv, probe(true))).toBe("herdr");
  });

  test("herdr-app when only HC_TERMINAL_ID is set", () => {
    expect(hostOf({ HC_TERMINAL_ID: "t1" }, probe(false))).toBe("app");
  });

  test("herdr-app when leaked herdr env names a dead socket", () => {
    expect(hostOf(both, probe(false))).toBe("app");
  });

  test("nothing when herdr env names a dead socket and no app", () => {
    expect(hostOf(herdrEnv, probe(false))).toBeNull();
  });

  test("nothing outside both", () => {
    expect(hostOf({}, probe(true))).toBeNull();
  });

  test("both live: the nearest herdr-core ancestor means herdr-app", () => {
    const chain = [
      "/bin/zsh",
      "/Applications/Herdr Core.app/Contents/MacOS/herdr-core",
      "/opt/homebrew/bin/herdr",
    ];
    expect(hostOf(both, probe(true, chain))).toBe("app");
  });

  test("both live: the nearest herdr ancestor means herdr", () => {
    const chain = ["/bin/zsh", "/opt/homebrew/bin/herdr", "herdr-core"];
    expect(hostOf(both, probe(true, chain))).toBe("herdr");
  });

  test("both live with no known ancestor keeps herdr", () => {
    expect(hostOf(both, probe(true, ["/bin/zsh"]))).toBe("herdr");
  });
});
