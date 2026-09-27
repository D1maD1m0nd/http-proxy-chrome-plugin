import "./setup"

import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { act } from "react"
import { cleanup, fireEvent, render } from "@testing-library/react"

import IndexPopup from "../src/Popup"
import { DEFAULT_SETTINGS } from "../src/defaultSettings"
import { initializeLanguage } from "../src/i18n"
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

const originalFetch = globalThis.fetch

const mount = async (options: {
  profiles?: ProxyProfile[]
  draft?: PopupFormState
  enabled?: boolean
  failSync?: boolean
  failDelete?: boolean
  browserLanguage?: string
  stored?: Record<string, unknown>
} = {}) => {
  const profiles = options.profiles ?? [makeProfile("1"), makeProfile("2")]
  const stored: Record<string, unknown> = {
    proxyProfiles: profiles,
    activeProfileId: profiles[0]?.id ?? null,
    proxyEnabled: options.enabled ?? true,
    ...(options.draft ? { profileDraft: { formState: options.draft, updatedAt: 1 } } : {}),
    ...options.stored
  }
  const syncStates: Record<string, unknown>[] = []
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      i18n: { getUILanguage: () => options.browserLanguage ?? "en-US" },
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
            if (options.failDelete && Array.isArray(items.proxyProfiles)
              && items.proxyProfiles.length < (stored.proxyProfiles as ProxyProfile[]).length) {
              Object.defineProperty(chrome.runtime, "lastError", {
                configurable: true,
                value: { message: "Storage write failed" }
              })
              callback()
              Reflect.deleteProperty(chrome.runtime, "lastError")
              return
            }
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
    await initializeLanguage()
    render(<IndexPopup />)
  })
  return { stored, syncStates }
}

const textOf = (node: Node | string): string =>
  typeof node === "string" ? node : node.textContent ?? ""

const button = (label: string) => [...document.querySelectorAll("button")].find(
  (node) => textOf(node).includes(label)
)

const click = async (label: string) => {
  const target = button(label)
  assert.ok(target, `Button '${label}' should be visible`)
  assert.equal(target.disabled, false)
  await act(async () => { fireEvent.click(target) })
}

const field = (label: string) => [...document.querySelectorAll("label")]
  .find((node) => textOf(node).startsWith(label))!
  .querySelector("input")!

const changeField = async (label: string, value: string) => {
  await act(async () => { fireEvent.change(field(label), { target: { value } }) })
}

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

test("ping checks each saved server and displays response time or failure", async () => {
  const requestedUrls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrls.push(String(input))
    assert.equal(init?.mode, "no-cors")
    assert.equal(init?.credentials, "omit")

    if (String(input).includes("proxy2")) {
      throw new Error("Connection failed")
    }

    return {} as Response
  }) as typeof fetch

  const { stored, syncStates } = await mount()
  await click("Ping servers")

  assert.deepEqual(requestedUrls, [
    "http://proxy1.example.com:8080/",
    "http://proxy2.example.com:8080/"
  ])
  assert.match(textOf(button("Profile 1")!), /\d+ ms/u)
  assert.match(textOf(button("Profile 2")!), /Unavailable/u)
  assert.equal(stored.activeProfileId, "1")
  assert.equal(syncStates.length, 0)

  await click("Profile 1")
  assert.match(textOf(button("Profile 1")!), /\d+ ms/u)
})

test("draft stays available in both lists and retains edits when switching profiles", async () => {
  const { stored } = await mount()
  await click("Add profile")
  await changeField("Proxy host", "unfinished.example.com")
  await click("Profile 1")
  assert.ok(button("Profile 3"))
  await click("Profile 2")
  await click("← Profiles")
  assert.ok(button("Profile 1"))
  assert.ok(button("Profile 2"))
  await click("Profile 3")
  assert.equal(field("Proxy host").value, "unfinished.example.com")
  await click("Add")
  assert.equal(field("Proxy host").value, "unfinished.example.com")
  assert.ok(stored.profileDraft)
})

test("restored draft survives navigation, saving another profile and importing a profile", async () => {
  const { stored } = await mount({ draft })
  await click("Profile 1")
  await click("Save")
  const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!
  await act(async () => {
    fireEvent.change(fileInput, {
      target: { files: [{ text: async () => JSON.stringify(makeProfile("imported")) }], value: "" }
    })
  })
  assert.ok(button("Unfinished profile"))
  assert.ok(stored.profileDraft)
  await click("Unfinished profile")
  assert.equal(field("Username").value, draft.username)
  assert.equal(field("Proxy host").value, draft.proxyHost)
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
  assert.ok(syncStates[0])
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
  assert.ok(saved[2])
  assert.equal(saved[2].proxyHost, draft.proxyHost)
  assert.equal(stored.activeProfileId, saved[2].id)
  assert.equal(stored.proxyEnabled, true)
  assert.equal(stored.profileDraft, undefined)
  assert.equal(textOf(document.body).includes("Draft"), false)
  assert.ok(button("Disable Proxy"))
})

