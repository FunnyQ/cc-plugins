import { createApp } from "/vendor/petite-vue.es.js";
import { App } from "./modules/dashboard-app.js";
import { installBloomTracker } from "./modules/bloom-tracker.js";
import { installHeroMotionSettler } from "./modules/hero-motion-settler.js";

async function loadDashboardMarkup() {
  const root = document.getElementById("dashboard-root");
  if (!root) throw new Error("Missing #dashboard-root");
  root.innerHTML = await loadPartial("/partials/dashboard.html");
  await expandPartials(root);
}

async function loadPartial(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to load partial ${path}: HTTP ${response.status}`);
  }
  return response.text();
}

async function expandPartials(container) {
  const placeholders = [...container.querySelectorAll("[data-partial]")];
  for (const placeholder of placeholders) {
    const partialPath = placeholder.dataset.partial;
    const template = document.createElement("template");
    template.innerHTML = await loadPartial(partialPath);
    await expandPartials(template.content);
    placeholder.replaceWith(template.content);
  }
}

window.App = App;
await loadDashboardMarkup();
createApp({ App }).mount("#app");
installBloomTracker();
installHeroMotionSettler();
