import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { isPathInside } from "./path-inside";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

// woff2, png and jpg carry their own compression — gzipping them burns CPU to
// make the body slightly bigger.
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg"]);

function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function shouldGzip(filePath: string, req: Request | undefined): boolean {
  if (!req) return false;
  if (!COMPRESSIBLE.has(extname(filePath).toLowerCase())) return false;
  return (req.headers.get("accept-encoding") ?? "").includes("gzip");
}

// `req` is optional so a caller that has no use for compression — a test, a
// one-off — can keep the two-argument form.
export function serveStaticFile(
  root: string,
  pathname: string,
  req?: Request,
): Response {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(root, "." + rel);
  if (!isPathInside(root, filePath) || !existsSync(filePath)) {
    return new Response("Not found", { status: 404 });
  }
  try {
    if (!statSync(filePath).isFile()) {
      return new Response("Not found", { status: 404 });
    }
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const headers: Record<string, string> = {
    "Content-Type": mimeFor(filePath),
    "Cache-Control": "no-cache",
  };
  if (!shouldGzip(filePath, req)) {
    return new Response(Bun.file(filePath), { headers });
  }
  headers["Content-Encoding"] = "gzip";
  headers.Vary = "Accept-Encoding";
  return new Response(Bun.gzipSync(readFileSync(filePath), { level: 6 }), {
    headers,
  });
}
