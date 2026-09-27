import i18n from "i18next"
import { initReactI18next } from "react-i18next"

import en from "./locales/en.json"
import ru from "./locales/ru.json"
import { getPreferredLanguage, setPreferredLanguage } from "./storage"

export type Language = "en" | "ru"
export type TranslationKey = keyof typeof en

// Check that both dictionaries have the same keys at compile time.
const russian: Record<TranslationKey, string> = ru
const english: Record<keyof typeof ru, string> = en

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation"
    resources: { translation: typeof en }
  }
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: english },
    ru: { translation: russian }
  },
  lng: "en",
  fallbackLng: "en",
  supportedLngs: ["en", "ru"],
  initAsync: false,
  interpolation: { escapeValue: false }
})

export const resolveLanguage = (locale: string): Language =>
  locale.toLowerCase().split(/[-_]/u)[0] === "ru" ? "ru" : "en"

export const initializeLanguage = async () => {
  const preferred = await getPreferredLanguage().catch(() => null)
  const browserLanguage = chrome.i18n?.getUILanguage() ?? navigator.language
  await i18n.changeLanguage(preferred ?? resolveLanguage(browserLanguage))
}

export const changeLanguage = async (language: Language) => {
  await setPreferredLanguage(language)
  await i18n.changeLanguage(language)
}

export type LocalizedMessage = {
  key: TranslationKey
  values?: Record<string, string | number | LocalizedMessage>
}

export const message = (
  key: TranslationKey,
  values?: LocalizedMessage["values"]
): LocalizedMessage => ({ key, values })

export const translateMessage = (value: LocalizedMessage): string =>
  i18n.t(value.key, Object.fromEntries(
    Object.entries(value.values ?? {}).map(([key, item]) => [
      key, typeof item === "object" ? translateMessage(item) : item
    ])
  ))

export class LocalizedError extends Error {
  constructor(public readonly localizedMessage: LocalizedMessage) {
    super(localizedMessage.key)
    this.name = "LocalizedError"
  }
}

export const getErrorFeedback = (
  error: unknown,
  fallback: TranslationKey
): LocalizedMessage => {
  if (error instanceof LocalizedError) return error.localizedMessage
  if (error instanceof Error && error.message) {
    return message("errorDetails", { message: message(fallback), details: error.message })
  }
  return message(fallback)
}

export default i18n
