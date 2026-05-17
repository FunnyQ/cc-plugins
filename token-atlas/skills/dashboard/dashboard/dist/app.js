import { createApp } from "/vendor/petite-vue.es.js";
import { App } from "./modules/dashboard-app.js";
import { installBloomTracker } from "./modules/bloom-tracker.js";

window.App = App;
createApp({ App }).mount("#app");
installBloomTracker();
