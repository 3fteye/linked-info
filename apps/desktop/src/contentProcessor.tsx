import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";

export type ContentPresentation =
  | { kind: "text"; text: string | null }
  | { kind: "markdown"; source: string | null };

export interface ContentProcessor {
  readonly id: string;
  readonly version: number;
  present(content: string | null): ContentPresentation;
}

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

export const textContentProcessor: ContentProcessor = {
  id: "text",
  version: 1,
  present(content) {
    return { kind: "text", text: content };
  },
};

export const markdownContentProcessor: ContentProcessor = {
  id: "markdown",
  version: 1,
  present(content) {
    return { kind: "markdown", source: content };
  },
};

export const contentProcessorRegistry = new ContentProcessorRegistry([
  textContentProcessor,
  markdownContentProcessor,
]);

export const maximumCanvasContentPreviewCharacters = 600;

export function canvasContentPreview(text: string | null): string | null {
  if (text === null || text.length <= maximumCanvasContentPreviewCharacters) {
    return text;
  }
  return `${text.slice(0, maximumCanvasContentPreviewCharacters)}…`;
}

interface NodeContentHostProps {
  className?: string;
  content: string | null;
  emptyContent?: ReactNode;
  hideWhenEmpty?: boolean;
  processorId: string | null;
  variant: "canvas" | "list";
}

export function NodeContentHost({
  className,
  content,
  emptyContent = null,
  hideWhenEmpty = false,
  processorId,
  variant,
}: NodeContentHostProps) {
  const resolved = contentProcessorRegistry.resolve(processorId);
  const presentation = resolved.processor.present(content);
  const source =
    presentation.kind === "text" ? presentation.text : presentation.source;
  const presentedText = variant === "canvas" ? canvasContentPreview(source) : source;
  const rendered = presentedText || emptyContent;
  if (hideWhenEmpty && (source === null || source.length === 0)) {
    return null;
  }
  const sharedProps = {
    className: [
      className,
      "node-content-host",
      presentation.kind === "markdown" ? "node-content-markdown" : null,
    ]
      .filter(Boolean)
      .join(" "),
    "data-content-processor": resolved.processor.id,
    "data-content-processor-supported": resolved.supported,
    "data-requested-content-processor": resolved.requestedId ?? undefined,
  };
  if (variant === "list" || presentation.kind === "text" || !presentedText) {
    return variant === "canvas" ? (
      <p {...sharedProps}>{rendered}</p>
    ) : (
      <span {...sharedProps}>{rendered}</span>
    );
  }
  return (
    <div {...sharedProps}>
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
        {presentedText}
      </ReactMarkdown>
    </div>
  );
}
