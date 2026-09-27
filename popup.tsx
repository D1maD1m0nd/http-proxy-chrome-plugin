import { useEffect, useMemo, useRef, useState } from "react"

import { DEFAULT_SETTINGS } from "~src/defaultSettings"
import {
  clearProfileDraft,
  createProfileDraft,
  getProfileDraft,
  getProfilesState,
  getProxyEnabled,
  saveProfile,
  setActiveProfileId,
  setProfileDraft,
  setProxyEnabled
} from "~src/storage"
import type {
  BackgroundMessage,
  BackgroundResponse,
  PopupFormState,
  ProxyProfile,
  ProxySettings
} from "~src/types"

type FeedbackState =
  | {
      tone: "success" | "error"
      text: string
    }
  | undefined

type ProfileExportPayload = {
  version: 1
  exportedAt: string
  profile: Pick<ProxyProfile, "name"> & ProxySettings
}

type ParsedProxyUrl = Pick<
  ProxySettings,
  "proxyHost" | "proxyPort" | "username" | "password"
>

const NEW_PROFILE_ID = "__new_profile__"
const PROFILE_EXPORT_VERSION = 1

const getNextProfileName = (profileCount: number) => `Profile ${profileCount + 1}`

const createFormState = (
  profile: Pick<ProxyProfile, "name"> & ProxySettings
): PopupFormState => ({
  profileName: profile.name,
  proxyHost: profile.proxyHost,
  proxyPort: String(profile.proxyPort),
  username: profile.username,
  password: profile.password,
  proxyDomainsText: profile.proxyDomains.join("\n"),
  directDomainsText: profile.directDomains.join("\n"),
  disableProxyDomainRouting: profile.disableProxyDomainRouting
})

const parseDomainList = (value: string) => {
  const uniqueValues = new Set<string>()

  for (const line of value.split(/\r?\n/u)) {
    const normalizedLine = line.trim().toLowerCase()

    if (normalizedLine) {
      uniqueValues.add(normalizedLine)
    }
  }

  return [...uniqueValues]
}

const parseImportedDomainList = (value: unknown, fallback: string[]) => {
  if (Array.isArray(value)) {
    return parseDomainList(value.map((item) => String(item)).join("\n"))
  }

  if (typeof value === "string") {
    return parseDomainList(value)
  }

  return [...fallback]
}

const appendDomainToListText = (value: string, domain: string) => {
  const domains = parseDomainList(value)

  if (domains.includes(domain)) {
    return {
      nextValue: value,
      alreadyExists: true
    }
  }

  return {
    nextValue: [...domains, domain].join("\n"),
    alreadyExists: false
  }
}

const isIpHost = (host: string) =>
  /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host) || host.includes(":")

const getProxyDomainFromUrl = (value: string | undefined) => {
  if (!value) {
    return null
  }

  try {
    const url = new URL(value)

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null
    }

    const host = url.hostname.trim().toLowerCase().replace(/^www\./u, "")

    if (!host) {
      return null
    }

    return host.includes(".") && !isIpHost(host) ? `.${host}` : host
  } catch {
    return null
  }
}

const getCurrentTabProxyDomain = () =>
  new Promise<string>((resolve, reject) => {
    chrome.tabs.query(
      {
        active: true,
        currentWindow: true
      },
      (tabs) => {
        const errorMessage = chrome.runtime.lastError?.message

        if (errorMessage) {
          reject(new Error(errorMessage))
          return
        }

        const domain = getProxyDomainFromUrl(tabs[0]?.url)

        if (!domain) {
          reject(new Error("Current tab does not have a web domain."))
          return
        }

        resolve(domain)
      }
    )
  })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const getImportProfileSource = (payload: unknown) => {
  if (!isRecord(payload)) {
    throw new Error("Import file must contain a profile object.")
  }

  const profileValue = payload.profile

  if (isRecord(profileValue)) {
    const settingsValue = profileValue.settings

    if (isRecord(settingsValue)) {
      return {
        ...settingsValue,
        name: profileValue.name
      }
    }

    return profileValue
  }

  return payload
}

const createImportedProfile = (payload: unknown) => {
  const source = getImportProfileSource(payload)
  const importedPort =
    typeof source.proxyPort === "number"
      ? source.proxyPort
      : Number.parseInt(String(source.proxyPort), 10)
  const draft = createProfileDraft(
    typeof source.name === "string" && source.name.trim()
      ? source.name.trim()
      : "Imported profile"
  )

  const profile: ProxyProfile = {
    ...draft,
    proxyHost:
      typeof source.proxyHost === "string"
        ? source.proxyHost.trim().toLowerCase()
        : DEFAULT_SETTINGS.proxyHost,
    proxyPort: Number.isInteger(importedPort)
      ? importedPort
      : DEFAULT_SETTINGS.proxyPort,
    username: typeof source.username === "string" ? source.username : "",
    password: typeof source.password === "string" ? source.password : "",
    proxyDomains: parseImportedDomainList(
      source.proxyDomains,
      DEFAULT_SETTINGS.proxyDomains
    ),
    directDomains: parseImportedDomainList(
      source.directDomains,
      DEFAULT_SETTINGS.directDomains
    ),
    disableProxyDomainRouting:
      typeof source.disableProxyDomainRouting === "boolean"
        ? source.disableProxyDomainRouting
        : DEFAULT_SETTINGS.disableProxyDomainRouting
  }
  const result = validateForm(createFormState(profile), false)

  if (!("settings" in result)) {
    throw new Error(`Invalid profile import: ${result.error}`)
  }

  return {
    ...profile,
    ...result.settings,
    name: result.profileName
  }
}

