import { parseTotpDirectiveLine, type TotpDirective } from "./totp";

export type EnhancedContentSegment =
  | { kind: "text"; text: string }
  | { directive: TotpDirective; kind: "totp" };

export interface ContentEnhancer {
  readonly id: string;
  matchLine(line: string): EnhancedContentSegment | null;
}

interface MarkdownFence {
  character: "`" | "~";
  length: number;
}

function openingMarkdownFence(line: string): MarkdownFence | null {
  const match = /^\s{0,3}(`{3,}|~{3,})/u.exec(line);
  if (match === null) {
    return null;
  }
  return {
    character: match[1][0] as "`" | "~",
    length: match[1].length,
  };
}

function closesMarkdownFence(line: string, fence: MarkdownFence): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length >= fence.length &&
    [...trimmed].every((character) => character === fence.character)
  );
}

export class ContentEnhancerRegistry {
  constructor(private readonly enhancers: readonly ContentEnhancer[]) {
    const ids = new Set<string>();
    for (const enhancer of enhancers) {
      if (ids.has(enhancer.id)) {
        throw new Error(`duplicate content enhancer id: ${enhancer.id}`);
      }
      ids.add(enhancer.id);
    }
  }

  segment(source: string, markdown: boolean): EnhancedContentSegment[] {
    const segments: EnhancedContentSegment[] = [];
    const textLines: string[] = [];
    let fence: MarkdownFence | null = null;

    const flushText = () => {
      if (textLines.length === 0) {
        return;
      }
      segments.push({ kind: "text", text: textLines.join("\n") });
      textLines.length = 0;
    };

    for (const line of source.split(/\r?\n/u)) {
      if (markdown && fence !== null) {
        textLines.push(line);
        if (closesMarkdownFence(line, fence)) {
          fence = null;
        }
        continue;
      }
      if (markdown) {
        const opening = openingMarkdownFence(line);
        if (opening !== null) {
          fence = opening;
          textLines.push(line);
          continue;
        }
      }
      const enhanced = this.enhancers
        .map((enhancer) => enhancer.matchLine(line))
        .find((candidate): candidate is EnhancedContentSegment => candidate !== null);
      if (enhanced === undefined) {
        textLines.push(line);
        continue;
      }
      flushText();
      segments.push(enhanced);
    }
    flushText();
    return segments;
  }
}

export const totpContentEnhancer: ContentEnhancer = {
  id: "totp-line",
  matchLine(line) {
    const directive = parseTotpDirectiveLine(line);
    return directive === null ? null : { directive, kind: "totp" };
  },
};

export const contentEnhancerRegistry = new ContentEnhancerRegistry([
  totpContentEnhancer,
]);

export function contentForSemanticAnalysis(content: string | null): string | null {
  if (content === null) {
    return null;
  }
  const text = contentEnhancerRegistry
    .segment(content, false)
    .filter((segment): segment is Extract<EnhancedContentSegment, { kind: "text" }> =>
      segment.kind === "text",
    )
    .map((segment) => segment.text)
    .join("\n")
    .trim();
  return text.length === 0 ? null : text;
}
