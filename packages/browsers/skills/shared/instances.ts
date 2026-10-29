import {
  existsSync,
  accessSync,
  constants,
  statSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  openSync,
  readSync,
  closeSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname, basename, isAbsolute } from "node:path";
import { nativePlatformInput, type Platform } from "./platform";

export type Instance = {
  id: string;
  pid: number;
  port: number;
  profile: string;
  browser: string;
  headless: boolean;
};

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

export function pickInstance(live: Instance[], id: string | null): Instance {
  if (id !== null) {
    const found = live.find((instance) => instance.id === id);
    if (!found)
      throw new Error(
        `no open instance ${id}; open: ${live.map((i) => i.id).join(", ") || "none"}`,
      );
    return found;
  }
  if (live.length === 0)
    throw new Error("no instance is open — run `open <url>` first");
  if (live.length > 1) {
    throw new Error(
      `${live.length} instances are open — pass --id: ${live.map((i) => i.id).join(", ")}`,
    );
  }
  return live[0]!;
}

export type BinaryOptions = {
  platform?: Platform;
  wsl?: boolean;
  validate?: (path: string) => boolean;
  lookup?: (name: string) => string | null;
  target?: (path: string) => string;
  env?: Record<string, string | undefined>;
};

export function resolveBinary(
  name: string,
  candidates: string[],
  options: BinaryOptions = {},
): string {
  const { platform, wsl } = { ...nativePlatformInput(), ...options };
  const validate =
    options.validate ??
    ((path: string) => {
      try {
        if (!statSync(path).isFile()) return false;
        if (platform === "win32") return /\.exe$/i.test(path);
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  const lookup =
    options.lookup ??
    ((name: string) =>
      Bun.which(name, { PATH: options.env?.PATH ?? options.env?.Path }));
  const target =
    options.target ??
    ((path: string) => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    });
  let snap = false;
  for (const candidate of candidates) {
    const path =
      isAbsolute(candidate) || /[\\/]/.test(candidate)
        ? candidate
        : lookup(candidate);
    if (!path) continue;
    const real = platform === "linux" ? target(path) : path;
    if (wsl && (/\.exe$/i.test(real) || /^[a-z]:/i.test(real))) continue;
    // A Snap confines the browser to its own /tmp, so it never sees the profile or DevToolsActivePort.
    if (platform === "linux" && (/^\/snap\/|^\/usr\/bin\/snap$/.test(real) || execsSnap(real))) {
      snap = true;
      continue;
    }
    if (validate(path)) return path;
  }
  throw new Error(
    `no ${name} found; looked for ${candidates.join(", ")}${snap ? `\nSnap builds of ${name} are not supported: their private /tmp hides the profile. Install a non-Snap build.` : ""}${wsl ? `\nInstall a Linux build of ${name} inside WSL.` : ""}`,
  );
}

// Ubuntu's transitional /usr/bin/firefox and /usr/bin/chromium-browser are shell scripts that exec /snap/bin/<name>.
function execsSnap(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(4096);
    const head = buffer.subarray(0, readSync(fd, buffer)).toString("latin1");
    return head.startsWith("#!") && /\/snap\/bin\//.test(head);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function ownedProfile(stateDir: string, instance: Instance): boolean {
  const root = resolve(stateDir);
  const profile = resolve(instance.profile);
  if (
    dirname(profile) !== root ||
    basename(profile) !== `profile-${instance.id}`
  )
    return false;
  try {
    return (
      !lstatSync(profile).isSymbolicLink() &&
      realpathSync(dirname(profile)) === realpathSync(root)
    );
  } catch {
    return false;
  }
}

function processDetails(
  pid: number,
): { command: string; identity: string } | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return {
        command: readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll(
          "\0",
          " ",
        ),
        identity: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!,
      };
    }
    const result =
      process.platform === "win32"
        ? Bun.spawnSync(
            [
              "powershell.exe",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $env:Q_BROWSER_PID); if ($p) { @($p.CommandLine, $p.CreationDate.ToString("o")) | ConvertTo-Json -Compress }',
            ],
            {
              env: { ...process.env, Q_BROWSER_PID: String(pid) },
              timeout: 2000,
            },
          )
        : Bun.spawnSync(
            ["ps", "-p", String(pid), "-o", "lstart=", "-o", "command="],
            { timeout: 2000 },
          );
    if (result.exitCode !== 0) return null;
    const output = result.stdout.toString().trim();
    if (!output) return null;
    if (process.platform === "win32") {
      const [command, identity] = JSON.parse(output);
      return { command, identity };
    }
    return { identity: output.slice(0, 24), command: output.slice(24).trim() };
  } catch {
    return null;
  }
}

function profileBusy(instance: Instance, terminatedTree = false): boolean {
  if (process.platform !== "win32" && isAlive(-instance.pid)) return true;

  try {
    const lock = readlinkSync(join(instance.profile, "SingletonLock"));
    const pid = Number(lock.slice(lock.lastIndexOf("-") + 1));
    if (isAlive(pid)) return true;
  } catch {}
  let port = instance.port;
  if (!port && instance.browser === "chrome") {
    try {
      port = Number(
        readFileSync(
          join(instance.profile, "DevToolsActivePort"),
          "utf8",
        ).split("\n")[0],
      );
    } catch {}
  }
  if (
    process.platform === "win32" &&
    !terminatedTree &&
    !port &&
    existsSync(
      join(dirname(instance.profile), "instances", `${instance.id}.owner`),
    )
  )
    return true;
  if (port > 0) {
    try {
      const listener = Bun.listen({
        hostname: "127.0.0.1",
        port,
        socket: { data() {} },
      });
      listener.stop(true);
    } catch {
      return true;
    }
  }
  return false;
}

