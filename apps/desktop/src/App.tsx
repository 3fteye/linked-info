import { useEffect, useMemo, useState } from "react";
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
import NodeEditor from "./NodeEditor";
import { supportedLanguages, type SupportedLanguage } from "./locales";
import {
  loadDraft,
  loadWorkspace,
  normalizeNodeName,
  saveDraft,
  saveWorkspace,
  type NodeDraft,
  type NodeLayout,
  type NodeReference,
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
  const [draft, setDraft] = useState<NodeDraft | null>(loadDraft);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const currentView = views.find((view) => view.id === activeView) ?? views[0];
  const activeLanguage = i18n.resolvedLanguage ?? i18n.language;
  const normalizedSearch = normalizeNodeName(searchTerm);

  const filteredNodes = useMemo(() => {
    if (normalizedSearch.length === 0) {
      return workspace.nodes;
    }
    return workspace.nodes.filter((node) =>
      normalizeNodeName(node.name).includes(normalizedSearch),
    );
  }, [normalizedSearch, workspace.nodes]);

  useEffect(() => {
    saveWorkspace(workspace);
  }, [workspace]);

  useEffect(() => {
    saveDraft(draft);
  }, [draft]);

  function changeLanguage(language: SupportedLanguage) {
    void i18n.changeLanguage(language);
  }

  function openCreateNode(position = defaultNodePosition(workspace.nodes.length)) {
    setDraft({
      nodeId: null,
      name: "",
      content: "",
      position,
      referenceTargetIds: [],
    });
    setDraftError(null);
  }

  function openEditNode(nodeId: string) {
    const node = workspace.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      return;
    }
    const layout = workspace.layout.find((item) => item.nodeId === nodeId);
    setDraft({
      nodeId,
      name: node.name,
      content: node.content ?? "",
      position: layout ?? defaultNodePosition(workspace.nodes.length),
      referenceTargetIds: workspace.references
        .filter((reference) => reference.sourceNodeId === nodeId)
        .map((reference) => reference.targetNodeId),
    });
    setDraftError(null);
  }

  function updateDraft(nextDraft: NodeDraft) {
    setDraft(nextDraft);
    if (draftError !== null) {
      setDraftError(null);
    }
  }

  function submitDraft() {
    if (draft === null) {
      return;
    }

    const name = draft.name.trim();
    if (name.length === 0) {
      setDraftError(t("validation.nameRequired"));
      return;
    }

    const normalizedName = normalizeNodeName(name);
    const duplicate = workspace.nodes.some(
      (node) =>
        node.id !== draft.nodeId && normalizeNodeName(node.name) === normalizedName,
    );
    if (duplicate) {
      setDraftError(t("validation.nameUnique"));
      return;
    }

    const content = draft.content.length === 0 ? null : draft.content;
    if (draft.nodeId === null) {
      const nodeId = crypto.randomUUID();
      setWorkspace((current) => ({
        ...current,
        nodes: [...current.nodes, { id: nodeId, name, content }],
        layout: [
          ...current.layout,
          { nodeId, x: draft.position.x, y: draft.position.y },
        ],
      }));
    } else {
      setWorkspace((current) => ({
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === draft.nodeId ? { ...node, name, content } : node,
        ),
      }));
    }

    setDraft(null);
    setDraftError(null);
  }

  function updateLayout(layout: NodeLayout[]) {
    setWorkspace((current) => ({ ...current, layout }));
  }

  function updateReferences(references: NodeReference[]) {
    setWorkspace((current) => ({ ...current, references }));
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
              <span className="item-count">
                {t("workspace.itemCount", { count: filteredNodes.length })}
              </span>
              <button
                className="primary-button header-create-button"
                onClick={() => openCreateNode()}
                type="button"
              >
                <Plus size={16} />
                <span>{t("actions.newNode")}</span>
              </button>
            </div>
          )}
        </header>

        <div
          className="workspace-content"
          data-editor-open={activeView !== "settings" && draft !== null}
        >
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
              labels={{
                createNode: t("actions.newNode"),
                editNode: t("actions.editNode"),
                empty: t("empty.canvas"),
                sourceHandle: t("references.sourceHandle"),
                targetHandle: t("references.targetHandle"),
              }}
              layout={workspace.layout}
              nodes={workspace.nodes}
              onCreateNode={openCreateNode}
              onEditNode={openEditNode}
              onLayoutChange={updateLayout}
              onReferencesChange={updateReferences}
              references={workspace.references}
              searchTerm={searchTerm}
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
                      onClick={() => openEditNode(node.id)}
                      type="button"
                    >
                      <strong>{node.name}</strong>
                      <span>{node.content ?? t("nodes.noContent")}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          {activeView !== "settings" && draft !== null && (
            <NodeEditor
              draft={draft}
              error={draftError}
              labels={{
                createTitle: t("editor.createTitle"),
                editTitle: t("editor.editTitle"),
                name: t("editor.name"),
                namePlaceholder: t("editor.namePlaceholder"),
                content: t("editor.content"),
                contentPlaceholder: t("editor.contentPlaceholder"),
                save: t("actions.save"),
                cancel: t("actions.cancel"),
                close: t("actions.close"),
              }}
              onCancel={() => {
                setDraft(null);
                setDraftError(null);
              }}
              onChange={updateDraft}
              onSubmit={submitDraft}
            />
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
