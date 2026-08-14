import { useState } from "react";

export interface SecretContentLabels {
  copy: string;
  hide: string;
  label: string;
  masked: string;
  reveal: string;
}

interface SecretContentProps {
  labels: SecretContentLabels;
  onCopySecret?: (value: string) => void;
  value: string;
}

export function SecretContent({ labels, onCopySecret, value }: SecretContentProps) {
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const revealed = revealedValue === value;

  return (
    <span className="secret-content" data-revealed={revealed}>
      <span className="secret-content-label">{labels.label}</span>
      <output aria-label={labels.label} className="secret-content-value">
        {revealed ? value : "••••••••"}
      </output>
      <button
        aria-pressed={revealed}
        className="nodrag nowheel secret-content-action"
        onClick={(event) => {
          event.stopPropagation();
          setRevealedValue(revealed ? null : value);
        }}
        onPointerDown={(event) => event.stopPropagation()}
        type="button"
      >
        {revealed ? labels.hide : labels.reveal}
      </button>
      {onCopySecret !== undefined && (
        <button
          className="nodrag nowheel secret-content-action"
          onClick={(event) => {
            event.stopPropagation();
            onCopySecret(value);
          }}
          onPointerDown={(event) => event.stopPropagation()}
          type="button"
        >
          {labels.copy}
        </button>
      )}
    </span>
  );
}

export function maskedSecretText(labels: SecretContentLabels): string {
  return `${labels.label}: ${labels.masked}`;
}
