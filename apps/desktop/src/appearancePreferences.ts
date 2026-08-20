export const appearanceThemePreferenceKey =
  "linked-info.appearance.theme.v1";

export const appearanceThemes = ["mint-light", "starry-dark"] as const;

export type AppearanceTheme = (typeof appearanceThemes)[number];

const defaultAppearanceTheme: AppearanceTheme = "starry-dark";

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadAppearanceTheme(
  storage: PreferenceStorage | null,
): AppearanceTheme {
  if (storage === null) {
    return defaultAppearanceTheme;
  }
  try {
    const stored = storage.getItem(appearanceThemePreferenceKey);
    return appearanceThemes.includes(stored as AppearanceTheme)
      ? (stored as AppearanceTheme)
      : defaultAppearanceTheme;
  } catch {
    return defaultAppearanceTheme;
  }
}

export function saveAppearanceTheme(
  storage: PreferenceStorage | null,
  theme: AppearanceTheme,
): void {
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(appearanceThemePreferenceKey, theme);
  } catch {
    // 界面主题是可选偏好；本地存储受限时不能阻断应用。
  }
}
