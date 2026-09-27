import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { test } from "node:test"
import { setImmediate } from "node:timers/promises"
import { runInNewContext } from "node:vm"

const buildDir = resolve("build/chrome-mv3-prod")
const manifest = JSON.parse(readFileSync(resolve(buildDir, "manifest.json"), "utf8"))
const background = readFileSync(resolve(buildDir, manifest.background.service_worker), "utf8")

const profile = {
  id: "existing-profile",
  name: "Existing profile",
  createdAt: 1,
  updatedAt: 1,
  proxyHost: "proxy.example.com",
  proxyPort: 8080,
  username: "test-user",
  password: "test-password",
  proxyDomains: [".chatgpt.com"],
  directDomains: [".company.local"],
  disableProxyDomainRouting: false
}

const plain = (value) => JSON.parse(JSON.stringify(value))

const startWorker = async (initialStorage = {
  proxyProfiles: [profile],
  activeProfileId: profile.id,
  proxyEnabled: true
}) => {
  const stored = structuredClone(initialStorage)
  const events = {}
  const configurations = []
  const badges = []
  let clearCount = 0
  const event = (name) => ({
    addListener(listener, ...options) {
      events[name] = { listener, options: plain(options) }
    }
  })

  const chrome = {
    runtime: {
      id: "test-extension",
      onInstalled: event("installed"),
      onStartup: event("startup"),
      onMessage: event("message")
    },
    action: {
      setBadgeText: async ({ text }) => { badges.push(text) },
      setBadgeBackgroundColor: async () => {},
      setBadgeTextColor: async () => {}
    },
    storage: { local: {
      get: (_keys, callback) => callback(structuredClone(stored)),
      set: (items, callback) => { Object.assign(stored, plain(items)); callback() },
      remove: (key, callback) => { delete stored[key]; callback() }
    } },
    proxy: { settings: {
      set: (configuration, callback) => { configurations.push(plain(configuration)); callback() },
      clear: (_options, callback) => { clearCount++; callback() }
    } },
    webRequest: {
      onAuthRequired: event("auth"),
      onCompleted: event("completed"),
      onErrorOccurred: event("error")
    }
  }

  runInNewContext(background, { chrome, console })
  // Chrome must see the listeners immediately when the service worker starts.
  assert.deepEqual(Object.keys(events).sort(), [
    "auth", "completed", "error", "installed", "message", "startup"
  ])
  await setImmediate()

  const sync = () => new Promise((resolveResponse) => {
    const keepChannelOpen = events.message.listener(
      { type: "SYNC_PROXY_STATE" }, {}, (response) => resolveResponse(plain(response))
    )
    assert.equal(keepChannelOpen, true)
  })

  return { stored, events, configurations, badges, sync, get clearCount() { return clearCount } }
}

const route = (configuration, host) => {
  const context = {
    dnsDomainIs: (value, suffix) => value.endsWith(suffix),
    shExpMatch: (value, pattern) => new RegExp(
      "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*") + "$"
    ).test(value)
  }
  runInNewContext(configuration.value.pacScript.data, context)
  return context.FindProxyForURL(`https://${host}/`, host)
}

