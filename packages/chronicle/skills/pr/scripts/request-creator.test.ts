import { describe, expect, test } from "bun:test";
import {
  buildArgs,
  createRequest,
  type CreateInput,
  type Runner,
} from "./request-creator";

const githubInput: CreateInput = {
  provider: "github",
  title: "Ship request creator",
  body: "Body text",
  base: "main",
  head: "feature/request-creator",
  draft: false,
};

describe("buildArgs", () => {
  test("builds github non-draft args", () => {
    expect(buildArgs(githubInput)).toEqual([
      "gh",
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      "feature/request-creator",
      "--title",
      "Ship request creator",
      "--body",
      "Body text",
    ]);
  });

  test("adds github draft flag", () => {
    expect(buildArgs({ ...githubInput, draft: true })).toContain("--draft");
  });

  // Cross-fork: the branch lives on the contributor's fork while the PR targets
  // upstream. `gh` cannot infer that when `origin` IS upstream, so the target repo
  // has to be explicit. `head` arrives already qualified as `owner:branch`.
  test("targets an explicit repo when one is given", () => {
    expect(
      buildArgs({
        ...githubInput,
        repo: "UPSTREAM/repo",
        head: "CONTRIBUTOR:feature/request-creator",
      }),
    ).toEqual([
      "gh",
      "pr",
      "create",
      "--repo",
      "UPSTREAM/repo",
      "--base",
      "main",
      "--head",
      "CONTRIBUTOR:feature/request-creator",
      "--title",
      "Ship request creator",
      "--body",
      "Body text",
    ]);
  });

  // Omitting --repo is what lets `gh` do the right thing in its own fork workflow
  // (origin = your fork): it defaults the base repo to the parent. Emitting --repo
  // unconditionally would turn those into fork→fork PRs.
  test("omits --repo when none is given", () => {
    expect(buildArgs(githubInput)).not.toContain("--repo");
  });

  // The marker is appended here, not by the drafting agent: a script cannot
  // forget it, reword it, or bury it mid-title.
  test("appends the skip-review marker to the github title", () => {
    expect(buildArgs({ ...githubInput, skipReview: true })).toContain(
      "Ship request creator [skip-review]",
    );
  });

  test("appends the skip-review marker to the gitlab title", () => {
    expect(
      buildArgs({ ...githubInput, provider: "gitlab", skipReview: true }),
    ).toContain("Ship request creator [skip-review]");
  });

  test("does not append the marker twice", () => {
    expect(
      buildArgs({
        ...githubInput,
        title: "Ship request creator [skip-review]",
        skipReview: true,
      }),
    ).toContain("Ship request creator [skip-review]");
  });

  test("leaves the title untouched without skipReview", () => {
    expect(buildArgs(githubInput)).toContain("Ship request creator");
  });

  test("builds gitlab draft args with branch flags and confirmation", () => {
    expect(
      buildArgs({
        ...githubInput,
        provider: "gitlab",
        draft: true,
      }),
    ).toEqual([
      "glab",
      "mr",
      "create",
      "--source-branch",
      "feature/request-creator",
      "--target-branch",
      "main",
      "--title",
      "Ship request creator",
      "--description",
      "Body text",
      "--yes",
      "--draft",
    ]);
  });
});

describe("createRequest", () => {
  test("returns the last URL from successful CLI output", async () => {
    const run: Runner = async () => ({
      exitCode: 0,
      stdout: [
        "Creating pull request",
        "https://github.com/acme/repo/pull/1",
        "View: https://github.com/acme/repo/pull/2",
      ].join("\n"),
      stderr: "",
    });

    await expect(createRequest(githubInput, run)).resolves.toEqual({
      ok: true,
      url: "https://github.com/acme/repo/pull/2",
    });
  });

  // Bun.spawn throws ENOENT for a binary that is not on PATH, which is the only
  // signal createRequest gets — there is no `command -v` preflight.
  test("maps a spawn ENOENT to missing-cli", async () => {
    const run: Runner = async () => {
      throw Object.assign(new Error('Executable not found in $PATH: "gh"'), {
        code: "ENOENT",
      });
    };

    await expect(createRequest(githubInput, run)).resolves.toMatchObject({
      ok: false,
      reason: "missing-cli",
    });
  });

  test("reports an unknown provider without running anything", async () => {
    const run: Runner = async () => {
      throw new Error("must not spawn");
    };

    await expect(
      createRequest({ ...githubInput, provider: "unknown" }, run),
    ).resolves.toMatchObject({
      ok: false,
      reason: "cli-error",
    });
  });

  test("maps repository or remote errors to no-remote", async () => {
    const run: Runner = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "fatal: not a git repository (or any parent up to mount point)",
    });

    await expect(createRequest(githubInput, run)).resolves.toMatchObject({
      ok: false,
      reason: "no-remote",
    });
  });

  test("maps other non-zero exits to cli-error", async () => {
    const run: Runner = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "GraphQL: title is too short",
    });

    await expect(createRequest(githubInput, run)).resolves.toEqual({
      ok: false,
      reason: "cli-error",
      message: "GraphQL: title is too short",
    });
  });
});
