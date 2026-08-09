import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArchiveRestore,
  Database,
  Download,
  FileText,
  Filter,
  Languages,
  Link2,
  Network,
  Plus,
  Search,
  Settings,
  Upload,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import GraphCanvas from "./GraphCanvas";
import { supportedLanguages, type SupportedLanguage } from "./locales";
import {
  isUnnamedNode,
  localWorkspacePersistence,
  normalizeNodeName,
  type InformationNode,
  type NodeLayout,
  type NodeReference,
  type WorkspaceSnapshot,
} from "./workspaceStore";
import {
  parseWorkspaceExport,
  serializeWorkspaceExport,
  type WorkspaceImportFailure,
} from "./workspaceBackup";
import {
  exportWorkspaceFile,
  importWorkspaceFile,
} from "./workspaceFileBridge";
import "./App.css";

type ViewId = "canvas" | "nodes" | "settings";

interface PendingWorkspaceReplacement {
  kind: "import" | "recovery";
  sourceName: string;
  workspace: WorkspaceSnapshot;
}

const importFailureTranslationKeys: Record<WorkspaceImportFailure, string> = {
  invalidJson: "backup.errors.invalidJson",
  invalidFormat: "backup.errors.invalidFormat",
  unsupportedVersion: "backup.errors.unsupportedVersion",
  invalidWorkspace: "backup.errors.invalidWorkspace",
};

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

function compactContent(content: string | null, maxLength = 32): string {
  const compacted = (content ?? "").replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) {
    return compacted;
  }
  return `${compacted.slice(0, maxLength - 1)}…`;
}

function nodeFilterLabel(
  node: InformationNode,
  unnamedLabel: string,
  noContentLabel: string,
): string {
  if (node.name !== null) {
    return node.name;
  }

  const summary = compactContent(node.content);
  return `${unnamedLabel} · ${summary || noContentLabel}`;
}

