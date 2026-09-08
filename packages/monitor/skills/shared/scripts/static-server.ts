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

// Built from mtime + size, never from the bytes: hashing content would re-read
// every file on every revalidation, which is the cost the 304 exists to avoid
// (cockpit's mermaid bundle alone is 3.16MB). Weak, because mtime + size is not
// proof of identical content. The encoding is part of the key — the gzip and
// plain bodies differ, so a client holding one must not get a 304 for the other.
function etagFor(
  stat: { mtimeMs: number; size: number },
  gzip: boolean,
): string {
  const suffix = gzip ? "-gz" : "";
  return `W/"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}${suffix}"`;
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
  let stat;
  try {
    stat = statSync(filePath);
    if (!stat.isFile()) {
      return new Response("Not found", { status: 404 });
    }
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const gzip = shouldGzip(filePath, req);
  const etag = etagFor(stat, gzip);
  const headers: Record<string, string> = {
    "Content-Type": mimeFor(filePath),
    "Cache-Control": "no-cache",
    ETag: etag,
  };
  // `no-cache` means revalidate every time, not "never cache" — the ETag is
  // what turns each of those revalidations from a full re-download into a 304.
  if (req?.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  if (!gzip) {
    return new Response(Bun.file(filePath), { headers });
  }
  headers["Content-Encoding"] = "gzip";
  headers.Vary = "Accept-Encoding";
  return new Response(Bun.gzipSync(readFileSync(filePath), { level: 6 }), {
    headers,
  });
}
