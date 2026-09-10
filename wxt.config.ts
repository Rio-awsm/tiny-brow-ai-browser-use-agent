import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Tiny",
    description:
      "A bring-your-own-key browser agent that drives the current tab from a side panel.",
    // sidePanel is added by WXT because a sidepanel entrypoint exists.
    // tabs and scripting are added in dev for hot reload.
    permissions: ["storage", "tabs", "activeTab", "debugger"],
    icons: {
      16: "icon/16.png",
      32: "icon/32.png",
      48: "icon/48.png",
      128: "icon/128.png",
    },
    action: {
      default_title: "Open Tiny",
      default_icon: {
        16: "icon/16.png",
        32: "icon/32.png",
        48: "icon/48.png",
        128: "icon/128.png",
      },
    },
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
