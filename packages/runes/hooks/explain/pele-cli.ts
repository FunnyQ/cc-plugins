// bun pele-cli.ts <page.html> rewrites each diagram fallback into pele's svg in place; runs as a child, since a mod has no Bun global
import { upgradeDiagrams } from "./pele";
import { render } from "./vendor/pele.js";

const page = process.argv[2]!;
const html = await Bun.file(page).text();
const upgraded = upgradeDiagrams(
  html,
  (source, idPrefix) => render(source, { idPrefix }).svg,
);
if (upgraded !== html) await Bun.write(page, upgraded);
