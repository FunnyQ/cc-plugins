// Shared JSON Response helpers for the cockpit daemon. Every endpoint returns
// the same shape — a JSON body with no-store caching — so the builder lives here
// once instead of being copied into each handler module.

export function jsonResponse(payload: object, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// Opt-in gzip, for the one endpoint whose body is measured in megabytes
// (/api/stats builds ~4.3MB; level 6 takes it to ~0.6MB in ~30ms). Every other
// caller keeps jsonResponse, so no cockpit endpoint pays the CPU for a payload
// too small to benefit.
export function gzipJsonResponse(
  payload: object,
  req: Request,
  status = 200,
): Response {
  if (!(req.headers.get("accept-encoding") ?? "").includes("gzip")) {
    return jsonResponse(payload, status);
  }
  return new Response(Bun.gzipSync(JSON.stringify(payload), { level: 6 }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Encoding": "gzip",
      Vary: "Accept-Encoding",
    },
  });
}

/** A human-readable message from any thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Generic API error: extracts a message from any thrown value. Defaults to 500
// (an unexpected server fault). Param-validation helpers that want a 400 default
// build their own thin wrapper on top of jsonResponse (see sse-tailer).
export function jsonError(err: unknown, status = 500): Response {
  return jsonResponse({ error: errorMessage(err) }, status);
}