test("invalid draft does not disable or replace the running profile", async () => {
  const { stored, syncStates } = await mount({ draft: { ...draft, proxyHost: "" } })
  await click("Enable Proxy")
  assert.equal(stored.activeProfileId, "1")
  assert.equal(stored.proxyEnabled, true)
  assert.equal(syncStates.length, 0)
  assert.ok(textOf(document.body).includes("Proxy host is required."))
  assert.ok(button("Unfinished profile"))
})

test("failed profile switch restores the previous active connection", async () => {
  const { stored, syncStates } = await mount({ failSync: true })
  await click("Profile 2")
  await click("Enable Proxy")
  assert.equal(stored.activeProfileId, "1")
  assert.equal(stored.proxyEnabled, true)
  assert.equal(syncStates.length, 2)
  assert.ok(syncStates[1])
  assert.equal(syncStates[1].activeProfileId, "1")
  assert.ok(button("Enable Proxy"))
  assert.ok(textOf(document.body).includes("Could not apply proxy"))
})

test("selected profile can be enabled when proxy is initially off", async () => {
  const { stored } = await mount({ enabled: false })
  await click("Profile 2")
  await click("Enable Proxy")
  assert.equal(stored.activeProfileId, "2")
  assert.equal(stored.proxyEnabled, true)
  assert.ok(button("Disable Proxy"))
})

const selectLanguage = async (value: "en" | "ru") => {
  const select = document.querySelector("select")!
  assert.equal(select.disabled, false)
  await act(async () => { fireEvent.change(select, { target: { value } }) })
}

test("Russian browser language selects Russian on first launch and localizes new names", async () => {
  const { stored } = await mount({ profiles: [], browserLanguage: "ru-RU" })
  assert.equal(document.documentElement.lang, "ru")
  assert.equal(document.title, "Прокси Менеджер")
  assert.equal(field("Название профиля").value, "Профиль 1")
  assert.ok(button("Добавить профиль"))
  assert.equal(stored.language, undefined)
  await selectLanguage("en")
  assert.equal(field("Profile name").value, "Profile 1")
  assert.equal(document.title, "Proxy Manager")
})

test("language selection persists across reopening and preserves edits and translated feedback", async () => {
  const { stored, syncStates } = await mount({ draft: { ...draft, proxyHost: "" } })
  await changeField("Username", "my edited username")
  await click("Enable Proxy")
  assert.ok(textOf(document.body).includes("Proxy host is required."))
  await selectLanguage("ru")
  assert.equal(stored.language, "ru")
  assert.equal(document.documentElement.lang, "ru")
  assert.ok(textOf(document.body).includes("Укажите адрес прокси."))
  assert.equal(field("Название профиля").value, draft.profileName)
  assert.equal(field("Имя пользователя").value, "my edited username")
  assert.deepEqual(stored.proxyProfiles, [makeProfile("1"), makeProfile("2")])
  assert.equal(syncStates.length, 0)
  const savedStorage = structuredClone(stored)
  cleanup()
  await mount({ stored: savedStorage, browserLanguage: "en-US" })
  assert.equal(document.querySelector("select")!.value, "ru")
  assert.equal(field("Имя пользователя").value, "my edited username")
  assert.ok(textOf(document.body).includes("Несохранённый черновик профиля восстановлен."))
  await selectLanguage("en")
  assert.ok(textOf(document.body).includes("Unsaved profile draft restored."))
})

test("unsupported browser and stored languages fall back to English", async () => {
  await mount({ browserLanguage: "de-DE", stored: { language: "unsupported" } })
  assert.equal(document.documentElement.lang, "en")
  assert.equal(document.title, "Proxy Manager")
  assert.ok(button("Ping servers"))
})

test("Russian ping results and malformed imports display localized feedback", async () => {
  await mount({ browserLanguage: "ru" })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("proxy2")) throw new Error("Connection failed")
    return {} as Response
  }) as typeof fetch
  await click("Пинг серверов")
  assert.match(textOf(button("Profile 1")!), /\d+ мс/u)
  assert.match(textOf(button("Profile 2")!), /Недоступен/u)
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
  await act(async () => {
    fireEvent.change(input, { target: { files: [{ text: async () => "invalid-json" }] } })
  })
  assert.ok(textOf(document.body).includes("Файл импорта должен содержать корректный JSON."))
  await selectLanguage("en")
  assert.ok(textOf(document.body).includes("Import file must contain valid JSON."))
  assert.match(textOf(button("Profile 1")!), /\d+ ms/u)
})

