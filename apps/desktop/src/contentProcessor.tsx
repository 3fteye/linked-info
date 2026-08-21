import {
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import {
  codeContentProcessorId,
  codePreviewLanguages,
  type CodePreviewLanguage,
} from "./codePreviewLanguages";
import {
  contentEnhancerRegistry,
  type EnhancedContentSegment,
} from "./contentEnhancer";
import {
  contentMarkerPresentationRegistry,
  missingContentMarkerPresentation,
} from "./contentMarkerPresentation";
import { contentMarkerRegistry } from "./contentMarker";
import {
  maskedTotpLine,
  TotpContentLine,
  type TotpContentLabels,
} from "./totpContent";
import type { SecretContentLabels } from "./secretContent";
import type {
  BuiltInExtensionActionHostResult,
  BuiltInExtensionMetadataInput,
  BuiltInExtensionRenderResult,
  ExtensionPresentationV1,
} from "./builtinExtensionHost";
import { builtInExtensionHost } from "./builtinExtensions";
import { ExtensionPresentationHost } from "./extensionPresentation";
import type { ExtensionMetadataPayload } from "./workspaceData";
import {
  managedExtensionRegistry,
  renderManagedExtensionProcessor,
  type ManagedExtensionProcessorRegistration,
} from "./managedExtensions";

const LazyCodePreview = lazy(async () => {
  const module = await import("./codePreview");
  return { default: module.CodePreview };
});

export type ContentPresentation =
  | { kind: "text"; text: string | null }
  | { kind: "markdown"; source: string | null }
  | { kind: "code"; language: CodePreviewLanguage; source: string | null };

export interface LegacyContentProcessor {
  readonly kind: "legacy";
  readonly id: string;
  readonly version: number;
  present(content: string | null): ContentPresentation;
}

export interface ExtensionContentProcessor {
  readonly extensionId: string;
  readonly kind: "extension";
  readonly id: string;
  readonly localId: string;
  readonly presentationKind: "code";
  readonly version: number;
}

export type ContentProcessor = LegacyContentProcessor | ExtensionContentProcessor;

export interface ResolvedContentProcessor {
  processor: ContentProcessor;
  requestedId: string | null;
  supported: boolean;
}

export class ContentProcessorRegistry {
  private readonly processors: ReadonlyMap<string, ContentProcessor>;

  constructor(processors: readonly ContentProcessor[]) {
    const byId = new Map<string, ContentProcessor>();
    for (const processor of processors) {
      if (byId.has(processor.id)) {
        throw new Error(`duplicate content processor id: ${processor.id}`);
      }
      byId.set(processor.id, processor);
    }
    if (!byId.has("text")) {
      throw new Error("the text content processor is required");
    }
    this.processors = byId;
  }

  resolve(requestedId: string | null): ResolvedContentProcessor {
    const processor =
      requestedId === null ? undefined : this.processors.get(requestedId);
    return {
      processor: processor ?? this.processors.get("text")!,
      requestedId,
      supported: requestedId === null || processor !== undefined,
    };
  }

  has(processorId: string): boolean {
    return this.processors.has(processorId);
  }

  list(): readonly ContentProcessor[] {
    return Array.from(this.processors.values());
  }
}

export const textContentProcessor: LegacyContentProcessor = {
  kind: "legacy",
  id: "text",
  version: 1,
  present(content) {
    return { kind: "text", text: content };
  },
};

export const markdownContentProcessor: LegacyContentProcessor = {
  kind: "legacy",
  id: "markdown",
  version: 1,
  present(content) {
    return { kind: "markdown", source: content };
  },
};

export const codeContentProcessors: readonly LegacyContentProcessor[] =
  codePreviewLanguages.map((language) => ({
    kind: "legacy" as const,
    id: codeContentProcessorId(language),
    version: 1,
    present(content: string | null): ContentPresentation {
      return { kind: "code", language, source: content };
    },
  }));

export const builtInExtensionContentProcessors: readonly ContentProcessor[] =
  builtInExtensionHost.listProcessors().map((processor) => ({
    extensionId: processor.extensionId,
    id: processor.id,
    kind: "extension" as const,
    localId: processor.localId,
    presentationKind: "code" as const,
    version: 1,
  }));

export const contentProcessorRegistry = new ContentProcessorRegistry([
  textContentProcessor,
  markdownContentProcessor,
  ...codeContentProcessors,
  ...builtInExtensionContentProcessors,
]);

export function contentProcessorUsesCodePresentation(
  processorId: string | null,
): boolean {
  const processor = contentProcessorRegistry.resolve(processorId).processor;
  return (
    (processor.kind === "legacy" &&
      processor.present(null).kind === "code") ||
    (processor.kind === "extension" && processor.presentationKind === "code")
  );
}

export function contentProcessorExtensionId(
  processorId: string | null,
): string | null {
  const managed = managedExtensionRegistry.processor(processorId);
  if (managed !== null) {
    return managed.extensionId;
  }
  const resolved = contentProcessorRegistry.resolve(processorId);
  return resolved.supported && resolved.processor.kind === "extension"
    ? resolved.processor.extensionId
    : null;
}

export const maximumCanvasContentPreviewCharacters = 600;
export const maximumExpandedCodePreviewCharacters = 20_000;
export const maximumExpandedCodePreviewLines = 500;

export interface ContentEnhancementLabels {
  code: {
    copy: string;
    languages: Record<CodePreviewLanguage, string>;
    truncated: string;
  };
  extension: {
    language: string;
    resolve: (key: string) => string | null;
  };
  secret: SecretContentLabels;
  totp: TotpContentLabels;
}

export type ManagedExtensionActionInvoker = (
  extensionId: string,
  actionId: string,
  nodeId: string,
  metadata: BuiltInExtensionMetadataInput | null,
  inputValue: string | null,
  baseRevision: number,
) => Promise<BuiltInExtensionActionHostResult>;

function boundedCanvasContentPreview(
  text: string | null,
  maximumCharacters: number,
): string | null {
  if (text === null || text.length <= maximumCharacters) {
    return text;
  }
  let preview = "";
  for (const segment of contentMarkerRegistry.segment(text)) {
    const source = segment.kind === "text" ? segment.text : segment.marker.raw;
    const remaining = maximumCharacters - preview.length;
    if (source.length <= remaining) {
      preview += source;
      continue;
    }
    if (
      segment.kind === "marker" &&
      segment.marker.definition?.excludeFromSemanticAnalysis === true
    ) {
      return `${preview}…`;
    }
    return `${preview}${source.slice(0, Math.max(0, remaining))}…`;
  }
  return `${preview.slice(0, maximumCharacters)}…`;
}

export function canvasContentPreview(text: string | null): string | null {
  return boundedCanvasContentPreview(
    text,
    maximumCanvasContentPreviewCharacters,
  );
}

export function canvasExpandedCodeContentPreview(
  text: string | null,
): string | null {
  if (text === null) {
    return null;
  }
  let maximumCharacters = Math.min(
    text.length,
    maximumExpandedCodePreviewCharacters,
  );
  let newlineCount = 0;
  for (let index = 0; index < maximumCharacters; index += 1) {
    if (text[index] === "\n") {
      newlineCount += 1;
      if (newlineCount >= maximumExpandedCodePreviewLines) {
        maximumCharacters = index;
        break;
      }
    }
  }
  return boundedCanvasContentPreview(text, maximumCharacters);
}

interface NodeContentHostProps {
  canvasPreviewEnabled?: boolean;
  className?: string;
  content: string | null;
  emptyContent?: ReactNode;
  enhancementLabels: ContentEnhancementLabels;
  extensionBaseRevision?: number;
  extensionMetadata?: BuiltInExtensionMetadataInput | null;
  hideWhenEmpty?: boolean;
  codeSourceContainsSensitive?: boolean;
  onCopyCodeSource?: (containsSensitive: boolean) => void;
  onCopySecret?: (value: string) => void;
  onExtensionMetadataChange?: (
    extensionId: string,
    schemaVersion: number,
    nodeMetadata: ExtensionMetadataPayload | null,
    workspaceMetadata: ExtensionMetadataPayload | null,
  ) => void;
  onExtensionProposal?: (result: BuiltInExtensionActionHostResult) => void;
  onManagedExtensionAction?: ManagedExtensionActionInvoker;
  nodeId?: string;
  nodeName?: string | null;
  directIncomingNodeIds?: readonly string[];
  directOutgoingNodeIds?: readonly string[];
  processorId: string | null;
  sourceTruncated?: boolean;
  variant: "canvas" | "list";
}

function SafeMarkdown({ source }: { source: string }) {
  return (
    <ReactMarkdown
      components={{
        a: ({ children }) => <span className="markdown-link-text">{children}</span>,
        img: ({ alt }) => (
          <span className="markdown-image-placeholder">
            {alt ? `[${alt}]` : "[image]"}
          </span>
        ),
      }}
      skipHtml
    >
      {source}
    </ReactMarkdown>
  );
}

function listContent(
  segments: readonly EnhancedContentSegment[],
  labels: ContentEnhancementLabels,
): string {
  return segments
    .map((segment) => {
      if (segment.kind === "text") {
        return segment.text;
      }
      if (segment.kind === "totp") {
        return maskedTotpLine(labels.totp);
      }
      return (
        contentMarkerPresentationRegistry.renderList(segment.marker, labels) ??
        missingContentMarkerPresentation(segment.marker)
      );
    })
    .join("");
}

function containsSensitiveSegments(
  segments: readonly EnhancedContentSegment[],
): boolean {
  return segments.some(
    (segment) =>
      segment.kind === "totp" ||
      (segment.kind === "marker" &&
        segment.marker.definition?.excludeFromSemanticAnalysis === true),
  );
}

export function contentContainsSensitive(content: string | null): boolean {
  return (
    content !== null &&
    containsSensitiveSegments(contentEnhancerRegistry.segment(content, false))
  );
}

interface ManagedExtensionContentProps {
  canvasPreviewEnabled: boolean;
  className?: string;
  content: string | null;
  directIncomingNodeIds: readonly string[];
  directOutgoingNodeIds: readonly string[];
  emptyContent: ReactNode;
  enhancementLabels: ContentEnhancementLabels;
  extensionBaseRevision: number;
  extensionMetadata: BuiltInExtensionMetadataInput | null;
  hideWhenEmpty: boolean;
  nodeId: string;
  nodeName: string | null;
  onCopyCodeSource?: (containsSensitive: boolean) => void;
  onCopySecret?: (value: string) => void;
  onExtensionMetadataChange?: (
    extensionId: string,
    schemaVersion: number,
    nodeMetadata: ExtensionMetadataPayload | null,
    workspaceMetadata: ExtensionMetadataPayload | null,
  ) => void;
  onExtensionProposal?: (result: BuiltInExtensionActionHostResult) => void;
  onManagedExtensionAction?: ManagedExtensionActionInvoker;
  registration: ManagedExtensionProcessorRegistration;
  sourceTruncated: boolean;
  variant: "canvas" | "list";
}

function ManagedExtensionContent({
  canvasPreviewEnabled,
  className,
  content,
  directIncomingNodeIds,
  directOutgoingNodeIds,
  emptyContent,
  enhancementLabels,
  extensionBaseRevision,
  extensionMetadata,
  hideWhenEmpty,
  nodeId,
  nodeName,
  onCopyCodeSource,
  onCopySecret,
  onExtensionMetadataChange,
  onExtensionProposal,
  onManagedExtensionAction,
  registration,
  sourceTruncated,
  variant,
}: ManagedExtensionContentProps) {
  const [renderResult, setRenderResult] =
    useState<BuiltInExtensionRenderResult | null>(null);
  const [actionPresentation, setActionPresentation] =
    useState<ExtensionPresentationV1 | null>(null);
  const [failed, setFailed] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const generationRef = useRef(0);
  const node = {
    id: nodeId,
    name: nodeName,
    content,
    directIncomingNodeIds: [...directIncomingNodeIds],
    directOutgoingNodeIds: [...directOutgoingNodeIds],
  };
  const directIncomingKey = directIncomingNodeIds.join("\u0000");
  const directOutgoingKey = directOutgoingNodeIds.join("\u0000");

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    let active = true;
    setRenderResult(null);
    setActionPresentation(null);
    setFailed(false);
    void renderManagedExtensionProcessor(registration, node, extensionMetadata)
      .then((result) => {
        if (active && generationRef.current === generation) setRenderResult(result);
      })
      .catch(() => {
        if (active && generationRef.current === generation) setFailed(true);
      });
    return () => {
      active = false;
      if (generationRef.current === generation) {
        generationRef.current += 1;
      }
    };
  }, [
    content,
    directIncomingKey,
    directOutgoingKey,
    extensionMetadata?.node,
    extensionMetadata?.schemaVersion,
    extensionMetadata?.workspace,
    nodeId,
    nodeName,
    registration,
  ]);

  if (failed || renderResult === null) {
    return (
      <NodeContentHost
        canvasPreviewEnabled={canvasPreviewEnabled}
        className={className}
        content={content}
        emptyContent={emptyContent}
        enhancementLabels={enhancementLabels}
        hideWhenEmpty={hideWhenEmpty}
        codeSourceContainsSensitive={contentContainsSensitive(content)}
        onCopyCodeSource={onCopyCodeSource}
        onCopySecret={onCopySecret}
        nodeId={nodeId}
        nodeName={nodeName}
        processorId="text"
        sourceTruncated={sourceTruncated}
        variant={variant}
      />
    );
  }

  const presentation = actionPresentation ?? renderResult.presentation;
  return (
    <div
      className={[className, "node-content-host", "node-content-extension"]
        .filter(Boolean)
        .join(" ")}
      data-content-processor={registration.fullId}
      data-content-processor-supported="true"
      data-extension-id={registration.extensionId}
    >
      <ExtensionPresentationHost
        actionLabelKey={(actionId) =>
          managedExtensionRegistry.actionLabelKey(
            registration.extensionId,
            actionId,
          )
        }
        labels={{
          code: enhancementLabels.code,
          resolve: (key) =>
            managedExtensionRegistry.resolveLabel(
              registration.extensionId,
              key,
              enhancementLabels.extension.language,
            ) ?? enhancementLabels.extension.resolve(key),
        }}
        onAction={
          variant === "list" ||
          actionBusy ||
          onManagedExtensionAction === undefined ||
          (onExtensionMetadataChange === undefined &&
            onExtensionProposal === undefined)
            ? undefined
            : (actionId, inputValue) => {
                const generation = generationRef.current;
                setActionBusy(true);
                void onManagedExtensionAction(
                  registration.extensionId,
                  actionId,
                  nodeId,
                  extensionMetadata,
                  inputValue,
                  extensionBaseRevision,
                )
                  .then((result) => {
                    if (generationRef.current !== generation) return;
                    if (result.proposal !== null) {
                      onExtensionProposal?.(result);
                    } else if (
                      result.nodeMetadata !== null ||
                      result.workspaceMetadata !== null
                    ) {
                      onExtensionMetadataChange?.(
                        result.extensionId,
                        result.metadataSchemaVersion,
                        result.nodeMetadata,
                        result.workspaceMetadata,
                      );
                    }
                    setActionPresentation(result.presentation);
                  })
                  .catch(() => {
                    if (generationRef.current === generation) setFailed(true);
                  })
                  .finally(() => {
                    if (generationRef.current === generation) setActionBusy(false);
                  });
              }
        }
        presentation={presentation}
        sourceTruncated={sourceTruncated || renderResult.inputTruncated}
        variant={variant}
      />
    </div>
  );
}

