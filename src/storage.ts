import {
  DEFAULT_PROFILE_NAME,
  DEFAULT_PROXY_ENABLED,
  DEFAULT_SETTINGS
} from "./defaultSettings"
import type {
  PopupDraftState,
  PopupFormState,
  ProfilesState,
  ProxyProfile,
  ProxySettings
} from "./types"

const PROFILES_KEY = "proxyProfiles"
const ACTIVE_PROFILE_ID_KEY = "activeProfileId"
const LEGACY_SETTINGS_KEY = "proxySettings"
const ENABLED_KEY = "proxyEnabled"
const PROFILE_DRAFT_KEY = "profileDraft"
const LANGUAGE_KEY = "language"

const getLastError = () => chrome.runtime.lastError?.message

const storageGet = <T>(keys?: string | string[] | Record<string, unknown> | null) =>
  new Promise<T>((resolve, reject) => {
    chrome.storage.local.get(keys ?? null, (result) => {
      const errorMessage = getLastError()

      if (errorMessage) {
        reject(new Error(errorMessage))
        return
      }

      resolve(result as T)
    })
  })

const storageSet = (items: Record<string, unknown>) =>
  new Promise<void>((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      const errorMessage = getLastError()

      if (errorMessage) {
        reject(new Error(errorMessage))
        return
      }

      resolve()
    })
  })

const storageRemove = (keys: string | string[]) =>
  new Promise<void>((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      const errorMessage = getLastError()

      if (errorMessage) {
        reject(new Error(errorMessage))
        return
      }

      resolve()
    })
  })