test("deleting an inactive profile requires confirmation and keeps the running connection", async () => {
  const { stored, syncStates } = await mount()
  await click("Profile 2")
  await click("Delete profile")
  assert.ok(textOf(document.body).includes("Delete profile “Profile 2”?"))
  await click("Cancel")
  assert.equal((stored.proxyProfiles as ProxyProfile[]).length, 2)
  await click("Delete profile")
  await click("Delete")
  assert.deepEqual(stored.proxyProfiles, [makeProfile("1")])
  assert.equal(stored.activeProfileId, "1")
  assert.equal(stored.proxyEnabled, true)
  assert.equal(syncStates.length, 0)
  assert.equal(button("Profile 2"), undefined)
  assert.ok(textOf(document.body).includes("Profile “Profile 2” deleted."))
  cleanup()
  await mount({ stored })
  assert.equal(button("Profile 2"), undefined)
})

test("deleting the connected profile disables it before removal without connecting another profile", async () => {
  const { stored, syncStates } = await mount()
  await click("Profile 1")
  await click("Delete profile")
  assert.ok(textOf(document.body).includes("The proxy will be disconnected."))
  await click("Delete")
  assert.equal(syncStates.length, 1)
  assert.equal(syncStates[0]!.proxyEnabled, false)
  assert.equal((syncStates[0]!.proxyProfiles as ProxyProfile[]).length, 2)
  assert.deepEqual(stored.proxyProfiles, [makeProfile("2")])
  assert.equal(stored.activeProfileId, "2")
  assert.equal(stored.proxyEnabled, false)
  await click("Profile 2")
  assert.ok(button("Enable Proxy"))
})

test("failure to disconnect cancels deletion and restores the running profile", async () => {
  const { stored, syncStates } = await mount({ failSync: true })
  await click("Profile 1")
  await click("Delete profile")
  await click("Delete")
  assert.equal((stored.proxyProfiles as ProxyProfile[]).length, 2)
  assert.equal(stored.activeProfileId, "1")
  assert.equal(stored.proxyEnabled, true)
  assert.equal(syncStates.length, 2)
  assert.equal(syncStates[1]!.proxyEnabled, true)
  assert.ok(button("Disable Proxy"))
  assert.ok(textOf(document.body).includes("Could not apply proxy"))
})

test("failed deletion retains the profile and shows that the proxy has already disconnected", async () => {
  const { stored } = await mount({ failDelete: true })
  await click("Profile 1")
  await click("Delete profile")
  await click("Delete")
  assert.equal((stored.proxyProfiles as ProxyProfile[]).length, 2)
  assert.equal(stored.proxyEnabled, false)
  assert.ok(button("Enable Proxy"))
  assert.ok(textOf(document.body).includes("Failed to delete profile."))
  assert.ok(textOf(document.body).includes("Storage write failed"))
})

test("deleting the last profile shows onboarding with localized confirmation", async () => {
  const { stored, syncStates } = await mount({ profiles: [makeProfile("1")], enabled: false, browserLanguage: "ru" })
  await click("Profile 1")
  await click("Удалить профиль")
  assert.ok(textOf(document.body).includes("Удалить профиль «Profile 1»?"))
  await click("Удалить")
  assert.deepEqual(stored.proxyProfiles, [])
  assert.equal(stored.activeProfileId, null)
  assert.equal(stored.proxyEnabled, false)
  assert.equal(syncStates.length, 0)
  assert.ok(button("Добавить профиль"))
  assert.ok(textOf(document.body).includes("Создайте первый профиль"))
  assert.ok(textOf(document.body).includes("Профиль «Profile 1» удалён."))
})

test("deleting the last saved profile keeps an existing draft accessible", async () => {
  const { stored } = await mount({ profiles: [makeProfile("1")], draft, enabled: false })
  await click("Profile 1")
  await click("Delete profile")
  await click("Delete")
  assert.deepEqual(stored.proxyProfiles, [])
  assert.deepEqual((stored.profileDraft as { formState: PopupFormState }).formState, draft)
  await click("Unfinished profile")
  assert.equal(field("Proxy host").value, draft.proxyHost)
  assert.equal(button("Delete profile"), undefined)
  assert.ok(button("Discard"))
})
