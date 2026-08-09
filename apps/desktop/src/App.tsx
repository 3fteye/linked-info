import { useState } from "react";
import { Database, FileText, Languages, Link2, Network, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { supportedLanguages, type SupportedLanguage } from "./locales";
import "./App.css";

type ViewId = "canvas" | "nodes" | "settings";

const views = [
  {
    id: "canvas" as const,
    labelKey: "navigation.canvas",
    emptyKey: "empty.canvas",
    icon: Network,
  },
  {
    id: "nodes" as const,
    labelKey: "navigation.nodes",
    emptyKey: "empty.nodes",
    icon: FileText,
  },
];

const languageLabelKeys: Record<SupportedLanguage, string> = {
  "zh-CN": "language.zhCN",
  "en-US": "language.enUS",
};

function App() {
  const { t, i18n } = useTranslation();
  const [activeView, setActiveView] = useState<ViewId>("canvas");
  const currentView = views.find((view) => view.id === activeView) ?? views[0];
  const EmptyIcon = currentView.icon;
  const activeLanguage = i18n.resolvedLanguage ?? i18n.language;

  function changeLanguage(language: SupportedLanguage) {
    void i18n.changeLanguage(language);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Link2 size={18} strokeWidth={2.2} />
          </span>
          <span>{t("app.name")}</span>
        </div>

        <nav className="primary-nav" aria-label={t("workspace.label")}>
          {views.map(({ id, labelKey, icon: Icon }) => (
            <button
              className="nav-item"
              data-active={activeView === id}
              key={id}
              onClick={() => setActiveView(id)}
              type="button"
            >
              <Icon size={18} />
              <span>{t(labelKey)}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="storage-status" title={t("storage.title")}>
            <Database size={15} />
            <span>{t("storage.development")}</span>
          </div>
          <button
            className="nav-item"
            data-active={activeView === "settings"}
            onClick={() => setActiveView("settings")}
            type="button"
          >
            <Settings size={18} />
            <span>{t("navigation.settings")}</span>
          </button>
        </div>
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div>
            <p className="section-label">{t("workspace.label")}</p>
            <h1>
              {activeView === "settings"
                ? t("navigation.settings")
                : t(currentView.labelKey)}
            </h1>
          </div>
          {activeView !== "settings" && (
            <span className="item-count">{t("workspace.itemCount", { count: 0 })}</span>
          )}
        </header>

        {activeView === "settings" ? (
          <section className="settings-panel">
            <div className="setting-row">
              <div className="setting-label">
                <Languages size={18} />
                <span>{t("settings.language")}</span>
              </div>
              <div className="segmented-control">
                {supportedLanguages.map((language) => (
                  <button
                    data-active={activeLanguage === language}
                    key={language}
                    onClick={() => changeLanguage(language)}
                    type="button"
                  >
                    {t(languageLabelKeys[language])}
                  </button>
                ))}
              </div>
            </div>
          </section>
        ) : (
          <section className="empty-state" aria-live="polite">
            <EmptyIcon size={30} strokeWidth={1.6} />
            <h2>{t(currentView.emptyKey)}</h2>
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
