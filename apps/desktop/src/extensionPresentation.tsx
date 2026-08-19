import { Fragment, lazy, Suspense } from "react";
import type {
  ExtensionPresentationElementV1,
  ExtensionPresentationV1,
} from "./builtinExtensionHost";
import { asCodePreviewLanguage, type CodePreviewLanguage } from "./codePreviewLanguages";

const LazyCodePreview = lazy(async () => {
  const module = await import("./codePreview");
  return { default: module.CodePreview };
});

export interface ExtensionPresentationLabels {
  code: {
    copy: string;
    languages: Record<CodePreviewLanguage, string>;
    truncated: string;
  };
  resolve(key: string): string | null;
}

interface ExtensionPresentationHostProps {
  actionLabelKey: (actionId: string) => string | null;
  labels: ExtensionPresentationLabels;
  onAction?: (actionId: string, inputValue: string | null) => void;
  presentation: ExtensionPresentationV1;
  sourceTruncated?: boolean;
  variant: "canvas" | "list";
}

function listElementText(element: ExtensionPresentationElementV1): string | null {
  switch (element.type) {
    case "text":
    case "badge":
      return element.text;
    case "code":
      return element.source;
    case "key-value":
      return element.items.map((item) => `${item.key}: ${item.value}`).join(" · ");
    case "table":
      return [element.columns.join(" · "), ...element.rows.map((row) => row.join(" · "))]
        .filter((line) => line.length > 0)
        .join(" | ");
    default:
      return null;
  }
}

function CodeElement({
  element,
  labels,
  sourceTruncated,
}: {
  element: Extract<ExtensionPresentationElementV1, { type: "code" }>;
  labels: ExtensionPresentationLabels;
  sourceTruncated: boolean;
}) {
  const language = asCodePreviewLanguage(element.language);
  if (language === null) {
    return (
      <pre className="nodrag nowheel extension-presentation-code-fallback">
        <code>{element.source}</code>
      </pre>
    );
  }
  return (
    <Suspense
      fallback={
        <pre className="nodrag nowheel extension-presentation-code-fallback">
          <code>{element.source}</code>
        </pre>
      }
    >
      <LazyCodePreview
        labels={{ copy: labels.code.copy, truncated: labels.code.truncated }}
        language={language}
        languageLabel={labels.code.languages[language]}
        source={element.source}
        sourceTruncated={sourceTruncated}
      />
    </Suspense>
  );
}

export function ExtensionPresentationHost({
  actionLabelKey,
  labels,
  onAction,
  presentation,
  sourceTruncated = false,
  variant,
}: ExtensionPresentationHostProps) {
  if (variant === "list") {
    const text = presentation.elements
      .map(listElementText)
      .filter((item): item is string => item !== null && item.length > 0)
      .join(" · ");
    return <span>{text}</span>;
  }
  return (
    <div className="extension-presentation">
      {presentation.elements.map((element, index) => {
        switch (element.type) {
          case "text":
            return <p key={index}>{element.text}</p>;
          case "code":
            return (
              <CodeElement
                element={element}
                key={index}
                labels={labels}
                sourceTruncated={sourceTruncated}
              />
            );
          case "key-value":
            return (
              <dl className="extension-presentation-key-values" key={index}>
                {element.items.map((item, itemIndex) => (
                  <Fragment key={itemIndex}>
                    <dt>{item.key}</dt>
                    <dd>{item.value}</dd>
                  </Fragment>
                ))}
              </dl>
            );
          case "table":
            return (
              <div className="nodrag nowheel extension-presentation-table-scroll" key={index}>
                <table>
                  <thead>
                    <tr>
                      {element.columns.map((column, columnIndex) => (
                        <th key={columnIndex}>{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {element.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "badge":
            return (
              <span
                className="extension-presentation-badge"
                data-tone={element.tone}
                key={index}
              >
                {element.text}
              </span>
            );
          case "divider":
            return <hr key={index} />;
          case "button": {
            const labelKey = actionLabelKey(element.actionId);
            if (labelKey === null) {
              return null;
            }
            const label = labels.resolve(labelKey);
            if (label === null) {
              return null;
            }
            return (
              <button
                className="nodrag nowheel extension-presentation-button"
                disabled={onAction === undefined}
                key={index}
                onClick={(event) => {
                  event.stopPropagation();
                  onAction?.(element.actionId, null);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                type="button"
              >
                {label}
              </button>
            );
          }
          case "select": {
            const label = labels.resolve(element.labelKey);
            const options = element.options.map((option) => ({
              ...option,
              label: labels.resolve(option.labelKey),
            }));
            if (label === null || options.some((option) => option.label === null)) {
              return null;
            }
            return (
              <label className="nodrag nowheel extension-presentation-select" key={index}>
                <span>{label}</span>
                <select
                  disabled={onAction === undefined}
                  onChange={(event) => {
                    event.stopPropagation();
                    onAction?.(element.actionId, event.target.value);
                  }}
                  onClick={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                  value={element.selected ?? ""}
                >
                  {options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            );
          }
        }
      })}
    </div>
  );
}
