// the pasted images of a prompt row, found again in the session transcript

type Block = {
  type: string;
  text?: string;
  source?: { media_type?: string; data?: string };
};
type Entry = {
  type?: string;
  imagePasteIds?: number[];
  message?: { content?: Block[] | string };
};

export const imageIds = (text: string) => [
  ...new Set([...text.matchAll(/\[Image #(\d+)\]/g)].map((m) => Number(m[1]))),
];

export const findImage = (jsonl: string, text: string, id: number) => {
  for (const raw of jsonl.split("\n").reverse()) {
    if (!raw.includes('"image"')) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    const content = entry.message?.content;
    if (entry.type !== "user" || !Array.isArray(content)) continue;
    const said = content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (!said.includes(text.trim())) continue;
    const images = content.filter((b) => b.type === "image" && b.source?.data);
    // a typed [Image #N] with no paste behind it is not in imagePasteIds, so position is only a guess without them
    const at = entry.imagePasteIds ? entry.imagePasteIds.indexOf(id) : id - 1;
    const image = images[at];
    if (!image) return undefined;
    return {
      data: image.source!.data!,
      mediaType: image.source!.media_type ?? "image/png",
    };
  }
  return undefined;
};
