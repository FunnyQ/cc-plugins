import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  type Baseline,
  buildBaseline,
  diff,
  extractLiterals,
  shapeOf,
  sourceLiterals,
  summary,
  usedMethods,
} from "./protocol-check.ts";

const tempRepos: string[] = [];
afterEach(() => {
  for (const repo of tempRepos.splice(0)) execFileSync("trash", [repo]);
});

/** A schema stub with only the parts the script reads. */
const schemaFixture = (protocol = 19) => ({
  protocol,
  schemas: {
    request: {
      oneOf: [
        {
          properties: {
            method: { const: "pane.split" },
            params: { $ref: "#/schemas/request/$defs/PaneSplitParams" },
          },
        },
        {
          properties: {
            method: { const: "tab.create" },
            params: { $ref: "#/schemas/request/$defs/TabCreateParams" },
          },
        },
        {
          properties: {
            method: { const: "worktree.remove" },
            params: { $ref: "#/schemas/request/$defs/WorktreeRemoveParams" },
          },
        },
      ],
      $defs: {
        PaneSplitParams: {
          required: ["direction"],
          properties: { direction: {}, cwd: {}, ratio: {} },
        },
        TabCreateParams: { properties: { label: {}, cwd: {} } },
        WorktreeRemoveParams: { required: ["path"], properties: { path: {} } },
      },
    },
    success_response: {
      $defs: {
        ResponseResult: {
          oneOf: [
            {
              required: ["type", "tab", "root_pane"],
              properties: {
                type: { const: "tab_created" },
                tab: {},
                root_pane: {
                  $ref: "#/schemas/success_response/$defs/PaneInfo",
                },
              },
            },
            { required: ["type"], properties: { type: { const: "ok" } } },
          ],
        },
        PaneInfo: {
          required: ["pane_id"],
          properties: { pane_id: {}, cwd: {}, label: {} },
        },
      },
    },
  },
});

describe("shapeOf", () => {
  test("sorts, so a reordered schema does not read as a change", () => {
    expect(
      shapeOf({ required: ["b", "a"], properties: { z: {}, y: {} } }),
    ).toEqual({
      required: ["a", "b"],
      props: ["y", "z"],
      schemas: { y: {}, z: {} },
    });
  });

  test("treats a params-less method as an empty shape rather than throwing", () => {
    expect(shapeOf(undefined)).toEqual({
      required: [],
      props: [],
      schemas: {},
    });
  });

  test("sorts union branches so schema reordering is stable", () => {
    const first = shapeOf({
      properties: { value: { oneOf: [{ type: "string" }, { type: "null" }] } },
    });
    const second = shapeOf({
      properties: { value: { oneOf: [{ type: "null" }, { type: "string" }] } },
    });
    expect(first).toEqual(second);
  });
});

describe("usedMethods", () => {
  test("keeps only methods that appear in the source", () => {
    const literals = new Set(["pane.split", "tab.create", "some.unrelated"]);
    expect(usedMethods(schemaFixture(), literals)).toEqual([
      "pane.split",
      "tab.create",
    ]);
  });

  test("ignores source strings that are not server methods", () => {
    expect(
      usedMethods(schemaFixture(), new Set(["serde.rename", "foo.bar"])),
    ).toEqual([]);
  });

  test("keeps methods with any number of dot-separated segments", () => {
    const schema = schemaFixture();
    schema.schemas.request.oneOf.push({
      properties: {
        method: { const: "client.window_title.set" },
        params: { $ref: "#/schemas/request/$defs/TabCreateParams" },
      },
    });
    expect(
      usedMethods(schema, new Set(["client.window_title.set"])),
    ).toEqual(["client.window_title.set"]);
  });
});

describe("extractLiterals", () => {
  test("finds single-, double-, and backtick-quoted API names", () => {
    expect(
      extractLiterals(`call("ping"); call('client.window_title.set'); call(\`tab.create\`)`),
    ).toEqual(new Set(["ping", "client.window_title.set", "tab.create"]));
  });

  test("source scan excludes the committed protocol baseline", () => {
    const repo = mkdtempSync(join(tmpdir(), "protocol-check-"));
    tempRepos.push(repo);
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "client.rs"), 'call("pane.split");\n');
    writeFileSync(
      join(repo, ".herdr-protocol.json"),
      '{"responses":{"wait_matched":{}}}\n',
    );
    execFileSync("git", ["-C", repo, "add", "."]);

    expect(sourceLiterals(repo)).toEqual(new Set(["pane.split"]));
  });

  test("source scan surfaces a non-git repository error", () => {
    const repo = mkdtempSync(join(tmpdir(), "protocol-check-"));
    tempRepos.push(repo);
    expect(() => sourceLiterals(repo)).toThrow();
  });
});

describe("buildBaseline", () => {
  const base = buildBaseline(
    schemaFixture(),
    ["pane.split"],
    new Set(["tab_created"]),
  );

  test("captures params for used methods only", () => {
    expect(Object.keys(base.methods)).toEqual(["pane.split"]);
    expect(base.methods["pane.split"]).toEqual({
      required: ["direction"],
      props: ["cwd", "direction", "ratio"],
      schemas: { cwd: {}, direction: {}, ratio: {} },
    });
  });

  test("keys response variants by their type const", () => {
    expect(Object.keys(base.responses)).toEqual(["tab_created"]);
  });

  test("does not track response variants absent from the plugin source", () => {
    expect(base.responses.ok).toBeUndefined();
  });

  test("dereferences types used by a tracked response", () => {
    expect(base.responses.tab_created.schemas.root_pane).toEqual({
      properties: {
        cwd: {},
        label: {},
        pane_id: {},
      },
      required: ["pane_id"],
    });
  });
});