export function NodeContentHost({
  canvasPreviewEnabled = true,
  className,
  content,
  codeSourceContainsSensitive,
  emptyContent = null,
  enhancementLabels,
  extensionBaseRevision = 0,
  extensionMetadata = null,
  hideWhenEmpty = false,
  onCopyCodeSource,
  onCopySecret,
  onExtensionMetadataChange,
  onExtensionProposal,
  onManagedExtensionAction,
  nodeId,
  nodeName = null,
  directIncomingNodeIds = [],
  directOutgoingNodeIds = [],
  processorId,
  sourceTruncated = false,
  variant,
}: NodeContentHostProps) {
  const managedProcessor = managedExtensionRegistry.processor(processorId);
  if (managedProcessor !== null && nodeId !== undefined) {
    return (
      <ManagedExtensionContent
        canvasPreviewEnabled={canvasPreviewEnabled}
        className={className}
        content={content}
        directIncomingNodeIds={directIncomingNodeIds}
        directOutgoingNodeIds={directOutgoingNodeIds}
        emptyContent={emptyContent}
        enhancementLabels={enhancementLabels}
        extensionBaseRevision={extensionBaseRevision}
        extensionMetadata={extensionMetadata}
        hideWhenEmpty={hideWhenEmpty}
        nodeId={nodeId}
        nodeName={nodeName}
        onCopyCodeSource={onCopyCodeSource}
        onCopySecret={onCopySecret}
        onExtensionMetadataChange={onExtensionMetadataChange}
        onExtensionProposal={onExtensionProposal}
        onManagedExtensionAction={onManagedExtensionAction}
        registration={managedProcessor}
        sourceTruncated={sourceTruncated}
        variant={variant}
      />
    );
  }
  const resolved = contentProcessorRegistry.resolve(processorId);
  if (resolved.processor.kind === "extension") {
    if (content === null || content.length === 0) {
      if (hideWhenEmpty) {
        return null;
      }
      return variant === "list" ? (
        <span
          className={[className, "node-content-host"]
            .filter(Boolean)
            .join(" ")}
          data-content-processor={resolved.processor.id}
          data-content-processor-supported={resolved.supported}
        >
          {emptyContent}
        </span>
      ) : (
        <p
          className={[className, "node-content-host"]
            .filter(Boolean)
            .join(" ")}
          data-content-processor={resolved.processor.id}
          data-content-processor-supported={resolved.supported}
        >
          {emptyContent}
        </p>
      );
    }
    try {
      const result = builtInExtensionHost.renderProcessor(
        resolved.processor.id,
        { content, hostNodeId: nodeId, name: nodeName },
        extensionMetadata,
      );
      return (
        <div
          className={[className, "node-content-host", "node-content-extension"]
            .filter(Boolean)
            .join(" ")}
          data-content-processor={resolved.processor.id}
          data-content-processor-supported={resolved.supported}
          data-extension-id={result.extensionId}
          data-requested-content-processor={resolved.requestedId ?? undefined}
        >
          <ExtensionPresentationHost
            actionLabelKey={(actionId) =>
              builtInExtensionHost.actionLabelKey(result.extensionId, actionId)
            }
            labels={{
              code: enhancementLabels.code,
              resolve: enhancementLabels.extension.resolve,
            }}
            onAction={
              variant === "list" ||
              (onExtensionMetadataChange === undefined &&
                onExtensionProposal === undefined)
                ? undefined
                : (actionId, inputValue) => {
                    let actionResult;
                    try {
                      actionResult = builtInExtensionHost.invokeAction(
                        result.extensionId,
                        actionId,
                        { content, hostNodeId: nodeId, name: nodeName },
                        extensionMetadata,
                        inputValue,
                        extensionBaseRevision,
                      );
                    } catch {
                      return;
                    }
                    if (actionResult.proposal !== null) {
                      onExtensionProposal?.(actionResult);
                    } else if (
                      actionResult.nodeMetadata !== null ||
                      actionResult.workspaceMetadata !== null
                    ) {
                      onExtensionMetadataChange?.(
                        actionResult.extensionId,
                        actionResult.metadataSchemaVersion,
                        actionResult.nodeMetadata,
                        actionResult.workspaceMetadata,
                      );
                    }
                  }
            }
            presentation={result.presentation}
            sourceTruncated={sourceTruncated || result.inputTruncated}
            variant={variant}
          />
        </div>
      );
    } catch {
      // An extension failure is isolated to this presentation. Plain text remains readable.
    }
  }
  const legacyProcessor =
    resolved.processor.kind === "legacy"
      ? resolved.processor
      : textContentProcessor;
  const presentation = legacyProcessor.present(content);
  const source = presentation.kind === "text" ? presentation.text : presentation.source;
  const presentedText =
    variant === "canvas" && canvasPreviewEnabled
      ? canvasContentPreview(source)
      : source;
  const enhancedSegments =
    presentedText === null || presentedText.length === 0
      ? []
      : contentEnhancerRegistry.segment(
          presentedText,
          presentation.kind === "markdown",
        );
  const hasEnhancements = enhancedSegments.some((segment) => segment.kind !== "text");
  const rendered = presentedText || emptyContent;
  if (hideWhenEmpty && (source === null || source.length === 0)) {
    return null;
  }
  const sharedProps = {
    className: [
      className,
      "node-content-host",
      presentation.kind === "markdown" ? "node-content-markdown" : null,
      presentation.kind === "code" ? "node-content-code" : null,
      hasEnhancements ? "node-content-enhanced" : null,
    ]
      .filter(Boolean)
      .join(" "),
    "data-content-processor": resolved.processor.id,
    "data-content-processor-supported": resolved.supported,
    "data-requested-content-processor": resolved.requestedId ?? undefined,
  };
  if (variant === "list") {
    return (
      <span {...sharedProps}>
        {hasEnhancements ? listContent(enhancedSegments, enhancementLabels) : rendered}
      </span>
    );
  }
  if (presentation.kind === "code" && presentedText) {
    const codeSource = listContent(enhancedSegments, enhancementLabels);
    const containsSensitive =
      codeSourceContainsSensitive ?? contentContainsSensitive(source);
    return (
      <div {...sharedProps}>
        <Suspense
          fallback={
            <pre className="nodrag nowheel code-preview-fallback">
              <code>{codeSource}</code>
            </pre>
          }
        >
          <LazyCodePreview
            labels={{
              copy: enhancementLabels.code.copy,
              truncated: enhancementLabels.code.truncated,
            }}
            language={presentation.language}
            languageLabel={enhancementLabels.code.languages[presentation.language]}
            onCopy={
              onCopyCodeSource === undefined
                ? undefined
                : () => onCopyCodeSource(containsSensitive)
            }
            source={codeSource}
            sourceTruncated={sourceTruncated}
          />
        </Suspense>
      </div>
    );
  }
  if (hasEnhancements) {
    return (
      <div {...sharedProps}>
        {enhancedSegments.map((segment, index) => (
          <Fragment key={index}>
            {segment.kind === "totp" ? (
              <TotpContentLine
                directive={segment.directive}
                labels={enhancementLabels.totp}
                onCopySecret={onCopySecret}
              />
            ) : segment.kind === "marker" ? (
              contentMarkerPresentationRegistry.renderCanvas(segment.marker, {
                labels: enhancementLabels,
                onCopySecret,
              }) ?? missingContentMarkerPresentation(segment.marker)
            ) : presentation.kind === "markdown" ? (
              <SafeMarkdown source={segment.text} />
            ) : (
              <span className="plain-content-segment">{segment.text}</span>
            )}
          </Fragment>
        ))}
      </div>
    );
  }
  if (presentation.kind === "text" || !presentedText) {
    return variant === "canvas" ? (
      <p {...sharedProps}>{rendered}</p>
    ) : (
      <span {...sharedProps}>{rendered}</span>
    );
  }
  return (
    <div {...sharedProps}>
      <SafeMarkdown source={presentedText} />
    </div>
  );
}
