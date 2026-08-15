import {
  contentMarkerRegistry,
  type ContentMarkerRegistry,
  type ParsedContentMarker,
} from "./contentMarker";
import {
  parseTotpDirectiveLine,
  type TotpDirective,
} from "./totp";

export type EnhancedContentSegment =
  | { kind: "text"; text: string }
  | { directive: TotpDirective; kind: "totp" }
  | { kind: "marker"; marker: ParsedContentMarker };

export interface ContentEnhancer {
  readonly excludeFromSemanticAnalysis: boolean;
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
  constructor(
    private readonly enhancers: readonly ContentEnhancer[],
    private readonly markerRegistry: ContentMarkerRegistry = contentMarkerRegistry,
  ) {
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

    const appendText = (text: string) => {
      if (text.length === 0) {
        return;
      }
      const previous = segments[segments.length - 1];
      if (previous?.kind === "text") {
        previous.text += text;
      } else {
        segments.push({ kind: "text", text });
      }
    };

    const appendLegacyText = (text: string) => {
      for (const [lineIndex, line] of text.split(/\r?\n/u).entries()) {
        if (lineIndex > 0) {
          appendText("\n");
        }
        const enhanced = this.enhancers
          .map((enhancer) => enhancer.matchLine(line))
          .find((candidate): candidate is EnhancedContentSegment => candidate !== null);
        if (enhanced === undefined) {
          appendText(line);
        } else {
          segments.push(enhanced);
        }
      }
    };

    const appendUnprotectedText = (text: string) => {
      for (const markerSegment of this.markerRegistry.segment(text)) {
        if (markerSegment.kind === "text") {
          appendLegacyText(markerSegment.text);
          continue;
        }
        if (markerSegment.marker.definition === null) {
          appendText(markerSegment.marker.raw);
        } else {
          segments.push({ kind: "marker", marker: markerSegment.marker });
        }
      }
    };

    if (!markdown) {
      appendUnprotectedText(source);
      return segments;
    }

    let fence: MarkdownFence | null = null;
    let region = "";
    for (const [lineIndex, line] of source.split(/\r?\n/u).entries()) {
      const piece = `${lineIndex > 0 ? "\n" : ""}${line}`;
      if (fence !== null) {
        region += piece;
        if (closesMarkdownFence(line, fence)) {
          appendText(region);
          region = "";
          fence = null;
        }
        continue;
      }
      const opening = openingMarkdownFence(line);
      if (opening === null) {
        region += piece;
        continue;
      }
      appendUnprotectedText(region);
      region = piece;
      fence = opening;
    }
    if (fence === null) {
      appendUnprotectedText(region);
    } else {
      appendText(region);
    }
    return segments;
  }

  semanticText(content: string): string | null {
    const withoutSensitiveMarkers = this.markerRegistry
      .segment(content)
      .map((segment) => {
        if (segment.kind === "text") {
          return segment.text;
        }
        if (segment.marker.definition === null) {
          return segment.marker.raw;
        }
        return segment.marker.definition.excludeFromSemanticAnalysis
          ? ""
          : segment.marker.payload;
      })
      .join("");
    const lines: string[] = [];
    for (const line of withoutSensitiveMarkers.split(/\r?\n/u)) {
      const excludedLegacyLine = this.enhancers.some(
        (enhancer) =>
          enhancer.excludeFromSemanticAnalysis && enhancer.matchLine(line) !== null,
      );
      if (excludedLegacyLine) {
        continue;
      }
      const semanticLine = line.trim();
      if (semanticLine.length > 0) {
        lines.push(semanticLine);
      }
    }
    const text = lines.join("\n").trim();
    return text.length === 0 ? null : text;
  }
}

export const totpContentEnhancer: ContentEnhancer = {
  excludeFromSemanticAnalysis: true,
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
  return contentEnhancerRegistry.semanticText(content);
}
