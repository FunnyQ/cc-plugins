import { describe, expect, test } from "bun:test";
import { gzipJsonResponse, jsonResponse } from "./http";

const PAYLOAD = {
  hello: "world",
  rows: Array.from({ length: 50 }, (_, i) => i),
};

function req(acceptEncoding?: string): Request {
  return new Request("http://127.0.0.1/api/stats", {
    headers: acceptEncoding ? { "Accept-Encoding": acceptEncoding } : {},
  });
}

async function bodyBytes(res: Response): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await res.arrayBuffer());
}

describe("jsonResponse", () => {
  test("never compresses — cockpit callers keep the plain body", async () => {
    const res = jsonResponse(PAYLOAD);
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(await res.json()).toEqual(PAYLOAD);
  });
});

describe("gzipJsonResponse", () => {
  test("compresses when the client accepts gzip", async () => {
    const res = gzipJsonResponse(PAYLOAD, req("gzip, deflate, br"));
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(res.headers.get("Vary")).toBe("Accept-Encoding");
    const decoded = Bun.gunzipSync(await bodyBytes(res));
    expect(JSON.parse(new TextDecoder().decode(decoded))).toEqual(PAYLOAD);
  });

  test("sends plain JSON when the client sends no Accept-Encoding", async () => {
    const res = gzipJsonResponse(PAYLOAD, req());
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(await res.json()).toEqual(PAYLOAD);
  });

  test("sends plain JSON when the client accepts only br", async () => {
    const res = gzipJsonResponse(PAYLOAD, req("br"));
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(await res.json()).toEqual(PAYLOAD);
  });

  test("keeps the JSON content type and no-store caching on both paths", async () => {
    for (const res of [
      gzipJsonResponse(PAYLOAD, req("gzip")),
      gzipJsonResponse(PAYLOAD, req()),
    ]) {
      expect(res.headers.get("Content-Type")).toBe(
        "application/json; charset=utf-8",
      );
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  test("passes the status through", () => {
    expect(gzipJsonResponse(PAYLOAD, req("gzip"), 503).status).toBe(503);
  });
});