const getExportFileName = (profileName: string) => {
  const safeName = profileName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")

  return `${safeName || "proxy-profile"}.json`
}

const downloadJsonFile = (fileName: string, payload: unknown) => {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
    type: "application/json"
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")

  link.href = url
  link.download = fileName
  link.rel = "noopener"
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

const decodeUrlCredential = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const parseProxyUrl = (value: string): ParsedProxyUrl => {
  const trimmedValue = value.trim()

  if (!trimmedValue) {
    throw new Error("Proxy URL is required.")
  }

  const url = new URL(
    /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmedValue)
      ? trimmedValue
      : `http://${trimmedValue}`
  )

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS proxy URLs are supported.")
  }

  const proxyHost = url.hostname.trim().toLowerCase()

  if (!proxyHost) {
    throw new Error("Proxy URL must include a host.")
  }

  const proxyPort = url.port
    ? Number.parseInt(url.port, 10)
    : url.protocol === "https:"
      ? 443
      : 80

  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    throw new Error("Proxy URL port must be a number from 1 to 65535.")
  }

  return {
    proxyHost,
    proxyPort,
    username: decodeUrlCredential(url.username),
    password: decodeUrlCredential(url.password)
  }
}

const validateForm = (
  formState: PopupFormState,
  requireCredentials: boolean
) => {
  const profileName = formState.profileName.trim()

  if (!profileName) {
    return {
      error: "Profile name is required."
    }
  }

  if (!formState.proxyHost.trim()) {
    return {
      error: "Proxy host is required."
    }
  }

  const proxyPort = Number.parseInt(formState.proxyPort, 10)

  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    return {
      error: "Proxy port must be a number from 1 to 65535."
    }
  }

  if (requireCredentials && !formState.username.trim()) {
    return {
      error: "Username is required when proxy is enabled."
    }
  }

  if (requireCredentials && !formState.password) {
    return {
      error: "Password is required when proxy is enabled."
    }
  }

  return {
    profileName,
    settings: {
      proxyHost: formState.proxyHost.trim().toLowerCase(),
      proxyPort,
      username: formState.username,
      password: formState.password,
      proxyDomains: parseDomainList(formState.proxyDomainsText),
      directDomains: parseDomainList(formState.directDomainsText),
      disableProxyDomainRouting: formState.disableProxyDomainRouting
    } satisfies ProxySettings
  }
}

const sendBackgroundMessage = (message: BackgroundMessage) =>
  new Promise<BackgroundResponse>((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: BackgroundResponse | undefined) => {
      const errorMessage = chrome.runtime.lastError?.message

      if (errorMessage) {
        reject(new Error(errorMessage))
        return
      }

      resolve(response ?? { ok: true })
    })
  })

const upsertProfileList = (profiles: ProxyProfile[], nextProfile: ProxyProfile) => {
  const existingIndex = profiles.findIndex(({ id }) => id === nextProfile.id)
  const nextProfiles = [...profiles]

  if (existingIndex >= 0) {
    nextProfiles[existingIndex] = nextProfile
    return nextProfiles
  }

  nextProfiles.push(nextProfile)
  return nextProfiles
}

