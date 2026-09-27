import { getActiveProfile } from "./storage"

const MAX_AUTH_ATTEMPTS = 3
const authAttempts = new Map<string, number>()

const getAttemptKey = (
  details: chrome.webRequest.OnAuthRequiredDetails
) => {
  const challengerHost = details.challenger?.host ?? "unknown-host"
  const challengerPort = details.challenger?.port ?? 0

  return `${details.requestId}:${challengerHost}:${challengerPort}`
}

export const clearAuthAttemptsForRequest = (requestId: string) => {
  const keyPrefix = `${requestId}:`

  for (const key of authAttempts.keys()) {
    if (key.startsWith(keyPrefix)) {
      authAttempts.delete(key)
    }
  }
}

export const handleProxyAuthRequired = async (
  details: chrome.webRequest.OnAuthRequiredDetails,
  callback: (response: chrome.webRequest.BlockingResponse) => void
) => {
  try {
    if (!details.isProxy || !details.challenger) {
      callback({})
      return
    }

    const activeProfile = await getActiveProfile()

    if (!activeProfile) {
      callback({ cancel: true })
      return
    }

    const challengerHost = details.challenger.host.toLowerCase()
    const configuredHost = activeProfile.proxyHost.toLowerCase()

    if (
      challengerHost !== configuredHost ||
      details.challenger.port !== activeProfile.proxyPort
    ) {
      callback({})
      return
    }

    const attemptKey = getAttemptKey(details)
    const nextAttemptCount = (authAttempts.get(attemptKey) ?? 0) + 1

    authAttempts.set(attemptKey, nextAttemptCount)

    if (nextAttemptCount > MAX_AUTH_ATTEMPTS) {
      callback({ cancel: true })
      return
    }

    if (!activeProfile.username.trim() || !activeProfile.password) {
      callback({ cancel: true })
      return
    }

    callback({
      authCredentials: {
        username: activeProfile.username,
        password: activeProfile.password
      }
    })
  } catch {
    callback({ cancel: true })
  }
}
