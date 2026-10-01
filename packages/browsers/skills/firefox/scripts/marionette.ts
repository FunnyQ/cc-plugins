// Marionette is Gecko's own remote protocol: length-prefixed JSON over TCP. CDP is
// gone from Firefox since 129, so this is the one door into stock Firefox and its
// forks (Zen) that needs no driver binary in between.

export type Response = [
  1,
  number,
  { error: string; message: string } | null,
  unknown,
];

export function encodeFrame(message: unknown): string {
  const body = JSON.stringify(message);
  return `${Buffer.byteLength(body)}:${body}`;
}

/**
 * The length prefix counts bytes, so the buffer must stay bytes until a whole
 * frame is in: decoding chunk by chunk would split a multibyte character and
 * shift every cut after it. Chunks are joined once per frame, not once per chunk,
 * because a full-page screenshot arrives as megabytes of base64 in small pieces.
 */
export class FrameReader {
  private chunks: Buffer[] = [];
  private size = 0;
  private end: number | null = null;

  push(chunk: Uint8Array): unknown[] {
    this.chunks.push(Buffer.from(chunk));
    this.size += chunk.length;
    const frames: unknown[] = [];
    for (;;) {
      if (this.end === null) {
        const head = this.flatten();
        const colon = head.indexOf(0x3a);
        if (colon < 0) return frames;
        this.end = colon + 1 + Number(head.subarray(0, colon).toString());
      }
      if (this.size < this.end) return frames;
      const all = this.flatten();
      frames.push(
        JSON.parse(all.subarray(all.indexOf(0x3a) + 1, this.end).toString()),
      );
      const rest = all.subarray(this.end);
      this.chunks = rest.length ? [rest] : [];
      this.size = rest.length;
      this.end = null;
    }
  }

  private flatten(): Buffer {
    const joined =
      this.chunks.length === 1
        ? this.chunks[0]!
        : Buffer.concat(this.chunks, this.size);
    this.chunks = joined.length ? [joined] : [];
    return joined;
  }
}

export function settle(response: Response): unknown {
  const [, , error, result] = response;
  if (error) throw new Error(`${error.error}: ${error.message}`);
  return result;
}

export type Client = {
  send: (command: string, params?: object) => Promise<any>;
  close: () => void;
};

/** Connects and waits for the greeting the server sends before it accepts commands. */
export async function connect(
  port: number,
  timeoutMs = 10_000,
): Promise<Client> {
  const reader = new FrameReader();
  const waiting = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  let greeted!: () => void;
  const greeting = new Promise<void>((resolve) => (greeted = resolve));
  let nextId = 0;

  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_socket, chunk) {
        for (const frame of reader.push(chunk)) {
          if (!Array.isArray(frame)) {
            greeted();
            continue;
          }
          const pending = waiting.get(frame[1]);
          if (!pending) continue;
          waiting.delete(frame[1]);
          try {
            pending.resolve(settle(frame as Response));
          } catch (error) {
            pending.reject(error);
          }
        }
      },
      close() {
        for (const { reject } of waiting.values())
          reject(new Error("Marionette connection closed"));
        waiting.clear();
      },
    },
  });

  // The server serves one connection at a time and leaves a second one silent.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    greeting.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              "Marionette sent no greeting — another command may be holding this instance",
            ),
          ),
        timeoutMs,
      );
    }),
  ]);

  return {
    send(command, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        socket.write(encodeFrame([0, id, command, params]));
      });
    },
    close() {
      socket.end();
    },
  };
}