function removeInstance(stateDir: string, instance: Instance): void {
  rmSync(instance.profile, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
  rmSync(join(stateDir, "instances", `${instance.id}.json`), { force: true });
  rmSync(join(stateDir, "instances", `${instance.id}.owner`), { force: true });
}

export function liveInstances(stateDir: string): Instance[] {
  const dir = join(stateDir, "instances");
  if (!existsSync(dir)) return [];
  const live: Instance[] = [];
  for (const file of readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()) {
    const instance = JSON.parse(
      readFileSync(join(dir, file), "utf8"),
    ) as Instance;
    if (file !== `${instance.id}.json` || !ownedProfile(stateDir, instance))
      throw new Error("instance profile ownership could not be verified");
    if (isAlive(instance.pid)) {
      verifyProcessOwnership(stateDir, instance);
      live.push(instance);
    } else if (profileBusy(instance)) live.push(instance);
    else removeInstance(stateDir, instance);
  }
  return live;
}

export function newProfile(stateDir: string): { id: string; profile: string } {
  mkdirSync(join(stateDir, "instances"), { recursive: true });
  const profile = mkdtempSync(join(stateDir, "profile-"));
  return { id: profile.slice(profile.lastIndexOf("-") + 1), profile };
}

export function recordInstance(stateDir: string, instance: Instance): void {
  const dir = join(stateDir, "instances");
  writeFileSync(join(dir, `${instance.id}.json`), JSON.stringify(instance));
  const owner = join(dir, `${instance.id}.owner`);
  if (!existsSync(owner)) {
    const identity = processDetails(instance.pid)?.identity;
    if (identity) writeFileSync(owner, identity);
  }
}

export type ShutdownOptions = {
  close?: () => Promise<unknown>;
  alive?: (pid: number) => boolean;
  details?: (pid: number) => { command: string; identity: string | null } | null;
  busy?: (instance: Instance) => boolean;
  kill?: (pid: number) => void;
  sleep?: (ms: number) => Promise<unknown>;
  timeoutMs?: number;
};

function verifyProcessOwnership(
  stateDir: string,
  instance: Instance,
  options: ShutdownOptions = {},
): void {
  const { command, identity } = (options.details ?? processDetails)(
    instance.pid,
  ) ?? { command: null, identity: null };
  const owner = join(stateDir, "instances", `${instance.id}.owner`);
  const escaped = instance.profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (
    !command ||
    !new RegExp(
      `(?:--user-data-dir=|(?:-profile|--profile) +)["']?${escaped}(?:["']?(?: |$))`,
    ).test(command) ||
    (existsSync(owner) && readFileSync(owner, "utf8") !== identity)
  )
    throw new Error("instance process ownership could not be verified");
}

export async function shutdown(
  stateDir: string,
  instance: Instance,
  options: ShutdownOptions = {},
): Promise<void> {
  const alive = options.alive ?? isAlive;
  let terminatedTree = false;
  const busy =
    options.busy ?? ((owned: Instance) => profileBusy(owned, terminatedTree));
  const sleep = options.sleep ?? Bun.sleep;
  const timeout = options.timeoutMs ?? 10_000;
  const path = join(stateDir, "instances", `${instance.id}.json`);
  if (
    !ownedProfile(stateDir, instance) ||
    !existsSync(path) ||
    JSON.stringify(JSON.parse(readFileSync(path, "utf8"))) !==
      JSON.stringify(instance)
  )
    throw new Error("instance ownership could not be verified");
  const verify = () => verifyProcessOwnership(stateDir, instance, options);
  if (alive(instance.pid)) verify();
  if (!alive(instance.pid) && busy(instance))
    throw new Error(
      `browser ${instance.id} is still running; profile retained`,
    );
  if (options.close && alive(instance.pid)) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        options.close(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("browser close timed out")),
            timeout,
          );
        }),
      ]);
    } catch {
    } finally {
      clearTimeout(timer);
    }
    const grace = Date.now() + Math.min(timeout, 1000);
    while ((alive(instance.pid) || busy(instance)) && Date.now() < grace)
      await sleep(20);
  }
  if (alive(instance.pid)) {
    verify();
    if (options.kill) options.kill(instance.pid);
    else if (process.platform === "win32") {
      const result = Bun.spawnSync(
        ["taskkill.exe", "/PID", String(instance.pid), "/T", "/F"],
        { timeout },
      );
      if (result.exitCode !== 0)
        throw new Error(
          `could not terminate owned browser ${instance.id}; profile retained`,
        );
      terminatedTree = true;
    } else process.kill(instance.pid, "SIGTERM");
  }
  const deadline = Date.now() + timeout;
  while ((alive(instance.pid) || busy(instance)) && Date.now() < deadline)
    await sleep(20);
  if (alive(instance.pid) || busy(instance))
    throw new Error(
      `browser ${instance.id} is still running; profile retained`,
    );
  removeInstance(stateDir, instance);
}

export async function freePort(): Promise<number> {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
}
