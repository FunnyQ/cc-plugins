import { expect, test } from "claude-code/testing";

import { findImage, imageIds } from "./images";

const line = (text: string, images: string[], pasteIds?: number[]) =>
  JSON.stringify({
    type: "user",
    imagePasteIds: pasteIds,
    message: {
      role: "user",
      content: [
        { type: "text", text },
        ...images.map((data) => ({
          type: "image",
          source: { type: "base64", media_type: "image/png", data },
        })),
      ],
    },
  });

test("imageIds lists each [Image #N] once, in order", () => {
  expect(imageIds("[Image #2] and [Image #1] then [Image #2]")).toEqual([2, 1]);
  expect(imageIds("no images")).toEqual([]);
});

test("findImage maps a paste id to its image through imagePasteIds", () => {
  const jsonl = [
    line("[Image #3] [Image #4] look", ["AAA", "BBB"], [3, 4]),
  ].join("\n");
  expect(findImage(jsonl, "[Image #3] [Image #4] look", 4)).toEqual({
    data: "BBB",
    mediaType: "image/png",
  });
});

test("findImage takes the last message with the same text", () => {
  const jsonl = [
    line("[Image #1] x", ["OLD"], [1]),
    line("[Image #1] x", ["NEW"], [1]),
  ].join("\n");
  expect(findImage(jsonl, "[Image #1] x", 1)?.data).toBe("NEW");
});

test("findImage falls back to position without imagePasteIds, and skips bad lines", () => {
  const jsonl = ["not json", line("[Image #2] y", ["A", "B"])].join("\n");
  expect(findImage(jsonl, "[Image #2] y", 2)?.data).toBe("B");
  expect(findImage(jsonl, "other", 1)).toBeUndefined();
});

test("findImage finds nothing for an id the message's imagePasteIds lacks", () => {
  const jsonl = line("[Image #2] [Image #6] [Image #7]", ["SIX", "SEVEN"], [6, 7]);
  expect(findImage(jsonl, "[Image #2] [Image #6] [Image #7]", 2)).toBeUndefined();
  expect(findImage(jsonl, "[Image #2] [Image #6] [Image #7]", 7)?.data).toBe("SEVEN");
});
