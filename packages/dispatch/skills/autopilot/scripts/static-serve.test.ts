import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mimeFor, resolveStaticPath, serveStatic } from "./static-serve";

let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "dispatch-static-serve-"));
  await mkdir(join(root, "modules"));
  await writeFile(join(root, "index.html"), "<h1>Flightdeck</h1>");
  await writeFile(join(root, "app.js"), "console.log('flightdeck');");
  await writeFile(join(root, "modules", "lanes.js"), "export {};");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveStaticPath", () => {
  test.each([
    ["/", "index.html"],
    ["/index.html", "index.html"],
    ["/app.js", "app.js"],
    ["/modules/lanes.js", join("modules", "lanes.js")],
  ])("resolves %s inside the root", (pathname, expected) => {
    expect(resolveStaticPath(root, pathname)).toBe(join(root, expected));
  });

  test.each([
    ["plain traversal", "/../../../etc/passwd"],
    ["encoded traversal", "/%2e%2e%2f%2e%2e%2fetc/passwd"],
    ["double-slash prefix", "//etc/passwd"],
    ["dot-padding trick", "/....//etc/passwd"],
    ["malformed percent-encoding", "/%2g"],
  ])("rejects %s", (_name, pathname) => {
    expect(resolveStaticPath(root, pathname)).toBeNull();
  });

  test("rejects a root-prefix sibling", () => {
    const siblingPath = `../${basename(root)}-evil/file.txt`;

    expect(resolve(root, siblingPath).startsWith(root)).toBe(true);
    expect(resolveStaticPath(root, siblingPath)).toBeNull();
  });
});

describe("mimeFor", () => {
  test.each([
    ["file.html", "text/html; charset=utf-8"],
    ["file.HTML", "text/html; charset=utf-8"],
    ["file.js", "application/javascript; charset=utf-8"],
    ["file.mjs", "application/javascript; charset=utf-8"],
    ["file.css", "text/css; charset=utf-8"],
    ["file.json", "application/json; charset=utf-8"],
    ["file.svg", "image/svg+xml"],
    ["file.png", "image/png"],
    ["file.ico", "image/x-icon"],
    ["file.woff2", "font/woff2"],
  ])("maps %s to %s", (path, expected) => {
    expect(mimeFor(path)).toBe(expected);
  });

  test.each(["file.txt", "file.xyz"])("falls back for %s", (path) => {
    expect(mimeFor(path)).toBe("application/octet-stream");
  });

  test("adds a charset only to text MIME types", () => {
    expect(mimeFor("index.html")).toContain("charset=utf-8");
    expect(mimeFor("app.js")).toContain("charset=utf-8");
    expect(mimeFor("styles.css")).toContain("charset=utf-8");
    expect(mimeFor("data.json")).toContain("charset=utf-8");
    expect(mimeFor("image.png")).not.toContain("charset");
    expect(mimeFor("font.woff2")).not.toContain("charset");
  });
});

describe("serveStatic", () => {
  test.each([
    ["an unsafe path", "/../../../etc/passwd"],
    ["a missing path", "/missing.js"],
    ["a directory", "/modules"],
  ])("returns 404 for %s", async (_name, pathname) => {
    const response = await serveStatic(root, pathname);

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  });

  test("returns a file with content and cache headers", async () => {
    const response = await serveStatic(root, "/index.html");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(await response.text()).toBe("<h1>Flightdeck</h1>");
  });
});
