// A minimal Chrome DevTools Protocol client: one WebSocket to one page target,
// request ids matched to responses, protocol errors thrown. Events matter only
// for navigation, because Page.navigate returns before the page has loaded.

type Reply = {
  id?: number;
  method?: string;
  result?: any;
  error?: { code: number; message: string };
};

/** Resolves a reply to its result, or throws the protocol error it carries. */
export function settle(method: string, reply: Reply): any {
  if (reply.error)
    throw new Error(`${method}: ${reply.error.message}`);
  return reply.result ?? {};
}

export type Page = {
  send: (method: string, params?: object) => Promise<any>;
  /** Resolves with whichever event fires first. Arm it before the command that causes it. */
  nextEvent: (events: string[], timeoutMs: number) => Promise<string>;
  close: () => void;
};

/** The first page target's WebSocket URL, from the browser's HTTP discovery endpoint. */
async function pageSocket(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = (await response.json()) as {
    type: string;
    webSocketDebuggerUrl: string;
  }[];
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error(`no page target on port ${port}`);
  return page.webSocketDebuggerUrl;
}

export async function connectPage(port: number): Promise<Page> {
  const socket = new WebSocket(await pageSocket(port));
  const waiting = new Map<
    number,
    { method: string; resolve: (v: any) => void; reject: (e: unknown) => void }
  >();
  const listeners = new Set<(method: string) => void>();
  let nextId = 0;

  socket.onmessage = (event) => {
    const reply = JSON.parse(String(event.data)) as Reply;
    if (reply.method) {
      for (const listener of listeners) listener(reply.method);
      return;
    }
    const pending = waiting.get(reply.id!);
    if (!pending) return;
    waiting.delete(reply.id!);
    try {
      pending.resolve(settle(pending.method, reply));
    } catch (error) {
      pending.reject(error);
    }
  };
  socket.onclose = () => {
    for (const { reject } of waiting.values())
      reject(new Error("CDP connection closed"));
    waiting.clear();
  };
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () =>
      reject(new Error(`could not connect to Chrome on port ${port}`));
  });

  return {
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        waiting.set(id, { method, resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    nextEvent(events, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(
            new Error(
              `none of ${events.join(", ")} fired within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
        const listener = (method: string) => {
          if (!events.includes(method)) return;
          clearTimeout(timer);
          listeners.delete(listener);
          resolve(method);
        };
        listeners.add(listener);
      });
    },
    close() {
      socket.close();
    },
  };
}
