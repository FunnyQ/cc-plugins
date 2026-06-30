import { existsSync, statSync } from "node:fs";
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

function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export function serveStaticFile(root: string, pathname: string): Response {
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
  return new Response(Bun.file(filePath), {
    headers: {
      "Content-Type": mimeFor(filePath),
      "Cache-Control": "no-cache",
    },
  });
}
