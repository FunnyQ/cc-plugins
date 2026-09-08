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

// woff2/png/jpg are already compressed — gzip would only make them bigger.
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg"]);

function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

// mtime+size, not a content hash — hashing re-reads the file the 304 exists to
// skip. Encoding is in the key: the gzip and plain bodies differ.
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
  // `no-cache` means revalidate every time, not never cache — hence the ETag.
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
