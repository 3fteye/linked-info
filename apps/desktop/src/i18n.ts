import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import {
  resources,
  supportedLanguages,
  type SupportedLanguage,
} from "./locales";

const languageStorageKey = "linked-info.language";

function isSupportedLanguage(value: string | null): value is SupportedLanguage {
  return supportedLanguages.some((language) => language === value);
}

function resolveInitialLanguage(): SupportedLanguage {
  const savedLanguage = localStorage.getItem(languageStorageKey);
  if (isSupportedLanguage(savedLanguage)) {
    return savedLanguage;
  }

  return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

void i18n.use(initReactI18next).init({
  resources,
  lng: resolveInitialLanguage(),
  fallbackLng: "zh-CN",
  interpolation: {
    escapeValue: false,
  },
});

i18n.on("languageChanged", (language) => {
  if (!isSupportedLanguage(language)) {
    return;
  }

  localStorage.setItem(languageStorageKey, language);
  document.documentElement.lang = language;
});

document.documentElement.lang = i18n.resolvedLanguage ?? "zh-CN";

export default i18n;
