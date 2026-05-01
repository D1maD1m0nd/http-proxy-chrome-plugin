import { useEffect, useMemo, useState } from "react"

import { DEFAULT_SETTINGS } from "~src/defaultSettings"
import {
  createProfileDraft,
  getProfilesState,
  getProxyEnabled,
  saveProfile,
  setActiveProfileId,
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

const NEW_PROFILE_ID = "__new_profile__"

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
  directDomainsText: profile.directDomains.join("\n")
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
      directDomains: parseDomainList(formState.directDomainsText)
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
  const [proxyEnabled, setProxyEnabledState] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isBusy, setIsBusy] = useState(false)
  const [feedback, setFeedback] = useState<FeedbackState>()

  useEffect(() => {
    let isMounted = true

    void Promise.all([getProfilesState(), getProxyEnabled()])
      .then(([profilesState, enabled]) => {
        if (!isMounted) {
          return
        }

        setProfiles(profilesState.profiles)
        setActiveProfileIdState(profilesState.activeProfileId)
        setProxyEnabledState(enabled)
        setNewProfileName(getNextProfileName(profilesState.profiles.length))

        const initialProfile =
          profilesState.profiles.find(
            ({ id }) => id === profilesState.activeProfileId
          ) ?? profilesState.profiles[0]

        if (initialProfile) {
          setSelectedProfileId(initialProfile.id)
          setFormState(createFormState(initialProfile))
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

  const isDraftProfile = selectedProfileId === NEW_PROFILE_ID
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

  const startDraftProfile = (preferredName?: string) => {
    const draftName = (preferredName ?? newProfileName).trim() || newProfileName

    setSelectedProfileId(NEW_PROFILE_ID)
    setFormState(
      createFormState({
        name: draftName,
        ...DEFAULT_SETTINGS
      })
    )
    setFeedback(undefined)
  }

  const selectProfile = (profile: ProxyProfile) => {
    setSelectedProfileId(profile.id)
    setFormState(createFormState(profile))
    setFeedback(undefined)
  }

  const persistCurrentProfile = async (options: {
    activateAfterSave: boolean
    requireCredentials: boolean
  }) => {
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
    const nextEnabled = !proxyEnabled

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
        await setProxyEnabled(false).catch(() => undefined)
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

          <button
            disabled={isLoading || isBusy}
            onClick={() => startDraftProfile()}
            style={miniButtonStyle}>
            Add profile
          </button>
        </div>

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

          {isDraftProfile ? (
            <div
              style={{
                ...profileButtonStyle,
                borderColor: "#1d5f8c",
                backgroundColor: "#f5f9fc"
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
                  {formState.profileName || "New profile"}
                </span>
                <span style={tagStyle("draft")}>Draft</span>
              </div>
              <span
                style={{
                  marginTop: 4,
                  fontSize: 11,
                  color: "#5b6472",
                  textAlign: "left"
                }}>
                Save or apply to add this profile to the list.
              </span>
            </div>
          ) : null}
        </div>
      </section>

      <button
        disabled={isLoading || isBusy}
        onClick={() => void handleToggleProxy()}
        style={{
          ...primaryButtonStyle,
          backgroundColor: proxyEnabled ? "#8a2d3b" : "#1d5f8c"
        }}>
        {proxyEnabled ? "Disable Proxy" : "Enable Proxy"}
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

        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>
            Domains via proxy
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
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))"
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
      ) : !hasProfiles && !isDraftProfile ? (
        renderOnboarding()
      ) : (
        renderEditor()
      )}

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