describe("diff", () => {
  const responseLiterals = new Set(["ok", "tab_created"]);
  const before = buildBaseline(
    schemaFixture(17),
    ["pane.split", "tab.create"],
    responseLiterals,
  );
  const clone = (): Baseline => JSON.parse(JSON.stringify(before));

  test("an additive upgrade reports nothing", () => {
    const after = clone();
    after.protocol = 19;
    after.methods["pane.split"].props.push("env");
    after.responses["tab_created"].props.push("workspace_id");
    expect(diff(before, after)).toEqual([]);
  });

  test("a removed method is a break", () => {
    const after = clone();
    delete after.methods["tab.create"];
    expect(diff(before, after)).toEqual(["method tab.create: gone"]);
  });

  test("a dropped request field is a break", () => {
    const after = clone();
    after.methods["pane.split"].props = ["direction", "cwd"];
    expect(diff(before, after)).toEqual(["method pane.split: dropped ratio"]);
  });

  test("a newly required request field is a break, since existing calls omit it", () => {
    const after = clone();
    after.methods["tab.create"].required = ["label"];
    expect(diff(before, after)).toEqual([
      "method tab.create: now requires label",
    ]);
  });

  test("a request field type change is a break", () => {
    const after = clone();
    after.methods["pane.split"].schemas.direction = { type: "number" };
    expect(diff(before, after)).toEqual([
      "method pane.split: changed direction schema",
    ]);
  });

  test("an old baseline without field schemas keeps the shape-only check", () => {
    const legacy = clone();
    for (const shape of Object.values(legacy.methods))
      delete (shape as any).schemas;
    for (const shape of Object.values(legacy.responses))
      delete (shape as any).schemas;
    expect(diff(legacy, { ...before, responses: {} })).toEqual([]);
  });

  test("safe enum widening in a request is not a break", () => {
    const base = clone();
    const after = clone();
    base.methods["pane.split"].schemas.direction = {
      enum: ["left", "right"],
    };
    after.methods["pane.split"].schemas.direction = {
      enum: ["down", "left", "right", "up"],
    };
    expect(diff(base, after)).toEqual([]);
  });

  test("safe enum narrowing in a response is not a break", () => {
    const base = clone();
    const after = clone();
    base.responses.tab_created.schemas.type = {
      enum: ["legacy", "tab_created"],
    };
    after.responses.tab_created.schemas.type = { enum: ["tab_created"] };
    expect(diff(base, after)).toEqual([]);
  });

  test("an optional field added inside an existing object is safe", () => {
    const after = clone();
    after.responses.tab_created.schemas.root_pane.properties = {
      ...(after.responses.tab_created.schemas.root_pane.properties as object),
      tokens: { type: "number" },
    };
    expect(diff(before, after)).toEqual([]);
  });

  test("a newly required response field is safe, since the server merely always sends it", () => {
    const after = clone();
    after.responses["ok"].required = ["type", "detail"];
    after.responses["ok"].props.push("detail");
    expect(diff(before, after)).toEqual([]);
  });

  test("a formerly required response field becoming optional is a break", () => {
    const after = clone();
    after.responses.tab_created.required = ["type", "tab"];
    expect(diff(before, after)).toEqual([
      "response tab_created: may omit root_pane",
    ]);
  });

  test("a dropped response field is a break, since the plugin may read it", () => {
    const after = clone();
    after.responses["tab_created"].props = ["type", "tab"];
    expect(diff(before, after)).toEqual([
      "response tab_created: dropped root_pane",
    ]);
  });

  test("a dropped field in a referenced response type is a break", () => {
    const after = clone();
    delete (after.responses.tab_created.schemas.root_pane.properties as any)
      .label;
    expect(diff(before, after)).toEqual([
      "response tab_created: changed root_pane schema",
    ]);
  });

  test("reports every break, not just the first", () => {
    const after = clone();
    delete after.methods["tab.create"];
    delete (after.responses.tab_created.schemas.root_pane.properties as any)
      .label;
    expect(diff(before, after)).toHaveLength(2);
  });
});

describe("summary", () => {
  const before = buildBaseline(schemaFixture(17), ["pane.split"], new Set());
  const after = buildBaseline(schemaFixture(19), ["pane.split"], new Set());

  test("a clean upgrade names both protocols and the method count", () => {
    const lines = summary(before, after, []);
    expect(lines[0]).toContain("protocol 17 → 19");
    expect(lines[0]).toContain("1 methods");
    expect(lines[1]).toContain("Safe to raise");
  });

  test("a re-run on the same protocol says so instead of showing an arrow", () => {
    expect(summary(after, after, [])[0]).toContain("protocol 19 unchanged");
  });

  test("breaks are indented under a count and end with the instruction", () => {
    const lines = summary(before, after, ["method x: gone"]);
    expect(lines[0]).toContain("1 breaking change(s)");
    expect(lines[1]).toBe("  method x: gone");
    expect(lines.at(-1)).toContain("Fix the call sites");
  });
});
