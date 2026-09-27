import { defineBackground } from "wxt/utils/define-background"

import {
  clearAuthAttemptsForRequest,
  handleProxyAuthRequired
} from "../src/auth"
import { applyProxySettings, disableProxy } from "../src/proxy"
import {
  getActiveProfile,
  getProxyEnabled,
  setProxyEnabled
} from "../src/storage"
import type { BackgroundMessage, BackgroundResponse } from "../src/types"

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Unknown background error."

const updateBadge = async (enabled: boolean) => {
  await chrome.action.setBadgeText({
    text: enabled ? "ON" : "OFF"
  })

  await chrome.action.setBadgeBackgroundColor({
    color: enabled ? "#1f8f5f" : "#6b7280"
  })

  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({
      color: "#ffffff"
    })
  }
}

const syncProxyState = async () => {
  const [enabled, activeProfile] = await Promise.all([
    getProxyEnabled(),
    getActiveProfile()
  ])

  if (enabled && activeProfile) {
    await applyProxySettings(activeProfile)
  } else {
    if (enabled && !activeProfile) {
      await setProxyEnabled(false)
    }

    await disableProxy()
  }

  await updateBadge(enabled && Boolean(activeProfile))
}

const sendSuccess = (
  sendResponse: (response: BackgroundResponse) => void
) => {
  sendResponse({ ok: true })
}

const sendFailure = (
  sendResponse: (response: BackgroundResponse) => void,
  error: unknown
) => {
  sendResponse({
    ok: false,
    error: getErrorMessage(error)
  })
}

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    void syncProxyState()
  })

  chrome.runtime.onStartup.addListener(() => {
    void syncProxyState()
  })

  chrome.runtime.onMessage.addListener((message: BackgroundMessage, _, sendResponse) => {
    if (message?.type !== "SYNC_PROXY_STATE") {
      return false
    }

    void syncProxyState()
      .then(() => sendSuccess(sendResponse))
      .catch((error) => sendFailure(sendResponse, error))

    return true
  })

  chrome.webRequest.onAuthRequired.addListener(
    (details, asyncCallback) => {
      if (asyncCallback) {
        void handleProxyAuthRequired(details, asyncCallback)
      }
      return undefined
    },
    {
      urls: ["<all_urls>"]
    },
    ["asyncBlocking"]
  )

  chrome.webRequest.onCompleted.addListener(
    (details) => {
      clearAuthAttemptsForRequest(details.requestId)
    },
    {
      urls: ["<all_urls>"]
    }
  )

  chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      clearAuthAttemptsForRequest(details.requestId)
    },
    {
      urls: ["<all_urls>"]
    }
  )

  void syncProxyState()
})
