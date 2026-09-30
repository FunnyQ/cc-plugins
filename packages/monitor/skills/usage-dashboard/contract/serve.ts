import type { Subprocess } from "bun";
import { request } from "node:http";
import { atlasCommand } from "./launcher.ts";

export type AtlasProc = {
  port: number;
  proc: Subprocess<"ignore", "pipe", "pipe">;
  stdout(): string;
  stderr(): string;
  stop(): Promise<void>;
};

export type Spawned = {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  stdout(): string;
  stderr(): string;
  // Resolves once both pipes hit EOF, so output read after exit is complete.
  drained: Promise<void>;
};

// Drains both pipes into strings so a test can inspect output while the process runs.
export function spawnAtlas(
  env: Record<string, string>,
  port: number,
  extraArgs: string[] = [],
): Spawned {
  const proc = Bun.spawn(
    atlasCommand("serve", ["--port", String(port), "--no-open", ...extraArgs]),
    {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let out = "";
  let err = "";
  const drain = async (
    stream: ReadableStream<Uint8Array>,
    push: (s: string) => void,
  ) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream)
      push(decoder.decode(chunk, { stream: true }));
  };
  const drained = Promise.all([
    drain(proc.stdout, (s) => (out += s)),
    drain(proc.stderr, (s) => (err += s)),
  ]).then(() => {});
  return { proc, stdout: () => out, stderr: () => err, drained };
}

export async function startAtlas(
  env: Record<string, string>,
  port: number,
  extraArgs: string[] = [],
): Promise<AtlasProc> {
  const spawned = spawnAtlas(env, port, extraArgs);
  const { proc } = spawned;
  const stop = async () => {
    if (proc.exitCode === null && proc.signalCode === null)
      proc.kill("SIGTERM");
    await proc.exited;
  };
  const ready = `Claude Stats Dashboard → http://localhost:${port}`;
  const deadline = Date.now() + 15_000;
  while (!spawned.stdout().includes(ready)) {
    if (Date.now() > deadline || proc.exitCode !== null) {
      await stop();
      throw new Error(
        `atlas serve did not start on ${port}\nstdout:\n${spawned.stdout()}\nstderr:\n${spawned.stderr()}`,
      );
    }
    await Bun.sleep(25);
  }
  return { port, ...spawned, stop };
}

// fetch() normalizes `..` and `%2e%2e` away, so traversal probes need the raw request line.
export function rawGet(
  port: number,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET" },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
