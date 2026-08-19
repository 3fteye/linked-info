import { useMemo } from "react";
import Prism from "prismjs";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-json";
import "prismjs/components/prism-powershell";
import "prismjs/components/prism-python";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-yaml";
import type { CodePreviewLanguage } from "./codePreviewLanguages";

const maximumRenderedCodeCharacters = 20_000;
const maximumRenderedCodeLines = 500;

interface CodeSegment {
  classNames: string[];
  text: string;
}

export interface CodePreviewLabels {
  copy: string;
  truncated: string;
}

interface CodePreviewProps {
  labels: CodePreviewLabels;
  language: CodePreviewLanguage;
  languageLabel: string;
  onCopy?: () => void;
  source: string;
  sourceTruncated?: boolean;
}

export function boundedCodePreviewSource(source: string): {
  source: string;
  truncated: boolean;
} {
  let end = Math.min(source.length, maximumRenderedCodeCharacters);
  let newlineCount = 0;
  for (let index = 0; index < end; index += 1) {
    if (source[index] === "\n") {
      newlineCount += 1;
      if (newlineCount >= maximumRenderedCodeLines) {
        end = index;
        break;
      }
    }
  }
  return end < source.length
    ? { source: `${source.slice(0, end)}…`, truncated: true }
    : { source, truncated: false };
}

function tokenClassNames(token: Prism.Token): string[] {
  const aliases = Array.isArray(token.alias)
    ? token.alias
    : typeof token.alias === "string"
      ? [token.alias]
      : [];
  return ["token", token.type, ...aliases];
}

function flattenTokenStream(
  stream: Prism.TokenStream,
  inheritedClassNames: string[] = [],
): CodeSegment[] {
  if (typeof stream === "string") {
    return stream.length === 0
      ? []
      : [{ classNames: inheritedClassNames, text: stream }];
  }
  if (Array.isArray(stream)) {
    return stream.flatMap((token) =>
      flattenTokenStream(token, inheritedClassNames),
    );
  }
  return flattenTokenStream(stream.content, [
    ...inheritedClassNames,
    ...tokenClassNames(stream),
  ]);
}

export function codePreviewLines(
  source: string,
  language: CodePreviewLanguage,
): CodeSegment[][] {
  const grammar = Prism.languages[language];
  const segments =
    grammar !== undefined
      ? flattenTokenStream(Prism.tokenize(source, grammar))
      : [{ classNames: [], text: source }];
  const lines: CodeSegment[][] = [[]];
  for (const segment of segments) {
    const pieces = segment.text.split("\n");
    for (const [index, piece] of pieces.entries()) {
      if (piece.length > 0) {
        lines[lines.length - 1].push({ ...segment, text: piece });
      }
      if (index < pieces.length - 1) {
        lines.push([]);
      }
    }
  }
  return lines;
}

export function CodePreview({
  labels,
  language,
  languageLabel,
  onCopy,
  source,
  sourceTruncated = false,
}: CodePreviewProps) {
  const bounded = useMemo(() => boundedCodePreviewSource(source), [source]);
  const lines = useMemo(
    () => codePreviewLines(bounded.source, language),
    [bounded.source, language],
  );
  const truncated = sourceTruncated || bounded.truncated;

  return (
    <section
      className="code-preview"
      data-truncated={truncated}
      data-language={language}
    >
      <header className="code-preview-toolbar">
        <span>{languageLabel}</span>
        {onCopy !== undefined && (
          <button
            className="nodrag nowheel code-preview-copy"
            onClick={(event) => {
              event.stopPropagation();
              onCopy();
            }}
            onPointerDown={(event) => event.stopPropagation()}
            type="button"
          >
            {labels.copy}
          </button>
        )}
      </header>
      <pre className="code-preview-scroll">
        <code>
          {lines.map((line, lineIndex) => (
            <span className="code-preview-line" key={lineIndex}>
              <span aria-hidden="true" className="code-preview-line-number">
                {lineIndex + 1}
              </span>
              <span className="code-preview-line-content">
                {line.length === 0
                  ? "\u200b"
                  : line.map((segment, segmentIndex) => (
                      <span
                        className={segment.classNames.join(" ") || undefined}
                        key={segmentIndex}
                      >
                        {segment.text}
                      </span>
                    ))}
              </span>
            </span>
          ))}
        </code>
      </pre>
      {truncated && (
        <footer className="code-preview-truncated">{labels.truncated}</footer>
      )}
    </section>
  );
}
