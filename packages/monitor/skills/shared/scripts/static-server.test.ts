import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStaticFile } from "./static-server";

let root: string;

// Long enough that gzip actually shrinks it — a few bytes of JS would grow.
const APP_JS = `console.log("hello");\n`.repeat(200);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "static-server-"));
  writeFileSync(join(root, "app.js"), APP_JS);
  writeFileSync(join(root, "index.html"), "<!doctype html><p>hi</p>");
  writeFileSync(join(root, "logo.png"), Buffer.alloc(4096, 7));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function req(acceptEncoding?: string): Request {
  return new Request("http://127.0.0.1/app.js", {
    headers: acceptEncoding ? { "Accept-Encoding": acceptEncoding } : {},
  });
}

describe("serveStaticFile", () => {
  test("serves the file uncompressed when no request is passed", async () => {
    const res = serveStaticFile(root, "/app.js");
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(await res.text()).toBe(APP_JS);
  });

  test("gzips a text asset when the client accepts gzip", async () => {
    const res = serveStaticFile(root, "/app.js", req("gzip, deflate"));
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(res.headers.get("Content-Type")).toBe(
      "application/javascript; charset=utf-8",
    );
    const raw = new Uint8Array(await res.arrayBuffer());
    expect(raw.byteLength).toBeLessThan(APP_JS.length);
    expect(new TextDecoder().decode(Bun.gunzipSync(raw))).toBe(APP_JS);
  });

  test("leaves an already-compressed type alone", async () => {
    const res = serveStaticFile(root, "/logo.png", req("gzip"));
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect((await res.arrayBuffer()).byteLength).toBe(4096);
  });

  test("serves plain bytes when the client does not accept gzip", async () => {
    const res = serveStaticFile(root, "/app.js", req());
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(await res.text()).toBe(APP_JS);
  });

  test("still resolves / to index.html and 404s outside the root", async () => {
    const index = serveStaticFile(root, "/", req("gzip"));
    const body = Bun.gunzipSync(new Uint8Array(await index.arrayBuffer()));
    expect(new TextDecoder().decode(body)).toContain("<p>hi</p>");
    expect(serveStaticFile(root, "/../secret", req("gzip")).status).toBe(404);
    expect(serveStaticFile(root, "/missing.js", req("gzip")).status).toBe(404);
  });
});
