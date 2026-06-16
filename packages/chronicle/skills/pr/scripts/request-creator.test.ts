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
    const run: Runner = async (cmd) => {
      if (cmd[0] === "sh") {
        return { exitCode: 0, stdout: "/usr/bin/gh\n", stderr: "" };
      }

      return {
        exitCode: 0,
        stdout: [
          "Creating pull request",
          "https://github.com/acme/repo/pull/1",
          "View: https://github.com/acme/repo/pull/2",
        ].join("\n"),
        stderr: "",
      };
    };

    await expect(createRequest(githubInput, run)).resolves.toEqual({
      ok: true,
      url: "https://github.com/acme/repo/pull/2",
    });
  });

  test("maps missing binary preflight to missing-cli", async () => {
    const run: Runner = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "",
    });

    await expect(createRequest(githubInput, run)).resolves.toMatchObject({
      ok: false,
      reason: "missing-cli",
    });
  });

  test("maps repository or remote errors to no-remote", async () => {
    const run: Runner = async (cmd) => {
      if (cmd[0] === "sh") {
        return { exitCode: 0, stdout: "/usr/bin/gh\n", stderr: "" };
      }

      return {
        exitCode: 1,
        stdout: "",
        stderr: "fatal: not a git repository (or any parent up to mount point)",
      };
    };

    await expect(createRequest(githubInput, run)).resolves.toMatchObject({
      ok: false,
      reason: "no-remote",
    });
  });

  test("maps other non-zero exits to cli-error", async () => {
    const run: Runner = async (cmd) => {
      if (cmd[0] === "sh") {
        return { exitCode: 0, stdout: "/usr/bin/gh\n", stderr: "" };
      }

      return {
        exitCode: 1,
        stdout: "",
        stderr: "GraphQL: title is too short",
      };
    };

    await expect(createRequest(githubInput, run)).resolves.toEqual({
      ok: false,
      reason: "cli-error",
      message: "GraphQL: title is too short",
    });
  });
});
