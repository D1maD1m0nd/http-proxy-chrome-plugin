export interface ProxySettings {
  proxyHost: string
  proxyPort: number
  username: string
  password: string
  proxyDomains: string[]
  directDomains: string[]
}

export interface ProxyProfile extends ProxySettings {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

export interface PopupFormState {
  profileName: string
  proxyHost: string
  proxyPort: string
  username: string
  password: string
  proxyDomainsText: string
  directDomainsText: string
}

export interface ProfilesState {
  profiles: ProxyProfile[]
  activeProfileId: string | null
}

export interface BackgroundMessage {
  type: "SYNC_PROXY_STATE"
}

export interface BackgroundResponse {
  ok: boolean
  error?: string
}
