import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { act, create } from "react-test-renderer"
import type { ReactTestInstance, ReactTestRenderer } from "react-test-renderer"

import IndexPopup from "../popup"
import { DEFAULT_SETTINGS } from "../src/defaultSettings"
import type { BackgroundResponse, PopupFormState, ProxyProfile } from "../src/types"

const makeProfile = (id: string): ProxyProfile => ({
  ...DEFAULT_SETTINGS,
  id,
  name: `Profile ${id}`,
  proxyHost: `proxy${id}.example.com`,
  proxyPort: 8080,
  username: `user${id}`,
  password: `password${id}`,
  createdAt: 1,
  updatedAt: 1
})

const draft: PopupFormState = {
  profileName: "Unfinished profile",
  proxyHost: "draft.example.com",
  proxyPort: "8080",
  username: "draft-user",
  password: "draft-password",
  proxyDomainsText: ".example.com",
  directDomainsText: "localhost",
  disableProxyDomainRouting: false
}

let renderer: ReactTestRenderer

const mount = async (options: {
  profiles?: ProxyProfile[]
  draft?: PopupFormState
  enabled?: boolean
  failSync?: boolean
} = {}) => {
  const profiles = options.profiles ?? [makeProfile("1"), makeProfile("2")]
  const stored: Record<string, unknown> = {
    proxyProfiles: profiles,
    activeProfileId: profiles[0]?.id ?? null,
    proxyEnabled: options.enabled ?? true,
    ...(options.draft ? { profileDraft: { formState: options.draft, updatedAt: 1 } } : {})
  }
  const syncStates: Record<string, unknown>[] = []
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: {
        sendMessage: (_message: unknown, callback: (response: BackgroundResponse) => void) => {
          syncStates.push(structuredClone(stored))
          callback(options.failSync && syncStates.length === 1
            ? { ok: false, error: "Could not apply proxy" }
            : { ok: true })
        }
      },
      storage: {
        local: {
          get: (keys: unknown, callback: (result: Record<string, unknown>) => void) => {
            callback(structuredClone({
              ...(keys && typeof keys === "object" ? keys : {}),
              ...stored
            }))
          },
          set: (items: Record<string, unknown>, callback: () => void) => {
            Object.assign(stored, structuredClone(items))
            callback()
          },
          remove: (key: string, callback: () => void) => {
            delete stored[key]
            callback()
          }
        }
      }
    }
  })
  await act(async () => {
    renderer = create(<IndexPopup />)
  })
  return { stored, syncStates }
}

const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("")

const button = (label: string) => renderer.root.findAllByType("button").find(
  (node) => textOf(node).includes(label)
)

const click = async (label: string) => {
  const target = button(label)
  assert.ok(target, `Button '${label}' should be visible`)
  assert.equal(target.props.disabled, false)
  await act(async () => { await target.props.onClick() })
}

const field = (label: string) => renderer.root.findAllByType("label")
  .find((node) => textOf(node).startsWith(label))!
  .findByType("input")

afterEach(async () => {
  if (renderer) {
    await act(async () => renderer.unmount())
  }
})

test("draft stays available in both lists and retains edits when switching profiles", async () => {
  const { stored } = await mount()
  await click("Add profile")
  await act(async () => {
    field("Proxy host").props.onChange({ target: { value: "unfinished.example.com" } })
  })
  await click("Profile 1")
  assert.ok(button("Profile 3"))
  await click("Profile 2")
  await click("← Profiles")
  assert.ok(button("Profile 1"))
  assert.ok(button("Profile 2"))
  await click("Profile 3")
  assert.equal(field("Proxy host").props.value, "unfinished.example.com")
  await click("Add")
  assert.equal(field("Proxy host").props.value, "unfinished.example.com")
  assert.ok(stored.profileDraft)
})

test("restored draft survives navigation, saving another profile and importing a profile", async () => {
  const { stored } = await mount({ draft })
  await click("Profile 1")
  await click("Save")
  const fileInput = renderer.root.findAllByType("input").find((node) => node.props.type === "file")!
  await act(async () => {
    await fileInput.props.onChange({
      target: { files: [{ text: async () => JSON.stringify(makeProfile("imported")) }], value: "" }
    })
  })
  assert.ok(button("Unfinished profile"))
  assert.ok(stored.profileDraft)
  await click("Unfinished profile")
  assert.equal(field("Username").props.value, draft.username)
  assert.equal(field("Proxy host").props.value, draft.proxyHost)
})

test("draft-only list remains accessible and explicit discard removes it", async () => {
  const { stored } = await mount({ profiles: [], draft, enabled: false })
  await click("← Profiles")
  await click("Unfinished profile")
  await click("Discard")
  assert.equal(stored.profileDraft, undefined)
  assert.equal(button("Unfinished profile"), undefined)
})

test("enabling a second saved profile switches directly without disabling proxy", async () => {
  const { stored, syncStates } = await mount()
  await click("Profile 2")
  assert.equal(button("Disable Proxy"), undefined)
  await click("Enable Proxy")
  assert.equal(stored.activeProfileId, "2")
  assert.equal(stored.proxyEnabled, true)
  assert.equal(syncStates.length, 1)
  assert.equal(syncStates[0].proxyEnabled, true)
  assert.equal(syncStates[0].activeProfileId, "2")
  assert.ok(button("Disable Proxy"))
  await click("Profile 1")
  assert.ok(button("Enable Proxy"))
  await click("Profile 2")
  await click("Disable Proxy")
  assert.equal(stored.proxyEnabled, false)
  assert.equal((stored.proxyProfiles as ProxyProfile[]).length, 2)
})

test("enabling a draft saves and activates it while keeping the existing profiles", async () => {
  const { stored } = await mount({ draft })
  await click("Enable Proxy")
  const saved = stored.proxyProfiles as ProxyProfile[]
  assert.equal(saved.length, 3)
  assert.equal(saved[2].proxyHost, draft.proxyHost)
  assert.equal(stored.activeProfileId, saved[2].id)
  assert.equal(stored.proxyEnabled, true)
  assert.equal(stored.profileDraft, undefined)
  assert.equal(textOf(renderer.root).includes("Draft"), false)
  assert.ok(button("Disable Proxy"))
})

test("invalid draft does not disable or replace the running profile", async () => {
  const { stored, syncStates } = await mount({ draft: { ...draft, proxyHost: "" } })
  await click("Enable Proxy")
  assert.equal(stored.activeProfileId, "1")
  assert.equal(stored.proxyEnabled, true)
  assert.equal(syncStates.length, 0)
  assert.ok(textOf(renderer.root).includes("Proxy host is required."))
  assert.ok(button("Unfinished profile"))
})

test("failed profile switch restores the previous active connection", async () => {
  const { stored, syncStates } = await mount({ failSync: true })
  await click("Profile 2")
  await click("Enable Proxy")
  assert.equal(stored.activeProfileId, "1")
  assert.equal(stored.proxyEnabled, true)
  assert.equal(syncStates.length, 2)
  assert.equal(syncStates[1].activeProfileId, "1")
  assert.ok(button("Enable Proxy"))
  assert.ok(textOf(renderer.root).includes("Could not apply proxy"))
})

test("selected profile can be enabled when proxy is initially off", async () => {
  const { stored } = await mount({ enabled: false })
  await click("Profile 2")
  await click("Enable Proxy")
  assert.equal(stored.activeProfileId, "2")
  assert.equal(stored.proxyEnabled, true)
  assert.ok(button("Disable Proxy"))
})