const createProfileId = () =>
  `profile-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

const normalizeDomainList = (value: unknown, fallback: string[]) => {
  if (!Array.isArray(value)) {
    return [...fallback]
  }

  const uniqueDomains = new Set<string>()

  for (const item of value) {
    const normalizedValue = String(item).trim().toLowerCase()

    if (normalizedValue) {
      uniqueDomains.add(normalizedValue)
    }
  }

  return [...uniqueDomains]
}

const normalizePort = (value: unknown) => {
  const parsedValue =
    typeof value === "number" ? value : Number.parseInt(String(value), 10)

  if (!Number.isInteger(parsedValue) || parsedValue < 1 || parsedValue > 65535) {
    return DEFAULT_SETTINGS.proxyPort
  }

  return parsedValue
}

const normalizeName = (value: unknown, fallback: string) => {
  if (typeof value !== "string") {
    return fallback
  }

  const normalizedValue = value.trim()

  return normalizedValue || fallback
}

const normalizeTimestamp = (value: unknown, fallback: number) => {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const normalizeDraftText = (value: unknown, fallback: string) =>
  typeof value === "string" ? value : fallback

const normalizeDraftDomainText = (value: unknown, fallback: string[]) => {
  if (typeof value === "string") {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join("\n")
  }

  return fallback.join("\n")
}

const normalizeDraftFormState = (value: unknown): PopupFormState | null => {
  if (!isRecord(value)) {
    return null
  }

  return {
    profileName: normalizeDraftText(value.profileName, "New profile"),
    proxyHost: normalizeDraftText(value.proxyHost, DEFAULT_SETTINGS.proxyHost),
    proxyPort: normalizeDraftText(
      value.proxyPort,
      String(DEFAULT_SETTINGS.proxyPort)
    ),
    username: normalizeDraftText(value.username, DEFAULT_SETTINGS.username),
    password: normalizeDraftText(value.password, DEFAULT_SETTINGS.password),
    proxyDomainsText: normalizeDraftDomainText(
      value.proxyDomainsText,
      DEFAULT_SETTINGS.proxyDomains
    ),
    directDomainsText: normalizeDraftDomainText(
      value.directDomainsText,
      DEFAULT_SETTINGS.directDomains
    ),
    disableProxyDomainRouting:
      typeof value.disableProxyDomainRouting === "boolean"
        ? value.disableProxyDomainRouting
        : DEFAULT_SETTINGS.disableProxyDomainRouting
  }
}

const normalizeSettings = (value?: Partial<ProxySettings>): ProxySettings => ({
  proxyHost:
    typeof value?.proxyHost === "string" && value.proxyHost.trim()
      ? value.proxyHost.trim().toLowerCase()
      : DEFAULT_SETTINGS.proxyHost,
  proxyPort: normalizePort(value?.proxyPort),
  username:
    typeof value?.username === "string"
      ? value.username
      : DEFAULT_SETTINGS.username,
  password:
    typeof value?.password === "string"
      ? value.password
      : DEFAULT_SETTINGS.password,
  proxyDomains: normalizeDomainList(
    value?.proxyDomains,
    DEFAULT_SETTINGS.proxyDomains
  ),
  directDomains: normalizeDomainList(
    value?.directDomains,
    DEFAULT_SETTINGS.directDomains
  ),
  disableProxyDomainRouting:
    typeof value?.disableProxyDomainRouting === "boolean"
      ? value.disableProxyDomainRouting
      : DEFAULT_SETTINGS.disableProxyDomainRouting
})

const normalizeProfile = (
  value: Partial<ProxyProfile> | undefined,
  fallbackName: string
): ProxyProfile | null => {
  if (!value || typeof value !== "object") {
    return null
  }

  const now = Date.now()
  const settings = normalizeSettings(value)

  return {
    id:
      typeof value.id === "string" && value.id.trim()
        ? value.id.trim()
        : createProfileId(),
    name: normalizeName(value.name, fallbackName),
    createdAt: normalizeTimestamp(value.createdAt, now),
    updatedAt: normalizeTimestamp(value.updatedAt, now),
    ...settings
  }
}

const normalizeProfiles = (value: unknown) => {
  if (!Array.isArray(value)) {
    return [] as ProxyProfile[]
  }

  const seenIds = new Set<string>()
  const profiles: ProxyProfile[] = []

  for (const [index, item] of value.entries()) {
    const profile = normalizeProfile(
      item as Partial<ProxyProfile>,
      `Profile ${index + 1}`
    )

    if (!profile || seenIds.has(profile.id)) {
      continue
    }

    seenIds.add(profile.id)
    profiles.push(profile)
  }

  return profiles
}

const saveProfilesState = async (state: ProfilesState) => {
  await storageSet({
    [PROFILES_KEY]: state.profiles,
    [ACTIVE_PROFILE_ID_KEY]: state.activeProfileId
  })
}

export const createProfileDraft = (
  name = `Profile ${Date.now()}`
): ProxyProfile => {
  const now = Date.now()

  return {
    id: createProfileId(),
    name: normalizeName(name, "New profile"),
    createdAt: now,
    updatedAt: now,
    ...DEFAULT_SETTINGS
  }
}

export const getProfilesState = async (): Promise<ProfilesState> => {
  const stored = await storageGet<{
    [PROFILES_KEY]?: unknown
    [ACTIVE_PROFILE_ID_KEY]?: unknown
    [LEGACY_SETTINGS_KEY]?: unknown
  }>(null)

  let profiles = normalizeProfiles(stored[PROFILES_KEY])
  let activeProfileId =
    typeof stored[ACTIVE_PROFILE_ID_KEY] === "string" &&
    stored[ACTIVE_PROFILE_ID_KEY]?.trim()
      ? stored[ACTIVE_PROFILE_ID_KEY]
      : null
  let shouldPersist = false
  let shouldRemoveLegacy = false

  if (profiles.length === 0 && stored[LEGACY_SETTINGS_KEY] !== undefined) {
    const migratedProfile = normalizeProfile(
      {
        ...normalizeSettings(stored[LEGACY_SETTINGS_KEY] as Partial<ProxySettings>),
        id: createProfileId(),
        name: DEFAULT_PROFILE_NAME
      },
      DEFAULT_PROFILE_NAME
    )

    if (migratedProfile) {
      profiles = [migratedProfile]
      activeProfileId = migratedProfile.id
      shouldPersist = true
      shouldRemoveLegacy = true
    }
  }

  const firstProfile = profiles[0]

  if (firstProfile) {
    const hasActiveProfile = profiles.some((profile) => profile.id === activeProfileId)

    if (!hasActiveProfile) {
      activeProfileId = firstProfile.id
      shouldPersist = true
    }
  } else if (activeProfileId !== null) {
    activeProfileId = null
    shouldPersist = true
  }

  if (shouldPersist) {
    await saveProfilesState({
      profiles,
      activeProfileId
    })
  }

  if (shouldRemoveLegacy) {
    await storageRemove(LEGACY_SETTINGS_KEY)
  }

  return {
    profiles,
    activeProfileId
  }
}

export const getProfiles = async () => {
  const state = await getProfilesState()

  return state.profiles
}

export const getActiveProfileId = async () => {
  const state = await getProfilesState()

  return state.activeProfileId
}

export const setActiveProfileId = async (profileId: string | null) => {
  const state = await getProfilesState()
  const nextActiveProfileId =
    profileId && state.profiles.some((profile) => profile.id === profileId)
      ? profileId
      : state.profiles[0]?.id ?? null

  await saveProfilesState({
    profiles: state.profiles,
    activeProfileId: nextActiveProfileId
  })
}

export const getActiveProfile = async () => {
  const state = await getProfilesState()

  return (
    state.profiles.find((profile) => profile.id === state.activeProfileId) ?? null
  )
}

export const saveProfile = async (profile: ProxyProfile) => {
  const state = await getProfilesState()
  const normalizedProfile = normalizeProfile(profile, "Profile")

  if (!normalizedProfile) {
    throw new Error("Invalid profile payload.")
  }

  const nextProfile: ProxyProfile = {
    ...normalizedProfile,
    updatedAt: Date.now()
  }
  const existingIndex = state.profiles.findIndex(
    ({ id }) => id === normalizedProfile.id
  )
  const nextProfiles = [...state.profiles]
  const existingProfile = nextProfiles[existingIndex]

  if (existingProfile) {
    nextProfile.createdAt = existingProfile.createdAt
    nextProfiles[existingIndex] = nextProfile
  } else {
    nextProfiles.push(nextProfile)
  }

  const nextActiveProfileId = state.activeProfileId ?? nextProfiles[0]?.id ?? null

  await saveProfilesState({
    profiles: nextProfiles,
    activeProfileId: nextActiveProfileId
  })

  return nextProfile
}

export const getProxyEnabled = async () => {
  const stored = await storageGet<{ [ENABLED_KEY]?: unknown }>({
    [ENABLED_KEY]: DEFAULT_PROXY_ENABLED
  })

  return Boolean(stored[ENABLED_KEY])
}

export const deleteProfile = async (profileId: string) => {
  const state = await getProfilesState()
  const profiles = state.profiles.filter(({ id }) => id !== profileId)
  const removedActiveProfile = state.activeProfileId === profileId
  const activeProfileId = removedActiveProfile
    ? profiles[0]?.id ?? null
    : state.activeProfileId

  await storageSet({
    [PROFILES_KEY]: profiles,
    [ACTIVE_PROFILE_ID_KEY]: activeProfileId,
    ...(removedActiveProfile ? { [ENABLED_KEY]: false } : {})
  })

  return { profiles, activeProfileId }
}

export const setProxyEnabled = async (enabled: boolean) => {
  await storageSet({
    [ENABLED_KEY]: enabled
  })
}

export const getProfileDraft = async (): Promise<PopupDraftState | null> => {
  const stored = await storageGet<{ [PROFILE_DRAFT_KEY]?: unknown }>({
    [PROFILE_DRAFT_KEY]: null
  })
  const draftValue = stored[PROFILE_DRAFT_KEY]

  if (!isRecord(draftValue)) {
    return null
  }

  const formState = normalizeDraftFormState(draftValue.formState)

  if (!formState) {
    return null
  }

  return {
    formState,
    updatedAt: normalizeTimestamp(draftValue.updatedAt, Date.now())
  }
}

export const setProfileDraft = async (formState: PopupFormState) => {
  await storageSet({
    [PROFILE_DRAFT_KEY]: {
      formState,
      updatedAt: Date.now()
    } satisfies PopupDraftState
  })
}

export const clearProfileDraft = async () => {
  await storageRemove(PROFILE_DRAFT_KEY)
}

export const getPreferredLanguage = async (): Promise<"en" | "ru" | null> => {
  const stored = await storageGet<{ language?: unknown }>({ [LANGUAGE_KEY]: null })
  return stored.language === "en" || stored.language === "ru" ? stored.language : null
}

export const setPreferredLanguage = async (language: "en" | "ru") => {
  await storageSet({ [LANGUAGE_KEY]: language })
}
