import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { parseSpec } from "./spec";

const ASSETS = join(import.meta.dir, "../assets");
const LIBS = new Set(["spring", "format"]);
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
};
// idle shutdown, 4h; a session that tunes longer reopens with `tune.ts open`
const IDLE_MS = 4 * 60 * 60 * 1000;

const HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "no-store",
};

type Applied = { seq: number; at: string; values: Record<string, unknown> };

const valuesPath = (dir: string) => join(dir, "values.json");
const consumedPath = (dir: string) => join(dir, "consumed");
const waitingPath = (dir: string) => join(dir, "waiting.pid");

function readApplied(dir: string): Applied | null {
  try {
    return JSON.parse(readFileSync(valuesPath(dir), "utf8"));
  } catch {
    return null;
  }
}

function readConsumed(dir: string): number {
  try {
    return Number(readFileSync(consumedPath(dir), "utf8")) || 0;
  } catch {
    return 0;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForApply(
  dir: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  writeFileSync(waitingPath(dir), String(process.pid));
  try {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const applied = readApplied(dir);
      if (applied && applied.seq > readConsumed(dir)) {
        writeFileSync(consumedPath(dir), String(applied.seq));
        return applied.values;
      }
      if (Date.now() >= deadline) return null;
      await Bun.sleep(Math.min(200, Math.max(0, deadline - Date.now())));
    }
  } finally {
    rmSync(waitingPath(dir), { force: true });
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...HEADERS, "content-type": "application/json" },
  });

function asset(path: string): Response {
  const file = join(ASSETS, path);
  if (!file.startsWith(ASSETS + sep) || !existsSync(file))
    return new Response("not found", { status: 404, headers: HEADERS });
  return new Response(Bun.file(file), {
    headers: {
      ...HEADERS,
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    },
  });
}

export function startServer({
  dir,
  specPath,
  port = 0,
}: {
  dir: string;
  specPath: string;
  port?: number;
}) {
  const nonce = crypto.randomUUID().slice(0, 12);
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  let lastHit = Date.now();

  const loadSpec = () =>
    parseSpec(JSON.parse(readFileSync(specPath, "utf8")), specPath);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      lastHit = Date.now();
      const url = new URL(req.url);
      const prefix = `/${nonce}/`;
      if (!url.pathname.startsWith(prefix))
        return new Response("not found", { status: 404 });
      if (req.method === "OPTIONS")
        return new Response(null, { status: 204, headers: HEADERS });
      const route = url.pathname.slice(prefix.length);

      if (req.method === "POST" && route === "apply") {
        let values: unknown;
        try {
          values = JSON.parse(await req.text()).values;
        } catch {
          return json({ error: "body must be JSON" }, 400);
        }
        if (typeof values !== "object" || values === null)
          return json({ error: "body needs a values object" }, 400);
        const applied: Applied = {
          seq: (readApplied(dir)?.seq ?? 0) + 1,
          at: new Date().toISOString(),
          values: values as Record<string, unknown>,
        };
        writeFileSync(valuesPath(dir), JSON.stringify(applied, null, 2));
        return json({ seq: applied.seq, at: applied.at });
      }
      if (req.method !== "GET")
        return new Response("method not allowed", {
          status: 405,
          headers: HEADERS,
        });

      if (route === "") return asset("shell.html");
      if (route === "spec.json") {
        try {
          return json(loadSpec());
        } catch (error) {
          return json({ error: (error as Error).message }, 422);
        }
      }
      if (route === "stage") {
        let snippet: string;
        try {
          const spec = loadSpec();
          snippet = spec.snippet ? readFileSync(spec.snippet, "utf8") : "";
        } catch (error) {
          snippet = `<p>${String((error as Error).message).replace(/</g, "&lt;")}</p>`;
        }
        const page = readFileSync(join(ASSETS, "stage.html"), "utf8")
          .split("<!--snippet-->")
          .join(snippet);
        return new Response(page, {
          headers: { ...HEADERS, "content-type": TYPES[".html"] },
        });
      }
      if (route === "status") {
        const pid = Number(
          existsSync(waitingPath(dir))
            ? readFileSync(waitingPath(dir), "utf8")
            : 0,
        );
        return json({
          seq: readApplied(dir)?.seq ?? 0,
          consumed: readConsumed(dir),
          waiting: pid > 0 && alive(pid),
        });
      }
      if (route.startsWith("lib/") && LIBS.has(route.slice(4))) {
        const source = readFileSync(
          join(import.meta.dir, `${route.slice(4)}.ts`),
          "utf8",
        );
        return new Response(transpiler.transformSync(source), {
          headers: { ...HEADERS, "content-type": TYPES[".js"] },
        });
      }
      return asset(route);
    },
  });

  const idle = setInterval(() => {
    if (Date.now() - lastHit > IDLE_MS) process.exit(0);
  }, 60_000);

  return {
    port: server.port as number,
    nonce,
    stop() {
      clearInterval(idle);
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const arg = (name: string) =>
    process.argv[process.argv.indexOf(`--${name}`) + 1];
  const dir = arg("dir");
  const specPath = arg("spec");
  const { port, nonce } = startServer({ dir, specPath });
  writeFileSync(
    join(dir, "server.json"),
    JSON.stringify({ pid: process.pid, port, nonce, spec: specPath }),
  );
}