function App() {
  const { t, i18n } = useTranslation();
  const [activeView, setActiveView] = useState<ViewId>("canvas");
  const [workspace, setWorkspace] = useState(() => localWorkspacePersistence.load());
  const workspaceRef = useRef(workspace);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [unnamedOnly, setUnnamedOnly] = useState(false);
  const [referenceFilterNodeIds, setReferenceFilterNodeIds] = useState<string[]>([]);
  const [pendingWorkspaceReplacement, setPendingWorkspaceReplacement] =
    useState<PendingWorkspaceReplacement | null>(null);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [recoveryAvailable, setRecoveryAvailable] = useState(
    () => localWorkspacePersistence.loadRecovery() !== null,
  );
  const currentView = views.find((view) => view.id === activeView) ?? views[0];
  const activeLanguage = i18n.resolvedLanguage ?? i18n.language;
  const normalizedSearch = normalizeNodeName(searchTerm);

  const referencedTargetIdsBySource = useMemo(() => {
    const targetIdsBySource = new Map<string, Set<string>>();
    for (const reference of workspace.references) {
      const targetIds = targetIdsBySource.get(reference.sourceNodeId) ?? new Set<string>();
      targetIds.add(reference.targetNodeId);
      targetIdsBySource.set(reference.sourceNodeId, targetIds);
    }
    return targetIdsBySource;
  }, [workspace.references]);

  const filteredNodes = useMemo(() => {
    return workspace.nodes.filter(
      (node) =>
        (!unnamedOnly || isUnnamedNode(node)) &&
          (normalizedSearch.length === 0 ||
            normalizeNodeName(node.name ?? "").includes(normalizedSearch)) &&
          referenceFilterNodeIds.every((targetNodeId) =>
            referencedTargetIdsBySource.get(node.id)?.has(targetNodeId),
          ),
    );
  }, [
    normalizedSearch,
    referenceFilterNodeIds,
    referencedTargetIdsBySource,
    unnamedOnly,
    workspace.nodes,
  ]);

  const selectedReferenceFilterNodes = useMemo(() => {
    const nodesById = new Map(workspace.nodes.map((node) => [node.id, node]));
    return referenceFilterNodeIds
      .map((nodeId) => nodesById.get(nodeId))
      .filter((node): node is InformationNode => node !== undefined);
  }, [referenceFilterNodeIds, workspace.nodes]);

  const availableReferenceFilterNodes = useMemo(() => {
    const selectedIds = new Set(referenceFilterNodeIds);
    return workspace.nodes
      .filter((node) => !selectedIds.has(node.id))
      .sort((left, right) =>
        nodeFilterLabel(left, t("nodes.unnamed"), t("nodes.noContent")).localeCompare(
          nodeFilterLabel(right, t("nodes.unnamed"), t("nodes.noContent")),
          activeLanguage,
        ),
      );
  }, [activeLanguage, referenceFilterNodeIds, t, workspace.nodes]);

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
    const saveTimer = window.setTimeout(
      () => localWorkspacePersistence.save(workspace),
      300,
    );
    return () => window.clearTimeout(saveTimer);
  }, [workspace]);

  useEffect(() => {
    const flushLocalWorkspace = () =>
      localWorkspacePersistence.save(workspaceRef.current);
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
        localWorkspacePersistence.save(next);
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

  function deleteNode(nodeId: string) {
    updateWorkspace(
      (current) => ({
        nodes: current.nodes.filter((node) => node.id !== nodeId),
        layout: current.layout.filter((item) => item.nodeId !== nodeId),
        references: current.references.filter(
          (reference) =>
            reference.sourceNodeId !== nodeId && reference.targetNodeId !== nodeId,
        ),
      }),
      true,
    );
    setEditingNodeId((current) => (current === nodeId ? null : current));
    setReferenceFilterNodeIds((current) =>
      current.filter((currentNodeId) => currentNodeId !== nodeId),
    );
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

  function toggleReferenceFilter(nodeId: string) {
    if (!workspace.nodes.some((node) => node.id === nodeId)) {
      return;
    }

    setReferenceFilterNodeIds((current) =>
      current.includes(nodeId)
        ? current.filter((currentNodeId) => currentNodeId !== nodeId)
        : [...current, nodeId],
    );
  }

  async function exportWorkspace() {
    setBackupStatus(null);
    try {
      const date = new Date().toISOString().slice(0, 10);
      const exported = await exportWorkspaceFile(
        serializeWorkspaceExport(workspaceRef.current),
        `linked-info-${date}.json`,
      );
      if (exported) {
        setBackupStatus(t("backup.exportSuccess"));
      }
    } catch {
      setBackupStatus(t("backup.exportFailed"));
    }
  }

  async function chooseWorkspaceImport() {
    setBackupStatus(null);
    try {
      const file = await importWorkspaceFile();
      if (file === null) {
        return;
      }
      const result = parseWorkspaceExport(file.text);
      if (!result.ok) {
        setBackupStatus(t(importFailureTranslationKeys[result.reason]));
        return;
      }
      setPendingWorkspaceReplacement({
        kind: "import",
        sourceName: file.name,
        workspace: result.workspace,
      });
    } catch {
      setBackupStatus(t("backup.importFailed"));
    }
  }

  function chooseRecoveryWorkspace() {
    setBackupStatus(null);
    const recovery = localWorkspacePersistence.loadRecovery();
    if (recovery === null) {
      setRecoveryAvailable(false);
      setBackupStatus(t("backup.recoveryUnavailable"));
      return;
    }
    setPendingWorkspaceReplacement({
      kind: "recovery",
      sourceName: t("backup.recoverySource"),
      workspace: recovery,
    });
  }

  function applyWorkspaceReplacement() {
    if (pendingWorkspaceReplacement === null) {
      return;
    }

    try {
      localWorkspacePersistence.preserveForRecovery(workspaceRef.current);
      localWorkspacePersistence.save(pendingWorkspaceReplacement.workspace);
      workspaceRef.current = pendingWorkspaceReplacement.workspace;
      setWorkspace(pendingWorkspaceReplacement.workspace);
      setEditingNodeId(null);
      setSearchTerm("");
      setUnnamedOnly(false);
      setReferenceFilterNodeIds([]);
      setRecoveryAvailable(true);
      setActiveView("canvas");
      setBackupStatus(
        pendingWorkspaceReplacement.kind === "recovery"
          ? t("backup.recoverySuccess")
          : t("backup.importSuccess"),
      );
      setPendingWorkspaceReplacement(null);
    } catch {
      setBackupStatus(t("backup.importFailed"));
    }
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
              <div className="reference-filter-area">
                <label className="reference-filter-picker">
                  <Filter aria-hidden="true" size={15} />
                  <span className="visually-hidden">{t("filters.referencePicker")}</span>
                  <select
                    aria-label={t("filters.referencePicker")}
                    disabled={availableReferenceFilterNodes.length === 0}
                    onChange={(event) => {
                      if (event.target.value.length > 0) {
                        toggleReferenceFilter(event.target.value);
                      }
                    }}
                    value=""
                  >
                    <option value="">{t("filters.addReference")}</option>
                    {availableReferenceFilterNodes.map((node) => (
                      <option key={node.id} value={node.id}>
                        {nodeFilterLabel(node, t("nodes.unnamed"), t("nodes.noContent"))}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedReferenceFilterNodes.length > 0 && (
                  <div
                    aria-label={t("filters.activeReferences")}
                    className="active-reference-filters"
                  >
                    {selectedReferenceFilterNodes.map((node) => {
                      const label = nodeFilterLabel(
                        node,
                        t("nodes.unnamed"),
                        t("nodes.noContent"),
                      );
                      return (
                        <button
                          aria-label={t("filters.removeReference", { name: label })}
                          className="active-reference-filter"
                          key={node.id}
                          onClick={() => toggleReferenceFilter(node.id)}
                          title={t("filters.removeReference", { name: label })}
                          type="button"
                        >
                          <span>{label}</span>
                          <X aria-hidden="true" size={12} />
                        </button>
                      );
                    })}
                    {selectedReferenceFilterNodes.length > 1 && (
                      <button
                        className="clear-reference-filters"
                        onClick={() => setReferenceFilterNodeIds([])}
                        type="button"
                      >
                        {t("filters.clearReferences")}
                      </button>
                    )}
                  </div>
                )}
              </div>
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
              <div className="setting-row data-setting-row">
                <div className="setting-label">
                  <ArchiveRestore size={18} />
                  <div className="setting-label-copy">
                    <span>{t("backup.title")}</span>
                    <small>{t("backup.description")}</small>
                  </div>
                </div>
                <div className="backup-actions">
                  <button
                    className="secondary-button"
                    onClick={() => void exportWorkspace()}
                    type="button"
                  >
                    <Download size={15} />
                    {t("backup.export")}
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() => void chooseWorkspaceImport()}
                    type="button"
                  >
                    <Upload size={15} />
                    {t("backup.import")}
                  </button>
                  {recoveryAvailable && (
                    <button
                      className="secondary-button"
                      onClick={chooseRecoveryWorkspace}
                      type="button"
                    >
                      <ArchiveRestore size={15} />
                      {t("backup.restoreRecovery")}
                    </button>
                  )}
                </div>
                {backupStatus !== null && (
                  <p className="backup-status" role="status">
                    {backupStatus}
                  </p>
                )}
              </div>
            </section>
          ) : activeView === "canvas" ? (
            <GraphCanvas
              editingNodeId={editingNodeId}
              labels={{
                cancel: t("actions.cancel"),
                confirmDeleteNode: t("actions.confirmDeleteNode"),
                createNode: t("actions.newNode"),
                content: t("editor.content"),
                contentPlaceholder: t("editor.contentPlaceholder"),
                editNode: t("actions.editNode"),
                deleteNode: t("actions.deleteNode"),
                deleteNodeBody: (name) => t("deleteNode.body", { name }),
                deleteNodeTitle: t("deleteNode.title"),
                empty: t("empty.canvas"),
                filterByNode: t("filters.filterByNode"),
                name: t("editor.name"),
                nameConflict: t("validation.nameUnique"),
                namePlaceholder: t("editor.namePlaceholder"),
                noContent: t("nodes.noContent"),
                references: t("references.list"),
                removeNodeFilter: t("filters.removeNodeFilter"),
                sourceHandle: t("references.sourceHandle"),
                targetHandle: t("references.targetHandle"),
                unnamed: t("nodes.unnamed"),
              }}
              layout={workspace.layout}
              nameConflictNodeIds={nameConflictNodeIds}
              nodes={workspace.nodes}
              onCreateNode={createNode}
              onDeleteNode={deleteNode}
              onEditNode={editNode}
              onLayoutChange={updateLayout}
              onNodeCommit={commitNode}
              onNodeContentChange={updateNodeContent}
              onNodeNameChange={updateNodeName}
              onReferencesChange={updateReferences}
              onToggleReferenceFilter={toggleReferenceFilter}
              referenceFilterNodeIds={referenceFilterNodeIds}
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

      {pendingWorkspaceReplacement !== null && (
        <div className="modal-backdrop" role="presentation">
          <section
            aria-labelledby="replace-workspace-dialog-title"
            aria-modal="true"
            className="confirmation-dialog"
            role="dialog"
          >
            <h2 id="replace-workspace-dialog-title">{t("backup.confirmTitle")}</h2>
            <p>
              {t("backup.confirmBody", {
                name: pendingWorkspaceReplacement.sourceName,
                nodes: pendingWorkspaceReplacement.workspace.nodes.length,
                references: pendingWorkspaceReplacement.workspace.references.length,
              })}
            </p>
            <div className="confirmation-dialog-actions">
              <button
                className="secondary-button"
                onClick={() => setPendingWorkspaceReplacement(null)}
                type="button"
              >
                {t("actions.cancel")}
              </button>
              <button
                className="primary-button"
                onClick={applyWorkspaceReplacement}
                type="button"
              >
                {t("backup.confirmReplace")}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default App;
