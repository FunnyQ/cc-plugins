import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareProjects,
  isTempPath,
  matchProjects,
  type ProjectCandidate,
  queryZoxide,
  readRegistry,
} from "./project-registry.ts";

async function withRegistry(
  contents: string | object,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-registry-"));
  const path = join(dir, "registry.json");
  await writeFile(
    path,
    typeof contents === "string" ? contents : JSON.stringify(contents),
  );
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("readRegistry", () => {
  test("returns candidates for a well-formed registry", async () => {
    await withRegistry(
      {
        version: 1,
        projects: {
          "/Users/dev/Projects/api-service": {
            name: "api-service",
            sources: ["claude"],
            last_used_at: 100,
          },
        },
      },
      async (path) => {
        const found = await readRegistry(path);
        expect(found).toEqual([
          {
            path: "/Users/dev/Projects/api-service",
            name: "api-service",
            aliases: [],
            lastUsedAt: 100,
          },
        ]);
      },
    );
  });

  test("a missing file degrades to an empty list", async () => {
    expect(await readRegistry("/nonexistent/registry.json")).toEqual([]);
  });

  test("unparseable JSON degrades to an empty list", async () => {
    await withRegistry("not json", async (path) => {
      expect(await readRegistry(path)).toEqual([]);
    });
  });

  test("an unsupported version degrades to an empty list", async () => {
    await withRegistry(
      { version: 2, projects: { "/x": { name: "x" } } },
      async (path) => {
        expect(await readRegistry(path)).toEqual([]);
      },
    );
  });

  test("a hidden entry is filtered out", async () => {
    await withRegistry(
      {
        version: 1,
        projects: {
          "/Users/dev/Projects/visible": { name: "visible" },
          "/Users/dev/Projects/hidden": { name: "hidden", hidden: true },
        },
      },
      async (path) => {
        const found = await readRegistry(path);
        expect(found.map((c) => c.name)).toEqual(["visible"]);
      },
    );
  });
});

describe("isTempPath", () => {
  test("flags all four temp shapes", () => {
    expect(isTempPath("/tmp/x")).toBe(true);
    expect(isTempPath("/private/tmp/x")).toBe(true);
    expect(isTempPath("/var/folders/ab/xy/T/foo")).toBe(true);
    expect(isTempPath("/private/var/folders/ab/xy/T/foo")).toBe(true);
  });

  test("a real project path is not flagged", () => {
    expect(isTempPath("/Users/dev/Projects/api-service")).toBe(false);
  });
});

describe("matchProjects", () => {
  const candidates: ProjectCandidate[] = [
    {
      path: "/Users/dev/Projects/api-service",
      name: "api-service",
      aliases: [],
    },
    {
      path: "/Users/dev/Projects/clients/acme",
      name: "acme",
      aliases: ["acme-corp"],
    },
    { path: "/tmp/scratch", name: "scratch", aliases: [] },
  ];

  test("matches by name", () => {
    expect(matchProjects(candidates, "api-service").map((c) => c.name)).toEqual(
      ["api-service"],
    );
  });

  test("matches by alias", () => {
    expect(matchProjects(candidates, "acme-corp").map((c) => c.name)).toEqual([
      "acme",
    ]);
  });

  test("a slash-separated fragment matches across name and path", () => {
    expect(
      matchProjects(candidates, "clients/acme").map((c) => c.name),
    ).toEqual(["acme"]);
  });

  test("a temp-path candidate is excluded even on a direct name match", () => {
    expect(matchProjects(candidates, "scratch")).toEqual([]);
  });
});

describe("compareProjects", () => {
  test("more recently used sorts first", () => {
    const a: ProjectCandidate = {
      path: "/a",
      name: "a",
      aliases: [],
      lastUsedAt: 1,
    };
    const b: ProjectCandidate = {
      path: "/b",
      name: "b",
      aliases: [],
      lastUsedAt: 2,
    };
    expect([a, b].sort(compareProjects)).toEqual([b, a]);
  });

  test("a stamped entry sorts before an unstamped one", () => {
    const stamped: ProjectCandidate = {
      path: "/a",
      name: "a",
      aliases: [],
      lastUsedAt: 1,
    };
    const unstamped: ProjectCandidate = { path: "/b", name: "b", aliases: [] };
    expect([unstamped, stamped].sort(compareProjects)).toEqual([
      stamped,
      unstamped,
    ]);
  });

  test("ties break alphabetically by name", () => {
    const a: ProjectCandidate = { path: "/a", name: "alpha", aliases: [] };
    const b: ProjectCandidate = { path: "/b", name: "beta", aliases: [] };
    expect([b, a].sort(compareProjects)).toEqual([a, b]);
  });
});

describe("queryZoxide", () => {
  test("returns the top path on success", async () => {
    // A real, non-temp directory — mkdtemp's own parent is itself a temp
    // path and would get filtered by the isTempPath check this exercises.
    const dir = import.meta.dir;
    const path = await queryZoxide("query-text", async () => ({
      stdout: `${dir}\n`,
      code: 0,
    }));
    expect(path).toBe(dir);
  });

  test("a missing zoxide binary degrades to null", async () => {
    const path = await queryZoxide("query-text", async () => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });
    expect(path).toBeNull();
  });

  test("a non-zero exit degrades to null", async () => {
    const path = await queryZoxide("query-text", async () => ({
      stdout: "",
      code: 1,
    }));
    expect(path).toBeNull();
  });

  test("a match that is no longer a directory degrades to null", async () => {
    const path = await queryZoxide("query-text", async () => ({
      stdout: "/nonexistent/path/gone\n",
      code: 0,
    }));
    expect(path).toBeNull();
  });

  test("a temp-path match degrades to null", async () => {
    const path = await queryZoxide("query-text", async () => ({
      stdout: "/tmp\n",
      code: 0,
    }));
    expect(path).toBeNull();
  });

  test("a query shorter than the minimum length skips the lookup entirely", async () => {
    let called = false;
    const path = await queryZoxide("a", async () => {
      called = true;
      return { stdout: "/tmp\n", code: 0 };
    });
    expect(path).toBeNull();
    expect(called).toBe(false);
  });
});
