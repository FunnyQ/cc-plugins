import { DIAGRAM_FALLBACK, unescapeHtml } from "./blocks";
import { cleanMain } from "./html";

export type Render = (source: string, idPrefix: string) => string;

const NODE_SHAPE =
  /(<g class="pele-node[^"]*"[^>]*>)(<(?:rect|polygon|circle|ellipse|path)\b[^>]*\/>)/g;

// the template paints the copy as a watercolour wash and the original as a pen outline; a cleaned click link is an empty <a>
const handDrawn = (svg: string): string =>
  svg
    .replace(/<a\b[^>]*>|<\/a\s*>/g, "")
    .replace(
      NODE_SHAPE,
      (_, node: string, shape: string) =>
        `${node}${shape.replace(/^<(\w+)/, '<$1 class="wash"')}${shape}`,
    );

export function upgradeDiagrams(html: string, render: Render): string {
  let n = 0;
  return html.replace(DIAGRAM_FALLBACK, (fallback, source: string) => {
    try {
      return handDrawn(cleanMain(render(unescapeHtml(source), `pele-${++n}-`)));
    } catch {
      return fallback;
    }
  });
}
