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
    // Requested one origin at a time when the user saves an endpoint, rather
    // than granted broadly at install. A BYOK tool cannot know its endpoints in
    // advance, and this is far easier to justify in review.
    optional_host_permissions: ["http://*/*", "https://*/*"],
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
