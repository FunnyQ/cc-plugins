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

// Generic API error: extracts a message from any thrown value. Defaults to 500
// (an unexpected server fault). Param-validation helpers that want a 400 default
// build their own thin wrapper on top of jsonResponse (see sse-tailer).
export function jsonError(err: unknown, status = 500): Response {
  const message = err instanceof Error ? err.message : String(err);
  return jsonResponse({ error: message }, status);
}
