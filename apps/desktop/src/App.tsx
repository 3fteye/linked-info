import { useEffect, useMemo, useRef, useState } from "react";
import {
  Database,
  FileText,
  Languages,
  Link2,
  Network,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import GraphCanvas from "./GraphCanvas";
import { supportedLanguages, type SupportedLanguage } from "./locales";
import {
  isUnnamedNode,
  loadWorkspace,
  normalizeNodeName,
  saveWorkspace,
  type NodeLayout,
  type NodeReference,
  type WorkspaceSnapshot,
} from "./workspaceStore";
import "./App.css";

type ViewId = "canvas" | "nodes" | "settings";

const views = [
  {
    id: "canvas" as const,
    labelKey: "navigation.canvas",
    icon: Network,
  },
  {
    id: "nodes" as const,
    labelKey: "navigation.nodes",
    icon: FileText,
  },
];

const languageLabelKeys: Record<SupportedLanguage, string> = {
  "zh-CN": "language.zhCN",
  "en-US": "language.enUS",
};

function defaultNodePosition(index: number): { x: number; y: number } {
  return {
    x: 80 + (index % 4) * 300,
    y: 80 + Math.floor(index / 4) * 210,
  };
}

function App() {
  const { t, i18n } = useTranslation();
  const [activeView, setActiveView] = useState<ViewId>("canvas");
  const [workspace, setWorkspace] = useState(loadWorkspace);
  const workspaceRef = useRef(workspace);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [unnamedOnly, setUnnamedOnly] = useState(false);
  const currentView = views.find((view) => view.id === activeView) ?? views[0];
  const activeLanguage = i18n.resolvedLanguage ?? i18n.language;
  const normalizedSearch = normalizeNodeName(searchTerm);

  const filteredNodes = useMemo(() => {
    return workspace.nodes.filter(
      (node) =>
        node.id === editingNodeId ||
        ((!unnamedOnly || isUnnamedNode(node)) &&
          (normalizedSearch.length === 0 ||
            normalizeNodeName(node.name ?? "").includes(normalizedSearch))),
    );
  }, [editingNodeId, normalizedSearch, unnamedOnly, workspace.nodes]);

  const nameConflictNodeIds = useMemo(() => {
    const idsByName = new Map<string, string[]>();
    for (const node of workspace.nodes) {
      const normalizedName = normalizeNodeName(node.name ?? "");
      if (normalizedName.length === 0) {
        continue;
      }
      const ids = idsByName.get(normalizedName) ?? [];
      ids.push(node.id);
      idsByName.set(normalizedName, ids);
    }

    return new Set(
      [...idsByName.values()].filter((ids) => ids.length > 1).flat(),
    );
  }, [workspace.nodes]);

  useEffect(() => {
    workspaceRef.current = workspace;
    const saveTimer = window.setTimeout(() => saveWorkspace(workspace), 300);
    return () => window.clearTimeout(saveTimer);
  }, [workspace]);

  useEffect(() => {
    const flushLocalWorkspace = () => saveWorkspace(workspaceRef.current);
    window.addEventListener("beforeunload", flushLocalWorkspace);
    return () => {
      window.removeEventListener("beforeunload", flushLocalWorkspace);
      flushLocalWorkspace();
    };
  }, []);

  function changeLanguage(language: SupportedLanguage) {
    void i18n.changeLanguage(language);
  }

  function updateWorkspace(
    updater: (current: WorkspaceSnapshot) => WorkspaceSnapshot,
    flushImmediately = false,
  ) {
    setWorkspace((current) => {
      const next = updater(current);
      workspaceRef.current = next;
      if (flushImmediately) {
        saveWorkspace(next);
      }
      return next;
    });
  }

  function createNode(position = defaultNodePosition(workspace.nodes.length)) {
    const nodeId = crypto.randomUUID();
    updateWorkspace(
      (current) => ({
        ...current,
        nodes: [...current.nodes, { id: nodeId, name: null, content: null }],
        layout: [...current.layout, { nodeId, x: position.x, y: position.y }],
      }),
      true,
    );
    setActiveView("canvas");
    setEditingNodeId(nodeId);
  }

  function editNode(nodeId: string) {
    if (workspace.nodes.some((node) => node.id === nodeId)) {
      setActiveView("canvas");
      window.setTimeout(() => setEditingNodeId(nodeId), 0);
    }
  }

  function updateNodeName(nodeId: string, name: string) {
    updateWorkspace((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === nodeId ? { ...node, name: name.length === 0 ? null : name } : node,
      ),
    }));
  }

  function updateNodeContent(nodeId: string, content: string) {
    updateWorkspace((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === nodeId
          ? { ...node, content: content.length === 0 ? null : content }
          : node,
      ),
    }));
  }

  function commitNode(nodeId: string) {
    updateWorkspace(
      (current) => ({
        ...current,
        nodes: current.nodes.map((node) => {
          if (node.id !== nodeId) {
            return node;
          }
          return {
            ...node,
            name: node.name?.trim() || null,
          };
        }),
      }),
      true,
    );
    if (!nameConflictNodeIds.has(nodeId)) {
      setEditingNodeId((current) => (current === nodeId ? null : current));
    }
  }

  function updateLayout(layout: NodeLayout[]) {
    updateWorkspace((current) => ({ ...current, layout }), true);
  }

  function updateReferences(references: NodeReference[]) {
    updateWorkspace((current) => ({ ...current, references }), true);
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
            <span>{t("storage.local")}</span>
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
          <div className="workspace-heading">
            <p className="section-label">{t("workspace.label")}</p>
            <h1>
              {activeView === "settings"
                ? t("navigation.settings")
                : t(currentView.labelKey)}
            </h1>
          </div>

          {activeView !== "settings" && (
            <div className="workspace-actions">
              <label className="search-field">
                <Search aria-hidden="true" size={16} />
                <span className="visually-hidden">{t("search.label")}</span>
                <input
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder={t("search.placeholder")}
                  value={searchTerm}
                />
              </label>
              <label className="unnamed-filter">
                <input
                  aria-label={t("filters.unnamedOnly")}
                  checked={unnamedOnly}
                  onChange={(event) => setUnnamedOnly(event.target.checked)}
                  type="checkbox"
                />
                <span>{t("filters.unnamedOnly")}</span>
              </label>
              <span className="item-count">
                {t("workspace.itemCount", { count: filteredNodes.length })}
              </span>
              <button
                className="primary-button header-create-button"
                onClick={() => createNode()}
                type="button"
              >
                <Plus size={16} />
                <span>{t("actions.newNode")}</span>
              </button>
            </div>
          )}
        </header>

        <div className="workspace-content">
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
          ) : activeView === "canvas" ? (
            <GraphCanvas
              editingNodeId={editingNodeId}
              labels={{
                createNode: t("actions.newNode"),
                content: t("editor.content"),
                contentPlaceholder: t("editor.contentPlaceholder"),
                editNode: t("actions.editNode"),
                empty: t("empty.canvas"),
                name: t("editor.name"),
                nameConflict: t("validation.nameUnique"),
                namePlaceholder: t("editor.namePlaceholder"),
                sourceHandle: t("references.sourceHandle"),
                targetHandle: t("references.targetHandle"),
                unnamed: t("nodes.unnamed"),
              }}
              layout={workspace.layout}
              nameConflictNodeIds={nameConflictNodeIds}
              nodes={workspace.nodes}
              onCreateNode={createNode}
              onEditNode={editNode}
              onLayoutChange={updateLayout}
              onNodeCommit={commitNode}
              onNodeContentChange={updateNodeContent}
              onNodeNameChange={updateNodeName}
              onReferencesChange={updateReferences}
              references={workspace.references}
              searchTerm={searchTerm}
              unnamedOnly={unnamedOnly}
            />
          ) : (
            <section className="node-list-view" aria-live="polite">
              {filteredNodes.length === 0 ? (
                <div className="list-empty">{t("empty.nodes")}</div>
              ) : (
                <div className="node-list">
                  {filteredNodes.map((node) => (
                    <button
                      className="node-list-row"
                      key={node.id}
                      onClick={() => editNode(node.id)}
                      type="button"
                    >
                      <strong data-unnamed={isUnnamedNode(node)}>
                        {node.name ?? t("nodes.unnamed")}
                      </strong>
                      <span>{node.content ?? t("nodes.noContent")}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

        </div>
      </main>
    </div>
  );
}

export default App;
