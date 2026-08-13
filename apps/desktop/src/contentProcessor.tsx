import type { ReactNode } from "react";

export interface ContentPresentation {
  kind: "text";
  text: string | null;
}

export interface ContentProcessor {
  readonly id: string;
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
}

export const textContentProcessor: ContentProcessor = {
  id: "text",
  present(content) {
    return { kind: "text", text: content };
  },
};

export const contentProcessorRegistry = new ContentProcessorRegistry([
  textContentProcessor,
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
  const presentedText =
    variant === "canvas" ? canvasContentPreview(presentation.text) : presentation.text;
  const rendered = presentedText || emptyContent;
  if (hideWhenEmpty && (presentation.text === null || presentation.text.length === 0)) {
    return null;
  }
  const sharedProps = {
    className,
    "data-content-processor": resolved.processor.id,
    "data-content-processor-supported": resolved.supported,
    "data-requested-content-processor": resolved.requestedId ?? undefined,
  };
  return variant === "canvas" ? (
    <p {...sharedProps}>{rendered}</p>
  ) : (
    <span {...sharedProps}>{rendered}</span>
  );
}