function IndexPopup() {
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const [profiles, setProfiles] = useState<ProxyProfile[]>([])
  const [activeProfileId, setActiveProfileIdState] = useState<string | null>(null)
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null)
  const [formState, setFormState] = useState<PopupFormState>(() =>
    createFormState({
      name: getNextProfileName(0),
      ...DEFAULT_SETTINGS
    })
  )
  const [newProfileName, setNewProfileName] = useState(getNextProfileName(0))
  const [draftFormState, setDraftFormState] = useState<PopupFormState | null>(null)
  const [proxyEnabled, setProxyEnabledState] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isBusy, setIsBusy] = useState(false)
  const [feedback, setFeedback] = useState<FeedbackState>()
  const [isProxyUrlImportVisible, setIsProxyUrlImportVisible] = useState(false)
  const [proxyUrlText, setProxyUrlText] = useState("")
  const [isProfileListVisible, setIsProfileListVisible] = useState(true)

  useEffect(() => {
    let isMounted = true

    void Promise.all([getProfilesState(), getProxyEnabled(), getProfileDraft()])
      .then(([profilesState, enabled, profileDraft]) => {
        if (!isMounted) {
          return
        }

        setProfiles(profilesState.profiles)
        setActiveProfileIdState(profilesState.activeProfileId)
        setProxyEnabledState(enabled)
        setNewProfileName(getNextProfileName(profilesState.profiles.length))

        if (profileDraft) {
          setDraftFormState(profileDraft.formState)
          setSelectedProfileId(NEW_PROFILE_ID)
          setFormState(profileDraft.formState)
          setIsProfileListVisible(false)
          setFeedback({
            tone: "success",
            text: "Unsaved profile draft restored."
          })
        } else {
          const initialProfile =
            profilesState.profiles.find(
              ({ id }) => id === profilesState.activeProfileId
            ) ?? profilesState.profiles[0]

          if (initialProfile) {
            setSelectedProfileId(initialProfile.id)
            setFormState(createFormState(initialProfile))
          }
        }
      })
      .catch((error: unknown) => {
        if (!isMounted) {
          return
        }

        setFeedback({
          tone: "error",
          text: error instanceof Error ? error.message : "Failed to load settings."
        })
      })
      .finally(() => {
        if (isMounted) {
          setIsLoading(false)
        }
      })

    return () => {
      isMounted = false
    }
  }, [])

  useEffect(() => {
    if (isLoading || selectedProfileId !== NEW_PROFILE_ID) {
      return
    }

    setDraftFormState(formState)
    void setProfileDraft(formState).catch(() => undefined)
  }, [formState, isLoading, selectedProfileId])

  const isDraftProfile = selectedProfileId === NEW_PROFILE_ID
  const isSelectedProfileEnabled =
    proxyEnabled && selectedProfileId === activeProfileId && !isDraftProfile
  const hasProfiles = profiles.length > 0
  const selectedStoredProfile =
    selectedProfileId && !isDraftProfile
      ? profiles.find(({ id }) => id === selectedProfileId) ?? null
      : null
  const statusLabel = useMemo(
    () => (proxyEnabled ? "Enabled" : "Disabled"),
    [proxyEnabled]
  )

  const updateField =
    (field: keyof PopupFormState) =>
    (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
    ) => {
      setFormState((currentState) => ({
        ...currentState,
        [field]: event.target.value
      }))
    }

  const handleToggleProxyDomainRouting = () => {
    setFormState((currentState) => ({
      ...currentState,
      disableProxyDomainRouting: !currentState.disableProxyDomainRouting
    }))
    setFeedback(undefined)
  }

  const handleAddCurrentSite = async () => {
    setIsBusy(true)

    try {
      const domain = await getCurrentTabProxyDomain()
      const { alreadyExists, nextValue } = appendDomainToListText(
        formState.proxyDomainsText,
        domain
      )

      setFormState((currentState) => ({
        ...currentState,
        proxyDomainsText: nextValue
      }))
      setFeedback({
        tone: "success",
        text: alreadyExists
          ? `${domain} is already in the proxy list.`
          : `${domain} added to the proxy list.`
      })
    } catch (error) {
      setFeedback({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to read current tab."
      })
    } finally {
      setIsBusy(false)
    }
  }

  const handleOpenImportDialog = () => {
    importInputRef.current?.click()
  }

  const handleOpenProxyUrlImport = () => {
    setIsProxyUrlImportVisible(true)
    setFeedback(undefined)
  }

  const handleCancelProxyUrlImport = () => {
    setIsProxyUrlImportVisible(false)
    setProxyUrlText("")
    setFeedback(undefined)
  }

  const handleImportProxyUrl = () => {
    try {
      const parsedProxyUrl = parseProxyUrl(proxyUrlText)
      const isNewDraft = !selectedProfileId
      const nextFormState: PopupFormState = {
        ...(isNewDraft
          ? createFormState({
              name:
                newProfileName.trim() ||
                `Proxy ${parsedProxyUrl.proxyHost}:${parsedProxyUrl.proxyPort}`,
              ...DEFAULT_SETTINGS
            })
          : formState),
        proxyHost: parsedProxyUrl.proxyHost,
        proxyPort: String(parsedProxyUrl.proxyPort),
        username: parsedProxyUrl.username,
        password: parsedProxyUrl.password
      }

      if (isNewDraft) {
        setSelectedProfileId(NEW_PROFILE_ID)
        void setProfileDraft(nextFormState).catch(() => undefined)
      }

      setFormState(nextFormState)
      setProxyUrlText("")
      setIsProxyUrlImportVisible(false)
      setFeedback({
        tone: "success",
        text: "Proxy URL imported."
      })
    } catch (error) {
      setFeedback({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to import URL."
      })
    }
  }

  const handleExportProfile = () => {
    const result = validateForm(formState, false)

    if (!("settings" in result)) {
      setFeedback({
        tone: "error",
        text: result.error
      })
      return
    }

    const payload: ProfileExportPayload = {
      version: PROFILE_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      profile: {
        name: result.profileName,
        ...result.settings
      }
    }

    downloadJsonFile(getExportFileName(result.profileName), payload)
    setFeedback({
      tone: "success",
      text: "Profile exported."
    })
  }

  const handleImportProfile = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0]

    event.target.value = ""

    if (!file) {
      return
    }

    setIsBusy(true)

    try {
      const importedProfile = createImportedProfile(JSON.parse(await file.text()))
      const savedProfile = await saveProfile(importedProfile)
      const nextProfiles = upsertProfileList(profiles, savedProfile)
      const nextActiveProfileId = activeProfileId ?? nextProfiles[0]?.id ?? null

      setProfiles(nextProfiles)
      setSelectedProfileId(savedProfile.id)
      setFormState(createFormState(savedProfile))
      setIsProfileListVisible(false)
      setActiveProfileIdState(nextActiveProfileId)
      setNewProfileName(getNextProfileName(nextProfiles.length))
      setIsProxyUrlImportVisible(false)
      setProxyUrlText("")
      setFeedback({
        tone: "success",
        text: "Profile imported."
      })
    } catch (error) {
      setFeedback({
        tone: "error",
        text:
          error instanceof Error ? error.message : "Failed to import profile."
      })
    } finally {
      setIsBusy(false)
    }
  }

  const handleDiscardDraft = async () => {
    setIsBusy(true)

    try {
      await clearProfileDraft()
      setDraftFormState(null)

      const nextProfile =
        profiles.find(({ id }) => id === activeProfileId) ?? profiles[0] ?? null

      if (nextProfile) {
        setSelectedProfileId(nextProfile.id)
        setFormState(createFormState(nextProfile))
      } else {
        setSelectedProfileId(null)
        setFormState(
          createFormState({
            name: newProfileName,
            ...DEFAULT_SETTINGS
          })
        )
      }

      setFeedback({
        tone: "success",
        text: "Draft discarded."
      })
    } catch (error) {
      setFeedback({
        tone: "error",
        text:
          error instanceof Error ? error.message : "Failed to discard draft."
      })
    } finally {
      setIsBusy(false)
    }
  }

  const startDraftProfile = (preferredName?: string) => {
    const draftName = (preferredName ?? newProfileName).trim() || newProfileName
    const nextFormState = draftFormState ?? createFormState({
      name: draftName,
      ...DEFAULT_SETTINGS
    })

    setDraftFormState(nextFormState)
    setSelectedProfileId(NEW_PROFILE_ID)
    setFormState(nextFormState)
    setIsProfileListVisible(false)
    setFeedback(undefined)
    setIsProxyUrlImportVisible(false)
    setProxyUrlText("")
    void setProfileDraft(nextFormState).catch(() => undefined)
  }

  const selectProfile = (profile: ProxyProfile) => {
    setSelectedProfileId(profile.id)
    setFormState(createFormState(profile))
    setIsProfileListVisible(false)
    setFeedback(undefined)
    setIsProxyUrlImportVisible(false)
    setProxyUrlText("")
  }

  const handleBackToProfiles = () => {
    setIsProfileListVisible(true)
    setIsProxyUrlImportVisible(false)
    setProxyUrlText("")
    setFeedback(undefined)
  }

  const persistCurrentProfile = async (options: {
    activateAfterSave: boolean
    requireCredentials: boolean
  }) => {
    const wasDraftProfile = isDraftProfile
    const result = validateForm(formState, options.requireCredentials)

    if (!("settings" in result)) {
      setFeedback({
        tone: "error",
        text: result.error
      })
      return null
    }

    const existingProfile =
      selectedStoredProfile ?? createProfileDraft(result.profileName)
    const savedProfile = await saveProfile({
      ...existingProfile,
      name: result.profileName,
      ...result.settings
    })
    const nextProfiles = upsertProfileList(profiles, savedProfile)
    const nextActiveProfileId =
      options.activateAfterSave
        ? savedProfile.id
        : activeProfileId ?? nextProfiles[0]?.id ?? null

    if (options.activateAfterSave) {
      await setActiveProfileId(savedProfile.id)
    }

    if (wasDraftProfile) {
      await clearProfileDraft()
      setDraftFormState(null)
    }

    setProfiles(nextProfiles)
    setSelectedProfileId(savedProfile.id)
    setFormState(createFormState(savedProfile))
    setActiveProfileIdState(nextActiveProfileId)
    setNewProfileName(getNextProfileName(nextProfiles.length))

    return {
      savedProfile,
      nextActiveProfileId
    }
  }

  const handleSave = async () => {
    setIsBusy(true)

    try {
      const persisted = await persistCurrentProfile({
        activateAfterSave: false,
        requireCredentials: false
      })

      if (!persisted) {
        return
      }

      setFeedback({
        tone: "success",
        text: "Profile saved."
      })
    } catch (error) {
      setFeedback({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to save profile."
      })
    } finally {
      setIsBusy(false)
    }
  }

  const handleApply = async () => {
    setIsBusy(true)

    try {
      const persisted = await persistCurrentProfile({
        activateAfterSave: true,
        requireCredentials: proxyEnabled
      })

      if (!persisted) {
        return
      }

      const response = await sendBackgroundMessage({
        type: "SYNC_PROXY_STATE"
      })

      if (!response.ok) {
        throw new Error(response.error ?? "Failed to apply proxy settings.")
      }

      setFeedback({
        tone: "success",
        text: proxyEnabled
          ? "Active profile updated."
          : "Profile saved and marked active."
      })
    } catch (error) {
      setFeedback({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to apply profile."
      })
    } finally {
      setIsBusy(false)
    }
  }

  const handleToggleProxy = async () => {
    const nextEnabled = !isSelectedProfileEnabled

    if (nextEnabled) {
      setIsBusy(true)

      try {
        const persisted = await persistCurrentProfile({
          activateAfterSave: true,
          requireCredentials: true
        })

        if (!persisted) {
          return
        }

        await setProxyEnabled(true)

        const response = await sendBackgroundMessage({
          type: "SYNC_PROXY_STATE"
        })

        if (!response.ok) {
          throw new Error(response.error ?? "Failed to enable proxy.")
        }

        setProxyEnabledState(true)
        setFeedback({
          tone: "success",
          text: "Proxy enabled."
        })
      } catch (error) {
        setFeedback({
          tone: "error",
          text: error instanceof Error ? error.message : "Failed to enable proxy."
        })
        // A failed switch must not turn off the previously connected profile.
        await setActiveProfileId(activeProfileId).catch(() => undefined)
        await setProxyEnabled(proxyEnabled).catch(() => undefined)
        setActiveProfileIdState(activeProfileId)
        await sendBackgroundMessage({ type: "SYNC_PROXY_STATE" }).catch(
          () => undefined
        )
      } finally {
        setIsBusy(false)
      }

      return
    }

    setIsBusy(true)

    try {
      await setProxyEnabled(false)

      const response = await sendBackgroundMessage({
        type: "SYNC_PROXY_STATE"
      })

      if (!response.ok) {
        throw new Error(response.error ?? "Failed to disable proxy.")
      }

      setProxyEnabledState(false)
      setFeedback({
        tone: "success",
        text: "Proxy disabled."
      })
    } catch (error) {
      setFeedback({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to disable proxy."
      })
    } finally {
      setIsBusy(false)
    }
  }

  const handleResetToDefaults = async () => {
    const nextFormState = createFormState({
      name: formState.profileName.trim() || newProfileName,
      ...DEFAULT_SETTINGS
    })

    if (isDraftProfile || !selectedStoredProfile) {
      setFormState(nextFormState)
      setFeedback({
        tone: "success",
        text: "Draft reset to defaults."
      })
      return
    }

    setIsBusy(true)

    try {
      const resetProfile = await saveProfile({
        ...selectedStoredProfile,
        name: nextFormState.profileName,
        ...DEFAULT_SETTINGS
      })
      const nextProfiles = upsertProfileList(profiles, resetProfile)

      setProfiles(nextProfiles)
      setFormState(createFormState(resetProfile))

      if (selectedStoredProfile.id === activeProfileId && proxyEnabled) {
        const response = await sendBackgroundMessage({
          type: "SYNC_PROXY_STATE"
        })

        if (!response.ok) {
          throw new Error(response.error ?? "Failed to re-apply defaults.")
        }
      }

      setFeedback({
        tone: "success",
        text:
          selectedStoredProfile.id === activeProfileId && proxyEnabled
            ? "Defaults restored and applied."
            : "Defaults restored."
      })
    } catch (error) {
      setFeedback({
        tone: "error",
        text:
          error instanceof Error ? error.message : "Failed to restore defaults."
      })
    } finally {
      setIsBusy(false)
    }
  }

  const renderProxyUrlImport = () =>
    isProxyUrlImportVisible ? (
      <section style={urlImportPanelStyle}>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Proxy URL</span>
          <input
            disabled={isLoading || isBusy}
            onChange={(event) => setProxyUrlText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                handleImportProxyUrl()
              }
            }}
            placeholder="http://user:password@host:8080"
            style={inputStyle}
            value={proxyUrlText}
          />
        </label>

        <div
          style={{
            display: "grid",
            gap: 8,
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))"
          }}>
          <button
            disabled={isLoading || isBusy}
            onClick={handleImportProxyUrl}
            style={primaryButtonStyle}>
            Import URL
          </button>
          <button
            disabled={isLoading || isBusy}
            onClick={handleCancelProxyUrlImport}
            style={secondaryButtonStyle}>
            Cancel
          </button>
        </div>
      </section>
    ) : null

  const renderOnboarding = () => (
    <div
      style={{
        display: "grid",
        gap: 16
      }}>
      <header
        style={{
          display: "grid",
          gap: 6
        }}>
        <div
          style={{
            fontSize: 20,
            fontWeight: 700,
            lineHeight: 1.2
          }}>
          Create your first profile
        </div>
        <div
          style={{
            fontSize: 12,
            color: "#5b6472",
            lineHeight: 1.45
          }}>
          Each profile stores its own proxy host, credentials and domain lists.
        </div>
      </header>

      <label style={{ display: "grid", gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>Profile name</span>
        <input
          disabled={isLoading || isBusy}
          onChange={(event) => setNewProfileName(event.target.value)}
          style={inputStyle}
          value={newProfileName}
        />
      </label>

      <button
        disabled={isLoading || isBusy}
        onClick={() => startDraftProfile(newProfileName)}
        style={primaryButtonStyle}>
        Add profile
      </button>

      <button
        disabled={isLoading || isBusy}
        onClick={handleOpenImportDialog}
        style={secondaryButtonStyle}>
        Import profile
      </button>

      <button
        disabled={isLoading || isBusy}
        onClick={handleOpenProxyUrlImport}
        style={secondaryButtonStyle}>
        Import from URL
      </button>

      {renderProxyUrlImport()}
    </div>
  )

  const renderDraftProfile = () => {
    const draft = isDraftProfile ? formState : draftFormState

    if (!draft) {
      return null
    }

    return (
      <button
        disabled={isLoading || isBusy}
        onClick={() => startDraftProfile()}
        style={{
          ...profileButtonStyle,
          borderColor: isDraftProfile ? "#1d5f8c" : "#c9d2dc",
          backgroundColor: isDraftProfile ? "#f5f9fc" : "#fbfaf7"
        }}
        type="button">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8
          }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#1f2937" }}>
            {draft.profileName || "New profile"}
          </span>
          <span style={tagStyle("draft")}>Draft</span>
        </div>
        <span style={{ marginTop: 4, fontSize: 11, color: "#5b6472" }}>
          Save or apply to add this profile to the list.
        </span>
      </button>
    )
  }

  const renderProfileList = () => (
    <div style={{ display: "grid", gap: 14 }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12
        }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.2 }}>
            Chrome Proxy Manager
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: "#5b6472" }}>
            Select a profile to connect or edit
          </div>
        </div>

        <div
          style={{
            padding: "6px 10px",
            borderRadius: 999,
            backgroundColor: proxyEnabled ? "#d6f5df" : "#e3e7ee",
            color: proxyEnabled ? "#155e3b" : "#465061",
            fontSize: 12,
            fontWeight: 700,
            minWidth: 88,
            textAlign: "center"
          }}>
          {statusLabel}
        </div>
      </header>

      <div
        style={{
          display: "grid",
          gap: 8,
          maxHeight: 460,
          overflowY: "auto"
        }}>
        {profiles.map((profile) => {
          const isActive = profile.id === activeProfileId

          return (
            <button
              key={profile.id}
              disabled={isBusy}
              onClick={() => selectProfile(profile)}
              style={{
                ...profileButtonStyle,
                borderColor: isActive ? "#1d5f8c" : "#c9d2dc",
                backgroundColor: isActive ? "#f5f9fc" : "#fbfaf7"
              }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8
                }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#1f2937" }}>
                  {profile.name}
                </span>
                {isActive ? (
                  <span style={tagStyle(proxyEnabled ? "live" : "active")}>
                    {proxyEnabled ? "Live" : "Active"}
                  </span>
                ) : null}
              </div>
              <span
                style={{
                  marginTop: 4,
                  fontSize: 11,
                  color: "#5b6472",
                  textAlign: "left"
                }}>
                {profile.proxyHost}:{profile.proxyPort}
              </span>
            </button>
          )
        })}
        {renderDraftProfile()}
      </div>

      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
        <button
          disabled={isLoading || isBusy}
          onClick={() => startDraftProfile()}
          style={primaryButtonStyle}>
          Add profile
        </button>
        <button
          disabled={isLoading || isBusy}
          onClick={handleOpenImportDialog}
          style={secondaryButtonStyle}>
          Import profile
        </button>
      </div>

      <button
        disabled={isLoading || isBusy}
        onClick={() => {
          startDraftProfile()
          setIsProxyUrlImportVisible(true)
        }}
        style={secondaryButtonStyle}>
        Import from URL
      </button>
    </div>
  )

  const renderEditor = () => (
    <div
      style={{
        display: "grid",
        gap: 14
      }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          paddingBottom: 2
        }}>
        <div>
          <button
            aria-label="Back to profiles"
            disabled={isLoading || isBusy}
            onClick={handleBackToProfiles}
            style={{
              ...miniButtonStyle,
              marginBottom: 8,
              padding: "5px 8px"
            }}
            type="button">
            ← Profiles
          </button>
          <div
            style={{
              fontSize: 18,
              fontWeight: 700,
              lineHeight: 1.2
            }}>
            Chrome Proxy Manager
          </div>
          <div
            style={{
              marginTop: 4,
              fontSize: 12,
              color: "#5b6472"
            }}>
            Profiles keep separate PAC routes and credentials
          </div>
        </div>

        <div
          style={{
            padding: "6px 10px",
            borderRadius: 999,
            backgroundColor: proxyEnabled ? "#d6f5df" : "#e3e7ee",
            color: proxyEnabled ? "#155e3b" : "#465061",
            fontSize: 12,
            fontWeight: 700,
            minWidth: 88,
            textAlign: "center"
          }}>
          {statusLabel}
        </div>
      </header>

      <section
        style={{
          display: "grid",
          gap: 10,
          padding: 12,
          borderRadius: 8,
          backgroundColor: "#ece7de"
        }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10
          }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: "#243244"
            }}>
            Profiles
          </div>

          <div
            style={{
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              justifyContent: "flex-end"
            }}>
            <button
              disabled={isLoading || isBusy}
              onClick={handleOpenImportDialog}
              style={miniButtonStyle}>
              Import
            </button>
            <button
              disabled={isLoading || isBusy}
              onClick={handleExportProfile}
              style={miniButtonStyle}>
              Export
            </button>
            <button
              disabled={isLoading || isBusy}
              onClick={handleOpenProxyUrlImport}
              style={miniButtonStyle}>
              From URL
            </button>
            <button
              disabled={isLoading || isBusy}
              onClick={() => startDraftProfile()}
              style={miniButtonStyle}>
              Add
            </button>
          </div>
        </div>

        {renderProxyUrlImport()}

        <div
          style={{
            display: "grid",
            gap: 8,
            maxHeight: 156,
            overflowY: "auto"
          }}>
          {profiles.map((profile) => {
            const isSelected = profile.id === selectedProfileId
            const isActive = profile.id === activeProfileId

            return (
              <button
                key={profile.id}
                disabled={isBusy}
                onClick={() => selectProfile(profile)}
                style={{
                  ...profileButtonStyle,
                  borderColor: isSelected ? "#1d5f8c" : "#c9d2dc",
                  backgroundColor: isSelected ? "#f5f9fc" : "#fbfaf7"
                }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8
                  }}>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: "#1f2937"
                    }}>
                    {profile.name}
                  </span>
                  {isActive ? (
                    <span style={tagStyle(proxyEnabled ? "live" : "active")}>
                      {proxyEnabled ? "Live" : "Active"}
                    </span>
                  ) : null}
                </div>
                <span
                  style={{
                    marginTop: 4,
                    fontSize: 11,
                    color: "#5b6472",
                    textAlign: "left"
                  }}>
                  {profile.proxyHost}:{profile.proxyPort}
                </span>
              </button>
            )
          })}

          {renderDraftProfile()}
        </div>
      </section>

      <button
        disabled={isLoading || isBusy}
        onClick={() => void handleToggleProxy()}
        style={{
          ...primaryButtonStyle,
          backgroundColor: isSelectedProfileEnabled ? "#8a2d3b" : "#1d5f8c"
        }}>
        {isSelectedProfileEnabled ? "Disable Proxy" : "Enable Proxy"}
      </button>

      <section
        style={{
          display: "grid",
          gap: 12
        }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Profile name</span>
          <input
            disabled={isLoading || isBusy}
            onChange={updateField("profileName")}
            style={inputStyle}
            value={formState.profileName}
          />
        </label>

        <div
          style={{
            display: "grid",
            gap: 10,
            gridTemplateColumns: "minmax(0, 1fr) 112px"
          }}>
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>Proxy host</span>
            <input
              disabled={isLoading || isBusy}
              onChange={updateField("proxyHost")}
              style={inputStyle}
              value={formState.proxyHost}
            />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>Proxy port</span>
            <input
              disabled={isLoading || isBusy}
              inputMode="numeric"
              onChange={updateField("proxyPort")}
              style={inputStyle}
              value={formState.proxyPort}
            />
          </label>
        </div>

        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Username</span>
          <input
            disabled={isLoading || isBusy}
            onChange={updateField("username")}
            style={inputStyle}
            value={formState.username}
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Password</span>
          <input
            disabled={isLoading || isBusy}
            onChange={updateField("password")}
            style={inputStyle}
            type="password"
            value={formState.password}
          />
        </label>

        <section
          style={{
            display: "grid",
            gap: 8,
            padding: 12,
            borderRadius: 8,
            border: "1px solid #d7cec0",
            backgroundColor: "#fbfaf7"
          }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10
            }}>
            <div
              style={{
                display: "grid",
                gap: 2
              }}>
              <span style={{ fontSize: 12, fontWeight: 700 }}>
                Domain list routing
              </span>
              <span style={{ fontSize: 11, color: "#5b6472" }}>
                {formState.disableProxyDomainRouting
                  ? "Disabled: proxy is used globally"
                  : "Enabled: proxy uses the domain list"}
              </span>
            </div>

            <button
              disabled={isLoading || isBusy}
              onClick={handleToggleProxyDomainRouting}
              style={{
                ...miniButtonStyle,
                minWidth: 90,
                backgroundColor: formState.disableProxyDomainRouting
                  ? "#f7ead0"
                  : "#e8eef7",
                borderColor: formState.disableProxyDomainRouting
                  ? "#d6a94a"
                  : "#b9c9df",
                color: formState.disableProxyDomainRouting
                  ? "#8a5d12"
                  : "#24405f"
              }}>
              {formState.disableProxyDomainRouting ? "Enable list" : "Disable list"}
            </button>
          </div>
        </section>

        <label style={{ display: "grid", gap: 6 }}>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              fontSize: 12,
              fontWeight: 600
            }}>
            Domains via proxy
            <button
              disabled={isLoading || isBusy}
              onClick={() => void handleAddCurrentSite()}
              style={miniButtonStyle}
              type="button">
              Add current site
            </button>
          </span>
          <textarea
            disabled={isLoading || isBusy}
            onChange={updateField("proxyDomainsText")}
            rows={8}
            style={textareaStyle}
            value={formState.proxyDomainsText}
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>
            Domains always direct
          </span>
          <textarea
            disabled={isLoading || isBusy}
            onChange={updateField("directDomainsText")}
            rows={5}
            style={textareaStyle}
            value={formState.directDomainsText}
          />
        </label>
      </section>

      <div
        style={{
          display: "grid",
          gap: 8,
          gridTemplateColumns: isDraftProfile
            ? "repeat(4, minmax(0, 1fr))"
            : "repeat(3, minmax(0, 1fr))"
        }}>
        <button
          disabled={isLoading || isBusy}
          onClick={() => void handleSave()}
          style={secondaryButtonStyle}>
          Save
        </button>
        <button
          disabled={isLoading || isBusy}
          onClick={() => void handleApply()}
          style={primaryButtonStyle}>
          Apply
        </button>
        <button
          disabled={isLoading || isBusy}
          onClick={() => void handleResetToDefaults()}
          style={secondaryButtonStyle}>
          Reset
        </button>
        {isDraftProfile ? (
          <button
            disabled={isLoading || isBusy}
            onClick={() => void handleDiscardDraft()}
            style={secondaryButtonStyle}>
            Discard
          </button>
        ) : null}
      </div>
    </div>
  )

  return (
    <div
      style={{
        width: 404,
        minHeight: 680,
        boxSizing: "border-box",
        padding: 16,
        backgroundColor: "#f4f1eb",
        color: "#1f2937",
        fontFamily: "\"Segoe UI\", Tahoma, sans-serif"
      }}>
      {isLoading ? (
        <div style={{ fontSize: 12, color: "#5b6472" }}>Loading settings...</div>
      ) : !hasProfiles && !draftFormState && !isDraftProfile ? (
        renderOnboarding()
      ) : isProfileListVisible ? (
        renderProfileList()
      ) : (
        renderEditor()
      )}

      <input
        accept="application/json,.json"
        onChange={(event) => void handleImportProfile(event)}
        ref={importInputRef}
        style={{ display: "none" }}
        type="file"
      />

      <div
        style={{
          minHeight: 20,
          marginTop: 14,
          fontSize: 12,
          color:
            feedback?.tone === "error"
              ? "#9f1d2c"
              : feedback?.tone === "success"
                ? "#166534"
                : "#5b6472"
        }}>
        {isBusy ? "Working..." : feedback?.text ?? "Ready."}
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  borderRadius: 8,
  border: "1px solid #c9d2dc",
  padding: "10px 12px",
  backgroundColor: "#fbfaf7",
  color: "#111827",
  fontSize: 13,
  outline: "none"
}

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: "vertical",
  minHeight: 104,
  lineHeight: 1.45
}

