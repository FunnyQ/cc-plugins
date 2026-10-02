import type { Register } from "claude-code";

// Feeds the usage dashboard's rate-limit cache and rollup nudge without wrapping the person's statusline.
export const register: Register = (on) => {
  on("session.measure", async ($, e, next) => {
    const result = await next(e);
    // `cockpit atlas measure` reads the statusline's stdin shape, so both writers share one cache format.
    const payload: {
      rate_limits?: Record<
        string,
        { used_percentage: number; resets_at?: number }
      >;
    } = {};
    if (e.rateLimits.length > 0) {
      payload.rate_limits = Object.fromEntries(
        e.rateLimits.map((w) => [
          w.kind,
          w.resetsAt === undefined
            ? { used_percentage: w.percentUsed }
            : {
                used_percentage: w.percentUsed,
                resets_at: Date.parse(w.resetsAt) / 1000,
              },
        ]),
      );
    }
    await $.process.run(
      [`${$.plugin.root}/skills/cockpit/bin/cockpit`, "atlas", "measure"],
      {
        stdin: JSON.stringify(payload),
      },
    );
    return result;
  });
};
