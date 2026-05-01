import { generatePacScript } from "~src/pac"
import type { ProxySettings } from "~src/types"

const getLastError = () => chrome.runtime.lastError?.message

const setProxyConfig = (value: chrome.proxy.ProxyConfig) =>
  new Promise<void>((resolve, reject) => {
    chrome.proxy.settings.set(
      {
        value,
        scope: "regular"
      },
      () => {
        const errorMessage = getLastError()

        if (errorMessage) {
          reject(new Error(errorMessage))
          return
        }

        resolve()
      }
    )
  })

export const enableProxy = async (settings: ProxySettings) => {
  await setProxyConfig({
    mode: "pac_script",
    pacScript: {
      data: generatePacScript(settings)
    }
  })
}

export const disableProxy = async () => {
  await new Promise<void>((resolve, reject) => {
    chrome.proxy.settings.clear(
      {
        scope: "regular"
      },
      () => {
        const errorMessage = getLastError()

        if (errorMessage) {
          reject(new Error(errorMessage))
          return
        }

        resolve()
      }
    )
  })
}

export const applyProxySettings = async (settings: ProxySettings) => {
  await enableProxy(settings)
}
