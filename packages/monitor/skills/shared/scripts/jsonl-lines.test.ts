import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonlLines } from "./jsonl-lines";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jsonl-lines-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, body: string | Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

function collect(path: string, opts?: Parameters<typeof readJsonlLines>[1]) {
  return [...readJsonlLines(path, opts)];
}

describe("readJsonlLines", () => {
  test("讀出每一行，不含換行字元", () => {
    const path = write("basic.jsonl", "a\nbb\nccc\n");
    expect(collect(path)).toEqual(["a", "bb", "ccc"]);
  });

  test("多位元組字元橫跨 chunk 邊界仍完整", () => {
    // 「中」是 3 bytes，4-byte chunk 保證切開它。
    const path = write("utf8.jsonl", "中文\n中\n文中文\n");
    expect(collect(path, { chunkSize: 4 })).toEqual(["中文", "中", "文中文"]);
  });

  test("單行長度超過一個 chunk", () => {
    const long = "x".repeat(5000);
    const path = write("long.jsonl", `${long}\nshort\n`);
    expect(collect(path, { chunkSize: 64 })).toEqual([long, "short"]);
  });

  test("\\r\\n 不被拆成兩行", () => {
    const path = write("crlf.jsonl", "a\r\nb\r\n");
    expect(collect(path)).toEqual(["a", "b"]);
  });

  test("保留空行，交給呼叫端過濾", () => {
    const path = write("blank.jsonl", "a\n\nb\n");
    expect(collect(path)).toEqual(["a", "", "b"]);
  });

  test("預設吐出結尾未換行的殘段", () => {
    const path = write("partial.jsonl", "a\nb");
    expect(collect(path)).toEqual(["a", "b"]);
  });

  test("emitPartial:false 時保留殘段給下一輪", () => {
    const path = write("partial2.jsonl", "a\nb");
    expect(collect(path, { emitPartial: false })).toEqual(["a"]);
  });

  test("空檔不吐任何東西", () => {
    const path = write("empty.jsonl", "");
    expect(collect(path)).toEqual([]);
    expect(collect(path, { emitPartial: false })).toEqual([]);
  });

  test("檔案不存在時安靜地不吐東西", () => {
    expect(collect(join(dir, "nope.jsonl"))).toEqual([]);
  });

  test("start offset 從指定 byte 開始讀", () => {
    const path = write("offset.jsonl", "aaa\nbbb\nccc\n");
    expect(collect(path, { start: 4 })).toEqual(["bbb", "ccc"]);
  });
});

describe("cursor.bytesConsumed", () => {
  // rollup-update 拿它當 bytes_parsed，語意必須等同舊的 lastIndexOf(0x0a) 邊界。
  test("等同最後一個換行後的位置", () => {
    const body = "aaa\nbbb\nccc\n";
    const path = write("consumed.jsonl", body);
    const cursor = { bytesConsumed: 0 };
    [...readJsonlLines(path, { emitPartial: false, cursor })];
    expect(cursor.bytesConsumed).toBe(body.length);
  });

  test("殘段不計入 bytesConsumed", () => {
    const path = write("consumed2.jsonl", "aaa\nbbb\npartial");
    const cursor = { bytesConsumed: 0 };
    [...readJsonlLines(path, { emitPartial: false, cursor })];
    expect(cursor.bytesConsumed).toBe("aaa\nbbb\n".length);
  });

  test("完全沒有完整行時停在 start", () => {
    const path = write("consumed3.jsonl", "aaaa\nno-newline-yet");
    const cursor = { bytesConsumed: 0 };
    [...readJsonlLines(path, { start: 5, emitPartial: false, cursor })];
    expect(cursor.bytesConsumed).toBe(5);
  });

  test("start offset 之後的邊界是絕對位置", () => {
    const path = write("consumed4.jsonl", "aaa\nbbb\nccc\n");
    const cursor = { bytesConsumed: 0 };
    [...readJsonlLines(path, { start: 4, emitPartial: false, cursor })];
    expect(cursor.bytesConsumed).toBe(12);
  });

  test("多位元組跨塊時 bytesConsumed 以 byte 計，不是字元數", () => {
    const body = "中文\n中\n";
    const path = write("consumed5.jsonl", body);
    const cursor = { bytesConsumed: 0 };
    [...readJsonlLines(path, { chunkSize: 4, emitPartial: false, cursor })];
    expect(cursor.bytesConsumed).toBe(Buffer.byteLength(body));
  });
});

describe("超過 JSC 字串上限的檔案", () => {
  // 唯一能證明修好了的測試：舊寫法在這個 fixture 上直接帶走 process，所以
  // 「跑完了」本身就是斷言的一部分。fixture 是 tmpdir 裡的 APFS 稀疏檔。
  const bigDir = mkdtempSync(join(tmpdir(), "jsonl-lines-big-"));
  const bigPath = join(bigDir, "huge.jsonl");

  afterAll(() => {
    rmSync(bigDir, { recursive: true, force: true });
  });

  test("2.4 GB 檔案的頭尾兩筆都讀得到", () => {
    const first = JSON.stringify({ marker: "first" });
    const last = JSON.stringify({ marker: "last" });
    const holeEnd = 2_400_000_000; // 跨過 2^31 的 JSC 字串上限量級

    const fd = openSync(bigPath, "w");
    try {
      writeSync(fd, `${first}\n`);
      // 每 ~600 KB 一個換行：一條 2.4 GB 的長行會讓串流撞上同一個上限。
      const nl = Buffer.from("\n");
      for (let at = 600_000; at < holeEnd; at += 600_000) {
        writeSync(fd, nl, 0, 1, at);
      }
      ftruncateSync(fd, holeEnd);
      // 前導換行，讓最後一筆是完整的一行而不是接在 \0 洞後面。
      writeSync(fd, Buffer.from(`\n${last}\n`), 0, last.length + 2, holeEnd);
    } finally {
      closeSync(fd);
    }

    let firstSeen: string | null = null;
    let lastSeen: string | null = null;
    let lineCount = 0;
    for (const line of readJsonlLines(bigPath)) {
      lineCount += 1;
      let entry: { marker?: string };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.marker === "first") firstSeen = entry.marker;
      if (entry.marker === "last") lastSeen = entry.marker;
    }

    expect(firstSeen).toBe("first");
    expect(lastSeen).toBe("last");
    expect(lineCount).toBeGreaterThan(4000);
  }, 600_000);
});