test("production manifest preserves Chrome MV3 capabilities and contains all entrypoints", () => {
  assert.equal(manifest.manifest_version, 3)
  assert.equal(manifest.name, "__MSG_appName__")
  assert.equal(manifest.default_locale, "en")
  assert.equal(manifest.description, "__MSG_appDescription__")
  assert.equal(manifest.action.default_title, "__MSG_appName__")
  for (const [locale, name] of [["en", "Proxy Manager"], ["ru", "Прокси Менеджер"]]) {
    const messages = JSON.parse(readFileSync(resolve(buildDir, `_locales/${locale}/messages.json`), "utf8"))
    assert.equal(messages.appName.message, name)
    assert.ok(messages.appDescription.message)
  }
  assert.deepEqual(manifest.permissions.slice().sort(), [
    "activeTab", "proxy", "storage", "webRequest", "webRequestAuthProvider"
  ])
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"])
  assert.equal(manifest.content_scripts, undefined)
  assert.equal(manifest.action.default_popup, "popup.html")
  for (const path of [manifest.action.default_popup, manifest.background.service_worker, ...Object.values(manifest.icons)]) {
    assert.ok(existsSync(resolve(buildDir, path)), `Missing build asset: ${path}`)
  }
  const html = readFileSync(resolve(buildDir, manifest.action.default_popup), "utf8")
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
  assert.ok(scripts.length > 0)
  for (const [, path] of scripts) {
    assert.doesNotMatch(path, /^https?:/)
    assert.ok(existsSync(resolve(buildDir, path.replace(/^\//, ""))))
  }
})

test("built worker restores existing profiles and applies list/global routing and disable", async () => {
  const worker = await startWorker()
  assert.deepEqual(worker.stored.proxyProfiles, [profile])
  assert.equal(worker.stored.activeProfileId, profile.id)
  assert.equal(worker.badges.at(-1), "ON")
  const configuration = worker.configurations.at(-1)
  assert.equal(configuration.scope, "regular")
  assert.equal(configuration.value.mode, "pac_script")
  assert.equal(route(configuration, "chatgpt.com"), "PROXY proxy.example.com:8080")
  assert.equal(route(configuration, "app.chatgpt.com"), "PROXY proxy.example.com:8080")
  assert.equal(route(configuration, "other.example"), "DIRECT")

  worker.stored.proxyProfiles[0].disableProxyDomainRouting = true
  assert.deepEqual(await worker.sync(), { ok: true })
  const globalConfiguration = worker.configurations.at(-1)
  assert.equal(route(globalConfiguration, "other.example"), "PROXY proxy.example.com:8080")
  for (const host of ["localhost", "127.0.0.1", "10.0.0.5", "192.168.1.2", "172.31.0.1", "app.company.local"]) {
    assert.equal(route(globalConfiguration, host), "DIRECT")
  }

  worker.stored.proxyEnabled = false
  assert.deepEqual(await worker.sync(), { ok: true })
  assert.equal(worker.clearCount, 1)
  assert.equal(worker.badges.at(-1), "OFF")
  assert.equal(worker.stored.proxyProfiles.length, 1)
})

test("built worker registers async proxy authentication and retains retry cleanup", async () => {
  const worker = await startWorker()
  const auth = worker.events.auth
  assert.deepEqual(auth.options, [{ urls: ["<all_urls>"] }, ["asyncBlocking"]])
  const details = {
    requestId: "request-1",
    isProxy: true,
    challenger: { host: profile.proxyHost, port: profile.proxyPort }
  }
  const authenticate = (challenge = details) => new Promise((resolveResponse) => {
    auth.listener(challenge, (response) => resolveResponse(plain(response)))
  })
  const expected = { authCredentials: { username: profile.username, password: profile.password } }
  assert.deepEqual(await authenticate({ ...details, isProxy: false }), {})
  assert.deepEqual(await authenticate({ ...details, challenger: { host: "other.example", port: 8080 } }), {})
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.deepEqual(await authenticate(), expected)
  }
  assert.deepEqual(await authenticate(), { cancel: true })
  worker.events.completed.listener({ requestId: details.requestId })
  assert.deepEqual(await authenticate(), expected)
  worker.events.error.listener({ requestId: details.requestId })
  assert.deepEqual(await authenticate(), expected)
})

test("built worker still migrates legacy settings when updating an older installation", async () => {
  const worker = await startWorker({ proxySettings: profile, proxyEnabled: true })
  assert.equal(worker.stored.proxySettings, undefined)
  assert.equal(worker.stored.proxyProfiles.length, 1)
  assert.equal(worker.stored.proxyProfiles[0].proxyHost, profile.proxyHost)
  assert.equal(worker.stored.activeProfileId, worker.stored.proxyProfiles[0].id)
  assert.equal(worker.badges.at(-1), "ON")
})
