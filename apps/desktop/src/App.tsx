import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArchiveRestore,
  BrainCircuit,
  Cloud,
  Cpu,
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
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import GraphCanvas from "./GraphCanvas";
import { supportedLanguages, type SupportedLanguage } from "./locales";
import {
  emptyWorkspace,
  isNodeNameAvailable,
  isUnnamedNode,
  moveNodeLayoutToFront,
  normalizeNodeName,
  type CanvasViewport,
  type InformationNode,
  type NodeLayout,
  type NodeReference,
  type WorkspaceSnapshot,
  type WorkspaceLoadResult,
  type WorkspacePersistence,
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
import type { WorkspaceLifecycle } from "./workspaceLifecycle";
import {
  appendWorkspaceHistory,
  captureWorkspaceHistory,
  emptyWorkspaceHistoryTimeline,
  restoreWorkspaceHistory,
  stepWorkspaceHistoryBackward,
  stepWorkspaceHistoryForward,
  type WorkspaceHistoryState,
} from "./workspaceHistory";
import { appendNodeReference } from "./referenceSearch";
import {
  EmbeddingAnalysisFailure,
  EmbeddingAnalyzer,
  type EmbeddingCandidate,
  type EmbeddingGateway,
} from "./embeddingService";
import type {
  EmbeddingVectorCache,
  EmbeddingVectorCacheStatus,
} from "./embeddingCache";
import {
  embeddingSettingsFingerprint,
  updateEmbeddingSettings,
  type EmbeddingSettings,
  type EmbeddingSettingsStore,
} from "./embeddingSettings";
import {
  localEmbeddingModelDefinition,
  localEmbeddingModels,
  type LocalEmbeddingModelId,
  type LocalEmbeddingModelStatus,
  type LocalEmbeddingProgress,
  type LocalEmbeddingRuntime,
} from "./localEmbeddingModels";
import "./App.css";

type ViewId = "canvas" | "nodes" | "settings";

interface PendingWorkspaceReplacement {
  kind: "import" | "recovery";
  sourceName: string;
  workspace: WorkspaceSnapshot;
}

interface AppProps {
  embeddingGateway: EmbeddingGateway;
  embeddingVectorCache: EmbeddingVectorCache;
  embeddingSettingsStore: EmbeddingSettingsStore;
  localEmbeddingRuntime: LocalEmbeddingRuntime;
  lifecycle: WorkspaceLifecycle;
  persistence: WorkspacePersistence;
}

interface SmartReferenceResult {
  acceptedNodeIds: string[];
  automaticallyAddedNodeIds: string[];
  candidates: EmbeddingCandidate[];
  sourceNodeId: string;
  truncatedNodeCount: number;
}

interface WorkspaceUpdateOptions {
  flushImmediately?: boolean;
  recordHistory?: boolean;
}

const workspaceHistoryLimit = 100;

function formatByteCount(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.max(1, Math.round(seconds))}s`;
  }
  const minutes = Math.ceil(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.ceil(minutes / 60)}h`;
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

function App({
  embeddingGateway,
  embeddingVectorCache,
  embeddingSettingsStore,
  localEmbeddingRuntime,
  lifecycle,
  persistence,
}: AppProps) {
  const { t, i18n } = useTranslation();
  const [activeView, setActiveView] = useState<ViewId>("canvas");
  const [workspace, setWorkspace] = useState(emptyWorkspace);
  const workspaceRef = useRef(workspace);
  const [persistenceReady, setPersistenceReady] = useState(false);
  const [primaryStorageProblem, setPrimaryStorageProblem] = useState<string | null>(null);
  const [recoveryStorageProblem, setRecoveryStorageProblem] = useState<string | null>(null);
  const [confirmClearUnreadable, setConfirmClearUnreadable] = useState(false);
  const [storageProblemStatus, setStorageProblemStatus] = useState<string | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const editBaselineRef = useRef<{
    nodeId: string;
    state: WorkspaceHistoryState;
  } | null>(null);
  const historyTimelineRef = useRef(emptyWorkspaceHistoryTimeline());
  const [historyAvailability, setHistoryAvailability] = useState({
    canUndo: false,
    canRedo: false,
  });
  const [searchTerm, setSearchTerm] = useState("");
  const [unnamedOnly, setUnnamedOnly] = useState(false);
  const [referenceFilterNodeIds, setReferenceFilterNodeIds] = useState<string[]>([]);
  const [pendingWorkspaceReplacement, setPendingWorkspaceReplacement] =
    useState<PendingWorkspaceReplacement | null>(null);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const embeddingAnalyzer = useMemo(
    () => new EmbeddingAnalyzer(embeddingGateway, embeddingVectorCache),
    [embeddingGateway, embeddingVectorCache],
  );
  const [embeddingSettings, setEmbeddingSettings] = useState<EmbeddingSettings>(() =>
    embeddingSettingsStore.load(),
  );
  const [remoteEmbeddingToken, setRemoteEmbeddingToken] = useState("");
  const [analyzingNodeId, setAnalyzingNodeId] = useState<string | null>(null);
  const [smartReferenceResult, setSmartReferenceResult] =
    useState<SmartReferenceResult | null>(null);
  const [smartReferenceStatus, setSmartReferenceStatus] = useState<string | null>(null);
  const [localEmbeddingProgress, setLocalEmbeddingProgress] =
    useState<LocalEmbeddingProgress | null>(null);
  const [localModelStatuses, setLocalModelStatuses] = useState<
    LocalEmbeddingModelStatus[]
  >([]);
  const [preparingLocalModelId, setPreparingLocalModelId] =
    useState<LocalEmbeddingModelId | null>(null);
  const [cancellingLocalDownload, setCancellingLocalDownload] = useState(false);
  const [vectorCacheStatus, setVectorCacheStatus] =
    useState<EmbeddingVectorCacheStatus | null>(null);
  const [vectorCacheBusy, setVectorCacheBusy] = useState(false);
  const [vectorCacheMessage, setVectorCacheMessage] = useState<string | null>(null);
  const currentView = views.find((view) => view.id === activeView) ?? views[0];
  const activeLanguage = i18n.resolvedLanguage ?? i18n.language;
  const normalizedSearch = normalizeNodeName(searchTerm);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;

    function refreshModelStatuses() {
      void localEmbeddingRuntime
        .inspectModels()
        .then((statuses) => {
          if (active) {
            setLocalModelStatuses(statuses);
          }
        })
        .catch(() => undefined);
    }

    refreshModelStatuses();
    void localEmbeddingRuntime
      .subscribe((progress) => {
        if (!active) {
          return;
        }
        setLocalEmbeddingProgress(progress);
        if (
          progress.phase === "ready" ||
          progress.phase === "cancelled" ||
          progress.phase === "failed"
        ) {
          setCancellingLocalDownload(false);
          refreshModelStatuses();
        }
      })
      .then((nextUnsubscribe) => {
        if (active) {
          unsubscribe = nextUnsubscribe;
        } else {
          nextUnsubscribe();
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [localEmbeddingRuntime]);

  useEffect(() => {
    if (activeView !== "settings") {
      return;
    }
    let active = true;
    void embeddingVectorCache
      .inspect()
      .then((status) => {
        if (active) {
          setVectorCacheStatus(status);
          setVectorCacheMessage(null);
        }
      })
      .catch((error) => {
        if (active) {
          const reason = error instanceof Error ? error.message : String(error);
          setVectorCacheMessage(
            t("smartReference.settings.vectorCache.inspectFailed", { reason }),
          );
        }
      });
    return () => {
      active = false;
    };
  }, [activeView, embeddingVectorCache, t]);

  useEffect(() => {
    let active = true;

    async function initializePersistence() {
      try {
        const [primary, recovery] = await Promise.all([
          persistence.load(),
          persistence.loadRecovery(),
        ]);
        if (!active) {
          return;
        }

        if (primary.status === "ready") {
          workspaceRef.current = primary.workspace;
          setWorkspace(primary.workspace);
          setPersistenceReady(true);
        } else if (primary.status === "missing") {
          const initialWorkspace = emptyWorkspace();
          workspaceRef.current = initialWorkspace;
          setWorkspace(initialWorkspace);
          setPersistenceReady(true);
        } else {
          setPrimaryStorageProblem(primary.raw);
        }

        if (recovery.status === "ready") {
          setRecoveryAvailable(true);
        } else if (recovery.status === "invalid") {
          setRecoveryStorageProblem(recovery.raw);
        }
      } catch {
        if (active) {
          setPrimaryStorageProblem("");
        }
      }
    }

    void initializePersistence();
    return () => {
      active = false;
    };
  }, [persistence]);

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
    if (!persistenceReady) {
      return;
    }
    workspaceRef.current = workspace;
    const saveTimer = window.setTimeout(
      () => {
        void persistence.save(workspace).catch(() => {
          setBackupStatus(t("storage.saveFailed"));
        });
      },
      300,
    );
    return () => window.clearTimeout(saveTimer);
  }, [persistence, persistenceReady, t, workspace]);

  useEffect(() => {
    if (!persistenceReady) {
      return;
    }

    let active = true;
    let unregister: (() => void) | null = null;
    const flushLocalWorkspace = () => persistence.save(workspaceRef.current);
    void lifecycle
      .registerCloseFlush(flushLocalWorkspace, () => {
        if (active) {
          setBackupStatus(t("storage.saveFailed"));
        }
      })
      .then((nextUnregister) => {
        if (active) {
          unregister = nextUnregister;
        } else {
          nextUnregister();
        }
      })
      .catch(() => {
        if (active) {
          setBackupStatus(t("storage.saveFailed"));
        }
      });

    return () => {
      active = false;
      unregister?.();
      void flushLocalWorkspace();
    };
  }, [lifecycle, persistence, persistenceReady, t]);

  function changeLanguage(language: SupportedLanguage) {
    void i18n.changeLanguage(language);
  }

  function changeEmbeddingConfiguration(patch: Partial<EmbeddingSettings>) {
    const next = updateEmbeddingSettings(embeddingSettings, patch);
    const fingerprintChanged =
      embeddingSettingsFingerprint(next) !==
      embeddingSettingsFingerprint(embeddingSettings);
    if (fingerprintChanged) {
      setRemoteEmbeddingToken("");
      setSmartReferenceResult(null);
      setLocalEmbeddingProgress(null);
    }
    setEmbeddingSettings(next);
    try {
      embeddingSettingsStore.save(next);
      setSmartReferenceStatus(null);
    } catch {
      setSmartReferenceStatus(t("smartReference.errors.settingsSaveFailed"));
    }
  }

  async function clearVectorCache() {
    if (vectorCacheBusy) {
      return;
    }
    setVectorCacheBusy(true);
    setVectorCacheMessage(null);
    try {
      const status = await embeddingVectorCache.clear();
      embeddingAnalyzer.clearCache();
      setVectorCacheStatus(status);
      setVectorCacheMessage(t("smartReference.settings.vectorCache.clearSuccess"));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setVectorCacheMessage(
        t("smartReference.settings.vectorCache.clearFailed", { reason }),
      );
    } finally {
      setVectorCacheBusy(false);
    }
  }

  async function analyzeNodeReferences(nodeId: string) {
    if (analyzingNodeId !== null || preparingLocalModelId !== null) {
      return;
    }
    setAnalyzingNodeId(nodeId);
    setLocalEmbeddingProgress(null);
    setCancellingLocalDownload(false);
    setSmartReferenceStatus(null);
    try {
      const currentWorkspace = workspaceRef.current;
      const analysis = await embeddingAnalyzer.analyze(
        nodeId,
        currentWorkspace.nodes,
        currentWorkspace.references,
        embeddingSettings,
        remoteEmbeddingToken,
      );
      const automaticCandidateIds =
        embeddingSettings.autoReferenceEnabled &&
        embeddingSettings.thresholdFingerprint ===
          embeddingSettingsFingerprint(embeddingSettings)
          ? analysis.candidates
              .filter(
                (candidate) =>
                  candidate.score >= embeddingSettings.autoReferenceThreshold,
              )
              .map((candidate) => candidate.nodeId)
          : [];
      const automaticallyAddedNodeIds: string[] = [];
      if (automaticCandidateIds.length > 0) {
        updateWorkspace(
          (current) => {
            let nextReferences = current.references;
            for (const targetNodeId of automaticCandidateIds) {
              const appended = appendNodeReference(
                nextReferences,
                nodeId,
                targetNodeId,
              );
              if (appended !== nextReferences) {
                automaticallyAddedNodeIds.push(targetNodeId);
                nextReferences = appended;
              }
            }
            return nextReferences === current.references
              ? current
              : { ...current, references: nextReferences };
          },
          { flushImmediately: true, recordHistory: true },
        );
      }
      setSmartReferenceResult({
        acceptedNodeIds: [...automaticallyAddedNodeIds],
        automaticallyAddedNodeIds,
        candidates: analysis.candidates,
        sourceNodeId: nodeId,
        truncatedNodeCount: analysis.truncatedNodeCount,
      });
    } catch (error) {
      if (error instanceof EmbeddingAnalysisFailure) {
        setSmartReferenceStatus(t(`smartReference.errors.${error.reason}`));
      } else {
        const reason = error instanceof Error ? error.message : String(error);
        setSmartReferenceStatus(
          reason.includes("local embedding download cancelled")
            ? t("smartReference.download.cancelled")
            : t("smartReference.errors.failed", { reason }),
        );
      }
    } finally {
      setAnalyzingNodeId(null);
    }
  }

  async function prepareLocalEmbeddingModel(modelId: LocalEmbeddingModelId) {
    if (analyzingNodeId !== null || preparingLocalModelId !== null) {
      return;
    }
    setPreparingLocalModelId(modelId);
    setLocalEmbeddingProgress(null);
    setCancellingLocalDownload(false);
    setSmartReferenceStatus(null);
    try {
      await localEmbeddingRuntime.prepareModel(modelId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setSmartReferenceStatus(
        reason.includes("local embedding download cancelled")
          ? t("smartReference.download.cancelled")
          : t("smartReference.errors.modelPreparationFailed", { reason }),
      );
    } finally {
      setPreparingLocalModelId(null);
    }
  }

  async function cancelLocalEmbeddingDownload() {
    if (cancellingLocalDownload) {
      return;
    }
    setCancellingLocalDownload(true);
    try {
      await localEmbeddingRuntime.cancelDownload();
    } catch (error) {
      setCancellingLocalDownload(false);
      const reason = error instanceof Error ? error.message : String(error);
      setSmartReferenceStatus(
        t("smartReference.errors.cancelDownloadFailed", { reason }),
      );
    }
  }

  function acceptSmartReference(targetNodeId: string) {
    const result = smartReferenceResult;
    if (result === null) {
      return;
    }
    updateWorkspace(
      (current) => {
        const references = appendNodeReference(
          current.references,
          result.sourceNodeId,
          targetNodeId,
        );
        return references === current.references
          ? current
          : { ...current, references };
      },
      { flushImmediately: true, recordHistory: true },
    );
    setSmartReferenceResult((current) =>
      current === null || current.acceptedNodeIds.includes(targetNodeId)
        ? current
        : {
            ...current,
            acceptedNodeIds: [...current.acceptedNodeIds, targetNodeId],
          },
    );
  }

  function updateWorkspace(
    updater: (current: WorkspaceSnapshot) => WorkspaceSnapshot,
    options: WorkspaceUpdateOptions = {},
  ): WorkspaceSnapshot {
    const current = workspaceRef.current;
    const next = updater(current);
    if (next === current) {
      return current;
    }
    if (options.recordHistory) {
      recordHistory(captureWorkspaceHistory(current), captureWorkspaceHistory(next));
    }
    workspaceRef.current = next;
    setWorkspace(next);
    if (options.flushImmediately) {
      void persistence.save(next).catch(() => {
        setBackupStatus(t("storage.saveFailed"));
      });
    }
    return next;
  }

  function syncHistoryAvailability() {
    setHistoryAvailability({
      canUndo: historyTimelineRef.current.undo.length > 0,
      canRedo: historyTimelineRef.current.redo.length > 0,
    });
  }

  function clearHistory() {
    historyTimelineRef.current = emptyWorkspaceHistoryTimeline();
    editBaselineRef.current = null;
    syncHistoryAvailability();
  }

  function recordHistory(before: WorkspaceHistoryState, after: WorkspaceHistoryState) {
    historyTimelineRef.current = appendWorkspaceHistory(
      historyTimelineRef.current,
      before,
      after,
      workspaceHistoryLimit,
    );
    syncHistoryAvailability();
  }

  function applyHistoryState(state: WorkspaceHistoryState) {
    const next = restoreWorkspaceHistory(state, workspaceRef.current.viewport);
    workspaceRef.current = next;
    setWorkspace(next);
    setEditingNodeId(null);
    editBaselineRef.current = null;
    const existingNodeIds = new Set(next.nodes.map((node) => node.id));
    setReferenceFilterNodeIds((current) =>
      current.filter((nodeId) => existingNodeIds.has(nodeId)),
    );
    void persistence.save(next).catch(() => {
      setBackupStatus(t("storage.saveFailed"));
    });
  }

  function undoWorkspace() {
    if (editingNodeId !== null) {
      return;
    }
    const step = stepWorkspaceHistoryBackward(historyTimelineRef.current);
    if (step === null) {
      return;
    }
    historyTimelineRef.current = step.timeline;
    applyHistoryState(step.state);
    syncHistoryAvailability();
  }

  function redoWorkspace() {
    if (editingNodeId !== null) {
      return;
    }
    const step = stepWorkspaceHistoryForward(historyTimelineRef.current);
    if (step === null) {
      return;
    }
    historyTimelineRef.current = step.timeline;
    applyHistoryState(step.state);
    syncHistoryAvailability();
  }

  function createNode(
    position = defaultNodePosition(workspaceRef.current.nodes.length),
  ) {
    const nodeId = crypto.randomUUID();
    const next = updateWorkspace(
      (current) => ({
        ...current,
        nodes: [...current.nodes, { id: nodeId, name: null, content: null }],
        layout: [...current.layout, { nodeId, x: position.x, y: position.y }],
      }),
      { flushImmediately: true, recordHistory: true },
    );
    editBaselineRef.current = {
      nodeId,
      state: captureWorkspaceHistory(next),
    };
    setActiveView("canvas");
    setEditingNodeId(nodeId);
  }

  function createReferencedNode(
    sourceNodeId: string,
    name: string,
    position: { x: number; y: number },
  ): string | null {
    const trimmedName = name.trim();
    const nodeId = crypto.randomUUID();
    if (
      trimmedName.length === 0 ||
      !workspaceRef.current.nodes.some((node) => node.id === sourceNodeId) ||
      !isNodeNameAvailable(workspaceRef.current.nodes, nodeId, trimmedName)
    ) {
      return null;
    }

    updateWorkspace(
      (current) => ({
        ...current,
        nodes: [
          ...current.nodes,
          { id: nodeId, name: trimmedName, content: null },
        ],
        layout: [...current.layout, { nodeId, x: position.x, y: position.y }],
        references: appendNodeReference(
          current.references,
          sourceNodeId,
          nodeId,
        ),
      }),
      { flushImmediately: true, recordHistory: true },
    );
    return nodeId;
  }

  function editNode(nodeId: string) {
    if (workspaceRef.current.nodes.some((node) => node.id === nodeId)) {
      bringNodeToFront(nodeId);
      editBaselineRef.current = {
        nodeId,
        state: captureWorkspaceHistory(workspaceRef.current),
      };
      setActiveView("canvas");
      window.setTimeout(() => setEditingNodeId(nodeId), 0);
    }
  }

  function bringNodeToFront(nodeId: string) {
    updateWorkspace(
      (current) => {
        const layout = moveNodeLayoutToFront(current.layout, nodeId);
        return layout === current.layout ? current : { ...current, layout };
      },
      { flushImmediately: true },
    );
  }

  function deleteNodes(nodeIds: string[]) {
    const deletedNodeIds = new Set(nodeIds);
    if (deletedNodeIds.size === 0) {
      return;
    }
    updateWorkspace(
      (current) => ({
        ...current,
        nodes: current.nodes.filter((node) => !deletedNodeIds.has(node.id)),
        layout: current.layout.filter((item) => !deletedNodeIds.has(item.nodeId)),
        references: current.references.filter(
          (reference) =>
            !deletedNodeIds.has(reference.sourceNodeId) &&
            !deletedNodeIds.has(reference.targetNodeId),
        ),
      }),
      { flushImmediately: true, recordHistory: true },
    );
    setEditingNodeId((current) =>
      current !== null && deletedNodeIds.has(current) ? null : current,
    );
    if (
      editBaselineRef.current !== null &&
      deletedNodeIds.has(editBaselineRef.current.nodeId)
    ) {
      editBaselineRef.current = null;
    }
    setReferenceFilterNodeIds((current) =>
      current.filter((currentNodeId) => !deletedNodeIds.has(currentNodeId)),
    );
  }

  function updateNodeName(nodeId: string, name: string): boolean {
    if (!isNodeNameAvailable(workspaceRef.current.nodes, nodeId, name)) {
      return false;
    }
    updateWorkspace((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === nodeId ? { ...node, name: name.length === 0 ? null : name } : node,
      ),
    }));
    return true;
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
    const next = updateWorkspace(
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
      { flushImmediately: true },
    );
    const baseline = editBaselineRef.current;
    if (baseline?.nodeId === nodeId) {
      recordHistory(baseline.state, captureWorkspaceHistory(next));
      editBaselineRef.current = null;
    }
    setEditingNodeId((current) => (current === nodeId ? null : current));
  }

  function updateLayout(layout: NodeLayout[]) {
    updateWorkspace((current) => ({ ...current, layout }), {
      flushImmediately: true,
      recordHistory: true,
    });
  }

  function updateReferences(references: NodeReference[]) {
    updateWorkspace((current) => ({ ...current, references }), {
      flushImmediately: true,
      recordHistory: true,
    });
  }

  function updateViewport(viewport: CanvasViewport) {
    updateWorkspace(
      (current) =>
        current.viewport !== null &&
        current.viewport.x === viewport.x &&
        current.viewport.y === viewport.y &&
        current.viewport.zoom === viewport.zoom
          ? current
          : { ...current, viewport },
      { flushImmediately: true },
    );
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

  async function chooseRecoveryWorkspace() {
    setBackupStatus(null);
    let recovery: WorkspaceLoadResult;
    try {
      recovery = await persistence.loadRecovery();
    } catch {
      setBackupStatus(t("backup.recoveryUnavailable"));
      return;
    }
    if (recovery.status === "missing") {
      setRecoveryAvailable(false);
      setBackupStatus(t("backup.recoveryUnavailable"));
      return;
    }
    if (recovery.status === "invalid") {
      setRecoveryAvailable(false);
      setRecoveryStorageProblem(recovery.raw);
      setBackupStatus(t("backup.recoveryInvalid"));
      return;
    }
    setPendingWorkspaceReplacement({
      kind: "recovery",
      sourceName: t("backup.recoverySource"),
      workspace: recovery.workspace,
    });
  }

  async function applyWorkspaceReplacement() {
    if (pendingWorkspaceReplacement === null) {
      return;
    }

    try {
      await persistence.preserveForRecovery(workspaceRef.current);
      await persistence.save(pendingWorkspaceReplacement.workspace);
      workspaceRef.current = pendingWorkspaceReplacement.workspace;
      setWorkspace(pendingWorkspaceReplacement.workspace);
      clearHistory();
      setEditingNodeId(null);
      setSearchTerm("");
      setUnnamedOnly(false);
      setReferenceFilterNodeIds([]);
      setRecoveryAvailable(true);
      setRecoveryStorageProblem(null);
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

  async function exportUnreadableData(raw: string, source: "primary" | "recovery") {
    setStorageProblemStatus(null);
    try {
      const date = new Date().toISOString().slice(0, 10);
      const exported = await exportWorkspaceFile(
        raw,
        `linked-info-unreadable-${source}-${date}.json`,
      );
      if (exported) {
        const message = t("storageProblem.exportSuccess");
        setStorageProblemStatus(message);
        if (source === "recovery") {
          setBackupStatus(message);
        }
      }
    } catch {
      const message = t("storageProblem.exportFailed");
      setStorageProblemStatus(message);
      if (source === "recovery") {
        setBackupStatus(message);
      }
    }
  }

  async function clearUnreadableWorkspace() {
    const initialWorkspace = emptyWorkspace();
    try {
      await persistence.save(initialWorkspace);
      workspaceRef.current = initialWorkspace;
      setWorkspace(initialWorkspace);
      clearHistory();
      setPrimaryStorageProblem(null);
      setConfirmClearUnreadable(false);
      setPersistenceReady(true);
    } catch {
      setStorageProblemStatus(t("storageProblem.clearFailed"));
    }
  }

  if (!persistenceReady) {
    return (
      <main className="storage-problem-shell">
        {primaryStorageProblem === null ? (
          <section className="storage-problem-card" aria-live="polite">
            <p>{t("storageProblem.loading")}</p>
          </section>
        ) : (
          <section className="storage-problem-card" aria-labelledby="storage-problem-title">
            <AlertTriangle aria-hidden="true" className="storage-problem-icon" size={28} />
            <h1 id="storage-problem-title">{t("storageProblem.title")}</h1>
            <p>{t("storageProblem.description")}</p>
            <div className="storage-problem-actions">
              <button
                className="secondary-button"
                disabled={primaryStorageProblem.length === 0}
                onClick={() =>
                  void exportUnreadableData(primaryStorageProblem, "primary")
                }
                type="button"
              >
                <Download size={15} />
                {t("storageProblem.exportRaw")}
              </button>
              <button
                className="danger-button"
                onClick={() => setConfirmClearUnreadable(true)}
                type="button"
              >
                <Trash2 size={15} />
                {t("storageProblem.clear")}
              </button>
            </div>
            {storageProblemStatus !== null && (
              <p className="backup-status" role="status">
                {storageProblemStatus}
              </p>
            )}
          </section>
        )}

        {confirmClearUnreadable && (
          <div className="modal-backdrop" role="presentation">
            <section
              aria-labelledby="clear-unreadable-dialog-title"
              aria-modal="true"
              className="confirmation-dialog"
              role="dialog"
            >
              <h2 id="clear-unreadable-dialog-title">
                {t("storageProblem.confirmTitle")}
              </h2>
              <p>{t("storageProblem.confirmBody")}</p>
              <div className="confirmation-dialog-actions">
                <button
                  className="secondary-button"
                  onClick={() => setConfirmClearUnreadable(false)}
                  type="button"
                >
                  {t("actions.cancel")}
                </button>
                <button
                  className="danger-button"
                  onClick={() => void clearUnreadableWorkspace()}
                  type="button"
                >
                  {t("storageProblem.confirmClear")}
                </button>
              </div>
            </section>
          </div>
        )}
      </main>
    );
  }

  const selectedLocalModel = localEmbeddingModelDefinition(
    embeddingSettings.localModel,
  );
  const selectedLocalModelStatus = localModelStatuses.find(
    (status) => status.modelId === embeddingSettings.localModel,
  );
  const localModelTaskRunning =
    preparingLocalModelId !== null ||
    (analyzingNodeId !== null && embeddingSettings.provider === "local");
  const localDownloadCancellable =
    localModelTaskRunning && localEmbeddingProgress?.phase === "downloading";
  const progressModel =
    localEmbeddingProgress === null
      ? selectedLocalModel
      : localEmbeddingModels.find(
          (model) => model.id === localEmbeddingProgress.modelId,
        ) ?? selectedLocalModel;
  const progressModelName = t(
    `smartReference.settings.models.${progressModel.translationKey}.name`,
  );

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
              <div className="setting-row data-setting-row smart-reference-setting-row">
                <div className="setting-label">
                  <BrainCircuit size={18} />
                  <div className="setting-label-copy">
                    <span>{t("smartReference.settings.provider")}</span>
                    <small>{t("smartReference.settings.providerDescription")}</small>
                  </div>
                </div>
                <div className="smart-reference-settings">
                  <div className="segmented-control">
                    <button
                      data-active={embeddingSettings.provider === "local"}
                      disabled={localModelTaskRunning || analyzingNodeId !== null}
                      onClick={() =>
                        changeEmbeddingConfiguration({ provider: "local" })
                      }
                      type="button"
                    >
                      <Cpu aria-hidden="true" size={14} />
                      {t("smartReference.settings.local")}
                    </button>
                    <button
                      data-active={embeddingSettings.provider === "remote"}
                      disabled={localModelTaskRunning || analyzingNodeId !== null}
                      onClick={() =>
                        changeEmbeddingConfiguration({ provider: "remote" })
                      }
                      type="button"
                    >
                      <Cloud aria-hidden="true" size={14} />
                      {t("smartReference.settings.remote")}
                    </button>
                  </div>
                  {embeddingSettings.provider === "local" ? (
                    <div className="local-model-settings">
                      <div
                        aria-label={t("smartReference.settings.localModelChoice")}
                        className="local-model-list"
                        role="radiogroup"
                      >
                        {localEmbeddingModels.map((model, index) => {
                          const status = localModelStatuses.find(
                            (candidate) => candidate.modelId === model.id,
                          );
                          const translationBase = `smartReference.settings.models.${model.translationKey}`;
                          return (
                            <label
                              className="local-model-card"
                              data-selected={embeddingSettings.localModel === model.id}
                              key={model.id}
                            >
                              <input
                                checked={embeddingSettings.localModel === model.id}
                                disabled={localModelTaskRunning}
                                name="local-embedding-model"
                                onChange={() =>
                                  changeEmbeddingConfiguration({ localModel: model.id })
                                }
                                type="radio"
                                value={model.id}
                              />
                              <span className="local-model-card-body">
                                <span className="local-model-card-heading">
                                  <strong>{t(`${translationBase}.name`)}</strong>
                                  {index === 0 && (
                                    <em>{t("smartReference.settings.recommended")}</em>
                                  )}
                                  <small>
                                    {status?.ready
                                      ? t("smartReference.settings.modelReady")
                                      : status !== undefined && status.cachedBytes > 0
                                        ? t("smartReference.settings.modelPartial", {
                                            cached: formatByteCount(status.cachedBytes),
                                            total: formatByteCount(status.totalBytes),
                                          })
                                        : t("smartReference.settings.modelNotDownloaded")}
                                  </small>
                                </span>
                                <span className="local-model-description">
                                  {t(`${translationBase}.description`)}
                                </span>
                                <span className="local-model-metadata">
                                  {t("smartReference.settings.modelMetadata", {
                                    size: formatByteCount(model.downloadBytes),
                                    dimensions: model.dimensions,
                                    license: model.license,
                                  })}
                                </span>
                                <span className="local-model-limitation">
                                  {t(`${translationBase}.limitation`)}
                                </span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                      <div className="local-model-actions">
                        <button
                          className="secondary-button"
                          disabled={
                            localModelTaskRunning || selectedLocalModelStatus?.ready === true
                          }
                          onClick={() =>
                            void prepareLocalEmbeddingModel(embeddingSettings.localModel)
                          }
                          type="button"
                        >
                          <Download aria-hidden="true" size={15} />
                          {selectedLocalModelStatus?.ready
                            ? t("smartReference.settings.modelReady")
                            : selectedLocalModelStatus !== undefined &&
                                selectedLocalModelStatus.cachedBytes > 0
                              ? t("smartReference.settings.continueDownload")
                              : t("smartReference.settings.downloadModel")}
                        </button>
                        <small>
                          {t("smartReference.settings.modelSource", {
                            repository: selectedLocalModel.repository,
                            revision: selectedLocalModel.revision.slice(0, 8),
                          })}
                        </small>
                      </div>
                    </div>
                  ) : (
                    <div className="remote-embedding-fields">
                      <label>
                        <span>{t("smartReference.settings.endpoint")}</span>
                        <input
                          onChange={(event) =>
                            changeEmbeddingConfiguration({
                              remoteEndpoint: event.target.value,
                            })
                          }
                          placeholder={t("smartReference.settings.endpointPlaceholder")}
                          spellCheck={false}
                          type="url"
                          value={embeddingSettings.remoteEndpoint}
                        />
                      </label>
                      <label>
                        <span>{t("smartReference.settings.model")}</span>
                        <input
                          onChange={(event) =>
                            changeEmbeddingConfiguration({
                              remoteModel: event.target.value,
                            })
                          }
                          placeholder={t("smartReference.settings.modelPlaceholder")}
                          spellCheck={false}
                          type="text"
                          value={embeddingSettings.remoteModel}
                        />
                      </label>
                      <label>
                        <span>{t("smartReference.settings.sessionToken")}</span>
                        <input
                          autoComplete="off"
                          onChange={(event) =>
                            setRemoteEmbeddingToken(event.target.value)
                          }
                          placeholder={t("smartReference.settings.tokenPlaceholder")}
                          spellCheck={false}
                          type="password"
                          value={remoteEmbeddingToken}
                        />
                      </label>
                      <small>{t("smartReference.settings.tokenDescription")}</small>
                    </div>
                  )}
                </div>
              </div>
              <div className="setting-row data-setting-row smart-reference-setting-row">
                <div className="setting-label">
                  <Sparkles size={18} />
                  <div className="setting-label-copy">
                    <span>{t("smartReference.settings.automatic")}</span>
                    <small>{t("smartReference.settings.automaticDescription")}</small>
                  </div>
                </div>
                <div className="automatic-reference-settings">
                  <label className="switch-setting">
                    <input
                      checked={embeddingSettings.autoReferenceEnabled}
                      onChange={(event) =>
                        changeEmbeddingConfiguration({
                          autoReferenceEnabled: event.target.checked,
                        })
                      }
                      type="checkbox"
                    />
                    <span>{t("smartReference.settings.enableAutomatic")}</span>
                  </label>
                  <label className="threshold-setting">
                    <span>{t("smartReference.settings.threshold")}</span>
                    <input
                      aria-label={t("smartReference.settings.threshold")}
                      max="1"
                      min="0"
                      onChange={(event) => {
                        if (Number.isFinite(event.target.valueAsNumber)) {
                          changeEmbeddingConfiguration({
                            autoReferenceThreshold: event.target.valueAsNumber,
                          });
                        }
                      }}
                      step="0.01"
                      type="range"
                      value={embeddingSettings.autoReferenceThreshold}
                    />
                    <output>{embeddingSettings.autoReferenceThreshold.toFixed(2)}</output>
                  </label>
                  <small>{t("smartReference.settings.thresholdDescription")}</small>
                </div>
              </div>
              <div className="setting-row data-setting-row smart-reference-setting-row">
                <div className="setting-label">
                  <Database size={18} />
                  <div className="setting-label-copy">
                    <span>{t("smartReference.settings.vectorCache.title")}</span>
                    <small>{t("smartReference.settings.vectorCache.description")}</small>
                  </div>
                </div>
                <div className="vector-cache-settings">
                  {vectorCacheStatus === null ? (
                    <span>{t("smartReference.settings.vectorCache.loading")}</span>
                  ) : vectorCacheStatus.persistent ? (
                    <span>
                      {t("smartReference.settings.vectorCache.usage", {
                        used: formatByteCount(vectorCacheStatus.diskBytes),
                        limit: formatByteCount(vectorCacheStatus.maxBytes),
                        count: vectorCacheStatus.entryCount,
                      })}
                    </span>
                  ) : (
                    <span>{t("smartReference.settings.vectorCache.desktopOnly")}</span>
                  )}
                  <small>{t("smartReference.settings.vectorCache.memoryLimit")}</small>
                  <button
                    className="secondary-button"
                    disabled={
                      vectorCacheBusy || vectorCacheStatus?.persistent !== true
                    }
                    onClick={() => void clearVectorCache()}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={15} />
                    {vectorCacheBusy
                      ? t("smartReference.settings.vectorCache.clearing")
                      : t("smartReference.settings.vectorCache.clear")}
                  </button>
                  {vectorCacheMessage !== null && <small>{vectorCacheMessage}</small>}
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
                      onClick={() => void chooseRecoveryWorkspace()}
                      type="button"
                    >
                      <ArchiveRestore size={15} />
                      {t("backup.restoreRecovery")}
                    </button>
                  )}
                  {recoveryStorageProblem !== null && (
                    <button
                      className="secondary-button"
                      onClick={() =>
                        void exportUnreadableData(recoveryStorageProblem, "recovery")
                      }
                      type="button"
                    >
                      <Download size={15} />
                      {t("backup.exportInvalidRecovery")}
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
              analyzingNodeId={analyzingNodeId}
              canRedo={historyAvailability.canRedo}
              canUndo={historyAvailability.canUndo}
              editingNodeId={editingNodeId}
              historyBlocked={editingNodeId !== null}
              labels={{
                analyzingNode: t("smartReference.analyzing"),
                cancel: t("actions.cancel"),
                confirmDeleteNode: (count) =>
                  count === 1
                    ? t("actions.confirmDeleteNode")
                    : t("actions.confirmDeleteNodes"),
                createNode: t("actions.newNode"),
                content: t("editor.content"),
                contentPlaceholder: t("editor.contentPlaceholder"),
                editNode: t("actions.editNode"),
                deleteNode: t("actions.deleteNode"),
                deleteNodeBody: (names) =>
                  names.length === 1
                    ? t("deleteNode.body", { name: names[0] })
                    : t("deleteNode.bodyMultiple", { count: names.length }),
                deleteNodeTitle: (count) =>
                  count === 1
                    ? t("deleteNode.title")
                    : t("deleteNode.titleMultiple", { count }),
                empty: t("empty.canvas"),
                filterByNode: t("filters.filterByNode"),
                name: t("editor.name"),
                nameConflict: t("validation.nameUnique"),
                namePlaceholder: t("editor.namePlaceholder"),
                noContent: t("nodes.noContent"),
                references: t("references.list"),
                referenceSearchCreate: (name) =>
                  t("references.searchCreate", { name }),
                referenceSearchCreateHint: t("references.searchCreateHint"),
                referenceSearchEmpty: t("references.searchEmpty"),
                referenceSearchHint: t("references.searchHint"),
                referenceSearchLabel: t("references.searchLabel"),
                referenceSearchPlaceholder: t("references.searchPlaceholder"),
                redo: t("actions.redo"),
                removeNodeFilter: t("filters.removeNodeFilter"),
                sourceHandle: t("references.sourceHandle"),
                smartReference: t("smartReference.action"),
                targetHandle: t("references.targetHandle"),
                undo: t("actions.undo"),
                unnamed: t("nodes.unnamed"),
              }}
              layout={workspace.layout}
              nameConflictNodeIds={nameConflictNodeIds}
              nodes={workspace.nodes}
              onAnalyzeNode={(nodeId) => void analyzeNodeReferences(nodeId)}
              onCreateNode={createNode}
              onCreateReferencedNode={createReferencedNode}
              onDeleteNodes={deleteNodes}
              onEditNode={editNode}
              onLayoutChange={updateLayout}
              onNodeCommit={commitNode}
              onNodeContentChange={updateNodeContent}
              onNodeBringToFront={bringNodeToFront}
              onNodeNameChange={updateNodeName}
              onReferencesChange={updateReferences}
              onRedo={redoWorkspace}
              onToggleReferenceFilter={toggleReferenceFilter}
              onUndo={undoWorkspace}
              onViewportChange={updateViewport}
              referenceFilterNodeIds={referenceFilterNodeIds}
              references={workspace.references}
              searchTerm={searchTerm}
              unnamedOnly={unnamedOnly}
              viewport={workspace.viewport}
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

      {localModelTaskRunning && (
        <div className="smart-reference-progress" role="status">
          <BrainCircuit aria-hidden="true" size={17} />
          <div className="smart-reference-progress-copy">
            <strong>
              {localEmbeddingProgress === null
                ? t("smartReference.download.preparing", { model: progressModelName })
                : t(
                    `smartReference.download.phases.${localEmbeddingProgress.phase}`,
                    { model: progressModelName },
                  )}
            </strong>
            {localEmbeddingProgress?.fileName !== null &&
              localEmbeddingProgress?.fileName !== undefined && (
                <span>
                  {t("smartReference.download.currentFile", {
                    current: localEmbeddingProgress.fileIndex,
                    count: localEmbeddingProgress.fileCount,
                    file: localEmbeddingProgress.fileName,
                  })}
                </span>
              )}
            {localEmbeddingProgress !== null &&
              localEmbeddingProgress.totalBytes > 0 && (
                <>
                  <progress
                    aria-label={t("smartReference.download.progressLabel")}
                    max={localEmbeddingProgress.totalBytes}
                    value={localEmbeddingProgress.downloadedBytes}
                  />
                  <span className="smart-reference-progress-metrics">
                    {t("smartReference.download.bytes", {
                      downloaded: formatByteCount(
                        localEmbeddingProgress.downloadedBytes,
                      ),
                      total: formatByteCount(localEmbeddingProgress.totalBytes),
                      percent: Math.min(
                        100,
                        Math.floor(
                          (localEmbeddingProgress.downloadedBytes /
                            localEmbeddingProgress.totalBytes) *
                            100,
                        ),
                      ),
                    })}
                    {localEmbeddingProgress.bytesPerSecond !== null && (
                      <>
                        {" · "}
                        {t("smartReference.download.speed", {
                          speed: formatByteCount(
                            localEmbeddingProgress.bytesPerSecond,
                          ),
                        })}
                      </>
                    )}
                    {localEmbeddingProgress.etaSeconds !== null && (
                      <>
                        {" · "}
                        {t("smartReference.download.eta", {
                          eta: formatDuration(localEmbeddingProgress.etaSeconds),
                        })}
                      </>
                    )}
                  </span>
                </>
              )}
          </div>
          {localDownloadCancellable && (
            <button
              className="secondary-button smart-reference-cancel-download"
              disabled={cancellingLocalDownload}
              onClick={() => void cancelLocalEmbeddingDownload()}
              type="button"
            >
              {cancellingLocalDownload
                ? t("smartReference.download.cancelling")
                : t("smartReference.download.cancel")}
            </button>
          )}
        </div>
      )}

      {analyzingNodeId !== null && embeddingSettings.provider === "remote" && (
        <div className="smart-reference-progress" role="status">
          <Cloud aria-hidden="true" size={17} />
          <div>
            <strong>{t("smartReference.analyzing")}</strong>
            <span>{t("smartReference.analyzingRemoteDescription")}</span>
          </div>
        </div>
      )}

      {smartReferenceStatus !== null && (
        <div className="smart-reference-status" role="alert">
          <span>{smartReferenceStatus}</span>
          <button
            aria-label={t("smartReference.close")}
            onClick={() => setSmartReferenceStatus(null)}
            type="button"
          >
            <X aria-hidden="true" size={14} />
          </button>
        </div>
      )}

      {smartReferenceResult !== null && (
        <div className="modal-backdrop" role="presentation">
          <section
            aria-labelledby="smart-reference-dialog-title"
            aria-modal="true"
            className="smart-reference-dialog"
            role="dialog"
          >
            <header>
              <div>
                <p className="section-label">{t("smartReference.resultLabel")}</p>
                <h2 id="smart-reference-dialog-title">
                  {t("smartReference.resultTitle", {
                    name: (() => {
                      const source = workspace.nodes.find(
                        (node) => node.id === smartReferenceResult.sourceNodeId,
                      );
                      return source === undefined
                        ? t("nodes.unnamed")
                        : nodeFilterLabel(
                            source,
                            t("nodes.unnamed"),
                            t("nodes.noContent"),
                          );
                    })(),
                  })}
                </h2>
              </div>
              <button
                aria-label={t("smartReference.close")}
                className="icon-button"
                onClick={() => setSmartReferenceResult(null)}
                type="button"
              >
                <X aria-hidden="true" size={16} />
              </button>
            </header>
            {smartReferenceResult.automaticallyAddedNodeIds.length > 0 && (
              <p className="smart-reference-summary">
                {t("smartReference.automaticAdded", {
                  count: smartReferenceResult.automaticallyAddedNodeIds.length,
                  threshold: embeddingSettings.autoReferenceThreshold.toFixed(2),
                })}
              </p>
            )}
            {smartReferenceResult.truncatedNodeCount > 0 && (
              <p className="smart-reference-warning">
                {t("smartReference.truncated", {
                  count: smartReferenceResult.truncatedNodeCount,
                })}
              </p>
            )}
            {smartReferenceResult.candidates.length === 0 ? (
              <p className="smart-reference-empty">{t("smartReference.empty")}</p>
            ) : (
              <div className="smart-reference-results">
                {smartReferenceResult.candidates.slice(0, 24).map((candidate) => {
                  const candidateNode = workspace.nodes.find(
                    (node) => node.id === candidate.nodeId,
                  );
                  if (candidateNode === undefined) {
                    return null;
                  }
                  const accepted = smartReferenceResult.acceptedNodeIds.includes(
                    candidate.nodeId,
                  );
                  return (
                    <div className="smart-reference-candidate" key={candidate.nodeId}>
                      <div>
                        <strong>
                          {nodeFilterLabel(
                            candidateNode,
                            t("nodes.unnamed"),
                            t("nodes.noContent"),
                          )}
                        </strong>
                        <span>
                          {t("smartReference.similarity", {
                            score: candidate.score.toFixed(3),
                          })}
                        </span>
                      </div>
                      <button
                        className="secondary-button"
                        disabled={accepted}
                        onClick={() => acceptSmartReference(candidate.nodeId)}
                        type="button"
                      >
                        {accepted
                          ? t("smartReference.referenced")
                          : t("smartReference.addReference")}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {smartReferenceResult.candidates.length > 24 && (
              <p className="smart-reference-limit">
                {t("smartReference.resultLimit", {
                  count: smartReferenceResult.candidates.length,
                })}
              </p>
            )}
            <footer>
              <small>{t("smartReference.scoreDescription")}</small>
              <button
                className="primary-button"
                onClick={() => setSmartReferenceResult(null)}
                type="button"
              >
                {t("smartReference.close")}
              </button>
            </footer>
          </section>
        </div>
      )}

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
                onClick={() => void applyWorkspaceReplacement()}
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
