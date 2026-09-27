import { defineConfig } from "wxt"

const icons = {
  16: "icon/16.png",
  32: "icon/32.png",
  48: "icon/48.png",
  64: "icon/64.png",
  128: "icon/128.png"
}

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  imports: false,
  manifestVersion: 3,
  targetBrowsers: ["chrome"],
  webExt: { disabled: true },
  outDir: "build",
  hooks: {
    "config:resolved"(wxt) {
      // Keep the unpacked extension's production path stable during migration.
      if (wxt.config.mode === "production") {
        wxt.config.outDir += "-prod"
      }
    }
  },
  manifest: {
    name: "__MSG_appName__",
    description: "__MSG_appDescription__",
    default_locale: "en",
    icons,
    action: { default_icon: icons, default_title: "__MSG_appName__" },
    permissions: [
      "activeTab",
      "proxy",
      "storage",
      "webRequest",
      "webRequestAuthProvider"
    ],
    host_permissions: ["<all_urls>"]
  }
})
