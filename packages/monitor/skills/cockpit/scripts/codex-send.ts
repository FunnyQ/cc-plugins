import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { jsonResponse as json } from "./http";
import {
  runDirectProbe,
  type ProbeOptions,
  type ProbeReport,
} from "./codex-control-probe";

const UUID_RE = /^[0-9a-f-]{36}$/;

type SendCodexTurn = (opts: ProbeOptions) => Promise<ProbeReport>;

function cockpitHome(): string {
  return process.env.COCKPIT_HOME || join(homedir(), ".cockpit");
}

function daemonToken(): string | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(cockpitHome(), "daemon.json"), "utf8"),
    );
    return typeof raw?.token === "string" ? raw.token : null;
  } catch {
    return null;
  }
}

export async function handleSendCodexMessage(
  req: Request,
  sendCodexTurn: SendCodexTurn = runDirectProbe,
): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const session = body?.session;
  const token = body?.token;
  if (token !== daemonToken()) return json({ error: "unauthorized" }, 401);
  if (typeof session !== "string" || !UUID_RE.test(session)) {
    return json({ error: "invalid session" }, 400);
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text === "") return json({ error: "empty text" }, 400);

  const report = await sendCodexTurn({ threadId: session, sendText: text });
  if (!report.ok || !report.turnStartOk) {
    return json(
      {
        error: report.errors.join("; ") || "Codex send failed",
        warnings: report.warnings,
      },
      502,
    );
  }

  return json({
    delivered: true,
    controlMode: report.controlMode,
    warnings: report.warnings,
  });
}
