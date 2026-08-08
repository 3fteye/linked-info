import { useState } from "react";
import {
  Database,
  FileText,
  Link2,
  Network,
  Settings,
  Shapes,
} from "lucide-react";
import "./App.css";

type ViewId = "information" | "types" | "relations" | "settings";

const views = [
  {
    id: "information" as const,
    label: "信息",
    emptyLabel: "还没有信息记录",
    icon: FileText,
  },
  {
    id: "types" as const,
    label: "信息类型",
    emptyLabel: "还没有信息类型",
    icon: Shapes,
  },
  {
    id: "relations" as const,
    label: "关系类型",
    emptyLabel: "还没有关系类型",
    icon: Network,
  },
];

function App() {
  const [activeView, setActiveView] = useState<ViewId>("information");
  const currentView =
    views.find((view) => view.id === activeView) ?? views[0];
  const EmptyIcon = currentView.icon;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Link2 size={18} strokeWidth={2.2} />
          </span>
          <span>关联信息</span>
        </div>

        <nav className="primary-nav" aria-label="主要导航">
          {views.map(({ id, label, icon: Icon }) => (
            <button
              className="nav-item"
              data-active={activeView === id}
              key={id}
              onClick={() => setActiveView(id)}
              type="button"
            >
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="storage-status" title="当前后端">
            <Database size={15} />
            <span>开发存储</span>
          </div>
          <button
            className="nav-item"
            data-active={activeView === "settings"}
            onClick={() => setActiveView("settings")}
            type="button"
          >
            <Settings size={18} />
            <span>设置</span>
          </button>
        </div>
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div>
            <p className="section-label">工作区</p>
            <h1>{activeView === "settings" ? "设置" : currentView.label}</h1>
          </div>
          {activeView !== "settings" && <span className="item-count">0 条</span>}
        </header>

        <section className="empty-state" aria-live="polite">
          {activeView === "settings" ? (
            <>
              <Settings size={30} strokeWidth={1.6} />
              <h2>尚未配置后端</h2>
            </>
          ) : (
            <>
              <EmptyIcon size={30} strokeWidth={1.6} />
              <h2>{currentView.emptyLabel}</h2>
            </>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
