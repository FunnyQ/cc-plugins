// W3C WebDriver facts both skills depend on. One copy, because a wrong key here
// fails silently: an element lookup returns an id nothing can read.

export const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

// One table for every protocol, so a key added for one browser exists in all of them.
// Code points, not string escapes: a formatter rewrites the escapes into invisible characters.
const KEYS: Record<string, { webdriver: number; vk: number; text?: string }> = {
  Backspace: { webdriver: 0xe003, vk: 8 },
  Tab: { webdriver: 0xe004, vk: 9 },
  Enter: { webdriver: 0xe007, vk: 13, text: "\r" },
  Escape: { webdriver: 0xe00c, vk: 27 },
  Space: { webdriver: 0xe00d, vk: 32, text: " " },
  PageUp: { webdriver: 0xe00e, vk: 33 },
  PageDown: { webdriver: 0xe00f, vk: 34 },
  End: { webdriver: 0xe010, vk: 35 },
  Home: { webdriver: 0xe011, vk: 36 },
  ArrowLeft: { webdriver: 0xe012, vk: 37 },
  ArrowUp: { webdriver: 0xe013, vk: 38 },
  ArrowRight: { webdriver: 0xe014, vk: 39 },
  ArrowDown: { webdriver: 0xe015, vk: 40 },
  Delete: { webdriver: 0xe017, vk: 46 },
};

function unknownKey(key: string): Error {
  return new Error(
    `unknown key ${key}; known: ${Object.keys(KEYS).join(", ")}`,
  );
}

/** The text WebDriver's element send-keys takes for one key. */
export function keyText(key: string): string {
  if (KEYS[key]) return String.fromCharCode(KEYS[key].webdriver);
  if ([...key].length === 1) return key;
  throw unknownKey(key);
}

export type KeyEvent = {
  key: string;
  code?: string;
  windowsVirtualKeyCode: number;
  text?: string;
};

/** The fields CDP's Input.dispatchKeyEvent needs; a key with text inserts it, one without only moves. */
export function keyEvent(key: string): KeyEvent {
  const known = KEYS[key];
  if (known) {
    return {
      key: key === "Space" ? " " : key,
      code: key,
      windowsVirtualKeyCode: known.vk,
      ...(known.text ? { text: known.text } : {}),
    };
  }
  if ([...key].length === 1)
    return {
      key,
      text: key,
      windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
    };
  throw unknownKey(key);
}

export function parseSize(size: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) throw new Error("--size must look like 1440x900");
  return { width: Number(match[1]), height: Number(match[2]) };
}

export function printable(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Wraps an expression so `ExecuteScript` returns its value. */
export function script(expression: string): string {
  return `return (${expression});`;
}

export function need(args: string[], count: number, usage: string): string[] {
  if (args.length < count) throw new Error(`usage: ${usage}`);
  return args;
}
