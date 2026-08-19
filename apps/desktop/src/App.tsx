import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  AlertTriangle,
  ArchiveRestore,
  BrainCircuit,
  Cloud,
  Clock3,
  Cpu,
  Database,
  Download,
  FileText,
  Filter,
  Fingerprint,
  KeyRound,
  Keyboard,
  Languages,
  Link2,
  LockKeyhole,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import GraphCanvas from "./GraphCanvas";
import CanvasOperationGuide from "./CanvasOperationGuide";
import { canvasOperationIds } from "./canvasOperations";
import {
  loadCanvasAutoAvoidOverlaps,
  saveCanvasAutoAvoidOverlaps,
} from "./canvasPreferences";
import DocumentImportDialog from "./DocumentImportDialog";
import {
  buildDocumentImportWorkspace,
  mergeDocumentImportCandidates,
  parseExternalDocumentImportFile,
  splitDocumentForImport,
  validateExternalDocumentImportReferences,
  validateExternalDocumentImportIsRestored,
  type DocumentImportCandidate,
  type DocumentImportDraft,
  type DocumentImportLlmGateway,
} from "./documentImport";
import { importDocumentDraft, importTextDocument } from "./documentImportBridge";
import {
  NodeContentHost,
  contentProcessorRegistry,
} from "./contentProcessor";
import { contentMarkerRegistry } from "./contentMarker";
import { NodeSearchIndex, type NodeSearchScope } from "./nodeSearch";
import { supportedLanguages, type SupportedLanguage } from "./locales";
import {
  emptyWorkspace,
  isNodeNameAvailable,
  isUnnamedNode,
  moveNodeLayoutToFront,
  normalizeNodeName,
  persistedNodeNameFromDraft,
  removeNodesFromWorkspaceView,
  parseStoredWorkspaceText,
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
  type ImportedWorkspaceFile,
} from "./workspaceFileBridge";
import {
  isEncryptedWorkspaceExport,
  type WorkspaceSecurity,
  type WorkspaceSecurityStatus,
} from "./workspaceSecurity";
import type {
  WorkspaceBackupEntry,
  WorkspaceBackupHistory,
  WorkspaceBackupHistoryStatus,
} from "./workspaceBackupHistory";
import type {
  SecretClipboard,
  SecretClipboardStatus,
} from "./secretClipboard";
import type {
  OffsiteBackupPage,
  OffsiteBackupService,
  OffsiteBackupTarget,
  S3ProviderTemplate,
  TemporaryBackupConnection,
} from "./offsiteBackup";
import {
  resolveS3Endpoint,
  s3EndpointPlaceholder,
  s3TemplateDefaults,
} from "./s3ProviderTemplates";
import WorkspaceRestorePreview from "./WorkspaceRestorePreview";
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
import {
  appendExistingNodeReference,
  appendNodeReference,
} from "./referenceSearch";
import {
  EmbeddingAnalysisFailure,
  EmbeddingAnalyzer,
  embeddingTransmissionEstimate,
  type EmbeddingGateway,
} from "./embeddingService";
import type {
  EmbeddingVectorCache,
  EmbeddingVectorCacheStatus,
} from "./embeddingCache";
import {
  embeddingSettingsFingerprint,
  smartReferenceScoringFingerprint,
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
import {
  prepareLlmReview,
  validateLlmReviewResponse,
  type LlmGateway,
} from "./llmReview";
import {
  updateLlmSettings,
  type LlmSettings,
  type LlmSettingsStore,
} from "./llmSettings";
import {
  localLlmModelDefinition,
  localLlmModels,
  type LocalLlmModelId,
  type LocalLlmModelStatus,
  type LocalLlmProgress,
  type LocalLlmRuntime,
} from "./localLlmModels";
import {
  filterSmartReferenceResultForWorkspace,
  smartReferenceResultCacheKey,
  smartReferenceResultSettingsFingerprint,
  smartReferenceSourceFingerprint,
  type CachedSmartReferenceResult,
  type SmartReferenceResultCache,
  type SmartReferenceResultCacheStatus,
} from "./smartReferenceCache";
import "./App.css";

type ViewId = "canvas" | "nodes" | "settings";
type SettingsTabId =
  | "general"
  | "operations"
  | "smartReference"
  | "dataSecurity";

interface PendingWorkspaceReplacement {
  kind: "history" | "import" | "recovery" | "bootstrapRestore";
  returnView: ViewId;
  sourceName: string;
  workspace: WorkspaceSnapshot;
  preparedRestoreId?: string;
}

interface PendingEncryptedWorkspaceImport extends ImportedWorkspaceFile {
  bootstrapRestore: boolean;
}

type WorkspaceReplacementHistoryBoundary = "undo" | "redo" | null;

interface AppNotice {
  message: string;
  action?: {
    label: string;
    run: () => void;
  };
}

type PendingOffsiteSensitiveAction =
  | { kind: "deleteSnapshot"; targetId: string; snapshotId: string; createdAtMs: number }
  | { kind: "removeTarget"; targetId: string; targetName: string }
  | { kind: "destroyTarget"; targetId: string; targetName: string }
  | {
      kind: "retention";
      targetId: string;
      enabled: boolean;
      maxSnapshots: number;
      maxAgeDays: number;
    };

interface AppProps {
  documentImportLlmGateway: DocumentImportLlmGateway;
  embeddingGateway: EmbeddingGateway;
  embeddingVectorCache: EmbeddingVectorCache;
  embeddingSettingsStore: EmbeddingSettingsStore;
  llmGateway: LlmGateway;
  llmSettingsStore: LlmSettingsStore;
  localEmbeddingRuntime: LocalEmbeddingRuntime;
  localLlmRuntime: LocalLlmRuntime;
  lifecycle: WorkspaceLifecycle;
  offsiteBackup: OffsiteBackupService;
  persistence: WorkspacePersistence;
  secretClipboard: SecretClipboard;
  smartReferenceResultCache: SmartReferenceResultCache;
  updateWorkspaceSecurityStatus: (status: WorkspaceSecurityStatus) => void;
  workspaceBackupHistory: WorkspaceBackupHistory;
  workspaceSecurity: WorkspaceSecurity;
  workspaceSecurityStatus: WorkspaceSecurityStatus;
}

interface SmartReferenceResult extends CachedSmartReferenceResult {
  analysisKey: string;
  acceptedNodeIds: string[];
  automaticallyAddedNodeIds: string[];
}

type SmartReferenceTaskStatus = "queued" | "running" | "completed" | "failed";

interface SmartReferenceTask {
  cacheHit: boolean;
  error: string | null;
  nodeId: string;
  result: SmartReferenceResult | null;
  status: SmartReferenceTaskStatus;
}

const maximumSmartReferenceBatchSize = 256;
const maximumSmartReferenceMemoryResults = 128;

interface WorkspaceUpdateOptions {
  flushImmediately?: boolean;
  affectsOffsiteBackup?: boolean;
  recordHistory?: boolean;
}

const workspaceHistoryLimit = 100;

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

function formatBackupDate(createdAtMs: number, language: string): string {
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(createdAtMs));
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
  documentImportLlmGateway,
  embeddingGateway,
  embeddingVectorCache,
  embeddingSettingsStore,
  llmGateway,
  llmSettingsStore,
  localEmbeddingRuntime,
  localLlmRuntime,
  lifecycle,
  offsiteBackup,
  persistence,
  secretClipboard,
  smartReferenceResultCache,
  updateWorkspaceSecurityStatus,
  workspaceBackupHistory,
  workspaceSecurity,
  workspaceSecurityStatus,
}: AppProps) {
  const { t, i18n } = useTranslation();
  const [activeView, setActiveView] = useState<ViewId>("canvas");
  const [activeSettingsTab, setActiveSettingsTab] =
    useState<SettingsTabId>("general");
  const [workspace, setWorkspace] = useState(emptyWorkspace);
  const workspaceRef = useRef(workspace);
  const skipUnmountFlushRef = useRef(false);
  const workspaceReplacementGenerationRef = useRef(0);
  const documentImportCancelledRef = useRef(false);
  const workspaceChangedInSessionRef = useRef(false);
  const [persistenceReady, setPersistenceReady] = useState(false);
  const [persistenceRecoveryRequired, setPersistenceRecoveryRequired] =
    useState(false);
  const [primaryStorageProblem, setPrimaryStorageProblem] = useState<string | null>(null);
  const [recoveryStorageProblem, setRecoveryStorageProblem] = useState<string | null>(null);
  const [confirmClearUnreadable, setConfirmClearUnreadable] = useState(false);
  const [storageProblemStatus, setStorageProblemStatus] = useState<string | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const editingNodeIdRef = useRef<string | null>(null);
  const editBaselineRef = useRef<{
    nodeId: string;
    state: WorkspaceHistoryState;
  } | null>(null);
  const historyTimelineRef = useRef(emptyWorkspaceHistoryTimeline());
  const workspaceReplacementHistoryBoundaryRef =
    useRef<WorkspaceReplacementHistoryBoundary>(null);
  const workspaceReplacementHistoryBusyRef = useRef(false);
  const workspaceMutationBlockedRef = useRef(false);
  const [historyAvailability, setHistoryAvailability] = useState({
    canUndo: false,
    canRedo: false,
  });
  const [searchTerm, setSearchTerm] = useState("");
  const [searchScope, setSearchScope] = useState<NodeSearchScope>("name");
  const [unmatchedNodeOpacity, setUnmatchedNodeOpacity] = useState(20);
  const [autoAvoidCanvasOverlaps, setAutoAvoidCanvasOverlaps] = useState(() =>
    loadCanvasAutoAvoidOverlaps(
      typeof localStorage === "undefined" ? null : localStorage,
    ),
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [unnamedOnly, setUnnamedOnly] = useState(false);
  const [referenceFilterNodeIds, setReferenceFilterNodeIds] = useState<string[]>([]);
  const [pendingWorkspaceReplacement, setPendingWorkspaceReplacement] =
    useState<PendingWorkspaceReplacement | null>(null);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [documentImportOpen, setDocumentImportOpen] = useState(false);
  const [documentImportSourceName, setDocumentImportSourceName] = useState("");
  const [documentImportSourceText, setDocumentImportSourceText] = useState("");
  const [documentImportDraft, setDocumentImportDraft] =
    useState<DocumentImportDraft | null>(null);
  const [documentImportPreview, setDocumentImportPreview] = useState<{
    draft: DocumentImportDraft;
    workspace: WorkspaceSnapshot;
  } | null>(null);
  const [documentImportBusy, setDocumentImportBusy] = useState(false);
  const [documentImportExternalLoading, setDocumentImportExternalLoading] = useState(false);
  const [documentImportProgress, setDocumentImportProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [documentImportError, setDocumentImportError] = useState<string | null>(null);
  const [automaticBackupHistory, setAutomaticBackupHistory] =
    useState<WorkspaceBackupHistoryStatus | null>(null);
  const [automaticBackupHistoryLoading, setAutomaticBackupHistoryLoading] =
    useState(false);
  const [automaticBackupHistoryError, setAutomaticBackupHistoryError] = useState<
    string | null
  >(null);
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const [securityDialog, setSecurityDialog] = useState<
    | "enable"
    | "change"
    | "rotate"
    | "export"
    | "exportUnreadable"
    | "backupTarget"
    | "offsiteSensitive"
    | null
  >(null);
  const [pendingBackupTarget, setPendingBackupTarget] = useState<
    | ({
        targetId: string | null;
        name: string;
        replaceCredentials: boolean;
      } & TemporaryBackupConnection & {
        s3Provider: S3ProviderTemplate;
      })
    | null
  >(null);
  const [pendingOffsiteSensitiveAction, setPendingOffsiteSensitiveAction] =
    useState<PendingOffsiteSensitiveAction | null>(null);
  const [offsiteConfirmationName, setOffsiteConfirmationName] = useState("");
  const [pendingUnreadableExport, setPendingUnreadableExport] = useState<{
    raw: string;
    source: "primary" | "recovery";
  } | null>(null);
  const [securityCurrentPassword, setSecurityCurrentPassword] = useState("");
  const [securityPassword, setSecurityPassword] = useState("");
  const [securityPasswordConfirmation, setSecurityPasswordConfirmation] =
    useState("");
  const [securityBusy, setSecurityBusy] = useState(false);
  const [securityMessage, setSecurityMessage] = useState<string | null>(null);
  const [secretClipboardStatus, setSecretClipboardStatus] =
    useState<SecretClipboardStatus | null>(null);
  const [recoveryClearDialog, setRecoveryClearDialog] = useState(false);
  const [recoveryClearPassword, setRecoveryClearPassword] = useState("");
  const [destroyWorkspaceDialog, setDestroyWorkspaceDialog] = useState(false);
  const [destroyWorkspacePassword, setDestroyWorkspacePassword] = useState("");
  const [destroyWorkspaceConfirmation, setDestroyWorkspaceConfirmation] =
    useState("");
  const [pendingEncryptedImport, setPendingEncryptedImport] =
    useState<PendingEncryptedWorkspaceImport | null>(null);
  const [encryptedImportPassword, setEncryptedImportPassword] = useState("");
  const [encryptedImportBusy, setEncryptedImportBusy] = useState(false);
  const [encryptedImportError, setEncryptedImportError] = useState<string | null>(
    null,
  );
  const [offsiteTargets, setOffsiteTargets] = useState<OffsiteBackupTarget[]>([]);
  const [selectedOffsiteTargetId, setSelectedOffsiteTargetId] = useState<
    string | null
  >(null);
  const [offsitePage, setOffsitePage] = useState<OffsiteBackupPage | null>(null);
  const [offsiteBusy, setOffsiteBusy] = useState(false);
  const [offsiteMessage, setOffsiteMessage] = useState<string | null>(null);
  const automaticOffsiteRunningRef = useRef(false);
  const automaticOffsiteRevisionRef = useRef(0);
  const automaticOffsiteMarkedRevisionRef = useRef(0);
  const [appNotice, setAppNotice] = useState<AppNotice | null>(null);
  const appNoticeTimerRef = useRef<number | null>(null);
  const [offsiteTargetName, setOffsiteTargetName] = useState("Cloudflare R2");
  const [offsiteEndpoint, setOffsiteEndpoint] = useState("");
  const [offsiteS3Provider, setOffsiteS3Provider] =
    useState<S3ProviderTemplate>("cloudflareR2");
  const [offsiteRegion, setOffsiteRegion] = useState("auto");
  const [offsiteBucket, setOffsiteBucket] = useState("");
  const [offsitePrefix, setOffsitePrefix] = useState("linked-info/v1");
  const [offsiteAccessKeyId, setOffsiteAccessKeyId] = useState("");
  const [offsiteSecretAccessKey, setOffsiteSecretAccessKey] = useState("");
  const [offsiteSessionToken, setOffsiteSessionToken] = useState("");
  const [editingOffsiteTargetId, setEditingOffsiteTargetId] = useState<
    string | null
  >(null);
  const [replaceOffsiteCredentials, setReplaceOffsiteCredentials] =
    useState(false);
  const offsiteRecoveryConnectionRef =
    useRef<TemporaryBackupConnection | null>(null);
  const [offsiteRecoveryPage, setOffsiteRecoveryPage] =
    useState<OffsiteBackupPage | null>(null);
  const [offsiteRestoreDrill, setOffsiteRestoreDrill] = useState<{
    targetId: string;
    snapshotId: string;
    createdAtMs: number;
  } | null>(null);
  const [offsiteRestoreDrillPassword, setOffsiteRestoreDrillPassword] =
    useState("");
  const [offsiteRestoreDrillError, setOffsiteRestoreDrillError] = useState<
    string | null
  >(null);
  const [offsiteRestoreDrillSucceeded, setOffsiteRestoreDrillSucceeded] =
    useState(false);
  const embeddingAnalyzer = useMemo(
    () => new EmbeddingAnalyzer(embeddingGateway, embeddingVectorCache),
    [embeddingGateway, embeddingVectorCache],
  );
  const [embeddingSettings, setEmbeddingSettings] = useState<EmbeddingSettings>(() => {
    const loaded = embeddingSettingsStore.load();
    if (!workspaceSecurityStatus.encrypted || loaded.provider === "local") {
      return loaded;
    }
    const localOnly = updateEmbeddingSettings(loaded, { provider: "local" });
    try {
      embeddingSettingsStore.save(localOnly);
    } catch {
      // The runtime guard still prevents remote transmission for encrypted data.
    }
    return localOnly;
  });
  const [llmSettings, setLlmSettings] = useState<LlmSettings>(() =>
    llmSettingsStore.load(),
  );
  const embeddingSettingsRef = useRef(embeddingSettings);
  const llmSettingsRef = useRef(llmSettings);
  embeddingSettingsRef.current = embeddingSettings;
  llmSettingsRef.current = llmSettings;
  const [remoteEmbeddingToken, setRemoteEmbeddingToken] = useState("");
  const [analyzingNodeId, setAnalyzingNodeId] = useState<string | null>(null);
  const [smartReferenceTasks, setSmartReferenceTasks] = useState<
    SmartReferenceTask[]
  >([]);
  const smartReferenceWorkerRunningRef = useRef(false);
  const [smartReferenceWorkerRevision, setSmartReferenceWorkerRevision] = useState(0);
  const smartReferenceQueueGenerationRef = useRef(0);
  const smartReferenceMemoryCacheRef = useRef(
    new Map<string, CachedSmartReferenceResult>(),
  );
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
  const [localLlmProgress, setLocalLlmProgress] =
    useState<LocalLlmProgress | null>(null);
  const [localLlmModelStatuses, setLocalLlmModelStatuses] = useState<
    LocalLlmModelStatus[]
  >([]);
  const [preparingLocalLlmModelId, setPreparingLocalLlmModelId] =
    useState<LocalLlmModelId | null>(null);
  const [cancellingLocalLlmDownload, setCancellingLocalLlmDownload] =
    useState(false);
  const [vectorCacheStatus, setVectorCacheStatus] =
    useState<EmbeddingVectorCacheStatus | null>(null);
  const [vectorCacheBusy, setVectorCacheBusy] = useState(false);
  const [vectorCacheMessage, setVectorCacheMessage] = useState<string | null>(null);
  const [smartReferenceCacheStatus, setSmartReferenceCacheStatus] =
    useState<SmartReferenceResultCacheStatus | null>(null);
  const [smartReferenceCacheBusy, setSmartReferenceCacheBusy] = useState(false);
  const [smartReferenceCacheMessage, setSmartReferenceCacheMessage] = useState<
    string | null
  >(null);
  const currentView = views.find((view) => view.id === activeView) ?? views[0];
  const activeLanguage = i18n.resolvedLanguage ?? i18n.language;
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const nodeSearchIndex = useMemo(() => new NodeSearchIndex(), []);
  const remoteEmbeddingScope = useMemo(
    () => embeddingTransmissionEstimate(workspace.nodes),
    [workspace.nodes],
  );
  const selectedOffsiteTarget = useMemo(
    () =>
      offsiteTargets.find((target) => target.id === selectedOffsiteTargetId) ?? null,
    [offsiteTargets, selectedOffsiteTargetId],
  );
  useEffect(() => {
    editingNodeIdRef.current = editingNodeId;
  }, [editingNodeId]);

  useEffect(() => {
    saveCanvasAutoAvoidOverlaps(
      typeof localStorage === "undefined" ? null : localStorage,
      autoAvoidCanvasOverlaps,
    );
  }, [autoAvoidCanvasOverlaps]);

  useEffect(() => {
    return () => {
      if (appNoticeTimerRef.current !== null) {
        window.clearTimeout(appNoticeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const focusNodeSearch = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.key.toLowerCase() !== "f"
      ) {
        return;
      }
      const searchInput = searchInputRef.current;
      if (searchInput === null) {
        return;
      }
      event.preventDefault();
      searchInput.focus({ preventScroll: true });
      searchInput.select();
    };
    window.addEventListener("keydown", focusNodeSearch, true);
    return () => window.removeEventListener("keydown", focusNodeSearch, true);
  }, []);

  function dismissAppNotice() {
    if (appNoticeTimerRef.current !== null) {
      window.clearTimeout(appNoticeTimerRef.current);
      appNoticeTimerRef.current = null;
    }
    setAppNotice(null);
  }

  function showAppNotice(message: string, action?: AppNotice["action"]) {
    if (appNoticeTimerRef.current !== null) {
      window.clearTimeout(appNoticeTimerRef.current);
    }
    setAppNotice({ message, action });
    appNoticeTimerRef.current = window.setTimeout(() => {
      setAppNotice(null);
      appNoticeTimerRef.current = null;
    }, action === undefined ? 6_000 : 10_000);
  }

  function openDocumentImport() {
    documentImportCancelledRef.current = false;
    setDocumentImportOpen(true);
    setDocumentImportDraft(null);
    setDocumentImportPreview(null);
    setDocumentImportSourceName("");
    setDocumentImportSourceText("");
    setDocumentImportError(null);
    setDocumentImportProgress(null);
  }

  function discardDocumentImport() {
    documentImportCancelledRef.current = true;
    setDocumentImportOpen(false);
    setDocumentImportDraft(null);
    setDocumentImportSourceName("");
    setDocumentImportSourceText("");
    setDocumentImportError(null);
    setDocumentImportProgress(null);
    if (documentImportBusy) void localLlmRuntime.stop();
  }

  async function chooseDocumentImportFile() {
    if (documentImportBusy) return;
    setDocumentImportError(null);
    try {
      const file = await importTextDocument();
      if (file === null) return;
      setDocumentImportSourceName(file.name);
      setDocumentImportSourceText(file.text);
    } catch (error) {
      setDocumentImportError(
        t("documentImport.errors.file", { reason: errorReason(error) }),
      );
    }
  }

  async function chooseExternalDocumentImportDraft() {
    if (documentImportBusy || documentImportExternalLoading) return;
    setDocumentImportExternalLoading(true);
    setDocumentImportError(null);
    try {
      const file = await importDocumentDraft();
      if (file === null) return;
      const external = parseExternalDocumentImportFile(file.text);
      validateExternalDocumentImportIsRestored(external);
      const candidates = mergeDocumentImportCandidates(
        external.responses,
        workspaceRef.current,
      );
      validateExternalDocumentImportReferences(candidates, workspaceRef.current);
      const sourceHash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(external.sourceText),
      );
      const hash = Array.from(new Uint8Array(sourceHash), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join("");
      setDocumentImportSourceName(external.sourceName);
      setDocumentImportSourceText(external.sourceText);
      setDocumentImportDraft({
        sourceNodeId: crypto.randomUUID(),
        sourceName: external.sourceName,
        sourceText: external.sourceText,
        sourceHash: hash,
        importedAtMs: Date.now(),
        modelId: "external",
        candidates,
      });
    } catch (error) {
      setDocumentImportError(
        t("documentImport.errors.externalDraft", { reason: errorReason(error) }),
      );
    } finally {
      setDocumentImportExternalLoading(false);
    }
  }

  async function analyzeDocumentImport() {
    if (documentImportBusy) return;
    const sourceText = documentImportSourceText;
    if (sourceText.trim().length === 0) return;
    setDocumentImportBusy(true);
    documentImportCancelledRef.current = false;
    setDocumentImportError(null);
    setLocalLlmProgress(null);
    const replacementGeneration = workspaceReplacementGenerationRef.current;
    try {
      const chunks = splitDocumentForImport(sourceText);
      const sourceName = documentImportSourceName.trim() || t("documentImport.pastedSource");
      const responses = [];
      for (let index = 0; index < chunks.length; index += 1) {
        if (documentImportCancelledRef.current) {
          throw new Error("document_import_cancelled");
        }
        setDocumentImportProgress({ current: index + 1, total: chunks.length });
        responses.push(
          await documentImportLlmGateway.extractChunk(llmSettings.localModel, {
            sourceName,
            chunkIndex: index,
            chunkCount: chunks.length,
            text: chunks[index],
          }),
        );
      }
      if (documentImportCancelledRef.current) {
        throw new Error("document_import_cancelled");
      }
      if (replacementGeneration !== workspaceReplacementGenerationRef.current) {
        throw new Error("document_import_outdated");
      }
      const sourceHash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(sourceText),
      );
      const hash = Array.from(new Uint8Array(sourceHash), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join("");
      setDocumentImportDraft({
        sourceNodeId: crypto.randomUUID(),
        sourceName,
        sourceText,
        sourceHash: hash,
        importedAtMs: Date.now(),
        modelId: llmSettings.localModel,
        candidates: mergeDocumentImportCandidates(responses, workspaceRef.current),
      });
    } catch (error) {
      const reason = errorReason(error);
      if (documentImportCancelledRef.current || reason === "document_import_cancelled") {
        return;
      }
      setDocumentImportError(
        reason === "documentImportTooLarge" || reason === "documentImportTooManyChunks"
          ? t(`documentImport.errors.${reason}`)
          : t("documentImport.errors.analysis", { reason }),
      );
    } finally {
      setDocumentImportBusy(false);
      setDocumentImportProgress(null);
    }
  }

  function updateDocumentImportCandidate(
    candidateId: string,
    patch: Partial<DocumentImportCandidate>,
  ) {
    setDocumentImportDraft((current) =>
      current === null
        ? null
        : {
            ...current,
            candidates: current.candidates.map((candidate) => {
              if (candidate.id !== candidateId) return candidate;
              const next = { ...candidate, ...patch };
              if (patch.name !== undefined) {
                const normalizedName = normalizeNodeName(patch.name);
                next.matchedNodeId =
                  workspaceRef.current.nodes.find(
                    (node) =>
                      node.name !== null &&
                      normalizeNodeName(node.name) === normalizedName,
                  )?.id ?? null;
              }
              return next;
            }),
          },
    );
    setDocumentImportError(null);
  }

  function previewDocumentImport() {
    if (documentImportDraft === null) return;
    try {
      const result = buildDocumentImportWorkspace(
        workspaceRef.current,
        documentImportDraft,
      );
      setDocumentImportPreview({
        draft: documentImportDraft,
        workspace: result.workspace,
      });
      setDocumentImportOpen(false);
      setDocumentImportError(null);
    } catch (error) {
      setDocumentImportError(
        t("documentImport.errors.draft", { reason: errorReason(error) }),
      );
    }
  }

  function cancelDocumentImportPreview() {
    setDocumentImportPreview(null);
    setDocumentImportOpen(true);
  }

  function confirmDocumentImport() {
    if (documentImportPreview === null) return;
    try {
      const result = buildDocumentImportWorkspace(
        workspaceRef.current,
        documentImportPreview.draft,
      );
      updateWorkspace(() => result.workspace, {
        flushImmediately: true,
        recordHistory: true,
      });
      setDocumentImportPreview(null);
      setDocumentImportDraft(null);
      setDocumentImportSourceName("");
      setDocumentImportSourceText("");
      setActiveView("canvas");
      showAppNotice(
        t("documentImport.success", {
          nodes: result.addedNodeCount,
          matched: result.matchedNodeCount,
          references: result.addedReferenceCount,
        }),
      );
    } catch (error) {
      setDocumentImportPreview(null);
      setDocumentImportOpen(true);
      setDocumentImportError(
        t("documentImport.errors.outdated", { reason: errorReason(error) }),
      );
    }
  }

  useEffect(() => {
    if (!workspaceSecurityStatus.encrypted) {
      setSecretClipboardStatus(null);
      return;
    }
    let active = true;
    void secretClipboard
      .inspect()
      .then((status) => {
        if (active) {
          setSecretClipboardStatus(status);
        }
      })
      .catch(() => {
        if (active) {
          setSecretClipboardStatus(null);
        }
      });
    return () => {
      active = false;
    };
  }, [secretClipboard, workspaceSecurityStatus.encrypted]);

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
    let active = true;
    let unsubscribe: (() => void) | undefined;

    function refreshModelStatuses() {
      void localLlmRuntime
        .inspectModels()
        .then((statuses) => {
          if (active) {
            setLocalLlmModelStatuses(statuses);
          }
        })
        .catch(() => undefined);
    }

    refreshModelStatuses();
    void localLlmRuntime
      .subscribe((progress) => {
        if (!active) {
          return;
        }
        setLocalLlmProgress(progress);
        if (
          progress.phase === "ready" ||
          progress.phase === "cancelled" ||
          progress.phase === "failed"
        ) {
          setCancellingLocalLlmDownload(false);
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
  }, [localLlmRuntime]);

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
    if (activeView !== "settings") {
      return;
    }
    let active = true;
    void smartReferenceResultCache
      .inspect()
      .then((status) => {
        if (active) {
          setSmartReferenceCacheStatus(status);
          setSmartReferenceCacheMessage(null);
        }
      })
      .catch((error) => {
        if (active) {
          setSmartReferenceCacheMessage(
            t("smartReference.settings.resultCache.inspectFailed", {
              reason: errorReason(error),
            }),
          );
        }
      });
    return () => {
      active = false;
    };
  }, [activeView, smartReferenceResultCache, t]);

  useEffect(() => {
    if (!persistenceReady || !workspaceBackupHistory.available) {
      return;
    }
    let active = true;
    setAutomaticBackupHistoryLoading(true);
    void workspaceBackupHistory
      .inspect()
      .then((status) => {
        if (active) {
          setAutomaticBackupHistory(status);
          setAutomaticBackupHistoryError(null);
        }
      })
      .catch(() => {
        if (active) {
          setAutomaticBackupHistoryError(t("backup.historyInspectFailed"));
        }
      })
      .finally(() => {
        if (active) {
          setAutomaticBackupHistoryLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [persistenceReady, t, workspaceBackupHistory]);

  useEffect(() => {
    if (!workspaceSecurityStatus.encrypted || !offsiteBackup.available) {
      return;
    }
    let active = true;
    void offsiteBackup
      .inspectTargets()
      .then((targets) => {
        if (!active) {
          return;
        }
        setOffsiteTargets(targets);
        setSelectedOffsiteTargetId((current) =>
          current !== null && targets.some((target) => target.id === current)
            ? current
            : (targets[0]?.id ?? null),
        );
      })
      .catch((error) => {
        if (active) {
          setOffsiteMessage(
            t("offsiteBackup.errors.inspect", { reason: errorReason(error) }),
          );
        }
      });
    return () => {
      active = false;
    };
  }, [offsiteBackup, t, workspaceSecurityStatus.encrypted]);

  useEffect(() => {
    if (
      !persistenceReady ||
      !workspaceSecurityStatus.encrypted ||
      !offsiteBackup.available
    ) {
      return;
    }
    void requestAutomaticOffsiteBackup(
      automaticOffsiteRevisionRef.current >
        automaticOffsiteMarkedRevisionRef.current,
      automaticOffsiteRevisionRef.current,
    );
    const timer = window.setInterval(() => {
      void requestAutomaticOffsiteBackup(
        automaticOffsiteRevisionRef.current >
          automaticOffsiteMarkedRevisionRef.current,
        automaticOffsiteRevisionRef.current,
      );
    }, 5 * 60 * 1_000);
    return () => window.clearInterval(timer);
  }, [offsiteBackup, persistenceReady, workspaceSecurityStatus.encrypted]);

  useEffect(() => {
    if (
      activeView !== "settings" ||
      selectedOffsiteTargetId === null
    ) {
      setOffsitePage(null);
      return;
    }
    let active = true;
    void offsiteBackup
      .list(selectedOffsiteTargetId)
      .then((page) => {
        if (active) {
          setOffsitePage(page);
        }
      })
      .catch((error) => {
        if (active) {
          setOffsiteMessage(
            t("offsiteBackup.errors.list", { reason: errorReason(error) }),
          );
        }
      });
    return () => {
      active = false;
    };
  }, [activeView, offsiteBackup, selectedOffsiteTarget, selectedOffsiteTargetId, t]);

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
          setPersistenceRecoveryRequired(false);
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

  const searchMatchedNodeIds = useMemo(
    () =>
      nodeSearchIndex.matchingNodeIds(
        workspace.nodes,
        deferredSearchTerm,
        searchScope,
      ),
    [deferredSearchTerm, nodeSearchIndex, searchScope, workspace.nodes],
  );

  const filteredNodes = useMemo(() => {
    return workspace.nodes.filter(
      (node) =>
        (!unnamedOnly || isUnnamedNode(node)) &&
          searchMatchedNodeIds.has(node.id) &&
          referenceFilterNodeIds.every((targetNodeId) =>
            referencedTargetIdsBySource.get(node.id)?.has(targetNodeId),
          ),
    );
  }, [
    referenceFilterNodeIds,
    referencedTargetIdsBySource,
    searchMatchedNodeIds,
    unnamedOnly,
    workspace.nodes,
  ]);

  const filteredNodeIds = useMemo(
    () => new Set(filteredNodes.map((node) => node.id)),
    [filteredNodes],
  );
  const hasActiveNodeFilter =
    normalizeNodeName(deferredSearchTerm).length > 0 ||
    unnamedOnly ||
    referenceFilterNodeIds.length > 0;

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

  const contentProcessorOptions = useMemo(
    () =>
      contentProcessorRegistry.list().map((processor) => ({
        id: processor.id,
        label:
          processor.id === "text"
            ? t("editor.contentProcessors.text")
            : processor.id === "markdown"
              ? t("editor.contentProcessors.markdown")
              : processor.id,
      })),
    [t],
  );

  const contentMarkerOptions = useMemo(
    () =>
      contentMarkerRegistry.list().map((marker) => ({
        id: marker.id,
        invalidPayloadLabel:
          marker.id === "totp" ? t("totp.invalid") : null,
        label:
          marker.id === "totp"
            ? t("contentMarkers.totp")
            : marker.id === "secret"
              ? t("contentMarkers.secret")
              : marker.id,
      })),
    [t],
  );

  const contentEnhancementLabels = useMemo(
    () => ({
      secret: {
        copy: t("secret.copy"),
        hide: t("secret.hide"),
        label: t("secret.label"),
        masked: t("secret.masked"),
        reveal: t("secret.reveal"),
      },
      totp: {
        copy: t("totp.copy"),
        generating: t("totp.generating"),
        invalid: t("totp.invalid"),
        masked: t("totp.masked"),
        remaining: (seconds: number) => t("totp.remaining", { seconds }),
      },
    }),
    [t],
  );

  useEffect(() => {
    if (!persistenceReady) {
      return;
    }
    workspaceRef.current = workspace;
    const captureAutomaticBackup = workspaceChangedInSessionRef.current;
    const automaticOffsiteRevision = automaticOffsiteRevisionRef.current;
    const saveTimer = window.setTimeout(
      () => {
        void persistence
          .save(workspace)
          .then(async () => {
            if (
              workspaceSecurityStatus.encrypted &&
              automaticOffsiteRevision > automaticOffsiteMarkedRevisionRef.current
            ) {
              void requestAutomaticOffsiteBackup(true, automaticOffsiteRevision);
            }
            if (!captureAutomaticBackup || !workspaceBackupHistory.available) {
              return;
            }
            try {
              const result = await workspaceBackupHistory.captureIfDue();
              setAutomaticBackupHistory(result.status);
              setAutomaticBackupHistoryError(null);
            } catch {
              setAutomaticBackupHistoryError(t("backup.historyCaptureFailed"));
            }
          })
          .catch(() => {
            setBackupStatus(t("storage.saveFailed"));
          });
      },
      300,
    );
    return () => window.clearTimeout(saveTimer);
  }, [
    persistence,
    persistenceReady,
    t,
    workspace,
    workspaceBackupHistory,
    workspaceSecurityStatus.encrypted,
  ]);

  useEffect(() => {
    if (!persistenceReady) {
      return;
    }

    let active = true;
    let unregister: (() => void) | null = null;
    const flushLocalWorkspace = async () => {
      await persistence.save(workspaceRef.current);
      if (!workspaceChangedInSessionRef.current || !workspaceBackupHistory.available) {
        return;
      }
      try {
        const result = await workspaceBackupHistory.captureIfDue();
        if (active) {
          setAutomaticBackupHistory(result.status);
          setAutomaticBackupHistoryError(null);
        }
      } catch {
        if (active) {
          setAutomaticBackupHistoryError(t("backup.historyCaptureFailed"));
        }
      }
    };
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
      if (!skipUnmountFlushRef.current) {
        void flushLocalWorkspace();
      }
    };
  }, [lifecycle, persistence, persistenceReady, t, workspaceBackupHistory]);

  function changeLanguage(language: SupportedLanguage) {
    void i18n.changeLanguage(language);
  }

  function closeSecurityDialog() {
    if (securityBusy) {
      return;
    }
    setSecurityDialog(null);
    setPendingUnreadableExport(null);
    setPendingBackupTarget(null);
    setPendingOffsiteSensitiveAction(null);
    setOffsiteConfirmationName("");
    setOffsiteAccessKeyId("");
    setOffsiteSecretAccessKey("");
    setOffsiteSessionToken("");
    setSecurityCurrentPassword("");
    setSecurityPassword("");
    setSecurityPasswordConfirmation("");
  }

  async function submitSecurityDialog(
    authenticationMethod: "password" | "system" = "password",
  ) {
    if (securityDialog === null || securityBusy) {
      return;
    }
    if (
      securityDialog === "offsiteSensitive" &&
      pendingOffsiteSensitiveAction?.kind === "destroyTarget" &&
      offsiteConfirmationName !== pendingOffsiteSensitiveAction.targetName
    ) {
      return;
    }
    const reauthenticationOnly =
      securityDialog === "export" ||
      securityDialog === "exportUnreadable" ||
      securityDialog === "backupTarget" ||
      securityDialog === "offsiteSensitive";
    if (
      !reauthenticationOnly &&
      securityPassword !== securityPasswordConfirmation
    ) {
      setSecurityMessage(t("security.passwordMismatch"));
      return;
    }
    if (
      !reauthenticationOnly &&
      Array.from(securityPassword).length < 15
    ) {
      setSecurityMessage(t("security.passwordTooShort"));
      return;
    }
    setSecurityBusy(true);
    setSecurityMessage(null);
    try {
      await persistence.save(workspaceRef.current);
      if (securityDialog === "enable") {
        if (embeddingSettings.provider === "remote") {
          const localOnly = updateEmbeddingSettings(embeddingSettings, {
            provider: "local",
          });
          embeddingSettingsStore.save(localOnly);
          setEmbeddingSettings(localOnly);
          setRemoteEmbeddingToken("");
        }
        const status = await workspaceSecurity.enable(securityPassword);
        embeddingAnalyzer.clearCache();
        setVectorCacheStatus(await embeddingVectorCache.inspect());
        updateWorkspaceSecurityStatus(status);
        showAppNotice(t("security.enableSuccess"));
      } else {
        const sensitiveOperation =
          securityDialog === "change"
            ? "changePassword"
            : securityDialog === "rotate"
              ? "rotateDataKey"
              : securityDialog === "backupTarget"
                ? "backupTargetChange"
                : securityDialog === "offsiteSensitive"
                  ? pendingOffsiteSensitiveAction?.kind === "deleteSnapshot"
                    ? "backupSnapshotDelete"
                    : pendingOffsiteSensitiveAction?.kind === "destroyTarget"
                      ? "backupTargetDestroy"
                    : pendingOffsiteSensitiveAction?.kind === "retention"
                        ? "backupRetentionChange"
                        : "backupTargetChange"
                : "exportWorkspace";
        const authorization = await workspaceSecurity.authorizeSensitiveOperation(
          sensitiveOperation,
          authenticationMethod === "system"
            ? {
                method: "system",
                message: t("security.sensitiveOperationPrompt"),
              }
            : { method: "password", password: securityCurrentPassword },
        );
        if (securityDialog === "change") {
          const result = await workspaceSecurity.changePassword(
            securityPassword,
            authorization,
          );
          if (result.status === "recoveryRequired") {
            skipUnmountFlushRef.current = true;
            workspaceMutationBlockedRef.current = true;
            setPersistenceRecoveryRequired(true);
            setPersistenceReady(false);
            return;
          }
          if (result.status === "committedLocked") {
            skipUnmountFlushRef.current = true;
          }
          updateWorkspaceSecurityStatus(result.securityStatus);
          showAppNotice(t("security.changeSuccess"));
        } else if (securityDialog === "rotate") {
          // Rotation revokes the current Rust plaintext session before it starts.
          // Prevent the unmount cleanup from attempting one final stale write.
          skipUnmountFlushRef.current = true;
          await workspaceSecurity.rotateDataKey(
            securityPassword,
            authorization,
          );
        } else if (securityDialog === "export") {
          await exportWorkspace(authorization);
        } else if (securityDialog === "backupTarget") {
          if (pendingBackupTarget === null) {
            throw new Error("offsite_backup_missing_pending_target");
          }
          const targetInput = {
            name: pendingBackupTarget.name,
            endpoint: pendingBackupTarget.endpoint,
            s3Provider: pendingBackupTarget.s3Provider,
            region: pendingBackupTarget.region,
            bucket: pendingBackupTarget.bucket,
            prefix: pendingBackupTarget.prefix,
            accessKeyId: pendingBackupTarget.accessKeyId,
            secretAccessKey: pendingBackupTarget.secretAccessKey,
            sessionToken: pendingBackupTarget.sessionToken,
            authorization,
          };
          const configured =
            pendingBackupTarget.targetId === null
              ? await offsiteBackup.configureS3Target(targetInput)
              : await offsiteBackup.updateS3Target({
                  ...targetInput,
                  targetId: pendingBackupTarget.targetId,
                  replaceCredentials: pendingBackupTarget.replaceCredentials,
                });
          setOffsiteTargets((targets) =>
            pendingBackupTarget.targetId === null
              ? [...targets, configured]
              : targets.map((target) =>
                  target.id === configured.id ? configured : target,
                ),
          );
          setSelectedOffsiteTargetId(configured.id);
          setOffsitePage(null);
          resetOffsiteTargetForm();
          showAppNotice(
            pendingBackupTarget.targetId === null
              ? t("offsiteBackup.targetConnected")
              : t("offsiteBackup.targetUpdated"),
          );
        } else if (
          securityDialog === "offsiteSensitive" &&
          pendingOffsiteSensitiveAction !== null
        ) {
          const action = pendingOffsiteSensitiveAction;
          if (action.kind === "deleteSnapshot") {
            await offsiteBackup.deleteSnapshot(
              action.targetId,
              action.snapshotId,
              authorization,
            );
            setOffsitePage(await offsiteBackup.list(action.targetId));
            setOffsiteTargets(await offsiteBackup.inspectTargets());
            showAppNotice(t("offsiteBackup.snapshotDeleted"));
          } else if (action.kind === "removeTarget") {
            await offsiteBackup.removeTarget(action.targetId, authorization);
            const targets = await offsiteBackup.inspectTargets();
            setOffsiteTargets(targets);
            setSelectedOffsiteTargetId(targets[0]?.id ?? null);
            setOffsitePage(null);
            if (editingOffsiteTargetId === action.targetId) {
              cancelOffsiteTargetEdit();
            }
            showAppNotice(t("offsiteBackup.targetRemoved"));
          } else if (action.kind === "destroyTarget") {
            const result = await offsiteBackup.deleteAllAndRemoveTarget(
              action.targetId,
              offsiteConfirmationName,
              authorization,
            );
            if (!result.targetRemoved) {
              setOffsiteMessage(
                t("offsiteBackup.errors.destroyPartial", {
                  count: result.deletedCount,
                  reason: result.error ?? "offsite_backup_unknown_error",
                }),
              );
            } else {
              const targets = await offsiteBackup.inspectTargets();
              setOffsiteTargets(targets);
              setSelectedOffsiteTargetId(targets[0]?.id ?? null);
              setOffsitePage(null);
              if (editingOffsiteTargetId === action.targetId) {
                cancelOffsiteTargetEdit();
              }
              showAppNotice(
                t("offsiteBackup.targetDestroyed", {
                  count: result.deletedCount,
                }),
              );
            }
          } else {
            const updated = await offsiteBackup.updateRetentionSettings(
              action.targetId,
              action.enabled,
              action.maxSnapshots,
              action.maxAgeDays,
              authorization,
            );
            setOffsiteTargets((targets) =>
              targets.map((target) =>
                target.id === updated.id ? updated : target,
              ),
            );
            showAppNotice(
              action.enabled
                ? t("offsiteBackup.retentionEnabled")
                : t("offsiteBackup.retentionDisabled"),
            );
          }
        } else if (pendingUnreadableExport !== null) {
          await exportUnreadableData(
            pendingUnreadableExport.raw,
            pendingUnreadableExport.source,
            authorization,
          );
        }
      }
      setSecurityDialog(null);
      setPendingUnreadableExport(null);
      setPendingBackupTarget(null);
      setPendingOffsiteSensitiveAction(null);
      setOffsiteConfirmationName("");
      setSecurityCurrentPassword("");
      setSecurityPassword("");
      setSecurityPasswordConfirmation("");
    } catch (error) {
      const reason = errorReason(error);
      setSecurityMessage(
        reason === "workspace_vault_password_blocked"
          ? t("security.passwordBlocked")
          : reason === "workspace_vault_password_rate_limited"
            ? t("security.passwordRateLimited")
            : reason === "offsite_backup_retention_requires_new_restore_drill"
              ? t("offsiteBackup.errors.retentionRequiresRestoreDrill")
            : t("security.operationFailed", { reason }),
      );
      try {
        updateWorkspaceSecurityStatus(await workspaceSecurity.inspect());
      } catch {
        // Keep the previous status when even the status probe fails.
      }
    } finally {
      setSecurityBusy(false);
    }
  }

  async function lockEncryptedWorkspace() {
    if (securityBusy) {
      return;
    }
    setSecurityBusy(true);
    setSecurityMessage(null);
    try {
      await persistence.save(workspaceRef.current);
      embeddingAnalyzer.clearCache();
      setRemoteEmbeddingToken("");
      skipUnmountFlushRef.current = true;
      updateWorkspaceSecurityStatus(await workspaceSecurity.lock());
    } catch (error) {
      skipUnmountFlushRef.current = false;
      setSecurityMessage(t("security.lockFailed", { reason: errorReason(error) }));
      setSecurityBusy(false);
    }
  }

  async function toggleSystemUnlock(enable: boolean) {
    if (securityBusy) {
      return;
    }
    setSecurityBusy(true);
    setSecurityMessage(null);
    try {
      const status = enable
        ? await workspaceSecurity.enableSystemUnlock(
            t("security.systemUnlockEnablePrompt"),
          )
        : await workspaceSecurity.disableSystemUnlock(
            await workspaceSecurity.authorizeSensitiveOperation(
              "systemUnlockChange",
              {
                method: "system",
                message: t("security.systemUnlockDisablePrompt"),
              },
            ),
          );
      updateWorkspaceSecurityStatus(status);
      showAppNotice(
        enable
          ? t("security.systemUnlockEnableSuccess")
          : t("security.systemUnlockDisableSuccess"),
      );
    } catch (error) {
      setSecurityMessage(
        t("security.systemUnlockOperationFailed", {
          reason: errorReason(error),
        }),
      );
      try {
        updateWorkspaceSecurityStatus(await workspaceSecurity.inspect());
      } catch {
        // Keep the previous status when even the status probe fails.
      }
    } finally {
      setSecurityBusy(false);
    }
  }

  async function changeIdleTimeout(minutes: number | null) {
    if (securityBusy) {
      return;
    }
    setSecurityBusy(true);
    setSecurityMessage(null);
    try {
      updateWorkspaceSecurityStatus(
        await workspaceSecurity.setIdleTimeout(minutes),
      );
      showAppNotice(t("security.idleTimeoutUpdated"));
    } catch (error) {
      setSecurityMessage(
        t("security.idleTimeoutUpdateFailed", {
          reason: errorReason(error),
        }),
      );
      try {
        updateWorkspaceSecurityStatus(await workspaceSecurity.inspect());
      } catch {
        // Keep the previous status when even the status probe fails.
      }
    } finally {
      setSecurityBusy(false);
    }
  }

  async function clearRecoveryData(
    authenticationMethod: "password" | "system" = "password",
  ) {
    if (securityBusy) {
      return;
    }
    setSecurityBusy(true);
    setSecurityMessage(null);
    try {
      const authorization = await workspaceSecurity.authorizeSensitiveOperation(
        "clearRecoveryData",
        authenticationMethod === "system"
          ? {
              method: "system",
              message: t("security.clearRecoveryPrompt"),
            }
          : { method: "password", password: recoveryClearPassword },
      );
      await workspaceSecurity.clearRecoveryData(authorization);
      setAutomaticBackupHistory(await workspaceBackupHistory.inspect());
      setRecoveryAvailable(false);
      setRecoveryStorageProblem(null);
      setWorkspaceReplacementHistoryBoundary(null);
      dismissAppNotice();
      setRecoveryClearDialog(false);
      setRecoveryClearPassword("");
      showAppNotice(t("security.clearRecoverySuccess"));
    } catch (error) {
      setSecurityMessage(
        t("security.clearRecoveryFailed", { reason: errorReason(error) }),
      );
    } finally {
      setSecurityBusy(false);
    }
  }

  async function destroyEncryptedWorkspace(
    authenticationMethod: "password" | "system" = "password",
  ) {
    if (
      securityBusy ||
      destroyWorkspaceConfirmation !== t("security.destroyConfirmationPhrase")
    ) {
      return;
    }
    setSecurityBusy(true);
    setSecurityMessage(null);
    skipUnmountFlushRef.current = true;
    try {
      const authorization = await workspaceSecurity.authorizeSensitiveOperation(
        "destroyWorkspace",
        authenticationMethod === "system"
          ? {
              method: "system",
              message: t("security.destroyPrompt"),
            }
          : { method: "password", password: destroyWorkspacePassword },
      );
      await workspaceSecurity.destroyWorkspace(authorization);
    } catch (error) {
      skipUnmountFlushRef.current = false;
      setSecurityMessage(
        t("security.destroyFailed", { reason: errorReason(error) }),
      );
      setSecurityBusy(false);
    }
  }

  function changeEmbeddingConfiguration(patch: Partial<EmbeddingSettings>) {
    const next = updateEmbeddingSettings(embeddingSettings, patch);
    const modelFingerprintChanged =
      embeddingSettingsFingerprint(next) !==
      embeddingSettingsFingerprint(embeddingSettings);
    const resultSettingsChanged =
      smartReferenceResultSettingsFingerprint(next, llmSettings) !==
      smartReferenceResultSettingsFingerprint(embeddingSettings, llmSettings);
    if (modelFingerprintChanged) {
      setRemoteEmbeddingToken("");
    }
    if (resultSettingsChanged) {
      setSmartReferenceResult(null);
      smartReferenceQueueGenerationRef.current += 1;
      setSmartReferenceTasks([]);
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

  function changeLlmConfiguration(patch: Partial<LlmSettings>) {
    const next = updateLlmSettings(llmSettings, patch);
    setLlmSettings(next);
    setSmartReferenceResult(null);
    smartReferenceQueueGenerationRef.current += 1;
    setSmartReferenceTasks([]);
    setLocalLlmProgress(null);
    if (!next.enabled) {
      void localLlmRuntime.stop();
    }
    try {
      llmSettingsStore.save(next);
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
      showAppNotice(t("smartReference.settings.vectorCache.clearSuccess"));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setVectorCacheMessage(
        t("smartReference.settings.vectorCache.clearFailed", { reason }),
      );
    } finally {
      setVectorCacheBusy(false);
    }
  }

  async function clearSmartReferenceResultCache() {
    if (smartReferenceCacheBusy) {
      return;
    }
    setSmartReferenceCacheBusy(true);
    setSmartReferenceCacheMessage(null);
    try {
      const status = await smartReferenceResultCache.clear();
      smartReferenceMemoryCacheRef.current.clear();
      setSmartReferenceCacheStatus(status);
      setSmartReferenceTasks((current) =>
        current.filter((task) => task.status === "queued" || task.status === "running"),
      );
      setSmartReferenceResult(null);
      showAppNotice(t("smartReference.settings.resultCache.clearSuccess"));
    } catch (error) {
      setSmartReferenceCacheMessage(
        t("smartReference.settings.resultCache.clearFailed", {
          reason: errorReason(error),
        }),
      );
    } finally {
      setSmartReferenceCacheBusy(false);
    }
  }

  function rememberSmartReferenceResult(
    key: string,
    result: CachedSmartReferenceResult,
  ) {
    const cache = smartReferenceMemoryCacheRef.current;
    cache.delete(key);
    cache.set(key, result);
    while (cache.size > maximumSmartReferenceMemoryResults) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      cache.delete(oldest);
    }
  }

  function hydrateSmartReferenceResult(
    analysisKey: string,
    cached: CachedSmartReferenceResult,
    automaticallyAddedNodeIds: string[] = [],
  ): SmartReferenceResult {
    const currentWorkspace = workspaceRef.current;
    const filtered = filterSmartReferenceResultForWorkspace(
      cached,
      currentWorkspace,
    );
    const currentNodeIds = new Set(currentWorkspace.nodes.map((node) => node.id));
    const currentAutomaticallyAddedNodeIds = automaticallyAddedNodeIds.filter(
      (nodeId) => currentNodeIds.has(nodeId),
    );
    const acceptedNodeIds = currentWorkspace.references
      .filter((reference) => reference.sourceNodeId === cached.sourceNodeId)
      .map((reference) => reference.targetNodeId)
      .filter((nodeId) => currentNodeIds.has(nodeId));
    return {
      ...filtered,
      analysisKey,
      acceptedNodeIds: Array.from(
        new Set([...acceptedNodeIds, ...currentAutomaticallyAddedNodeIds]),
      ),
      automaticallyAddedNodeIds: currentAutomaticallyAddedNodeIds,
    };
  }

  function smartReferenceFailureMessage(error: unknown): string {
    if (error instanceof EmbeddingAnalysisFailure) {
      return t(`smartReference.errors.${error.reason}`);
    }
    const reason = errorReason(error);
    if (reason === "smart_reference_source_changed") {
      return t("smartReference.errors.sourceChanged");
    }
    if (reason === "smart_reference_workspace_changed_before_auto_reference") {
      return t("smartReference.errors.automaticWorkspaceChanged");
    }
    return reason.includes("local embedding download cancelled")
      ? t("smartReference.download.cancelled")
      : reason.includes("local LLM download cancelled")
        ? t("smartReference.llm.download.cancelled")
        : t("smartReference.errors.failed", { reason });
  }

  async function runSmartReferenceAnalysis(
    nodeId: string,
    queueGeneration: number,
  ): Promise<{ cacheHit: boolean; result: SmartReferenceResult }> {
    const currentEmbeddingSettings = embeddingSettingsRef.current;
    const currentLlmSettings = llmSettingsRef.current;
    if (
      workspaceSecurityStatus.encrypted &&
      currentEmbeddingSettings.provider === "remote"
    ) {
      throw new Error(t("smartReference.errors.remoteBlockedByEncryption"));
    }
    setLocalEmbeddingProgress(null);
    setCancellingLocalDownload(false);
    setSmartReferenceStatus(null);
    const currentWorkspace = workspaceRef.current;
    const replacementGeneration = workspaceReplacementGenerationRef.current;
    const sourceFingerprint = await smartReferenceSourceFingerprint(
      nodeId,
      currentWorkspace,
    );
    if (sourceFingerprint === null) {
      throw new Error("smart_reference_source_changed");
    }
    const analysisKey = await smartReferenceResultCacheKey(
      nodeId,
      currentWorkspace,
      currentEmbeddingSettings,
      currentLlmSettings,
    );
    const memoryResult = smartReferenceMemoryCacheRef.current.get(analysisKey);
    if (memoryResult !== undefined) {
      rememberSmartReferenceResult(analysisKey, memoryResult);
      return {
        cacheHit: true,
        result: hydrateSmartReferenceResult(analysisKey, memoryResult),
      };
    }
    const persistentResult = await smartReferenceResultCache.read(analysisKey);
    if (persistentResult !== null) {
      rememberSmartReferenceResult(analysisKey, persistentResult);
      return {
        cacheHit: true,
        result: hydrateSmartReferenceResult(analysisKey, persistentResult),
      };
    }
    const analysis = await embeddingAnalyzer.analyze(
      nodeId,
      currentWorkspace.nodes,
      currentWorkspace.references,
      currentEmbeddingSettings,
      remoteEmbeddingToken,
    );
    let llmSelectedNodeIds: string[] = [];
    let llmUncertainNodeIds: string[] = [];
    let llmNoMatch = false;
    if (currentLlmSettings.enabled) {
      const prepared = prepareLlmReview(
        nodeId,
        currentWorkspace.nodes,
        currentWorkspace.references,
        analysis,
      );
      if (prepared === null) {
        llmNoMatch = true;
      } else {
        const response = await llmGateway.review(
          { kind: "local", modelId: currentLlmSettings.localModel },
          prepared.request,
        );
        const decision = validateLlmReviewResponse(prepared, response);
        llmSelectedNodeIds = decision.selectedNodeIds;
        llmUncertainNodeIds = decision.uncertainNodeIds;
        llmNoMatch = decision.noMatch;
      }
    }
    if (
      queueGeneration !== smartReferenceQueueGenerationRef.current ||
      replacementGeneration !== workspaceReplacementGenerationRef.current
    ) {
      throw new Error("smart_reference_source_changed");
    }
    const currentSourceFingerprint = await smartReferenceSourceFingerprint(
      nodeId,
      workspaceRef.current,
    );
    if (currentSourceFingerprint !== sourceFingerprint) {
      throw new Error("smart_reference_source_changed");
    }
    const automaticCandidateIds =
      !currentLlmSettings.enabled &&
      currentEmbeddingSettings.autoReferenceEnabled &&
      currentEmbeddingSettings.thresholdFingerprint ===
        smartReferenceScoringFingerprint(currentEmbeddingSettings)
        ? analysis.candidates
            .filter(
              (candidate) =>
                candidate.score >= currentEmbeddingSettings.autoReferenceThreshold,
            )
            .map((candidate) => candidate.nodeId)
        : [];
    const automaticallyAddedNodeIds: string[] = [];
    if (automaticCandidateIds.length > 0) {
      const latestKey = await smartReferenceResultCacheKey(
        nodeId,
        workspaceRef.current,
        embeddingSettingsRef.current,
        llmSettingsRef.current,
      );
      if (latestKey !== analysisKey) {
        throw new Error("smart_reference_workspace_changed_before_auto_reference");
      }
      updateWorkspace(
        (current) => {
          let nextReferences = current.references;
          for (const targetNodeId of automaticCandidateIds) {
            const appended = appendExistingNodeReference(
              current.nodes,
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
    const currentNodeIds = new Set(
      workspaceRef.current.nodes.map((node) => node.id),
    );
    if (!currentNodeIds.has(nodeId)) {
      throw new Error("smart_reference_source_changed");
    }
    const currentLlmSelectedNodeIds = llmSelectedNodeIds.filter((candidateId) =>
      currentNodeIds.has(candidateId),
    );
    const currentLlmUncertainNodeIds = llmUncertainNodeIds.filter((candidateId) =>
      currentNodeIds.has(candidateId),
    );
    const cached: CachedSmartReferenceResult = {
      candidates: analysis.candidates.filter((candidate) =>
        currentNodeIds.has(candidate.nodeId),
      ),
      generatedAtMs: Date.now(),
      llmEnabled: currentLlmSettings.enabled,
      llmNoMatch:
        llmNoMatch ||
        (currentLlmSelectedNodeIds.length === 0 &&
          currentLlmUncertainNodeIds.length === 0),
      llmSelectedNodeIds: currentLlmSelectedNodeIds,
      llmUncertainNodeIds: currentLlmUncertainNodeIds,
      relatedNodes: analysis.relatedNodes.filter((related) =>
        currentNodeIds.has(related.nodeId),
      ),
      sourceFingerprint,
      sourceNodeId: nodeId,
      truncatedNodeCount: analysis.truncatedNodeCount,
    };
    let resultKey = analysisKey;
    if (automaticallyAddedNodeIds.length === 0) {
      rememberSmartReferenceResult(analysisKey, cached);
      try {
        await smartReferenceResultCache.write(analysisKey, cached);
      } catch (error) {
        setSmartReferenceCacheMessage(
          t("smartReference.settings.resultCache.writeFailed", {
            reason: errorReason(error),
          }),
        );
      }
    } else {
      resultKey = await smartReferenceResultCacheKey(
        nodeId,
        workspaceRef.current,
        embeddingSettingsRef.current,
        llmSettingsRef.current,
      );
    }
    return {
      cacheHit: false,
      result: hydrateSmartReferenceResult(
        resultKey,
        cached,
        automaticallyAddedNodeIds,
      ),
    };
  }

  function enqueueSmartReferenceNodes(nodeIds: string[]) {
    const currentNodeIds = new Set(workspaceRef.current.nodes.map((node) => node.id));
    const unique = Array.from(new Set(nodeIds))
      .filter((nodeId) => currentNodeIds.has(nodeId))
      .slice(0, maximumSmartReferenceBatchSize);
    if (unique.length === 0) {
      return;
    }
    setSmartReferenceTasks((current) => {
      const queued = new Set(unique);
      const retained = current.filter(
        (task) => task.status === "running" || !queued.has(task.nodeId),
      );
      const runningNodeIds = new Set(
        retained.filter((task) => task.status === "running").map((task) => task.nodeId),
      );
      return [
        ...retained,
        ...unique
          .filter((nodeId) => !runningNodeIds.has(nodeId))
          .map((nodeId) => ({
            cacheHit: false,
            error: null,
            nodeId,
            result: null,
            status: "queued" as const,
          })),
      ];
    });
    setSmartReferenceStatus(null);
  }

  async function openSmartReferenceTask(task: SmartReferenceTask) {
    if (task.result === null) {
      return;
    }
    const currentSourceFingerprint = await smartReferenceSourceFingerprint(
      task.nodeId,
      workspaceRef.current,
    );
    if (currentSourceFingerprint !== task.result.sourceFingerprint) {
      const message = t("smartReference.errors.sourceChanged");
      setSmartReferenceTasks((current) =>
        current.map((candidate) =>
          candidate.nodeId === task.nodeId
            ? { ...candidate, error: message, result: null, status: "failed" }
            : candidate,
        ),
      );
      setSmartReferenceStatus(message);
      return;
    }
    setSmartReferenceResult(
      hydrateSmartReferenceResult(
        task.result.analysisKey,
        task.result,
        task.result.automaticallyAddedNodeIds,
      ),
    );
  }

  useEffect(() => {
    if (
      smartReferenceWorkerRunningRef.current ||
      preparingLocalModelId !== null ||
      preparingLocalLlmModelId !== null
    ) {
      return;
    }
    const nextTask = smartReferenceTasks.find((task) => task.status === "queued");
    if (nextTask === undefined) {
      return;
    }
    const queueGeneration = smartReferenceQueueGenerationRef.current;
    smartReferenceWorkerRunningRef.current = true;
    setAnalyzingNodeId(nextTask.nodeId);
    setSmartReferenceTasks((current) =>
      current.map((task) =>
        task.nodeId === nextTask.nodeId
          ? { ...task, error: null, status: "running" }
          : task,
      ),
    );
    void runSmartReferenceAnalysis(nextTask.nodeId, queueGeneration)
      .then(({ cacheHit, result }) => {
        if (queueGeneration !== smartReferenceQueueGenerationRef.current) {
          return;
        }
        setSmartReferenceTasks((current) =>
          current.map((task) =>
            task.nodeId === nextTask.nodeId
              ? { ...task, cacheHit, error: null, result, status: "completed" }
              : task,
          ),
        );
      })
      .catch((error) => {
        if (queueGeneration !== smartReferenceQueueGenerationRef.current) {
          return;
        }
        const message = smartReferenceFailureMessage(error);
        setSmartReferenceTasks((current) =>
          current.map((task) =>
            task.nodeId === nextTask.nodeId
              ? { ...task, error: message, result: null, status: "failed" }
              : task,
          ),
        );
      })
      .finally(() => {
        smartReferenceWorkerRunningRef.current = false;
        setAnalyzingNodeId(null);
        setSmartReferenceWorkerRevision((current) => current + 1);
      });
  }, [
    preparingLocalLlmModelId,
    preparingLocalModelId,
    smartReferenceTasks,
    smartReferenceWorkerRevision,
  ]);

  async function prepareLocalEmbeddingModel(modelId: LocalEmbeddingModelId) {
    if (
      analyzingNodeId !== null ||
      preparingLocalModelId !== null ||
      preparingLocalLlmModelId !== null
    ) {
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

  async function prepareLocalLlmModel(modelId: LocalLlmModelId) {
    if (
      analyzingNodeId !== null ||
      preparingLocalModelId !== null ||
      preparingLocalLlmModelId !== null
    ) {
      return;
    }
    setPreparingLocalLlmModelId(modelId);
    setLocalLlmProgress(null);
    setCancellingLocalLlmDownload(false);
    setSmartReferenceStatus(null);
    try {
      await localLlmRuntime.prepareModel(modelId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setSmartReferenceStatus(
        reason.includes("local LLM download cancelled")
          ? t("smartReference.llm.download.cancelled")
          : t("smartReference.llm.errors.modelPreparationFailed", { reason }),
      );
    } finally {
      setPreparingLocalLlmModelId(null);
    }
  }

  async function cancelLocalLlmDownload() {
    if (cancellingLocalLlmDownload) {
      return;
    }
    setCancellingLocalLlmDownload(true);
    try {
      await localLlmRuntime.cancelDownload();
    } catch (error) {
      setCancellingLocalLlmDownload(false);
      const reason = error instanceof Error ? error.message : String(error);
      setSmartReferenceStatus(
        t("smartReference.llm.errors.cancelDownloadFailed", { reason }),
      );
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

  async function acceptSmartReference(targetNodeId: string) {
    const result = smartReferenceResult;
    if (result === null) {
      return;
    }
    const currentNodeIds = new Set(
      workspaceRef.current.nodes.map((node) => node.id),
    );
    const currentSourceFingerprint = await smartReferenceSourceFingerprint(
      result.sourceNodeId,
      workspaceRef.current,
    );
    if (currentSourceFingerprint !== result.sourceFingerprint) {
      setSmartReferenceStatus(t("smartReference.errors.sourceChanged"));
      setSmartReferenceResult(null);
      return;
    }
    if (!currentNodeIds.has(targetNodeId)) {
      setSmartReferenceStatus(t("smartReference.errors.candidateMissing"));
      setSmartReferenceResult((current) =>
        current === null
          ? null
          : hydrateSmartReferenceResult(
              current.analysisKey,
              current,
              current.automaticallyAddedNodeIds,
            ),
      );
      return;
    }
    updateWorkspace(
      (current) => {
        const references = appendExistingNodeReference(
          current.nodes,
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
    setSmartReferenceTasks((current) =>
      current.map((task) =>
        task.nodeId !== result.sourceNodeId || task.result === null
          ? task
          : {
              ...task,
              result: {
                ...task.result,
                acceptedNodeIds: task.result.acceptedNodeIds.includes(targetNodeId)
                  ? task.result.acceptedNodeIds
                  : [...task.result.acceptedNodeIds, targetNodeId],
              },
            },
      ),
    );
  }

  function updateWorkspace(
    updater: (current: WorkspaceSnapshot) => WorkspaceSnapshot,
    options: WorkspaceUpdateOptions = {},
  ): WorkspaceSnapshot {
    const current = workspaceRef.current;
    if (workspaceMutationBlockedRef.current) {
      return current;
    }
    const next = updater(current);
    if (next === current) {
      return current;
    }
    workspaceChangedInSessionRef.current = true;
    if (options.affectsOffsiteBackup !== false) {
      automaticOffsiteRevisionRef.current += 1;
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
      canUndo:
        historyTimelineRef.current.undo.length > 0 ||
        workspaceReplacementHistoryBoundaryRef.current === "undo",
      canRedo:
        historyTimelineRef.current.redo.length > 0 ||
        workspaceReplacementHistoryBoundaryRef.current === "redo",
    });
  }

  function clearHistory() {
    historyTimelineRef.current = emptyWorkspaceHistoryTimeline();
    workspaceReplacementHistoryBoundaryRef.current = null;
    editBaselineRef.current = null;
    syncHistoryAvailability();
  }

  function setWorkspaceReplacementHistoryBoundary(
    boundary: WorkspaceReplacementHistoryBoundary,
  ) {
    workspaceReplacementHistoryBoundaryRef.current = boundary;
    syncHistoryAvailability();
  }

  function recordHistory(before: WorkspaceHistoryState, after: WorkspaceHistoryState) {
    if (workspaceReplacementHistoryBoundaryRef.current !== null) {
      dismissAppNotice();
    }
    if (workspaceReplacementHistoryBoundaryRef.current === "redo") {
      workspaceReplacementHistoryBoundaryRef.current = null;
    }
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
    workspaceChangedInSessionRef.current = true;
    automaticOffsiteRevisionRef.current += 1;
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
      if (workspaceReplacementHistoryBoundaryRef.current === "undo") {
        void swapWorkspaceWithRecovery("undo");
      }
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
      if (workspaceReplacementHistoryBoundaryRef.current === "redo") {
        void swapWorkspaceWithRecovery("redo");
      }
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
        view: removeNodesFromWorkspaceView(current.view, deletedNodeIds),
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
    setSmartReferenceTasks((current) =>
      current.filter((task) => !deletedNodeIds.has(task.nodeId)),
    );
    setSmartReferenceResult((current) => {
      if (current === null || deletedNodeIds.has(current.sourceNodeId)) {
        return null;
      }
      const keep = (nodeId: string) => !deletedNodeIds.has(nodeId);
      return {
        ...current,
        acceptedNodeIds: current.acceptedNodeIds.filter(keep),
        automaticallyAddedNodeIds: current.automaticallyAddedNodeIds.filter(keep),
        candidates: current.candidates.filter((candidate) => keep(candidate.nodeId)),
        llmSelectedNodeIds: current.llmSelectedNodeIds.filter(keep),
        llmUncertainNodeIds: current.llmUncertainNodeIds.filter(keep),
        relatedNodes: current.relatedNodes.filter((related) => keep(related.nodeId)),
      };
    });
  }

  function updateNodeName(nodeId: string, name: string): boolean {
    if (!isNodeNameAvailable(workspaceRef.current.nodes, nodeId, name)) {
      return false;
    }
    updateWorkspace((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === nodeId ? { ...node, name: persistedNodeNameFromDraft(name) } : node,
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

  function updateNodeContentProcessor(nodeId: string, processorId: string) {
    if (!contentProcessorRegistry.has(processorId)) {
      return;
    }
    updateWorkspace((current) => {
      if (!current.nodes.some((node) => node.id === nodeId)) {
        return current;
      }
      const currentProcessorId =
        current.view.contentProcessorByNodeId[nodeId] ?? "text";
      if (currentProcessorId === processorId) {
        return current;
      }
      const contentProcessorByNodeId = {
        ...current.view.contentProcessorByNodeId,
      };
      if (processorId === "text") {
        delete contentProcessorByNodeId[nodeId];
      } else {
        contentProcessorByNodeId[nodeId] = processorId;
      }
      return {
        ...current,
        view: {
          ...current.view,
          contentProcessorByNodeId,
        },
      };
    });
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
      { flushImmediately: true, affectsOffsiteBackup: false },
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

  function activateCanvasReferenceFilter(nodeId: string) {
    if (!workspaceRef.current.nodes.some((node) => node.id === nodeId)) {
      return;
    }

    setReferenceFilterNodeIds((current) =>
      current.length === 1 && current[0] === nodeId ? [] : [nodeId],
    );
  }

  function clearNodeFilters() {
    setSearchTerm("");
    setUnnamedOnly(false);
    setReferenceFilterNodeIds([]);
  }

  async function exportWorkspace(authorization?: string) {
    setBackupStatus(null);
    if (workspaceSecurityStatus.encrypted && authorization === undefined) {
      setSecurityMessage(null);
      setSecurityCurrentPassword("");
      setSecurityDialog("export");
      return;
    }
    try {
      const date = new Date().toISOString().slice(0, 10);
      const plaintext = serializeWorkspaceExport(workspaceRef.current);
      const contents = workspaceSecurityStatus.encrypted
        ? await workspaceSecurity.encryptExport(plaintext, authorization ?? "")
        : plaintext;
      const exported = await exportWorkspaceFile(
        contents,
        workspaceSecurityStatus.encrypted
          ? `linked-info-${date}.encrypted.json`
          : `linked-info-${date}.json`,
      );
      if (exported) {
        showAppNotice(t("backup.exportSuccess"));
      }
    } catch {
      setBackupStatus(t("backup.exportFailed"));
    }
  }

  function queueWorkspaceImport(
    file: ImportedWorkspaceFile,
    text = file.text,
    preparedRestoreId?: string,
  ) {
    const result = parseWorkspaceExport(text);
    if (!result.ok) {
      if (preparedRestoreId !== undefined) {
        void workspaceSecurity.cancelRestore(preparedRestoreId);
      }
      setBackupStatus(t(importFailureTranslationKeys[result.reason]));
      return;
    }
    setPendingWorkspaceReplacement({
      kind: preparedRestoreId === undefined ? "import" : "bootstrapRestore",
      returnView: activeView,
      sourceName: file.name,
      workspace: result.workspace,
      preparedRestoreId,
    });
  }

  async function chooseWorkspaceImport() {
    setBackupStatus(null);
    try {
      const file = await importWorkspaceFile();
      if (file === null) {
        return;
      }
      if (isEncryptedWorkspaceExport(file.text)) {
        setPendingEncryptedImport({
          ...file,
          bootstrapRestore: !workspaceSecurityStatus.encrypted,
        });
        setEncryptedImportPassword("");
        setEncryptedImportError(null);
        return;
      }
      queueWorkspaceImport(file);
    } catch {
      setBackupStatus(t("backup.importFailed"));
    }
  }

  async function decryptPendingWorkspaceImport() {
    if (
      pendingEncryptedImport === null ||
      encryptedImportBusy ||
      encryptedImportPassword.length === 0
    ) {
      return;
    }
    setEncryptedImportBusy(true);
    setEncryptedImportError(null);
    try {
      const file = pendingEncryptedImport;
      const prepared = file.bootstrapRestore
        ? await workspaceSecurity.prepareRestore(
            file.text,
            encryptedImportPassword,
          )
        : null;
      const plaintext =
        prepared?.plaintext ??
        (await workspaceSecurity.decryptExport(
          file.text,
          encryptedImportPassword,
        ));
      setPendingEncryptedImport(null);
      setEncryptedImportPassword("");
      queueWorkspaceImport(file, plaintext, prepared?.id);
    } catch (error) {
      const reason = errorReason(error);
      setEncryptedImportError(
        reason === "workspace_vault_invalid_password"
          ? t("security.invalidPassword")
          : t("backup.encryptedImportFailed", { reason }),
      );
    } finally {
      setEncryptedImportBusy(false);
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
      setWorkspaceReplacementHistoryBoundary(null);
      setBackupStatus(t("backup.recoveryUnavailable"));
      return;
    }
    if (recovery.status === "invalid") {
      setRecoveryAvailable(false);
      setWorkspaceReplacementHistoryBoundary(null);
      setRecoveryStorageProblem(recovery.raw);
      setBackupStatus(t("backup.recoveryInvalid"));
      return;
    }
    setPendingWorkspaceReplacement({
      kind: "recovery",
      returnView: activeView,
      sourceName: t("backup.recoverySource"),
      workspace: recovery.workspace,
    });
  }

  async function chooseAutomaticBackup(entry: WorkspaceBackupEntry) {
    if (entry.state !== "ready") {
      setBackupStatus(t("backup.historyInvalid"));
      return;
    }
    setBackupStatus(null);
    try {
      const contents = await workspaceBackupHistory.read(entry.id);
      const loaded = parseStoredWorkspaceText(contents);
      if (loaded.status !== "ready") {
        setBackupStatus(t("backup.historyInvalid"));
        return;
      }
      setPendingWorkspaceReplacement({
        kind: "history",
        returnView: activeView,
        sourceName: t("backup.historySource", {
          time: formatBackupDate(entry.createdAtMs, activeLanguage),
        }),
        workspace: loaded.workspace,
      });
      setActiveView("canvas");
    } catch {
      setBackupStatus(t("backup.historyReadFailed"));
      try {
        setAutomaticBackupHistory(await workspaceBackupHistory.inspect());
      } catch {
        setAutomaticBackupHistoryError(t("backup.historyInspectFailed"));
      }
    }
  }

  function currentTemporaryBackupConnection(
    credentialsRequired = true,
  ): TemporaryBackupConnection | null {
    const endpoint = resolveS3Endpoint(
      offsiteS3Provider,
      offsiteEndpoint,
      offsiteRegion,
    );
    if (
      endpoint.length === 0 ||
      offsiteRegion.trim().length === 0 ||
      offsiteBucket.trim().length === 0 ||
      (credentialsRequired &&
        (offsiteAccessKeyId.length < 3 || offsiteSecretAccessKey.length < 8))
    ) {
      return null;
    }
    return {
      provider: "s3Compatible",
      endpoint,
      region: offsiteRegion.trim(),
      bucket: offsiteBucket.trim(),
      prefix: offsitePrefix.trim(),
      accessKeyId: offsiteAccessKeyId,
      secretAccessKey: offsiteSecretAccessKey,
      sessionToken:
        offsiteSessionToken.length > 0 ? offsiteSessionToken : null,
    };
  }

  function changeS3Provider(template: S3ProviderTemplate) {
    const defaults = s3TemplateDefaults(template);
    setOffsiteS3Provider(template);
    setOffsiteEndpoint(defaults.endpoint);
    setOffsiteRegion(defaults.region);
    setOffsitePrefix(defaults.prefix);
    setOffsiteRecoveryPage(null);
    if (editingOffsiteTargetId === null) {
      setOffsiteTargetName(t(`offsiteBackup.s3Providers.${template}`));
    }
  }

  function beginOffsiteTargetEdit(target: OffsiteBackupTarget) {
    const template = target.s3Provider ?? "custom";
    setEditingOffsiteTargetId(target.id);
    setReplaceOffsiteCredentials(false);
    setOffsiteTargetName(target.name);
    setOffsiteS3Provider(template);
    setOffsiteEndpoint(target.endpoint);
    setOffsiteRegion(target.region ?? "");
    setOffsiteBucket(target.bucket ?? "");
    setOffsitePrefix(target.prefix ?? "");
    setOffsiteAccessKeyId("");
    setOffsiteSecretAccessKey("");
    setOffsiteSessionToken("");
    setOffsiteMessage(null);
    window.requestAnimationFrame(() => {
      document
        .getElementById("offsite-target-form")
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }

  function resetOffsiteTargetForm() {
    const defaults = s3TemplateDefaults("cloudflareR2");
    setEditingOffsiteTargetId(null);
    setReplaceOffsiteCredentials(false);
    setOffsiteTargetName(t("offsiteBackup.s3Providers.cloudflareR2"));
    setOffsiteS3Provider("cloudflareR2");
    setOffsiteEndpoint(defaults.endpoint);
    setOffsiteRegion(defaults.region);
    setOffsiteBucket("");
    setOffsitePrefix(defaults.prefix);
    setOffsiteAccessKeyId("");
    setOffsiteSecretAccessKey("");
    setOffsiteSessionToken("");
  }

  function cancelOffsiteTargetEdit() {
    resetOffsiteTargetForm();
    setOffsiteMessage(null);
  }

  function renderOffsiteConnectionFields() {
    return (
      <>
        <small>{t("offsiteBackup.s3UnifiedDescription")}</small>
        <label>
          <span>{t("offsiteBackup.s3Provider")}</span>
          <select
            data-testid="offsite-s3-provider"
            disabled={offsiteBusy}
            onChange={(event) =>
              changeS3Provider(event.target.value as S3ProviderTemplate)
            }
            value={offsiteS3Provider}
          >
            <option value="cloudflareR2">
              {t("offsiteBackup.s3Providers.cloudflareR2")}
            </option>
            <option value="backblazeB2">
              {t("offsiteBackup.s3Providers.backblazeB2")}
            </option>
            <option value="tigris">
              {t("offsiteBackup.s3Providers.tigris")}
            </option>
            <option value="oracleOci">
              {t("offsiteBackup.s3Providers.oracleOci")}
            </option>
            <option value="custom">
              {t("offsiteBackup.s3Providers.custom")}
            </option>
          </select>
        </label>
        <small>{t(`offsiteBackup.s3ProviderDescriptions.${offsiteS3Provider}`)}</small>
        <label>
          <span>{t("offsiteBackup.s3Region")}</span>
          <input
            autoComplete="off"
            data-testid="offsite-s3-region"
            disabled={offsiteBusy}
            onChange={(event) => {
              setOffsiteRegion(event.target.value);
              setOffsiteRecoveryPage(null);
            }}
            placeholder={
              offsiteS3Provider === "cloudflareR2" || offsiteS3Provider === "tigris"
                ? "auto"
                : "us-west-004"
            }
            value={offsiteRegion}
          />
        </label>
        <label>
          <span>{t("offsiteBackup.s3Endpoint")}</span>
          <input
            data-testid="offsite-s3-endpoint"
            disabled={offsiteBusy}
            onChange={(event) => {
              setOffsiteEndpoint(event.target.value);
              setOffsiteRecoveryPage(null);
            }}
            placeholder={s3EndpointPlaceholder(
              offsiteS3Provider,
              offsiteRegion,
            )}
            type="url"
            value={offsiteEndpoint}
          />
        </label>
        <label>
          <span>{t("offsiteBackup.s3Bucket")}</span>
          <input
            autoComplete="off"
            disabled={offsiteBusy}
            onChange={(event) => {
              setOffsiteBucket(event.target.value);
              setOffsiteRecoveryPage(null);
            }}
            value={offsiteBucket}
          />
        </label>
        <label>
          <span>{t("offsiteBackup.s3Prefix")}</span>
          <input
            autoComplete="off"
            disabled={offsiteBusy}
            onChange={(event) => {
              setOffsitePrefix(event.target.value);
              setOffsiteRecoveryPage(null);
            }}
            value={offsitePrefix}
          />
        </label>
        {editingOffsiteTargetId !== null && (
          <label className="switch-setting offsite-replace-credentials">
            <input
              checked={replaceOffsiteCredentials}
              data-testid="offsite-replace-credentials"
              disabled={offsiteBusy}
              onChange={(event) => {
                setReplaceOffsiteCredentials(event.target.checked);
                setOffsiteAccessKeyId("");
                setOffsiteSecretAccessKey("");
                setOffsiteSessionToken("");
              }}
              type="checkbox"
            />
            {t("offsiteBackup.replaceCredentials")}
          </label>
        )}
        {(editingOffsiteTargetId === null || replaceOffsiteCredentials) && (
          <>
            <label>
              <span>{t("offsiteBackup.s3AccessKeyId")}</span>
              <input
                autoComplete="off"
                disabled={offsiteBusy}
                onChange={(event) => {
                  setOffsiteAccessKeyId(event.target.value);
                  setOffsiteRecoveryPage(null);
                }}
                type="password"
                value={offsiteAccessKeyId}
              />
            </label>
            <label>
              <span>{t("offsiteBackup.s3SecretAccessKey")}</span>
              <input
                autoComplete="off"
                disabled={offsiteBusy}
                onChange={(event) => {
                  setOffsiteSecretAccessKey(event.target.value);
                  setOffsiteRecoveryPage(null);
                }}
                type="password"
                value={offsiteSecretAccessKey}
              />
            </label>
            <label>
              <span>{t("offsiteBackup.s3SessionToken")}</span>
              <input
                autoComplete="off"
                disabled={offsiteBusy}
                onChange={(event) => {
                  setOffsiteSessionToken(event.target.value);
                  setOffsiteRecoveryPage(null);
                }}
                type="password"
                value={offsiteSessionToken}
              />
            </label>
          </>
        )}
        {editingOffsiteTargetId !== null && !replaceOffsiteCredentials && (
          <small>{t("offsiteBackup.keepCredentialsDescription")}</small>
        )}
        <small>{t("offsiteBackup.s3CredentialDescription")}</small>
      </>
    );
  }

  function requestOffsiteTargetConfiguration() {
    const replacingCredentials =
      editingOffsiteTargetId === null || replaceOffsiteCredentials;
    const connection = currentTemporaryBackupConnection(replacingCredentials);
    if (
      offsiteBusy ||
      offsiteTargetName.trim().length === 0 ||
      connection === null
    ) {
      setOffsiteMessage(t("offsiteBackup.errors.invalidConfiguration"));
      return;
    }
    setOffsiteMessage(null);
    setSecurityMessage(null);
    setSecurityCurrentPassword("");
    setPendingBackupTarget({
      targetId: editingOffsiteTargetId,
      name: offsiteTargetName.trim(),
      replaceCredentials: replacingCredentials,
      ...connection,
      s3Provider: offsiteS3Provider,
    });
    setSecurityDialog("backupTarget");
  }

  function requestOffsiteSensitiveAction(action: PendingOffsiteSensitiveAction) {
    if (offsiteBusy || securityBusy) {
      return;
    }
    setOffsiteMessage(null);
    setSecurityMessage(null);
    setSecurityCurrentPassword("");
    setOffsiteConfirmationName("");
    setPendingOffsiteSensitiveAction(action);
    setSecurityDialog("offsiteSensitive");
  }

  async function connectOffsiteRecovery() {
    const connection = currentTemporaryBackupConnection();
    if (offsiteBusy || connection === null) {
      setOffsiteMessage(t("offsiteBackup.errors.invalidRecoveryConfiguration"));
      return;
    }
    setOffsiteBusy(true);
    setOffsiteMessage(null);
    try {
      const page = await offsiteBackup.listRecovery({
        ...connection,
      });
      offsiteRecoveryConnectionRef.current = connection;
      setOffsiteRecoveryPage(page);
      showAppNotice(t("offsiteBackup.recoveryConnected"));
    } catch (error) {
      offsiteRecoveryConnectionRef.current = null;
      setOffsiteRecoveryPage(null);
      setOffsiteMessage(
        t("offsiteBackup.errors.list", { reason: errorReason(error) }),
      );
    } finally {
      setOffsiteBusy(false);
    }
  }

  async function chooseOffsiteBootstrapBackup(snapshotId: string) {
    const connection = offsiteRecoveryConnectionRef.current;
    if (
      offsiteBusy ||
      offsiteRecoveryPage === null ||
      connection === null
    ) {
      return;
    }
    setOffsiteBusy(true);
    setOffsiteMessage(null);
    try {
      const downloaded = await offsiteBackup.downloadRecovery({
        ...connection,
        snapshotId,
      });
      setPendingEncryptedImport({
        name: t("offsiteBackup.restoreSource", {
          time: formatBackupDate(downloaded.metadata.createdAtMs, activeLanguage),
        }),
        text: downloaded.encryptedExport,
        bootstrapRestore: true,
      });
      setEncryptedImportPassword("");
      setEncryptedImportError(null);
    } catch (error) {
      setOffsiteMessage(
        t("offsiteBackup.errors.download", { reason: errorReason(error) }),
      );
    } finally {
      setOffsiteBusy(false);
    }
  }

  async function refreshOffsiteBackups(targetId = selectedOffsiteTargetId) {
    if (targetId === null || offsiteBusy) {
      return;
    }
    setOffsiteBusy(true);
    setOffsiteMessage(null);
    try {
      const [targets, page] = await Promise.all([
        offsiteBackup.inspectTargets(),
        offsiteBackup.list(targetId),
      ]);
      setOffsiteTargets(targets);
      setOffsitePage(page);
    } catch (error) {
      setOffsiteMessage(
        t("offsiteBackup.errors.list", { reason: errorReason(error) }),
      );
    } finally {
      setOffsiteBusy(false);
    }
  }

  async function requestAutomaticOffsiteBackup(
    markPending: boolean,
    markedRevision = automaticOffsiteRevisionRef.current,
  ) {
    if (
      automaticOffsiteRunningRef.current ||
      !workspaceSecurityStatus.encrypted ||
      !offsiteBackup.available
    ) {
      return;
    }
    automaticOffsiteRunningRef.current = true;
    let pendingMarkCompleted = !markPending;
    try {
      if (markPending) {
        const targets = await offsiteBackup.markAutomaticPending();
        pendingMarkCompleted = true;
        automaticOffsiteMarkedRevisionRef.current = Math.max(
          automaticOffsiteMarkedRevisionRef.current,
          markedRevision,
        );
        setOffsiteTargets(targets);
      }
      const outcomes = await offsiteBackup.runDueAutomatic(
        serializeWorkspaceExport(workspaceRef.current),
      );
      if (outcomes.length > 0) {
        setOffsiteTargets(await offsiteBackup.inspectTargets());
      }
    } catch {
      // Automatic backup failures stay isolated from local persistence. Rust keeps
      // the target pending and records a bounded provider error for Settings.
    } finally {
      automaticOffsiteRunningRef.current = false;
      if (
        pendingMarkCompleted &&
        automaticOffsiteRevisionRef.current >
        automaticOffsiteMarkedRevisionRef.current
      ) {
        void requestAutomaticOffsiteBackup(
          true,
          automaticOffsiteRevisionRef.current,
        );
      }
    }
  }

  async function updateAutomaticOffsiteSettings(
    targetId: string,
    enabled: boolean,
    intervalHours: number,
  ) {
    if (offsiteBusy) {
      return;
    }
    setOffsiteBusy(true);
    setOffsiteMessage(null);
    try {
      const updated = await offsiteBackup.updateAutomaticSettings(
        targetId,
        enabled,
        intervalHours,
      );
      setOffsiteTargets((targets) =>
        targets.map((target) => (target.id === updated.id ? updated : target)),
      );
      showAppNotice(
        enabled
          ? t("offsiteBackup.automaticEnabled")
          : t("offsiteBackup.automaticDisabled"),
      );
      if (enabled) {
        void requestAutomaticOffsiteBackup(false);
      }
    } catch (error) {
      setOffsiteMessage(
        t("offsiteBackup.errors.automaticSettings", {
          reason: errorReason(error),
        }),
      );
    } finally {
      setOffsiteBusy(false);
    }
  }

  async function createOffsiteSnapshot() {
    if (selectedOffsiteTargetId === null || offsiteBusy) {
      return;
    }
    setOffsiteBusy(true);
    setOffsiteMessage(null);
    try {
      await persistence.save(workspaceRef.current);
      const plaintext = serializeWorkspaceExport(workspaceRef.current);
      await offsiteBackup.create(selectedOffsiteTargetId, plaintext);
      const [targets, page] = await Promise.all([
        offsiteBackup.inspectTargets(),
        offsiteBackup.list(selectedOffsiteTargetId),
      ]);
      setOffsiteTargets(targets);
      setOffsitePage(page);
      showAppNotice(t("offsiteBackup.uploadSuccess"));
    } catch (error) {
      setOffsiteMessage(
        t("offsiteBackup.errors.upload", { reason: errorReason(error) }),
      );
    } finally {
      setOffsiteBusy(false);
    }
  }

  async function verifyOffsiteSnapshot(snapshotId: string) {
    if (selectedOffsiteTargetId === null || offsiteBusy) {
      return;
    }
    setOffsiteBusy(true);
    setOffsiteMessage(null);
    try {
      const verification = await offsiteBackup.verify(
        selectedOffsiteTargetId,
        snapshotId,
      );
      setOffsiteTargets(await offsiteBackup.inspectTargets());
      showAppNotice(
        t("offsiteBackup.verifySuccess", {
          size: formatByteCount(verification.downloadedBytes),
        }),
      );
    } catch (error) {
      setOffsiteMessage(
        t("offsiteBackup.errors.verify", { reason: errorReason(error) }),
      );
    } finally {
      setOffsiteBusy(false);
    }
  }

  function openOffsiteRestoreDrill(snapshotId: string, createdAtMs: number) {
    if (selectedOffsiteTargetId === null || offsiteBusy) {
      return;
    }
    setOffsiteRestoreDrill({
      targetId: selectedOffsiteTargetId,
      snapshotId,
      createdAtMs,
    });
    setOffsiteRestoreDrillPassword("");
    setOffsiteRestoreDrillError(null);
    setOffsiteRestoreDrillSucceeded(false);
  }

  function closeOffsiteRestoreDrill() {
    if (offsiteBusy) {
      return;
    }
    setOffsiteRestoreDrill(null);
    setOffsiteRestoreDrillPassword("");
    setOffsiteRestoreDrillError(null);
    setOffsiteRestoreDrillSucceeded(false);
  }

  async function runOffsiteRestoreDrill() {
    if (
      offsiteRestoreDrill === null ||
      offsiteBusy ||
      offsiteRestoreDrillPassword.length === 0
    ) {
      return;
    }
    setOffsiteBusy(true);
    setOffsiteRestoreDrillError(null);
    try {
      const updated = await offsiteBackup.testRestore(
        offsiteRestoreDrill.targetId,
        offsiteRestoreDrill.snapshotId,
        offsiteRestoreDrillPassword,
      );
      setOffsiteTargets((targets) =>
        targets.map((target) => (target.id === updated.id ? updated : target)),
      );
      setOffsiteRestoreDrillPassword("");
      setOffsiteRestoreDrillSucceeded(true);
    } catch (error) {
      const reason = errorReason(error);
      setOffsiteRestoreDrillError(
        reason === "workspace_vault_invalid_password"
          ? t("security.invalidPassword")
          : reason === "workspace_restore_password_rejected_by_current_workspace"
            ? t("offsiteBackup.errors.currentPasswordRejected")
            : reason === "workspace_restore_snapshot_wrap_mismatch"
              ? t("offsiteBackup.errors.snapshotWrapMismatch")
              : reason === "workspace_restore_snapshot_key_mismatch_or_corrupt"
                ? t("offsiteBackup.errors.snapshotKeyMismatch")
                : reason === "workspace_restore_snapshot_wrap_inconsistent"
                  ? t("offsiteBackup.errors.snapshotWrapInconsistent")
          : t("offsiteBackup.errors.restoreDrill", { reason }),
      );
    } finally {
      setOffsiteBusy(false);
    }
  }

  async function chooseOffsiteBackup(snapshotId: string) {
    if (selectedOffsiteTargetId === null || offsiteBusy) {
      return;
    }
    setOffsiteBusy(true);
    setOffsiteMessage(null);
    try {
      const downloaded = await offsiteBackup.download(
        selectedOffsiteTargetId,
        snapshotId,
      );
      setPendingEncryptedImport({
        name: t("offsiteBackup.restoreSource", {
          time: formatBackupDate(downloaded.metadata.createdAtMs, activeLanguage),
        }),
        text: downloaded.encryptedExport,
        bootstrapRestore: false,
      });
      setEncryptedImportPassword("");
      setEncryptedImportError(null);
    } catch (error) {
      setOffsiteMessage(
        t("offsiteBackup.errors.download", { reason: errorReason(error) }),
      );
    } finally {
      setOffsiteBusy(false);
    }
  }

  async function applyWorkspaceReplacement() {
    if (pendingWorkspaceReplacement === null) {
      return;
    }

    let bootstrapStarted = false;
    let bootstrapCommitted = false;
    try {
      let replacementWorkspace = pendingWorkspaceReplacement.workspace;
      if (pendingWorkspaceReplacement.kind === "bootstrapRestore") {
        const preparedRestoreId = pendingWorkspaceReplacement.preparedRestoreId;
        if (preparedRestoreId === undefined) {
          throw new Error("workspace_restore_not_prepared");
        }
        bootstrapStarted = true;
        workspaceMutationBlockedRef.current = true;
        skipUnmountFlushRef.current = true;
        setPersistenceReady(false);
        await persistence.save(workspaceRef.current);
        const result = await persistence.runExclusiveTransaction(() =>
          workspaceSecurity.commitRestore(preparedRestoreId),
        );
        bootstrapCommitted = true;
        if (result.status === "recoveryRequired") {
          setPersistenceRecoveryRequired(true);
          return;
        }
        updateWorkspaceSecurityStatus(result.securityStatus);
        if (result.status === "committedLocked") {
          return;
        }
        const authoritative = await persistence.load();
        if (authoritative.status !== "ready") {
          setPersistenceRecoveryRequired(true);
          return;
        }
        replacementWorkspace = authoritative.workspace;
        setOffsiteEndpoint("");
        offsiteRecoveryConnectionRef.current = null;
        setOffsiteRecoveryPage(null);
      } else {
        await persistence.preserveForRecovery(workspaceRef.current);
        await persistence.save(pendingWorkspaceReplacement.workspace);
      }
      workspaceChangedInSessionRef.current = true;
      automaticOffsiteRevisionRef.current += 1;
      workspaceReplacementGenerationRef.current += 1;
      workspaceRef.current = replacementWorkspace;
      setWorkspace(replacementWorkspace);
      clearHistory();
      setWorkspaceReplacementHistoryBoundary("undo");
      setEditingNodeId(null);
      setSearchTerm("");
      setUnnamedOnly(false);
      setReferenceFilterNodeIds([]);
      smartReferenceQueueGenerationRef.current += 1;
      smartReferenceMemoryCacheRef.current.clear();
      setSmartReferenceTasks([]);
      setSmartReferenceResult(null);
      setRecoveryAvailable(true);
      setRecoveryStorageProblem(null);
      setActiveView("canvas");
      const successMessage =
        pendingWorkspaceReplacement.kind === "recovery"
          ? t("backup.recoverySuccess")
          : pendingWorkspaceReplacement.kind === "history"
            ? t("backup.historyRestoreSuccess")
            : pendingWorkspaceReplacement.kind === "bootstrapRestore"
              ? t("offsiteBackup.bootstrapSuccess")
              : t("backup.importSuccess");
      showAppNotice(successMessage, {
        label: t("backup.undoReplacement"),
        run: () => void swapWorkspaceWithRecovery("undo"),
      });
      setPendingWorkspaceReplacement(null);
      if (bootstrapStarted) {
        workspaceMutationBlockedRef.current = false;
        skipUnmountFlushRef.current = false;
        setPersistenceReady(true);
      }
    } catch {
      if (bootstrapCommitted) {
        // Rust has crossed its durable commit point. Keep stale React state
        // unmounted and require recovery instead of reporting a false import
        // failure that would allow the old snapshot to be saved again.
        setPersistenceRecoveryRequired(true);
        setPersistenceReady(false);
      } else {
        if (bootstrapStarted) {
          workspaceMutationBlockedRef.current = false;
          skipUnmountFlushRef.current = false;
          setPersistenceReady(true);
        }
        setBackupStatus(t("backup.importFailed"));
      }
    }
  }

  async function swapWorkspaceWithRecovery(direction: "undo" | "redo") {
    if (
      editingNodeIdRef.current !== null ||
      workspaceReplacementHistoryBusyRef.current ||
      workspaceReplacementHistoryBoundaryRef.current !== direction
    ) {
      return;
    }
    workspaceReplacementHistoryBusyRef.current = true;
    workspaceMutationBlockedRef.current = true;
    skipUnmountFlushRef.current = true;
    workspaceReplacementHistoryBoundaryRef.current = null;
    syncHistoryAvailability();
    setPersistenceReady(false);
    try {
      const result = await persistence.swapWithRecovery();
      if (result.status === "reloadRequired") {
        // The Rust transaction may already be committed. Do not let the
        // lifecycle cleanup flush the stale React snapshot over it.
        skipUnmountFlushRef.current = true;
        setPersistenceRecoveryRequired(true);
        setPersistenceReady(false);
        return;
      }
      const next = result.workspace;
      workspaceChangedInSessionRef.current = true;
      automaticOffsiteRevisionRef.current += 1;
      workspaceReplacementGenerationRef.current += 1;
      workspaceRef.current = next;
      setWorkspace(next);
      historyTimelineRef.current = emptyWorkspaceHistoryTimeline();
      editBaselineRef.current = null;
      setEditingNodeId(null);
      setSearchTerm("");
      setUnnamedOnly(false);
      setReferenceFilterNodeIds([]);
      smartReferenceQueueGenerationRef.current += 1;
      smartReferenceMemoryCacheRef.current.clear();
      setSmartReferenceTasks([]);
      setSmartReferenceResult(null);
      setRecoveryAvailable(true);
      setRecoveryStorageProblem(null);
      setActiveView("canvas");
      setWorkspaceReplacementHistoryBoundary(direction === "undo" ? "redo" : "undo");
      workspaceMutationBlockedRef.current = false;
      skipUnmountFlushRef.current = false;
      setPersistenceReady(true);
      showAppNotice(
        direction === "undo"
          ? t("backup.replacementUndoSuccess")
          : t("backup.replacementRedoSuccess"),
        {
          label:
            direction === "undo"
              ? t("backup.redoReplacement")
              : t("backup.undoReplacement"),
          run: () =>
            void swapWorkspaceWithRecovery(direction === "undo" ? "redo" : "undo"),
        },
      );
    } catch {
      workspaceMutationBlockedRef.current = false;
      skipUnmountFlushRef.current = false;
      setPersistenceReady(true);
      workspaceReplacementHistoryBoundaryRef.current = direction;
      setBackupStatus(t("backup.replacementUndoFailed"));
    } finally {
      workspaceReplacementHistoryBusyRef.current = false;
      syncHistoryAvailability();
    }
  }

  async function cancelWorkspaceReplacement() {
    if (pendingWorkspaceReplacement === null) {
      return;
    }
    if (pendingWorkspaceReplacement.preparedRestoreId !== undefined) {
      try {
        await workspaceSecurity.cancelRestore(
          pendingWorkspaceReplacement.preparedRestoreId,
        );
      } catch {
        setBackupStatus(t("offsiteBackup.errors.cancelRestore"));
      }
    }
    setActiveView(pendingWorkspaceReplacement.returnView);
    setPendingWorkspaceReplacement(null);
  }

  async function exportUnreadableData(
    raw: string,
    source: "primary" | "recovery",
    authorization?: string,
  ) {
    setStorageProblemStatus(null);
    if (workspaceSecurityStatus.encrypted && authorization === undefined) {
      setSecurityMessage(null);
      setSecurityCurrentPassword("");
      setPendingUnreadableExport({ raw, source });
      setSecurityDialog("exportUnreadable");
      return;
    }
    try {
      const date = new Date().toISOString().slice(0, 10);
      const contents = workspaceSecurityStatus.encrypted
        ? await workspaceSecurity.encryptExport(raw, authorization ?? "")
        : raw;
      const exported = await exportWorkspaceFile(
        contents,
        workspaceSecurityStatus.encrypted
          ? `linked-info-unreadable-${source}-${date}.encrypted.json`
          : `linked-info-unreadable-${source}-${date}.json`,
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
      workspaceChangedInSessionRef.current = true;
      workspaceReplacementGenerationRef.current += 1;
      smartReferenceQueueGenerationRef.current += 1;
      smartReferenceMemoryCacheRef.current.clear();
      workspaceRef.current = initialWorkspace;
      setWorkspace(initialWorkspace);
      setSmartReferenceTasks([]);
      setSmartReferenceResult(null);
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
        {persistenceRecoveryRequired ? (
          <section className="storage-problem-card" aria-labelledby="storage-recovery-title">
            <AlertTriangle aria-hidden="true" className="storage-problem-icon" size={28} />
            <h1 id="storage-recovery-title">
              {t("storageProblem.recoveryRequiredTitle")}
            </h1>
            <p>{t("storageProblem.recoveryRequiredDescription")}</p>
            <div className="storage-problem-actions">
              <button
                className="primary-button"
                onClick={() => window.location.reload()}
                type="button"
              >
                {t("storageProblem.restart")}
              </button>
            </div>
          </section>
        ) : primaryStorageProblem === null ? (
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
  const localEmbeddingTaskRunning =
    preparingLocalModelId !== null ||
    (analyzingNodeId !== null && embeddingSettings.provider === "local");
  const localLlmTaskRunning =
    preparingLocalLlmModelId !== null ||
    ((documentImportBusy || (analyzingNodeId !== null && llmSettings.enabled)) &&
      localLlmProgress !== null &&
      !["ready", "cancelled", "failed"].includes(localLlmProgress.phase));
  const localModelTaskRunning =
    localEmbeddingTaskRunning || localLlmTaskRunning;
  const localDownloadCancellable =
    localEmbeddingTaskRunning && localEmbeddingProgress?.phase === "downloading";
  const progressModel =
    localEmbeddingProgress === null
      ? selectedLocalModel
      : localEmbeddingModels.find(
          (model) => model.id === localEmbeddingProgress.modelId,
        ) ?? selectedLocalModel;
  const progressModelName = t(
    `smartReference.settings.models.${progressModel.translationKey}.name`,
  );
  const selectedLocalLlmModel = localLlmModelDefinition(llmSettings.localModel);
  const selectedLocalLlmModelStatus = localLlmModelStatuses.find(
    (status) => status.modelId === llmSettings.localModel,
  );
  const localLlmDownloadCancellable =
    localLlmTaskRunning && localLlmProgress?.phase === "downloading";
  const progressLlmModel =
    localLlmProgress === null
      ? selectedLocalLlmModel
      : localLlmModels.find((model) => model.id === localLlmProgress.modelId) ??
        selectedLocalLlmModel;
  const progressLlmModelName = t(
    `smartReference.llm.settings.models.${progressLlmModel.translationKey}.name`,
  );
  const canvasOperationItems = canvasOperationIds.map((id) => ({
    action: t(`canvasShortcuts.items.${id}.action`),
    id,
    keys: t(`canvasShortcuts.items.${id}.keys`),
  }));
  const settingsTabs = [
    {
      id: "general" as const,
      icon: Languages,
      label: t("settings.tabs.general"),
    },
    {
      id: "operations" as const,
      icon: Keyboard,
      label: t("settings.tabs.operations"),
    },
    {
      id: "smartReference" as const,
      icon: BrainCircuit,
      label: t("settings.tabs.smartReference"),
    },
    {
      id: "dataSecurity" as const,
      icon: ShieldCheck,
      label: t("settings.tabs.dataSecurity"),
    },
  ];
  const handleSettingsTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % settingsTabs.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + settingsTabs.length) % settingsTabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = settingsTabs.length - 1;
    }
    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    const nextTab = settingsTabs[nextIndex];
    setActiveSettingsTab(nextTab.id);
    requestAnimationFrame(() => {
      document.getElementById(`settings-tab-${nextTab.id}`)?.focus();
    });
  };

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
              disabled={pendingWorkspaceReplacement !== null}
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
            data-testid="settings-navigation"
            disabled={pendingWorkspaceReplacement !== null}
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
              {documentImportPreview !== null
                ? t("documentImport.previewTitle")
                : pendingWorkspaceReplacement !== null
                ? t("backup.preview.title")
                : activeView === "settings"
                  ? t("navigation.settings")
                  : t(currentView.labelKey)}
            </h1>
          </div>

          {activeView !== "settings" &&
            pendingWorkspaceReplacement === null &&
            documentImportPreview === null && (
            <div className="workspace-actions">
              <div className="node-search-control">
                <label className="search-scope-picker">
                  <span className="visually-hidden">{t("search.scopeLabel")}</span>
                  <select
                    aria-label={t("search.scopeLabel")}
                    data-testid="node-search-scope"
                    onChange={(event) =>
                      setSearchScope(event.target.value as NodeSearchScope)
                    }
                    value={searchScope}
                  >
                    <option value="name">{t("search.scopes.name")}</option>
                    <option value="content">{t("search.scopes.content")}</option>
                    <option value="both">{t("search.scopes.both")}</option>
                  </select>
                </label>
                <label className="search-field">
                  <Search aria-hidden="true" size={16} />
                  <span className="visually-hidden">{t("search.label")}</span>
                  <input
                    data-testid="node-search"
                    onChange={(event) => setSearchTerm(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setSearchTerm("");
                        event.currentTarget.blur();
                      }
                    }}
                    placeholder={t(`search.placeholders.${searchScope}`)}
                    ref={searchInputRef}
                    value={searchTerm}
                  />
                </label>
              </div>
              {activeView === "canvas" && (
                <label
                  className="unmatched-opacity-control"
                  title={t("search.unmatchedOpacityHint")}
                >
                  <span>{t("search.unmatchedOpacity")}</span>
                  <input
                    aria-label={t("search.unmatchedOpacity")}
                    data-testid="unmatched-node-opacity"
                    max="100"
                    min="0"
                    onChange={(event) =>
                      setUnmatchedNodeOpacity(Number(event.target.value))
                    }
                    step="5"
                    type="range"
                    value={unmatchedNodeOpacity}
                  />
                  <output>
                    {unmatchedNodeOpacity === 0
                      ? t("search.hidden")
                      : t("search.opacityValue", { value: unmatchedNodeOpacity })}
                  </output>
                </label>
              )}
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
                {hasActiveNodeFilter
                  ? t("workspace.filteredItemCount", {
                      count: filteredNodes.length,
                      total: workspace.nodes.length,
                    })
                  : t("workspace.itemCount", { count: filteredNodes.length })}
              </span>
              <button
                className="secondary-button"
                onClick={openDocumentImport}
                type="button"
              >
                <Upload size={16} />
                <span>{t("documentImport.action")}</span>
              </button>
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
          {documentImportPreview !== null ? (
            <WorkspaceRestorePreview
              current={workspace}
              labels={{
                title: t("documentImport.previewTitle"),
                source: documentImportPreview.draft.sourceName,
                before: t("documentImport.previewBefore"),
                after: t("documentImport.previewAfter"),
                overlay: t("backup.preview.overlay"),
                cancel: t("actions.cancel"),
                confirm: t("documentImport.confirm"),
                identical: t("backup.preview.identical"),
                added: t("backup.preview.added"),
                removed: t("backup.preview.removed"),
                modified: t("backup.preview.modified"),
                moved: t("backup.preview.moved"),
                resized: t("backup.preview.resized"),
                stacking: t("backup.preview.stacking"),
                beforePosition: t("backup.preview.beforePosition"),
                unnamed: t("nodes.unnamed"),
                noContent: t("nodes.noContent"),
                legendAdded: t("documentImport.legendAdded"),
                legendRemoved: t("backup.preview.legendRemoved"),
                legendModified: t("backup.preview.legendModified"),
                legendMoved: t("backup.preview.legendMoved"),
                legendResized: t("backup.preview.legendResized"),
              }}
              onCancel={cancelDocumentImportPreview}
              onConfirm={confirmDocumentImport}
              replacement={documentImportPreview.workspace}
            />
          ) : pendingWorkspaceReplacement !== null ? (
            <WorkspaceRestorePreview
              current={workspace}
              labels={{
                title: t("backup.preview.title"),
                source: pendingWorkspaceReplacement.sourceName,
                before: t("backup.preview.before"),
                after: t("backup.preview.after"),
                overlay: t("backup.preview.overlay"),
                cancel: t("actions.cancel"),
                confirm: t("backup.confirmReplace"),
                identical: t("backup.preview.identical"),
                added: t("backup.preview.added"),
                removed: t("backup.preview.removed"),
                modified: t("backup.preview.modified"),
                moved: t("backup.preview.moved"),
                resized: t("backup.preview.resized"),
                stacking: t("backup.preview.stacking"),
                beforePosition: t("backup.preview.beforePosition"),
                unnamed: t("nodes.unnamed"),
                noContent: t("nodes.noContent"),
                legendAdded: t("backup.preview.legendAdded"),
                legendRemoved: t("backup.preview.legendRemoved"),
                legendModified: t("backup.preview.legendModified"),
                legendMoved: t("backup.preview.legendMoved"),
                legendResized: t("backup.preview.legendResized"),
              }}
              onCancel={cancelWorkspaceReplacement}
              onConfirm={() => void applyWorkspaceReplacement()}
              replacement={pendingWorkspaceReplacement.workspace}
            />
          ) : activeView === "settings" ? (
            <section className="settings-panel">
              <nav
                aria-label={t("settings.tabs.label")}
                className="settings-tab-list"
                role="tablist"
              >
                {settingsTabs.map(({ id, icon: Icon, label }, index) => (
                  <button
                    aria-controls={`settings-panel-${id}`}
                    aria-selected={activeSettingsTab === id}
                    className="settings-tab"
                    data-testid={`settings-tab-${id}`}
                    id={`settings-tab-${id}`}
                    key={id}
                    onClick={() => setActiveSettingsTab(id)}
                    onKeyDown={(event) => handleSettingsTabKeyDown(event, index)}
                    role="tab"
                    tabIndex={activeSettingsTab === id ? 0 : -1}
                    type="button"
                  >
                    <Icon aria-hidden="true" size={16} />
                    <span>{label}</span>
                  </button>
                ))}
              </nav>
              <section
                aria-labelledby="settings-tab-general"
                className="settings-tab-panel"
                hidden={activeSettingsTab !== "general"}
                id="settings-panel-general"
                role="tabpanel"
              >
                <header className="settings-group-heading">
                  <h2>{t("settings.generalTitle")}</h2>
                  <p>{t("settings.generalDescription")}</p>
                </header>
                <div className="setting-row">
                  <div className="setting-label">
                    <Languages size={18} />
                    <span>{t("settings.language")}</span>
                  </div>
                  <div className="segmented-control">
                    {supportedLanguages.map((language) => (
                      <button
                        data-active={activeLanguage === language}
                        data-language={language}
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
              <section
                aria-labelledby="settings-tab-operations"
                className="settings-tab-panel"
                hidden={activeSettingsTab !== "operations"}
                id="settings-panel-operations"
                role="tabpanel"
              >
                <header className="settings-group-heading">
                  <h2 data-testid="operation-guide-heading">
                    {t("settings.operationGuideTitle")}
                  </h2>
                  <p>{t("settings.operationGuideDescription")}</p>
                </header>
                <div className="setting-row">
                  <div className="setting-label">
                    <Network size={18} />
                    <div className="setting-label-copy">
                      <span>{t("canvasLayout.autoAvoidTitle")}</span>
                      <small>{t("canvasLayout.autoAvoidDescription")}</small>
                    </div>
                  </div>
                  <label className="switch-setting">
                    <input
                      checked={autoAvoidCanvasOverlaps}
                      data-testid="auto-avoid-canvas-overlaps"
                      onChange={(event) =>
                        setAutoAvoidCanvasOverlaps(event.target.checked)
                      }
                      type="checkbox"
                    />
                    <span>{t("canvasLayout.autoAvoidEnable")}</span>
                  </label>
                </div>
                <div className="setting-row operation-guide-setting-row">
                  <div className="setting-label">
                    <Keyboard size={18} />
                    <div className="setting-label-copy">
                      <span>{t("settings.canvasOperations")}</span>
                      <small>{t("settings.canvasOperationsDescription")}</small>
                    </div>
                  </div>
                  <CanvasOperationGuide
                    items={canvasOperationItems}
                    pickerLabel={t("canvasShortcuts.pickerLabel")}
                    replayLabel={t("canvasShortcuts.replay")}
                  />
                </div>
              </section>
              <section
                aria-labelledby="settings-tab-smartReference"
                className="settings-tab-panel"
                hidden={activeSettingsTab !== "smartReference"}
                id="settings-panel-smartReference"
                role="tabpanel"
              >
                <header className="settings-group-heading">
                  <h2>{t("settings.smartReferenceTitle")}</h2>
                  <p>{t("settings.smartReferenceDescription")}</p>
                </header>
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
                      disabled={
                        workspaceSecurityStatus.encrypted ||
                        localModelTaskRunning ||
                        analyzingNodeId !== null
                      }
                      onClick={() =>
                        changeEmbeddingConfiguration({ provider: "remote" })
                      }
                      type="button"
                    >
                      <Cloud aria-hidden="true" size={14} />
                      {t("smartReference.settings.remote")}
                    </button>
                  </div>
                  {workspaceSecurityStatus.encrypted && (
                    <small>{t("security.remoteAiBlocked")}</small>
                  )}
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
                      <small>
                        {t("smartReference.settings.remotePrivacyDescription", {
                          nodes: remoteEmbeddingScope.nodeCount,
                          segments: remoteEmbeddingScope.segmentCount,
                        })}
                      </small>
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
                  {llmSettings.enabled && (
                    <small>{t("smartReference.llm.settings.automaticPaused")}</small>
                  )}
                </div>
              </div>
              <div className="setting-row data-setting-row smart-reference-setting-row">
                <div className="setting-label">
                  <BrainCircuit size={18} />
                  <div className="setting-label-copy">
                    <span>{t("smartReference.llm.settings.title")}</span>
                    <small>{t("smartReference.llm.settings.description")}</small>
                  </div>
                </div>
                <div className="automatic-reference-settings">
                  <label className="switch-setting">
                    <input
                      checked={llmSettings.enabled}
                      disabled={localModelTaskRunning || analyzingNodeId !== null}
                      onChange={(event) =>
                        changeLlmConfiguration({ enabled: event.target.checked })
                      }
                      type="checkbox"
                    />
                    <span>{t("smartReference.llm.settings.enable")}</span>
                  </label>
                  <div
                    aria-label={t("smartReference.llm.settings.localModelChoice")}
                    className="local-model-list"
                    role="radiogroup"
                  >
                    {localLlmModels.map((model) => {
                      const status = localLlmModelStatuses.find(
                        (candidate) => candidate.modelId === model.id,
                      );
                      const translationBase = `smartReference.llm.settings.models.${model.translationKey}`;
                      return (
                        <label
                          className="local-model-card"
                          data-selected={llmSettings.localModel === model.id}
                          key={model.id}
                        >
                          <input
                            checked={llmSettings.localModel === model.id}
                            disabled={localModelTaskRunning || analyzingNodeId !== null}
                            name="local-llm-model"
                            onChange={() =>
                              changeLlmConfiguration({ localModel: model.id })
                            }
                            type="radio"
                            value={model.id}
                          />
                          <span className="local-model-card-body">
                            <span className="local-model-card-heading">
                              <strong>{t(`${translationBase}.name`)}</strong>
                              <em>{t("smartReference.settings.recommended")}</em>
                              <small>
                                {status?.loaded
                                  ? t("smartReference.llm.settings.modelLoaded")
                                  : status?.ready
                                    ? t("smartReference.settings.modelReady")
                                    : status?.verificationRequired
                                      ? t(
                                          "smartReference.llm.settings.modelNeedsVerification",
                                        )
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
                              {t("smartReference.llm.settings.modelMetadata", {
                                size: formatByteCount(model.downloadBytes),
                                quantization: model.quantization,
                                tokens: model.contextTokens,
                                license: model.license,
                                runtime: model.runtime,
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
                  {selectedLocalLlmModelStatus?.runtimeAvailable === false && (
                    <small>{t("smartReference.llm.settings.runtimeUnavailable")}</small>
                  )}
                  <div className="local-model-actions">
                    <button
                      className="secondary-button"
                      disabled={
                        localModelTaskRunning ||
                        analyzingNodeId !== null ||
                        selectedLocalLlmModelStatus?.ready === true ||
                        selectedLocalLlmModelStatus?.runtimeAvailable === false
                      }
                      onClick={() =>
                        void prepareLocalLlmModel(llmSettings.localModel)
                      }
                      type="button"
                    >
                      <Download aria-hidden="true" size={15} />
                      {selectedLocalLlmModelStatus?.ready
                        ? t("smartReference.settings.modelReady")
                        : selectedLocalLlmModelStatus?.verificationRequired
                          ? t("smartReference.llm.settings.verifyModel")
                          : selectedLocalLlmModelStatus !== undefined &&
                              selectedLocalLlmModelStatus.cachedBytes > 0
                            ? t("smartReference.settings.continueDownload")
                            : t("smartReference.settings.downloadModel")}
                    </button>
                    <small>
                      {t("smartReference.settings.modelSource", {
                        repository: selectedLocalLlmModel.repository,
                        revision: selectedLocalLlmModel.revision.slice(0, 8),
                      })}
                    </small>
                  </div>
                  <small>{t("smartReference.llm.settings.confirmationRequired")}</small>
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
                    <span>
                      {workspaceSecurityStatus.encrypted
                        ? t("security.vectorCacheMemoryOnly")
                        : t("smartReference.settings.vectorCache.desktopOnly")}
                    </span>
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
              <div className="setting-row data-setting-row smart-reference-setting-row">
                <div className="setting-label">
                  <ArchiveRestore size={18} />
                  <div className="setting-label-copy">
                    <span>{t("smartReference.settings.resultCache.title")}</span>
                    <small>{t("smartReference.settings.resultCache.description")}</small>
                  </div>
                </div>
                <div className="vector-cache-settings">
                  {smartReferenceCacheStatus === null ? (
                    <span>{t("smartReference.settings.resultCache.loading")}</span>
                  ) : smartReferenceCacheStatus.persistent ? (
                    <span>
                      {t("smartReference.settings.resultCache.usage", {
                        used: formatByteCount(smartReferenceCacheStatus.diskBytes),
                        limit: formatByteCount(smartReferenceCacheStatus.maxBytes),
                        count: smartReferenceCacheStatus.entryCount,
                      })}
                    </span>
                  ) : (
                    <span>{t("smartReference.settings.resultCache.memoryOnly")}</span>
                  )}
                  <small>{t("smartReference.settings.resultCache.lifecycle")}</small>
                  <button
                    className="secondary-button"
                    disabled={
                      smartReferenceCacheBusy ||
                      smartReferenceCacheStatus?.persistent !== true
                    }
                    onClick={() => void clearSmartReferenceResultCache()}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={15} />
                    {smartReferenceCacheBusy
                      ? t("smartReference.settings.resultCache.clearing")
                      : t("smartReference.settings.resultCache.clear")}
                  </button>
                  {smartReferenceCacheMessage !== null && (
                    <small>{smartReferenceCacheMessage}</small>
                  )}
                </div>
              </div>
              </section>
              <section
                aria-labelledby="settings-tab-dataSecurity"
                className="settings-tab-panel"
                hidden={activeSettingsTab !== "dataSecurity"}
                id="settings-panel-dataSecurity"
                role="tabpanel"
              >
                <header className="settings-group-heading">
                  <h2>{t("settings.dataSecurityTitle")}</h2>
                  <p>{t("settings.dataSecurityDescription")}</p>
                </header>
              <div className="setting-row data-setting-row">
                <div className="setting-label">
                  {workspaceSecurityStatus.encrypted ? (
                    <ShieldCheck size={18} />
                  ) : (
                    <LockKeyhole size={18} />
                  )}
                  <div className="setting-label-copy">
                    <span>{t("security.settingsTitle")}</span>
                    <small>
                      {workspaceSecurityStatus.encrypted
                        ? t("security.encryptedDescription")
                        : t("security.plaintextDescription")}
                    </small>
                  </div>
                </div>
                <div className="security-settings-actions">
                  {workspaceSecurityStatus.encrypted ? (
                    <>
                      <button
                        className="secondary-button"
                        disabled={
                          securityBusy ||
                          !workspaceSecurityStatus.systemUnlockAvailable
                        }
                        onClick={() =>
                          void toggleSystemUnlock(
                            !workspaceSecurityStatus.systemUnlockEnabled,
                          )
                        }
                        type="button"
                      >
                        <Fingerprint aria-hidden="true" size={15} />
                        {workspaceSecurityStatus.systemUnlockEnabled
                          ? t("security.disableSystemUnlock")
                          : t("security.enableSystemUnlock")}
                      </button>
                      <button
                        className="secondary-button"
                        disabled={securityBusy}
                        onClick={() => {
                          setSecurityMessage(null);
                          setSecurityDialog("change");
                        }}
                        type="button"
                      >
                        <KeyRound aria-hidden="true" size={15} />
                        {t("security.changePassword")}
                      </button>
                      <button
                        className="secondary-button"
                        disabled={securityBusy}
                        onClick={() => {
                          setSecurityMessage(null);
                          setSecurityDialog("rotate");
                        }}
                        type="button"
                      >
                        <RefreshCw aria-hidden="true" size={15} />
                        {t("security.rotateDataKey")}
                      </button>
                      <button
                        className="secondary-button"
                        disabled={securityBusy}
                        onClick={() => void lockEncryptedWorkspace()}
                        type="button"
                      >
                        <LockKeyhole aria-hidden="true" size={15} />
                        {t("security.lockNow")}
                      </button>
                      <label className="security-idle-setting">
                        <Clock3 aria-hidden="true" size={15} />
                        <span>{t("security.idleTimeout")}</span>
                        <select
                          aria-label={t("security.idleTimeout")}
                          disabled={securityBusy}
                          onChange={(event) => {
                            const value = event.target.value;
                            void changeIdleTimeout(
                              value === "off" ? null : Number(value),
                            );
                          }}
                          value={
                            workspaceSecurityStatus.idleTimeoutMinutes?.toString() ??
                            "off"
                          }
                        >
                          <option value="5">{t("security.idleTimeout5")}</option>
                          <option value="15">{t("security.idleTimeout15")}</option>
                          <option value="30">{t("security.idleTimeout30")}</option>
                          <option value="off">{t("security.idleTimeoutOff")}</option>
                        </select>
                      </label>
                      <button
                        className="danger-button"
                        disabled={securityBusy}
                        onClick={() => {
                          setSecurityMessage(null);
                          setDestroyWorkspacePassword("");
                          setDestroyWorkspaceConfirmation("");
                          setDestroyWorkspaceDialog(true);
                        }}
                        type="button"
                      >
                        <Trash2 aria-hidden="true" size={15} />
                        {t("security.destroyWorkspace")}
                      </button>
                      <small>
                        {!workspaceSecurityStatus.systemUnlockAvailable
                          ? t("security.systemUnlockUnavailable")
                          : workspaceSecurityStatus.systemUnlockEnabled
                            ? t("security.systemUnlockEnabledDescription")
                            : t("security.systemUnlockDisabledDescription")}
                      </small>
                    </>
                  ) : (
                    <button
                      className="primary-button"
                      disabled={!workspaceSecurity.available || securityBusy}
                      onClick={() => {
                        setSecurityMessage(null);
                        setSecurityDialog("enable");
                      }}
                      type="button"
                    >
                      <LockKeyhole aria-hidden="true" size={15} />
                      {t("security.enable")}
                    </button>
                  )}
                  {securityMessage !== null && (
                    <small role="status">{securityMessage}</small>
                  )}
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
                    data-testid="import-workspace"
                    onClick={() => void chooseWorkspaceImport()}
                    type="button"
                  >
                    <Upload size={15} />
                    {t("backup.import")}
                  </button>
                  {recoveryAvailable && (
                    <button
                      className="secondary-button"
                      data-testid="restore-recovery-workspace"
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
                {workspaceBackupHistory.available && (
                  <div className="automatic-backup-history">
                    <div className="automatic-backup-history-heading">
                      <div>
                        <strong>{t("backup.historyTitle")}</strong>
                        <small>{t("backup.historyDescription")}</small>
                      </div>
                      {automaticBackupHistory !== null && (
                        <small>
                          {t("backup.historyUsage", {
                            count: automaticBackupHistory.entries.length,
                            maximumCount: automaticBackupHistory.maximumCount,
                            size: formatByteCount(automaticBackupHistory.totalBytes),
                            maximumSize: formatByteCount(
                              automaticBackupHistory.maximumBytes,
                            ),
                            maximumAgeDays: Math.round(
                              automaticBackupHistory.maximumAgeMs /
                                (24 * 60 * 60 * 1_000),
                            ),
                          })}
                        </small>
                      )}
                    </div>
                    {workspaceSecurityStatus.encrypted &&
                      automaticBackupHistory !== null &&
                      (automaticBackupHistory.entries.length > 0 ||
                        recoveryAvailable ||
                        recoveryStorageProblem !== null) && (
                        <button
                          className="danger-button"
                          disabled={securityBusy}
                          onClick={() => {
                            setSecurityMessage(null);
                            setRecoveryClearPassword("");
                            setRecoveryClearDialog(true);
                          }}
                          type="button"
                        >
                          <Trash2 aria-hidden="true" size={14} />
                          {t("security.clearRecoveryData")}
                        </button>
                      )}
                    {automaticBackupHistoryLoading && (
                      <p className="automatic-backup-history-message">
                        {t("backup.historyLoading")}
                      </p>
                    )}
                    {automaticBackupHistoryError !== null && (
                      <p
                        className="automatic-backup-history-message is-error"
                        role="status"
                      >
                        {automaticBackupHistoryError}
                      </p>
                    )}
                    {!automaticBackupHistoryLoading &&
                      automaticBackupHistory !== null &&
                      automaticBackupHistory.entries.length === 0 && (
                        <p className="automatic-backup-history-message">
                          {t("backup.historyEmpty")}
                        </p>
                      )}
                    {automaticBackupHistory !== null &&
                      automaticBackupHistory.entries.length > 0 && (
                        <div className="automatic-backup-list" role="list">
                          {automaticBackupHistory.entries.map((entry) => (
                            <div
                              className="automatic-backup-entry"
                              key={entry.id}
                              role="listitem"
                            >
                              <div>
                                <strong>
                                  {formatBackupDate(entry.createdAtMs, activeLanguage)}
                                </strong>
                                <small>
                                  {formatByteCount(entry.sizeBytes)}
                                  {entry.state === "invalid"
                                    ? ` · ${t("backup.historyInvalidLabel")}`
                                    : ""}
                                </small>
                              </div>
                              <button
                                className="secondary-button"
                                disabled={entry.state !== "ready"}
                                onClick={() => void chooseAutomaticBackup(entry)}
                                type="button"
                              >
                                <ArchiveRestore aria-hidden="true" size={14} />
                                {t("backup.historyRestore")}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                  </div>
                )}
                {backupStatus !== null && (
                  <p className="backup-status" role="status">
                    {backupStatus}
                  </p>
                )}
              </div>
              <div className="setting-row data-setting-row">
                <div className="setting-label">
                  <Cloud size={18} />
                  <div className="setting-label-copy">
                    <span>{t("offsiteBackup.title")}</span>
                    <small>{t("offsiteBackup.description")}</small>
                  </div>
                </div>
                <div className="offsite-backup-settings">
                  {!workspaceSecurityStatus.encrypted ? (
                    <div className="remote-embedding-fields offsite-target-form">
                      <strong>{t("offsiteBackup.bootstrapTitle")}</strong>
                      <small>{t("offsiteBackup.bootstrapDescription")}</small>
                      {renderOffsiteConnectionFields()}
                      <small>{t("offsiteBackup.bootstrapTokenDescription")}</small>
                      <button
                        className="secondary-button"
                        disabled={offsiteBusy || !offsiteBackup.available}
                        onClick={() => void connectOffsiteRecovery()}
                        type="button"
                      >
                        <Cloud aria-hidden="true" size={15} />
                        {t("offsiteBackup.connectForRecovery")}
                      </button>
                      {offsiteRecoveryPage !== null &&
                        offsiteRecoveryPage.items.length === 0 && (
                          <p className="automatic-backup-history-message">
                            {t("offsiteBackup.empty")}
                          </p>
                        )}
                      {offsiteRecoveryPage !== null &&
                        offsiteRecoveryPage.items.length > 0 && (
                          <div className="automatic-backup-list" role="list">
                            {offsiteRecoveryPage.items.map((snapshot) => (
                              <div
                                className="automatic-backup-entry"
                                key={snapshot.id}
                                role="listitem"
                              >
                                <div>
                                  <strong>
                                    {formatBackupDate(
                                      snapshot.createdAtMs,
                                      activeLanguage,
                                    )}
                                  </strong>
                                  <small>
                                    {formatByteCount(snapshot.sizeBytes)} · {snapshot.sha256.slice(0, 12)}…
                                  </small>
                                </div>
                                <button
                                  className="primary-button"
                                  disabled={offsiteBusy}
                                  onClick={() =>
                                    void chooseOffsiteBootstrapBackup(snapshot.id)
                                  }
                                  type="button"
                                >
                                  <ArchiveRestore aria-hidden="true" size={14} />
                                  {t("offsiteBackup.restoreOnThisDevice")}
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                    </div>
                  ) : (
                    <>
                      {offsiteTargets.length > 0 && (
                        <>
                          <label className="offsite-target-selector">
                            <span>{t("offsiteBackup.target")}</span>
                            <select
                              disabled={offsiteBusy}
                              onChange={(event) =>
                                setSelectedOffsiteTargetId(event.target.value)
                              }
                              value={selectedOffsiteTargetId ?? ""}
                            >
                              {offsiteTargets.map((target) => (
                                <option key={target.id} value={target.id}>
                                  {target.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          {selectedOffsiteTarget !== null && (
                            <div className="offsite-target-summary">
                              <strong>{selectedOffsiteTarget.endpoint}</strong>
                              <small>
                                {t("offsiteBackup.s3TargetLocation", {
                                  provider: t(
                                    `offsiteBackup.s3Providers.${selectedOffsiteTarget.s3Provider ?? "custom"}`,
                                  ),
                                  region: selectedOffsiteTarget.region ?? "",
                                  bucket: selectedOffsiteTarget.bucket ?? "",
                                  prefix: selectedOffsiteTarget.prefix ?? "",
                                })}
                              </small>
                              <small>
                                {t("offsiteBackup.targetStatus", {
                                  uploaded:
                                    selectedOffsiteTarget.lastUploadAtMs === null
                                      ? t("offsiteBackup.never")
                                      : formatBackupDate(
                                          selectedOffsiteTarget.lastUploadAtMs,
                                          activeLanguage,
                                        ),
                                  verified:
                                    selectedOffsiteTarget.lastVerifiedAtMs === null
                                      ? t("offsiteBackup.never")
                                      : formatBackupDate(
                                          selectedOffsiteTarget.lastVerifiedAtMs,
                                          activeLanguage,
                                        ),
                                  restored:
                                    selectedOffsiteTarget.lastRestoreTestAtMs === null
                                      ? t("offsiteBackup.never")
                                      : formatBackupDate(
                                          selectedOffsiteTarget.lastRestoreTestAtMs,
                                          activeLanguage,
                                        ),
                                })}
                              </small>
                              {selectedOffsiteTarget.maximumUploadBytes !== null && (
                                <small>
                                  {t("offsiteBackup.providerLimit", {
                                    size: formatByteCount(
                                      selectedOffsiteTarget.maximumUploadBytes,
                                    ),
                                  })}
                                </small>
                              )}
                              <div className="offsite-automatic-settings">
                                <label className="switch-setting">
                                  <input
                                    checked={selectedOffsiteTarget.automaticEnabled}
                                    disabled={offsiteBusy}
                                    onChange={(event) =>
                                      void updateAutomaticOffsiteSettings(
                                        selectedOffsiteTarget.id,
                                        event.target.checked,
                                        selectedOffsiteTarget.automaticIntervalHours,
                                      )
                                    }
                                    type="checkbox"
                                  />
                                  {t("offsiteBackup.automatic")}
                                </label>
                                <label>
                                  <span>{t("offsiteBackup.automaticInterval")}</span>
                                  <select
                                    disabled={
                                      offsiteBusy ||
                                      !selectedOffsiteTarget.automaticEnabled
                                    }
                                    onChange={(event) =>
                                      void updateAutomaticOffsiteSettings(
                                        selectedOffsiteTarget.id,
                                        true,
                                        Number(event.target.value),
                                      )
                                    }
                                    value={selectedOffsiteTarget.automaticIntervalHours}
                                  >
                                    {[24, 72, 168].map((hours) => (
                                      <option key={hours} value={hours}>
                                        {t("offsiteBackup.automaticIntervalHours", {
                                          count: hours,
                                        })}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              </div>
                              <small>
                                {selectedOffsiteTarget.automaticEnabled
                                  ? selectedOffsiteTarget.automaticPending
                                    ? t("offsiteBackup.automaticPending")
                                    : t("offsiteBackup.automaticCurrent")
                                  : t("offsiteBackup.automaticDescription")}
                              </small>
                              {selectedOffsiteTarget.lastAutomaticError !== null && (
                                <small className="offsite-automatic-error" role="alert">
                                  {t("offsiteBackup.automaticError", {
                                    reason: selectedOffsiteTarget.lastAutomaticError,
                                  })}
                                </small>
                              )}
                              <div className="offsite-automatic-settings offsite-retention-settings">
                                <label className="switch-setting">
                                  <input
                                    checked={selectedOffsiteTarget.retentionEnabled}
                                    disabled={offsiteBusy}
                                    onChange={(event) =>
                                      requestOffsiteSensitiveAction({
                                        kind: "retention",
                                        targetId: selectedOffsiteTarget.id,
                                        enabled: event.target.checked,
                                        maxSnapshots:
                                          selectedOffsiteTarget.retentionMaxSnapshots,
                                        maxAgeDays:
                                          selectedOffsiteTarget.retentionMaxAgeDays,
                                      })
                                    }
                                    type="checkbox"
                                  />
                                  {t("offsiteBackup.retention")}
                                </label>
                                <label>
                                  <span>{t("offsiteBackup.retentionCount")}</span>
                                  <select
                                    disabled={offsiteBusy}
                                    onChange={(event) =>
                                      requestOffsiteSensitiveAction({
                                        kind: "retention",
                                        targetId: selectedOffsiteTarget.id,
                                        enabled: selectedOffsiteTarget.retentionEnabled,
                                        maxSnapshots: Number(event.target.value),
                                        maxAgeDays:
                                          selectedOffsiteTarget.retentionMaxAgeDays,
                                      })
                                    }
                                    value={selectedOffsiteTarget.retentionMaxSnapshots}
                                  >
                                    {[10, 30, 60, 100].map((count) => (
                                      <option key={count} value={count}>
                                        {t("offsiteBackup.retentionSnapshots", { count })}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label>
                                  <span>{t("offsiteBackup.retentionAge")}</span>
                                  <select
                                    disabled={offsiteBusy}
                                    onChange={(event) =>
                                      requestOffsiteSensitiveAction({
                                        kind: "retention",
                                        targetId: selectedOffsiteTarget.id,
                                        enabled: selectedOffsiteTarget.retentionEnabled,
                                        maxSnapshots:
                                          selectedOffsiteTarget.retentionMaxSnapshots,
                                        maxAgeDays: Number(event.target.value),
                                      })
                                    }
                                    value={selectedOffsiteTarget.retentionMaxAgeDays}
                                  >
                                    {[30, 90, 180, 365].map((count) => (
                                      <option key={count} value={count}>
                                        {t("offsiteBackup.retentionDays", { count })}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              </div>
                              <small>
                                {selectedOffsiteTarget.retentionEnabled
                                  ? t("offsiteBackup.retentionDescriptionEnabled")
                                  : t("offsiteBackup.retentionDescription")}
                              </small>
                              <small>
                                {t("offsiteBackup.lifecycleStatus", {
                                  attempted:
                                    selectedOffsiteTarget.lastAutomaticAttemptAtMs === null
                                      ? t("offsiteBackup.never")
                                      : formatBackupDate(
                                          selectedOffsiteTarget.lastAutomaticAttemptAtMs,
                                          activeLanguage,
                                        ),
                                  next:
                                    !selectedOffsiteTarget.automaticEnabled
                                      ? t("offsiteBackup.automaticOff")
                                      : !selectedOffsiteTarget.automaticPending
                                        ? t("offsiteBackup.noPendingChanges")
                                        : selectedOffsiteTarget.lastUploadAtMs === null
                                          ? t("offsiteBackup.whenAppChecks")
                                          : formatBackupDate(
                                              selectedOffsiteTarget.lastUploadAtMs +
                                                selectedOffsiteTarget.automaticIntervalHours *
                                                  60 *
                                                  60 *
                                                  1_000,
                                              activeLanguage,
                                            ),
                                  cleanup:
                                    selectedOffsiteTarget.lastRetentionCleanupAtMs === null
                                      ? t("offsiteBackup.never")
                                      : formatBackupDate(
                                          selectedOffsiteTarget.lastRetentionCleanupAtMs,
                                          activeLanguage,
                                        ),
                                })}
                              </small>
                              {selectedOffsiteTarget.lastRetentionError !== null && (
                                <small className="offsite-automatic-error" role="alert">
                                  {t("offsiteBackup.retentionError", {
                                    reason: selectedOffsiteTarget.lastRetentionError,
                                  })}
                                </small>
                              )}
                            </div>
                          )}
                          {selectedOffsiteTarget !== null && (
                            <div className="backup-actions">
                              <button
                                className="secondary-button"
                                disabled={offsiteBusy}
                                onClick={() =>
                                  beginOffsiteTargetEdit(selectedOffsiteTarget)
                                }
                                type="button"
                              >
                                <Pencil aria-hidden="true" size={15} />
                                {t("offsiteBackup.editTarget")}
                              </button>
                              <button
                                className="primary-button"
                                disabled={offsiteBusy || selectedOffsiteTargetId === null}
                                onClick={() => void createOffsiteSnapshot()}
                                type="button"
                              >
                                <Upload aria-hidden="true" size={15} />
                                {t("offsiteBackup.uploadNow")}
                              </button>
                              <button
                                className="secondary-button"
                                disabled={offsiteBusy}
                                onClick={() =>
                                  requestOffsiteSensitiveAction({
                                    kind: "removeTarget",
                                    targetId: selectedOffsiteTarget.id,
                                    targetName: selectedOffsiteTarget.name,
                                  })
                                }
                                type="button"
                              >
                                <X aria-hidden="true" size={15} />
                                {t("offsiteBackup.removeTarget")}
                              </button>
                              <button
                                className="danger-button"
                                disabled={offsiteBusy}
                                onClick={() =>
                                  requestOffsiteSensitiveAction({
                                    kind: "destroyTarget",
                                    targetId: selectedOffsiteTarget.id,
                                    targetName: selectedOffsiteTarget.name,
                                  })
                                }
                                type="button"
                              >
                                <Trash2 aria-hidden="true" size={15} />
                                {t("offsiteBackup.destroyTarget")}
                              </button>
                              <button
                                className="secondary-button"
                                disabled={offsiteBusy || selectedOffsiteTargetId === null}
                                onClick={() => void refreshOffsiteBackups()}
                                type="button"
                              >
                                <RefreshCw aria-hidden="true" size={15} />
                                {t("offsiteBackup.refresh")}
                              </button>
                            </div>
                          )}
                          {offsitePage !== null && offsitePage.items.length === 0 && (
                            <p className="automatic-backup-history-message">
                              {t("offsiteBackup.empty")}
                            </p>
                          )}
                          {offsitePage !== null && offsitePage.items.length > 0 && (
                            <div className="automatic-backup-list" role="list">
                              {offsitePage.items.map((snapshot) => (
                                <div
                                  className="automatic-backup-entry"
                                  key={snapshot.id}
                                  role="listitem"
                                >
                                  <div>
                                    <strong>
                                      {formatBackupDate(
                                        snapshot.createdAtMs,
                                        activeLanguage,
                                      )}
                                    </strong>
                                    <small>
                                      {formatByteCount(snapshot.sizeBytes)} · {snapshot.sha256.slice(0, 12)}…
                                    </small>
                                  </div>
                                  <div className="offsite-entry-actions">
                                    <button
                                      className="secondary-button"
                                      disabled={offsiteBusy}
                                      onClick={() =>
                                        void verifyOffsiteSnapshot(snapshot.id)
                                      }
                                      type="button"
                                    >
                                      <ShieldCheck aria-hidden="true" size={14} />
                                      {t("offsiteBackup.verify")}
                                    </button>
                                    <button
                                      className="danger-button"
                                      disabled={offsiteBusy}
                                      onClick={() =>
                                        selectedOffsiteTargetId !== null &&
                                        requestOffsiteSensitiveAction({
                                          kind: "deleteSnapshot",
                                          targetId: selectedOffsiteTargetId,
                                          snapshotId: snapshot.id,
                                          createdAtMs: snapshot.createdAtMs,
                                        })
                                      }
                                      type="button"
                                    >
                                      <Trash2 aria-hidden="true" size={14} />
                                      {t("offsiteBackup.deleteSnapshot")}
                                    </button>
                                    <button
                                      className="secondary-button"
                                      disabled={offsiteBusy}
                                      onClick={() =>
                                        openOffsiteRestoreDrill(
                                          snapshot.id,
                                          snapshot.createdAtMs,
                                        )
                                      }
                                      type="button"
                                    >
                                      <KeyRound aria-hidden="true" size={14} />
                                      {t("offsiteBackup.restoreDrill")}
                                    </button>
                                    <button
                                      className="secondary-button"
                                      disabled={offsiteBusy}
                                      onClick={() => void chooseOffsiteBackup(snapshot.id)}
                                      type="button"
                                    >
                                      <ArchiveRestore aria-hidden="true" size={14} />
                                      {t("offsiteBackup.restore")}
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </>
                  )}
                  {offsiteMessage !== null && (
                    <small role="status">{offsiteMessage}</small>
                  )}
                </div>
              </div>
              {workspaceSecurityStatus.encrypted && (
                <div
                  className="setting-row data-setting-row"
                  id="offsite-target-form"
                >
                  <div className="setting-label">
                    {editingOffsiteTargetId === null ? (
                      <Plus size={18} />
                    ) : (
                      <Pencil size={18} />
                    )}
                    <div className="setting-label-copy">
                      <span>
                        {editingOffsiteTargetId === null
                          ? t("offsiteBackup.addTarget")
                          : t("offsiteBackup.editTargetTitle")}
                      </span>
                      <small>
                        {editingOffsiteTargetId === null
                          ? t("offsiteBackup.addTargetDescription")
                          : t("offsiteBackup.editTargetDescription")}
                      </small>
                    </div>
                  </div>
                  <div className="offsite-backup-settings">
                    <div className="remote-embedding-fields offsite-target-create-form">
                      <label>
                        <span>{t("offsiteBackup.targetName")}</span>
                        <input
                          disabled={offsiteBusy}
                          maxLength={80}
                          onChange={(event) => setOffsiteTargetName(event.target.value)}
                          value={offsiteTargetName}
                        />
                      </label>
                      {renderOffsiteConnectionFields()}
                      <div className="backup-actions">
                        {editingOffsiteTargetId !== null && (
                          <button
                            className="secondary-button"
                            disabled={offsiteBusy}
                            onClick={cancelOffsiteTargetEdit}
                            type="button"
                          >
                            <X aria-hidden="true" size={15} />
                            {t("actions.cancel")}
                          </button>
                        )}
                        <button
                          className="secondary-button"
                          disabled={offsiteBusy || !offsiteBackup.available}
                          onClick={requestOffsiteTargetConfiguration}
                          type="button"
                        >
                          <Cloud aria-hidden="true" size={15} />
                          {editingOffsiteTargetId === null
                            ? t("offsiteBackup.connect")
                            : t("offsiteBackup.saveTargetChanges")}
                        </button>
                      </div>
                    </div>
                    <small>{t("offsiteBackup.passwordHistoryWarning")}</small>
                  </div>
                </div>
              )}
              </section>
            </section>
          ) : activeView === "canvas" ? (
            <GraphCanvas
              analyzingNodeId={analyzingNodeId}
              autoAvoidOverlaps={autoAvoidCanvasOverlaps}
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
                contentProcessor: t("editor.contentProcessor"),
                unsupportedContentProcessor: (processorId) =>
                  t("editor.contentProcessorUnsupported", { processorId }),
                copySecret: t("secretClipboard.copy"),
                copySecretFailed: t("secretClipboard.failed"),
                copySecretSuccess: t("secretClipboard.copied", {
                  seconds: Math.round(
                    (secretClipboardStatus?.clearAfterMs ?? 45_000) / 1_000,
                  ),
                }),
                editMarker: (markerLabel) =>
                  t("contentMarkers.current", { marker: markerLabel }),
                markSelection: t("contentMarkers.markSelection"),
                markerNote: t("contentMarkers.note"),
                markerNotePlaceholder: t("contentMarkers.notePlaceholder"),
                markerPayloadInvalid: (markerLabel) =>
                  t("contentMarkers.invalidPayload", { marker: markerLabel }),
                markerSelectionConflict: t("contentMarkers.selectionConflict"),
                removeMarker: t("contentMarkers.remove"),
                saveMarkerNote: t("contentMarkers.saveNote"),
                secretCopy: contentEnhancementLabels.secret.copy,
                secretHide: contentEnhancementLabels.secret.hide,
                secretLabel: contentEnhancementLabels.secret.label,
                secretMasked: contentEnhancementLabels.secret.masked,
                secretReveal: contentEnhancementLabels.secret.reveal,
                totpCopy: contentEnhancementLabels.totp.copy,
                totpGenerating: contentEnhancementLabels.totp.generating,
                totpInvalid: contentEnhancementLabels.totp.invalid,
                totpMasked: contentEnhancementLabels.totp.masked,
                totpRemaining: contentEnhancementLabels.totp.remaining,
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
                noMatches: t("empty.search"),
                filterByNode: t("filters.filterByNode"),
                fitNodeContent: t("nodeSize.fit"),
                arrangeNodes: (count) =>
                  t("canvasLayout.arrangeAction", { count }),
                arrangementApply: t("canvasLayout.apply"),
                arrangementDescription: (count) =>
                  t("canvasLayout.description", { count }),
                arrangementFailed: t("canvasLayout.failed"),
                arrangementMode: t("canvasLayout.mode"),
                arrangementModes: {
                  auto: t("canvasLayout.modes.auto"),
                  grid: t("canvasLayout.modes.grid"),
                  overlap: t("canvasLayout.modes.overlap"),
                  relationship: t("canvasLayout.modes.relationship"),
                },
                arrangementSize: t("canvasLayout.size"),
                arrangementSizes: {
                  "equal-size": t("canvasLayout.sizes.equal-size"),
                  "equal-width": t("canvasLayout.sizes.equal-width"),
                  preserve: t("canvasLayout.sizes.preserve"),
                },
                arrangementTitle: t("canvasLayout.title"),
                name: t("editor.name"),
                nameConflict: t("validation.nameUnique"),
                namePlaceholder: t("editor.namePlaceholder"),
                noContent: t("nodes.noContent"),
                references: t("references.list"),
                collapsedIncomingReferences: (count) =>
                  t("references.collapsedIncoming", { count }),
                incomingReferenceBrowserFilter: t(
                  "references.incomingBrowserFilter",
                ),
                incomingReferenceBrowserNoMatches: t(
                  "references.incomingBrowserNoMatches",
                ),
                incomingReferenceBrowserSearch: t(
                  "references.incomingBrowserSearch",
                ),
                incomingReferenceBrowserShowing: (count, total) =>
                  t("references.incomingBrowserShowing", { count, total }),
                incomingReferenceBrowserTitle: t(
                  "references.incomingBrowserTitle",
                ),
                incomingReferenceFocus: (name) =>
                  t("references.incomingFocus", { name }),
                incomingReferences: (count) =>
                  t("references.incomingReferences", { count }),
                referenceSearchCreate: (name) =>
                  t("references.searchCreate", { name }),
                referenceSearchCreateHint: t("references.searchCreateHint"),
                referenceSearchEmpty: t("references.searchEmpty"),
                referenceSearchHint: t("references.searchHint"),
                referenceSearchLabel: t("references.searchLabel"),
                referenceSearchPlaceholder: t("references.searchPlaceholder"),
                redo: t("actions.redo"),
                resetNodeSize: t("nodeSize.reset"),
                removeNodeFilter: t("filters.removeNodeFilter"),
                sourceHandle: t("references.sourceHandle"),
                smartReference: t("smartReference.action"),
                smartReferenceMultiple: (count) =>
                  t("smartReference.batchAction", { count }),
                shortcuts: {
                  items: canvasOperationItems,
                  open: t("canvasShortcuts.open"),
                  title: t("canvasShortcuts.title"),
                },
                targetHandle: t("references.targetHandle"),
                undo: t("actions.undo"),
                unnamed: t("nodes.unnamed"),
              }}
              layout={workspace.layout}
              contentProcessorByNodeId={workspace.view.contentProcessorByNodeId}
              contentProcessorOptions={contentProcessorOptions}
              contentMarkerOptions={contentMarkerOptions}
              nameConflictNodeIds={nameConflictNodeIds}
              nodes={workspace.nodes}
              onAnalyzeNodes={enqueueSmartReferenceNodes}
              onCreateNode={createNode}
              onCreateReferencedNode={createReferencedNode}
              onCopySecret={
                secretClipboardStatus?.available === true
                  ? async (text) => {
                      setSecretClipboardStatus(await secretClipboard.copy(text));
                    }
                  : null
              }
              nodeFiltersActive={hasActiveNodeFilter}
              onClearNodeFilters={clearNodeFilters}
              onDeleteNodes={deleteNodes}
              onEditNode={editNode}
              onLayoutChange={updateLayout}
              onNodeCommit={commitNode}
              onNodeContentChange={updateNodeContent}
              onNodeContentProcessorChange={updateNodeContentProcessor}
              onNodeBringToFront={bringNodeToFront}
              onNodeNameChange={updateNodeName}
              onReferencesChange={updateReferences}
              onRedo={redoWorkspace}
              onToggleReferenceFilter={activateCanvasReferenceFilter}
              onUndo={undoWorkspace}
              onViewportChange={updateViewport}
              referenceFilterNodeIds={referenceFilterNodeIds}
              references={workspace.references}
              filteredNodeIds={filteredNodeIds}
              unmatchedNodeOpacity={unmatchedNodeOpacity}
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
                      <NodeContentHost
                        content={node.content}
                        emptyContent={t("nodes.noContent")}
                        enhancementLabels={contentEnhancementLabels}
                        processorId={
                          workspace.view.contentProcessorByNodeId[node.id] ?? null
                        }
                        variant="list"
                      />
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

        </div>
      </main>

      {localEmbeddingTaskRunning && !localLlmTaskRunning && (
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

      {localLlmTaskRunning && (
        <div className="smart-reference-progress" role="status">
          <BrainCircuit aria-hidden="true" size={17} />
          <div className="smart-reference-progress-copy">
            <strong>
              {localLlmProgress === null
                ? t("smartReference.llm.download.preparing", {
                    model: progressLlmModelName,
                  })
                : t(
                    `smartReference.llm.download.phases.${localLlmProgress.phase}`,
                    { model: progressLlmModelName },
                  )}
            </strong>
            {localLlmProgress?.fileName !== null &&
              localLlmProgress?.fileName !== undefined && (
                <span>{localLlmProgress.fileName}</span>
              )}
            {localLlmProgress !== null && localLlmProgress.totalBytes > 0 && (
              <>
                <progress
                  aria-label={t("smartReference.download.progressLabel")}
                  max={localLlmProgress.totalBytes}
                  value={localLlmProgress.downloadedBytes}
                />
                <span className="smart-reference-progress-metrics">
                  {t("smartReference.download.bytes", {
                    downloaded: formatByteCount(localLlmProgress.downloadedBytes),
                    total: formatByteCount(localLlmProgress.totalBytes),
                    percent: Math.min(
                      100,
                      Math.floor(
                        (localLlmProgress.downloadedBytes /
                          localLlmProgress.totalBytes) *
                          100,
                      ),
                    ),
                  })}
                  {localLlmProgress.bytesPerSecond !== null && (
                    <>
                      {" · "}
                      {t("smartReference.download.speed", {
                        speed: formatByteCount(localLlmProgress.bytesPerSecond),
                      })}
                    </>
                  )}
                  {localLlmProgress.etaSeconds !== null && (
                    <>
                      {" · "}
                      {t("smartReference.download.eta", {
                        eta: formatDuration(localLlmProgress.etaSeconds),
                      })}
                    </>
                  )}
                </span>
              </>
            )}
          </div>
          {localLlmDownloadCancellable && (
            <button
              className="secondary-button smart-reference-cancel-download"
              disabled={cancellingLocalLlmDownload}
              onClick={() => void cancelLocalLlmDownload()}
              type="button"
            >
              {cancellingLocalLlmDownload
                ? t("smartReference.download.cancelling")
                : t("smartReference.download.cancel")}
            </button>
          )}
        </div>
      )}

      {analyzingNodeId !== null &&
        embeddingSettings.provider === "remote" &&
        !localLlmTaskRunning && (
        <div className="smart-reference-progress" role="status">
          <Cloud aria-hidden="true" size={17} />
          <div>
            <strong>{t("smartReference.analyzing")}</strong>
            <span>
              {t("smartReference.analyzingRemoteDescription", {
                nodes: remoteEmbeddingScope.nodeCount,
                segments: remoteEmbeddingScope.segmentCount,
              })}
            </span>
          </div>
        </div>
      )}

      {smartReferenceTasks.length > 0 && (
        <aside className="smart-reference-queue" data-testid="smart-reference-queue">
          <header>
            <div>
              <strong>{t("smartReference.queue.title")}</strong>
              <span>
                {t("smartReference.queue.summary", {
                  completed: smartReferenceTasks.filter(
                    (task) => task.status === "completed",
                  ).length,
                  queued: smartReferenceTasks.filter((task) => task.status === "queued")
                    .length,
                  total: smartReferenceTasks.length,
                })}
              </span>
            </div>
            <button
              disabled={smartReferenceTasks.every(
                (task) => task.status === "queued" || task.status === "running",
              )}
              onClick={() =>
                setSmartReferenceTasks((current) =>
                  current.filter(
                    (task) => task.status === "queued" || task.status === "running",
                  ),
                )
              }
              type="button"
            >
              {t("smartReference.queue.clearFinished")}
            </button>
          </header>
          <div className="smart-reference-queue-list">
            {smartReferenceTasks.map((task) => {
              const node = workspace.nodes.find((candidate) => candidate.id === task.nodeId);
              const label =
                node === undefined
                  ? t("smartReference.queue.missingNode")
                  : nodeFilterLabel(
                      node,
                      t("nodes.unnamed"),
                      t("nodes.noContent"),
                    );
              return (
                <div
                  className="smart-reference-queue-item"
                  data-status={task.status}
                  key={task.nodeId}
                >
                  <div>
                    <strong>{label}</strong>
                    <span>
                      {task.status === "completed" && task.cacheHit
                        ? t("smartReference.queue.cached")
                        : t(`smartReference.queue.${task.status}`)}
                    </span>
                    {task.error !== null && <small>{task.error}</small>}
                  </div>
                  {task.status === "completed" ? (
                    <button
                      onClick={() => void openSmartReferenceTask(task)}
                      type="button"
                    >
                      {t("smartReference.queue.open")}
                    </button>
                  ) : task.status === "failed" ? (
                    <button
                      onClick={() => enqueueSmartReferenceNodes([task.nodeId])}
                      type="button"
                    >
                      {t("smartReference.queue.retry")}
                    </button>
                  ) : task.status === "queued" ? (
                    <button
                      onClick={() =>
                        setSmartReferenceTasks((current) =>
                          current.filter((candidate) => candidate.nodeId !== task.nodeId),
                        )
                      }
                      type="button"
                    >
                      {t("smartReference.queue.remove")}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </aside>
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
            <div className="smart-reference-scroll">
              {smartReferenceResult.llmEnabled && (
                <section className="smart-reference-result-section">
                  <h3>{t("smartReference.llm.selectedTitle")}</h3>
                  <p>{t("smartReference.llm.selectedDescription")}</p>
                  {smartReferenceResult.llmNoMatch ? (
                    <p className="smart-reference-section-empty">
                      {t("smartReference.llm.noMatch")}
                    </p>
                  ) : smartReferenceResult.llmSelectedNodeIds.length === 0 ? (
                    <p className="smart-reference-section-empty">
                      {t("smartReference.llm.selectedEmpty")}
                    </p>
                  ) : (
                    <div className="smart-reference-results">
                      {smartReferenceResult.llmSelectedNodeIds.map((nodeId) => {
                        const node = workspace.nodes.find(
                          (candidate) => candidate.id === nodeId,
                        );
                        if (node === undefined) {
                          return null;
                        }
                        const accepted =
                          smartReferenceResult.acceptedNodeIds.includes(nodeId);
                        return (
                          <div className="smart-reference-candidate" key={nodeId}>
                            <div>
                              <strong>
                                {nodeFilterLabel(
                                  node,
                                  t("nodes.unnamed"),
                                  t("nodes.noContent"),
                                )}
                              </strong>
                              <span>{t("smartReference.llm.selectedByModel")}</span>
                            </div>
                            <button
                              className="secondary-button"
                              disabled={accepted}
                              onClick={() => void acceptSmartReference(nodeId)}
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
                </section>
              )}
              {smartReferenceResult.llmEnabled &&
                smartReferenceResult.llmUncertainNodeIds.length > 0 && (
                  <section className="smart-reference-result-section">
                    <h3>{t("smartReference.llm.uncertainTitle")}</h3>
                    <p>{t("smartReference.llm.uncertainDescription")}</p>
                    <div className="smart-reference-results">
                      {smartReferenceResult.llmUncertainNodeIds.map((nodeId) => {
                        const node = workspace.nodes.find(
                          (candidate) => candidate.id === nodeId,
                        );
                        if (node === undefined) {
                          return null;
                        }
                        const accepted =
                          smartReferenceResult.acceptedNodeIds.includes(nodeId);
                        return (
                          <div className="smart-reference-candidate" key={nodeId}>
                            <div>
                              <strong>
                                {nodeFilterLabel(
                                  node,
                                  t("nodes.unnamed"),
                                  t("nodes.noContent"),
                                )}
                              </strong>
                              <span>{t("smartReference.llm.uncertainByModel")}</span>
                            </div>
                            <button
                              className="secondary-button"
                              disabled={accepted}
                              onClick={() => void acceptSmartReference(nodeId)}
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
                  </section>
                )}
              <section className="smart-reference-result-section">
                <h3>
                  {t(
                    smartReferenceResult.llmEnabled
                      ? "smartReference.llm.baseCandidatesTitle"
                      : "smartReference.recommendationsTitle",
                  )}
                </h3>
                <p>
                  {t(
                    smartReferenceResult.llmEnabled
                      ? "smartReference.llm.baseCandidatesDescription"
                      : "smartReference.recommendationsDescription",
                  )}
                </p>
                {smartReferenceResult.candidates.length === 0 ? (
                  <p className="smart-reference-section-empty">
                    {t("smartReference.empty")}
                  </p>
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
                              {t("smartReference.recommendationScore", {
                                score: candidate.score.toFixed(3),
                                count: candidate.supportingNodeIds.length,
                              })}
                            </span>
                          </div>
                          <button
                            className="secondary-button"
                            disabled={accepted}
                            onClick={() => void acceptSmartReference(candidate.nodeId)}
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
              </section>
              <section className="smart-reference-result-section">
                <h3>{t("smartReference.relatedTitle")}</h3>
                <p>{t("smartReference.relatedDescription")}</p>
                {smartReferenceResult.relatedNodes.length === 0 ? (
                  <p className="smart-reference-section-empty">
                    {t("smartReference.relatedEmpty")}
                  </p>
                ) : (
                  <div className="smart-reference-results smart-reference-related-results">
                    {smartReferenceResult.relatedNodes.slice(0, 8).map((related) => {
                      const relatedNode = workspace.nodes.find(
                        (node) => node.id === related.nodeId,
                      );
                      if (relatedNode === undefined) {
                        return null;
                      }
                      return (
                        <div className="smart-reference-candidate" key={related.nodeId}>
                          <div>
                            <strong>
                              {nodeFilterLabel(
                                relatedNode,
                                t("nodes.unnamed"),
                                t("nodes.noContent"),
                              )}
                            </strong>
                            <span>
                              {t("smartReference.similarity", {
                                score: related.similarity.toFixed(3),
                              })}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {smartReferenceResult.relatedNodes.length > 8 && (
                  <p className="smart-reference-limit">
                    {t("smartReference.relatedLimit", {
                      count: smartReferenceResult.relatedNodes.length,
                    })}
                  </p>
                )}
              </section>
            </div>
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

      {documentImportOpen && (
        <DocumentImportDialog
          busy={documentImportBusy}
          draft={documentImportDraft}
          error={documentImportError}
          labels={{
            title: t("documentImport.title"),
            description: t("documentImport.description"),
            sourceName: t("documentImport.sourceName"),
            sourceNamePlaceholder: t("documentImport.sourceNamePlaceholder"),
            sourceText: t("documentImport.sourceText"),
            sourceTextPlaceholder: t("documentImport.sourceTextPlaceholder"),
            chooseFile: t("documentImport.chooseFile"),
            chooseExternalDraft: t("documentImport.chooseExternalDraft"),
            loadingExternalDraft: t("documentImport.loadingExternalDraft"),
            analyze: t("documentImport.analyze"),
            analyzing: t("documentImport.analyzing"),
            cancel: t("actions.cancel"),
            close: t("actions.close"),
            draftTitle: t("documentImport.draftTitle"),
            draftDescription: t("documentImport.draftDescription"),
            draftLoaded: (source, count, selected) =>
              t("documentImport.draftLoaded", { source, count, selected }),
            preview: t("documentImport.preview"),
            selectedCount: (count) => t("documentImport.selectedCount", { count }),
            existingMatch: t("documentImport.existingMatch"),
            newNode: t("documentImport.newNode"),
            existingReadOnly: t("documentImport.existingReadOnly"),
            content: t("editor.content"),
            references: t("references.list"),
            referencesPlaceholder: t("documentImport.referencesPlaceholder"),
            noCandidates: t("documentImport.noCandidates"),
          }}
          onAnalyze={() => void analyzeDocumentImport()}
          onCancel={() => {
            discardDocumentImport();
          }}
          onChooseFile={() => void chooseDocumentImportFile()}
          onChooseExternalDraft={() => void chooseExternalDocumentImportDraft()}
          onPreview={previewDocumentImport}
          onSourceNameChange={setDocumentImportSourceName}
          onSourceTextChange={setDocumentImportSourceText}
          onUpdateCandidate={updateDocumentImportCandidate}
          loadingExternalDraft={documentImportExternalLoading}
          progress={documentImportProgress}
          sourceName={documentImportSourceName}
          sourceText={documentImportSourceText}
        />
      )}

      {securityDialog !== null && (
        <div className="modal-backdrop" role="presentation">
          <section
            aria-labelledby="workspace-security-dialog-title"
            aria-modal="true"
            className="confirmation-dialog security-dialog"
            role="dialog"
          >
            <h2 id="workspace-security-dialog-title">
              {securityDialog === "enable"
                ? t("security.enableTitle")
                : securityDialog === "change"
                  ? t("security.changeTitle")
                  : securityDialog === "rotate"
                    ? t("security.rotateTitle")
                    : securityDialog === "backupTarget"
                      ? pendingBackupTarget?.targetId === null
                        ? t("offsiteBackup.reauthenticateTitle")
                        : t("offsiteBackup.reauthenticateEditTitle")
                    : securityDialog === "offsiteSensitive"
                      ? pendingOffsiteSensitiveAction?.kind === "deleteSnapshot"
                        ? t("offsiteBackup.deleteSnapshotTitle")
                        : pendingOffsiteSensitiveAction?.kind === "removeTarget"
                          ? t("offsiteBackup.removeTargetTitle")
                        : pendingOffsiteSensitiveAction?.kind === "destroyTarget"
                          ? t("offsiteBackup.destroyTargetTitle")
                          : t("offsiteBackup.retentionTitle")
                    : t("security.exportTitle")}
            </h2>
            <p>
              {securityDialog === "enable"
                ? t("security.enableWarning")
                : securityDialog === "change"
                  ? t("security.changeDescription")
                  : securityDialog === "rotate"
                    ? t("security.rotateDescription")
                    : securityDialog === "backupTarget"
                      ? pendingBackupTarget?.targetId === null
                        ? t("offsiteBackup.reauthenticateDescription")
                        : t("offsiteBackup.reauthenticateEditDescription")
                    : securityDialog === "offsiteSensitive"
                      ? pendingOffsiteSensitiveAction?.kind === "deleteSnapshot"
                        ? t("offsiteBackup.deleteSnapshotDescription", {
                            time: formatBackupDate(
                              pendingOffsiteSensitiveAction.createdAtMs,
                              activeLanguage,
                            ),
                          })
                        : pendingOffsiteSensitiveAction?.kind === "removeTarget"
                          ? t("offsiteBackup.removeTargetDescription", {
                              name: pendingOffsiteSensitiveAction.targetName,
                            })
                          : pendingOffsiteSensitiveAction?.kind === "destroyTarget"
                            ? t("offsiteBackup.destroyTargetDescription", {
                                name: pendingOffsiteSensitiveAction.targetName,
                              })
                            : t("offsiteBackup.retentionDescriptionConfirm", {
                                count:
                                  pendingOffsiteSensitiveAction?.kind === "retention"
                                    ? pendingOffsiteSensitiveAction.maxSnapshots
                                    : 0,
                                days:
                                  pendingOffsiteSensitiveAction?.kind === "retention"
                                    ? pendingOffsiteSensitiveAction.maxAgeDays
                                    : 0,
                              })
                    : securityDialog === "exportUnreadable"
                    ? t("security.exportUnreadableDescription")
                    : t("security.exportDescription")}
            </p>
            <form
              className="security-dialog-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submitSecurityDialog();
              }}
            >
              {securityDialog !== "enable" && (
                <>
                  <label htmlFor="workspace-security-current-password">
                    {t("security.currentPassword")}
                  </label>
                  <input
                    autoComplete="current-password"
                    autoFocus
                    id="workspace-security-current-password"
                    onChange={(event) =>
                      setSecurityCurrentPassword(event.target.value)
                    }
                    type="password"
                    value={securityCurrentPassword}
                  />
                </>
              )}
              {securityDialog !== "export" &&
                securityDialog !== "exportUnreadable" &&
                securityDialog !== "backupTarget" &&
                securityDialog !== "offsiteSensitive" && (
                <>
                  <label htmlFor="workspace-security-password">
                    {securityDialog === "rotate"
                      ? t("security.rotatePassword")
                      : t("security.newPassword")}
                  </label>
                  <input
                    autoComplete="new-password"
                    autoFocus={securityDialog === "enable"}
                    id="workspace-security-password"
                    onChange={(event) => setSecurityPassword(event.target.value)}
                    type="password"
                    value={securityPassword}
                  />
                  <label htmlFor="workspace-security-password-confirmation">
                    {t("security.confirmPassword")}
                  </label>
                  <input
                    autoComplete="new-password"
                    id="workspace-security-password-confirmation"
                    onChange={(event) =>
                      setSecurityPasswordConfirmation(event.target.value)
                    }
                    type="password"
                    value={securityPasswordConfirmation}
                  />
                </>
              )}
              {securityDialog === "offsiteSensitive" &&
                pendingOffsiteSensitiveAction?.kind === "destroyTarget" && (
                  <>
                    <label htmlFor="offsite-target-confirmation-name">
                      {t("offsiteBackup.destroyTargetConfirmation", {
                        name: pendingOffsiteSensitiveAction.targetName,
                      })}
                    </label>
                    <input
                      autoComplete="off"
                      id="offsite-target-confirmation-name"
                      onChange={(event) =>
                        setOffsiteConfirmationName(event.target.value)
                      }
                      value={offsiteConfirmationName}
                    />
                  </>
                )}
              {securityMessage !== null && (
                <p className="security-error" role="alert">
                  {securityMessage}
                </p>
              )}
              <div className="confirmation-dialog-actions">
                <button
                  className="secondary-button"
                  disabled={securityBusy}
                  onClick={closeSecurityDialog}
                  type="button"
                >
                  {t("actions.cancel")}
                </button>
                <button
                  className="primary-button"
                  disabled={
                    securityBusy ||
                    (securityDialog !== "enable" &&
                      securityCurrentPassword.length === 0) ||
                    (securityDialog === "offsiteSensitive" &&
                      pendingOffsiteSensitiveAction?.kind === "destroyTarget" &&
                      offsiteConfirmationName !==
                        pendingOffsiteSensitiveAction.targetName)
                  }
                  type="submit"
                >
                  {securityBusy
                    ? t("security.processing")
                    : securityDialog === "enable"
                      ? t("security.enable")
                      : securityDialog === "change"
                        ? t("security.changePassword")
                        : securityDialog === "rotate"
                          ? t("security.rotateConfirm")
                          : securityDialog === "backupTarget"
                            ? pendingBackupTarget?.targetId === null
                              ? t("offsiteBackup.connect")
                              : t("offsiteBackup.saveTargetChanges")
                          : securityDialog === "offsiteSensitive"
                            ? pendingOffsiteSensitiveAction?.kind === "deleteSnapshot"
                              ? t("offsiteBackup.deleteSnapshot")
                              : pendingOffsiteSensitiveAction?.kind === "removeTarget"
                                ? t("offsiteBackup.removeTarget")
                                : pendingOffsiteSensitiveAction?.kind === "destroyTarget"
                                  ? t("offsiteBackup.destroyTargetConfirm")
                                  : t("offsiteBackup.retentionConfirm")
                        : t("backup.export")}
                </button>
              </div>
              {securityDialog !== "enable" &&
                workspaceSecurityStatus.systemUnlockAvailable &&
                workspaceSecurityStatus.systemUnlockEnabled && (
                  <button
                    className="secondary-button security-system-reauth-button"
                    disabled={securityBusy}
                    onClick={() => void submitSecurityDialog("system")}
                    type="button"
                  >
                    <Fingerprint aria-hidden="true" size={15} />
                    {t("security.useSystemVerification")}
                  </button>
                )}
            </form>
          </section>
        </div>
      )}

      {recoveryClearDialog && (
        <div className="modal-backdrop" role="presentation">
          <section
            aria-labelledby="clear-recovery-dialog-title"
            aria-modal="true"
            className="confirmation-dialog security-dialog"
            role="dialog"
          >
            <h2 id="clear-recovery-dialog-title">
              {t("security.clearRecoveryTitle")}
            </h2>
            <p>{t("security.clearRecoveryDescription")}</p>
            <form
              className="security-dialog-form"
              onSubmit={(event) => {
                event.preventDefault();
                void clearRecoveryData();
              }}
            >
              <label htmlFor="clear-recovery-password">
                {t("security.currentPassword")}
              </label>
              <input
                autoComplete="current-password"
                autoFocus
                id="clear-recovery-password"
                onChange={(event) => setRecoveryClearPassword(event.target.value)}
                type="password"
                value={recoveryClearPassword}
              />
              {securityMessage !== null && (
                <p className="security-error" role="alert">
                  {securityMessage}
                </p>
              )}
              <div className="confirmation-dialog-actions">
                <button
                  className="secondary-button"
                  disabled={securityBusy}
                  onClick={() => setRecoveryClearDialog(false)}
                  type="button"
                >
                  {t("actions.cancel")}
                </button>
                <button
                  className="danger-button"
                  disabled={securityBusy || recoveryClearPassword.length === 0}
                  type="submit"
                >
                  {t("security.clearRecoveryConfirm")}
                </button>
              </div>
              {workspaceSecurityStatus.systemUnlockAvailable &&
                workspaceSecurityStatus.systemUnlockEnabled && (
                  <button
                    className="secondary-button security-system-reauth-button"
                    disabled={securityBusy}
                    onClick={() => void clearRecoveryData("system")}
                    type="button"
                  >
                    <Fingerprint aria-hidden="true" size={15} />
                    {t("security.useSystemVerification")}
                  </button>
                )}
            </form>
          </section>
        </div>
      )}

      {destroyWorkspaceDialog && (
        <div className="modal-backdrop" role="presentation">
          <section
            aria-labelledby="destroy-workspace-dialog-title"
            aria-modal="true"
            className="confirmation-dialog security-dialog"
            role="dialog"
          >
            <h2 id="destroy-workspace-dialog-title">
              {t("security.destroyTitle")}
            </h2>
            <p>{t("security.destroyDescription")}</p>
            <form
              className="security-dialog-form"
              onSubmit={(event) => {
                event.preventDefault();
                void destroyEncryptedWorkspace();
              }}
            >
              <label htmlFor="destroy-workspace-password">
                {t("security.currentPassword")}
              </label>
              <input
                autoComplete="current-password"
                autoFocus
                id="destroy-workspace-password"
                onChange={(event) => setDestroyWorkspacePassword(event.target.value)}
                type="password"
                value={destroyWorkspacePassword}
              />
              <label htmlFor="destroy-workspace-confirmation">
                {t("security.destroyConfirmationLabel", {
                  phrase: t("security.destroyConfirmationPhrase"),
                })}
              </label>
              <input
                autoComplete="off"
                id="destroy-workspace-confirmation"
                onChange={(event) =>
                  setDestroyWorkspaceConfirmation(event.target.value)
                }
                value={destroyWorkspaceConfirmation}
              />
              {securityMessage !== null && (
                <p className="security-error" role="alert">
                  {securityMessage}
                </p>
              )}
              <div className="confirmation-dialog-actions">
                <button
                  className="secondary-button"
                  disabled={securityBusy}
                  onClick={() => setDestroyWorkspaceDialog(false)}
                  type="button"
                >
                  {t("actions.cancel")}
                </button>
                <button
                  className="danger-button"
                  disabled={
                    securityBusy ||
                    destroyWorkspacePassword.length === 0 ||
                    destroyWorkspaceConfirmation !==
                      t("security.destroyConfirmationPhrase")
                  }
                  type="submit"
                >
                  {t("security.destroyConfirm")}
                </button>
              </div>
              {workspaceSecurityStatus.systemUnlockAvailable &&
                workspaceSecurityStatus.systemUnlockEnabled && (
                  <button
                    className="secondary-button security-system-reauth-button"
                    disabled={
                      securityBusy ||
                      destroyWorkspaceConfirmation !==
                        t("security.destroyConfirmationPhrase")
                    }
                    onClick={() => void destroyEncryptedWorkspace("system")}
                    type="button"
                  >
                    <Fingerprint aria-hidden="true" size={15} />
                    {t("security.useSystemVerification")}
                  </button>
                )}
            </form>
          </section>
        </div>
      )}

      {pendingEncryptedImport !== null && (
        <div className="modal-backdrop" role="presentation">
          <section
            aria-labelledby="encrypted-import-dialog-title"
            aria-modal="true"
            className="confirmation-dialog security-dialog"
            role="dialog"
          >
            <h2 id="encrypted-import-dialog-title">
              {t("backup.encryptedImportTitle")}
            </h2>
            <p>
              {t("backup.encryptedImportDescription", {
                name: pendingEncryptedImport.name,
              })}
            </p>
            <form
              className="security-dialog-form"
              onSubmit={(event) => {
                event.preventDefault();
                void decryptPendingWorkspaceImport();
              }}
            >
              <label htmlFor="encrypted-import-password">
                {t("security.password")}
              </label>
              <input
                autoComplete="current-password"
                autoFocus
                id="encrypted-import-password"
                onChange={(event) => setEncryptedImportPassword(event.target.value)}
                type="password"
                value={encryptedImportPassword}
              />
              {encryptedImportError !== null && (
                <p className="security-error" role="alert">
                  {encryptedImportError}
                </p>
              )}
              <div className="confirmation-dialog-actions">
                <button
                  className="secondary-button"
                  disabled={encryptedImportBusy}
                  onClick={() => {
                    setPendingEncryptedImport(null);
                    setEncryptedImportPassword("");
                    setEncryptedImportError(null);
                  }}
                  type="button"
                >
                  {t("actions.cancel")}
                </button>
                <button
                  className="primary-button"
                  disabled={
                    encryptedImportBusy || encryptedImportPassword.length === 0
                  }
                  type="submit"
                >
                  {encryptedImportBusy
                    ? t("security.unlocking")
                    : t("backup.decryptImport")}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {offsiteRestoreDrill !== null && (
        <div className="modal-backdrop" role="presentation">
          <section
            aria-labelledby="offsite-restore-drill-dialog-title"
            aria-modal="true"
            className="confirmation-dialog security-dialog"
            role="dialog"
          >
            <h2 id="offsite-restore-drill-dialog-title">
              {offsiteRestoreDrillSucceeded
                ? t("offsiteBackup.restoreDrillSuccessTitle")
                : t("offsiteBackup.restoreDrillTitle")}
            </h2>
            {offsiteRestoreDrillSucceeded ? (
              <>
                <p className="security-notice" role="status">
                  {t("offsiteBackup.restoreDrillSuccess")}
                </p>
                <div className="confirmation-dialog-actions">
                  <button
                    autoFocus
                    className="primary-button"
                    onClick={closeOffsiteRestoreDrill}
                    type="button"
                  >
                    {t("actions.close")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>
                  {t("offsiteBackup.restoreDrillDescription", {
                    time: formatBackupDate(
                      offsiteRestoreDrill.createdAtMs,
                      activeLanguage,
                    ),
                  })}
                </p>
                <form
                  className="security-dialog-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void runOffsiteRestoreDrill();
                  }}
                >
                  <label htmlFor="offsite-restore-drill-password">
                    {t("security.password")}
                  </label>
                  <input
                    autoComplete="current-password"
                    autoFocus
                    id="offsite-restore-drill-password"
                    onChange={(event) =>
                      setOffsiteRestoreDrillPassword(event.target.value)
                    }
                    type="password"
                    value={offsiteRestoreDrillPassword}
                  />
                  {offsiteRestoreDrillError !== null && (
                    <p className="security-error" role="alert">
                      {offsiteRestoreDrillError}
                    </p>
                  )}
                  <div className="confirmation-dialog-actions">
                    <button
                      className="secondary-button"
                      disabled={offsiteBusy}
                      onClick={closeOffsiteRestoreDrill}
                      type="button"
                    >
                      {t("actions.cancel")}
                    </button>
                    <button
                      className="primary-button"
                      disabled={
                        offsiteBusy || offsiteRestoreDrillPassword.length === 0
                      }
                      type="submit"
                    >
                      {offsiteBusy
                        ? t("offsiteBackup.restoreDrillRunning")
                        : t("offsiteBackup.restoreDrillConfirm")}
                    </button>
                  </div>
                </form>
              </>
            )}
          </section>
        </div>
      )}

      {appNotice !== null && (
        <div className="app-status-toast" role="status">
          <span>{appNotice.message}</span>
          {appNotice.action !== undefined && (
            <button
              className="app-status-action"
              data-testid="app-notice-action"
              onClick={() => {
                const action = appNotice.action;
                dismissAppNotice();
                action?.run();
              }}
              type="button"
            >
              {appNotice.action.label}
            </button>
          )}
          <button
            aria-label={t("actions.close")}
            className="app-status-close"
            onClick={dismissAppNotice}
            type="button"
          >
            <X aria-hidden="true" size={15} />
          </button>
        </div>
      )}

    </div>
  );
}

export default App;
