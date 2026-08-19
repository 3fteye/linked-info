import { Fragment, lazy, Suspense, type ReactNode } from "react";
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
import {
  type BuiltInExtensionMetadataInput,
} from "./builtinExtensionHost";
import { builtInExtensionHost } from "./builtinExtensions";
import { ExtensionPresentationHost } from "./extensionPresentation";
import type { ExtensionMetadataPayload } from "./workspaceData";

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
    resolve: (key: string) => string | null;
  };
  secret: SecretContentLabels;
  totp: TotpContentLabels;
}

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
  nodeName?: string | null;
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

export function NodeContentHost({
  canvasPreviewEnabled = true,
  className,
  content,
  codeSourceContainsSensitive,
  emptyContent = null,
  enhancementLabels,
  extensionMetadata = null,
  hideWhenEmpty = false,
  onCopyCodeSource,
  onCopySecret,
  onExtensionMetadataChange,
  nodeName = null,
  processorId,
  sourceTruncated = false,
  variant,
}: NodeContentHostProps) {
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
        { content, name: nodeName },
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
              variant === "list" || onExtensionMetadataChange === undefined
                ? undefined
                : (actionId, inputValue) => {
                    let actionResult;
                    try {
                      actionResult = builtInExtensionHost.invokeAction(
                        result.extensionId,
                        actionId,
                        { content, name: nodeName },
                        extensionMetadata,
                        inputValue,
                      );
                    } catch {
                      return;
                    }
                    if (
                      actionResult.nodeMetadata !== null ||
                      actionResult.workspaceMetadata !== null
                    ) {
                      onExtensionMetadataChange(
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