const primaryButtonStyle: React.CSSProperties = {
  appearance: "none",
  border: "none",
  borderRadius: 8,
  padding: "10px 12px",
  backgroundColor: "#1d5f8c",
  color: "#f8fafc",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer"
}

const secondaryButtonStyle: React.CSSProperties = {
  appearance: "none",
  border: "1px solid #c9d2dc",
  borderRadius: 8,
  padding: "10px 12px",
  backgroundColor: "#fbfaf7",
  color: "#243244",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer"
}

const miniButtonStyle: React.CSSProperties = {
  ...secondaryButtonStyle,
  padding: "7px 10px",
  fontSize: 12
}

const urlImportPanelStyle: React.CSSProperties = {
  display: "grid",
  gap: 8,
  padding: 10,
  borderRadius: 8,
  border: "1px solid #d7cec0",
  backgroundColor: "#fbfaf7"
}

const profileButtonStyle: React.CSSProperties = {
  appearance: "none",
  display: "grid",
  width: "100%",
  boxSizing: "border-box",
  gap: 0,
  borderRadius: 8,
  border: "1px solid #c9d2dc",
  padding: "10px 12px",
  cursor: "pointer",
  textAlign: "left"
}

const tagStyle = (tone: "live" | "active" | "draft"): React.CSSProperties => {
  const colorMap = {
    live: {
      backgroundColor: "#d6f5df",
      color: "#155e3b"
    },
    active: {
      backgroundColor: "#e8eef7",
      color: "#24405f"
    },
    draft: {
      backgroundColor: "#f7ead0",
      color: "#8a5d12"
    }
  } satisfies Record<
    "live" | "active" | "draft",
    {
      backgroundColor: string
      color: string
    }
  >

  return {
    padding: "3px 8px",
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 700,
    ...colorMap[tone]
  }
}

export default IndexPopup
