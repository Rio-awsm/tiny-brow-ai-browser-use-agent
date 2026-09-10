import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "tiny-brow",
    description:
      "A bring-your-own-key browser agent that drives the current tab from a side panel.",
    // sidePanel is added by WXT because a sidepanel entrypoint exists.
    // tabs and scripting are added in dev for hot reload.
    permissions: ["storage", "tabs", "activeTab"],
    action: {
      default_title: "Open tiny-brow",
    },
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
