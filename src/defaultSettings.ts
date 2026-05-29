import type { ProxySettings } from "~src/types"

export const DEFAULT_PROXY_DOMAINS = [
  ".openai.com",
  ".chatgpt.com",
  ".oaistatic.com",
  ".oaiusercontent.com",
  ".github.com",
  ".githubusercontent.com",
  ".githubassets.com",
  ".github.io",
  ".youtube.com",
  ".ytimg.com",
  ".googlevideo.com",
  ".google.com",
  ".gstatic.com",
  ".googleapis.com"
]

export const DEFAULT_DIRECT_DOMAINS = [
  ".snq.ru",
  ".company.local",
  ".corp",
  "*.internal.*"
]

export const LOCAL_DIRECT_PATTERNS = [
  "127.*",
  "10.*",
  "192.168.*",
  "172.16.*",
  "172.17.*",
  "172.18.*",
  "172.19.*",
  "172.20.*",
  "172.21.*",
  "172.22.*",
  "172.23.*",
  "172.24.*",
  "172.25.*",
  "172.26.*",
  "172.27.*",
  "172.28.*",
  "172.29.*",
  "172.30.*",
  "172.31.*"
]

export const DEFAULT_SETTINGS: ProxySettings = {
  proxyHost: "",
  proxyPort: 443,
  username: "",
  password: "",
  proxyDomains: [...DEFAULT_PROXY_DOMAINS],
  directDomains: [...DEFAULT_DIRECT_DOMAINS],
  disableProxyDomainRouting: false
}

export const DEFAULT_PROFILE_NAME = "Default profile"
export const DEFAULT_PROXY_ENABLED = false
