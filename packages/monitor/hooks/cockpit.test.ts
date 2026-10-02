import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";

// The mod's own lib is es2023 with no timers, while the test runner has both.
declare const setTimeout: (fn: () => void, ms: number) => unknown;
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

const ran = { result: {}, text: "ran" };

// Stands for the cockpit daemon and the engine beneath the mod: the first run of a tool waits on the terminal dialog, a later run waits on `rerun`, and `verdict` is what the dashboard sends. A noun answering a primitive answers `{ value }`.
function world(on: On, opts: { isAnsweredBeneath?: boolean } = {}) {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const submitted: string[] = [];
  const verdict = deferred<Record<string, unknown>>();
  const terminal = deferred<typeof ran>();
  const rerun = deferred<typeof ran>();
  const inboxDone = deferred<void>();
  const clock = mock.clock(on);
  let coreRuns = 0;
  let inboxCalls = 0;
  const inboxSessions: string[] = [];
  let sessionId = "11111111-1111-4111-8111-111111111111";

  on(
    "process.run",
    () =>
      ({
        value: {
          exitCode: 0,
          stdout: '{"port":5858,"token":"t"}\n',
          stderr: "",
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }) as never,
  );
  on(
    "session.id",
    () => ({ value: sessionId }) as never,
  );
  on("session.start", (_$, e) => e as never);
  on("session.end", () => ({ sessionId: "11111111-1111-4111-8111-111111111111" }) as never);
  on("prompt.submit", (_$, e) => {
    submitted.push(`${e.origin.kind === "plugin" && e.origin.asUser ? "asUser:" : ""}${e.text}`);
    return e as never;
  });
  on("http.fetch", async (_$, e) => {
    const path = new URL(e.url).pathname;
    let answer: Record<string, unknown> = { ok: true };
    if (path === "/api/inbox") {
      inboxCalls++;
      inboxSessions.push(new URL(e.url).searchParams.get("session")!);
      if (inboxCalls === 1) answer = { message: "from the dashboard" };
      else {
        await inboxDone.promise;
        // A real poll waits on I/O; an instant answer would spin the loop on microtasks and starve the test's timers.
        await new Promise<void>((r) => setTimeout(r, 1));
        answer = { message: null, timeout: true };
      }
    } else if (path === "/api/permission-pull") {
      answer = await verdict.promise;
    } else {
      posts.push({ path, body: JSON.parse(e.init?.body ?? "{}") });
    }
    return {
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify(answer),
      },
    } as never;
  });
  on("classic.PermissionRequest", () => (opts.isAnsweredBeneath ? { decision: { behavior: "allow" as const } } : {}));
  on("tool.check", () => ({ decision: "ask" }));
  on(
    "tool.call",
    () => (++coreRuns === 1 ? terminal.promise : rerun.promise) as never,
  );

  return {
    clock,
    posts,
    submitted,
    verdict,
    terminal,
    rerun,
    inboxDone,
    coreRuns: () => coreRuns,
    inboxCalls: () => inboxCalls,
    inboxSessions,
    useSession: (id: string) => (sessionId = id),
  };
}

const bash = {
  tool: "Bash",
  command: "pnpm deploy",
  description: "Deploy",
} as const;
const asked = {
  tool_name: "Bash",
  tool_input: { command: "pnpm deploy", description: "Deploy" },
};
const tick = () => new Promise<void>((r) => setTimeout(r, 1));

test("an open dialog reaches the dashboard and its allow reruns the tool past the ask", async ($, on) => {
  const w = world(on);
  const call = $.tool.call(bash);
  while (w.coreRuns() < 1) await tick();
  await $.classic.PermissionRequest(asked as never);
  while (!w.posts.length) await tick();
  const sent = w.posts[0]!;
  expect(sent.body).toMatchObject({
    session: "11111111-1111-4111-8111-111111111111",
    tool_name: "Bash",
    description: "Deploy",
    input_preview: "pnpm deploy",
    token: "t",
  });
  const id = sent.body.request_id as string;
  w.verdict.resolve({ request_id: id, behavior: "allow" });
  while (w.coreRuns() < 2) await tick();
  expect(
    (
      await $.tool.check({
        tool: "Bash",
        input: asked.tool_input,
        tool_use_id: id,
      })
    ).decision,
  ).toBe("allow");
  w.rerun.resolve(ran);
  expect((await call).text).toBe("ran");
  expect(
    (
      await $.tool.check({
        tool: "Bash",
        input: asked.tool_input,
        tool_use_id: id,
      })
    ).decision,
  ).toBe("ask");
});

test("a dashboard deny refuses the call", async ($, on) => {
  const w = world(on);
  const call = $.tool.call(bash);
  while (w.coreRuns() < 1) await tick();
  await $.classic.PermissionRequest(asked as never);
  while (!w.posts.length) await tick();
  w.verdict.resolve({
    request_id: w.posts[0]!.body.request_id,
    behavior: "deny",
  });
  expect(await call).toEqual({ deny: "Denied from the cockpit dashboard." });
});

test("a terminal answer wins and tells the dashboard the request is resolved", async ($, on) => {
  const w = world(on);
  const call = $.tool.call(bash);
  while (w.coreRuns() < 1) await tick();
  await $.classic.PermissionRequest(asked as never);
  while (!w.posts.length) await tick();
  w.terminal.resolve(ran);
  expect((await call).text).toBe("ran");
  w.verdict.resolve({ abandoned: true });
  expect(w.posts.map((p) => p.path)).toEqual([
    "/api/permission-request",
    "/api/permission-resolved",
  ]);
  expect(w.posts[1]!.body.request_id).toBe(w.posts[0]!.body.request_id);
});

test("a request a hook beneath answered never reaches the dashboard", async ($, on) => {
  const w = world(on, { isAnsweredBeneath: true });
  const call = $.tool.call(bash);
  while (w.coreRuns() < 1) await tick();
  await $.classic.PermissionRequest(asked as never);
  w.terminal.resolve(ran);
  expect((await call).text).toBe("ran");
  expect(w.posts).toEqual([]);
});

test("a dashboard message becomes a prompt", async ($, on) => {
  const w = world(on);
  await $.session.start({ cwd: "/repo", surface: null } as never);
  while (w.inboxCalls() < 2) await tick();
  expect(w.submitted).toEqual(["asUser:from the dashboard"]);
  await $.session.end({ reason: "other" } as never);
  w.inboxDone.resolve();
});

for (const reason of ["resume", "clear"] as const) {
  test(`a ${reason} keeps the process polling, now for the new session id`, async ($, on) => {
    const w = world(on);
    await $.session.start({ cwd: "/repo", surface: null } as never);
    while (w.inboxCalls() < 2) await tick();
    await $.session.end({ reason, sessionId: "11111111-1111-4111-8111-111111111111" } as never);
    // The engine switches the id only after session.end resolves.
    await w.clock.advance(300);
    w.useSession("22222222-2222-4222-8222-222222222222");
    while (!w.inboxSessions.some((s) => s.startsWith("2222"))) await w.clock.advance(100);
    w.inboxDone.resolve();
    for (let i = 0; i < 10; i++) await tick();
    expect(w.inboxSessions.filter((s) => s.startsWith("1111")).length).toBe(2);
    await $.session.end({ reason: "other" } as never);
  });
}
