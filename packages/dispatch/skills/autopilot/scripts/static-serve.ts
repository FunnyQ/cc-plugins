import { statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-cache",
};

export function resolveStaticPath(
  root: string,
  pathname: string,
): string | null {
  const mappedPathname = pathname === "/" ? "/index.html" : pathname;
  let decodedPathname: string;

  try {
    decodedPathname = decodeURIComponent(mappedPathname);
  } catch {
    return null;
  }

  const relativePathname = decodedPathname.startsWith("/")
    ? decodedPathname.slice(1)
    : decodedPathname;

  if (relativePathname.includes("//")) {
    return null;
  }

  const absoluteRoot = resolve(root);
  const resolvedPath = resolve(absoluteRoot, relativePathname);
  const isInside =
    resolvedPath === absoluteRoot ||
    resolvedPath.startsWith(absoluteRoot + sep);

  return isInside ? resolvedPath : null;
}

export function mimeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: NO_CACHE_HEADERS });
}

export async function serveStatic(
  root: string,
  pathname: string,
): Promise<Response> {
  const filePath = resolveStaticPath(root, pathname);

  if (filePath === null) {
    return notFound();
  }

  try {
    if (!statSync(filePath).isFile()) {
      return notFound();
    }
  } catch {
    return notFound();
  }

  return new Response(Bun.file(filePath), {
    headers: {
      "Content-Type": mimeFor(filePath),
      ...NO_CACHE_HEADERS,
    },
  });
}
