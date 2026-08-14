import { useEffect, useMemo, useState } from "react";
import {
  generateTotp,
  totpRemainingSeconds,
  type TotpDirective,
} from "./totp";

export interface TotpContentLabels {
  copy: string;
  generating: string;
  invalid: string;
  masked: string;
  remaining: (seconds: number) => string;
}

interface TotpContentLineProps {
  directive: TotpDirective;
  labels: TotpContentLabels;
  onCopySecret?: (value: string) => void;
}

export function TotpContentLine({
  directive,
  labels,
  onCopySecret,
}: TotpContentLineProps) {
  const [timestampMs, setTimestampMs] = useState(() => Date.now());
  const [code, setCode] = useState<string | null>(null);
  const [generationFailed, setGenerationFailed] = useState(false);
  const configuration = directive.valid ? directive.configuration : null;
  const counter =
    configuration === null
      ? null
      : Math.floor(timestampMs / 1_000 / configuration.period);

  useEffect(() => {
    if (configuration === null || counter === null) {
      return;
    }
    let active = true;
    setCode(null);
    setGenerationFailed(false);
    void generateTotp(
      configuration,
      counter * configuration.period * 1_000,
    )
      .then((nextCode) => {
        if (active) {
          setCode(nextCode);
        }
      })
      .catch(() => {
        if (active) {
          setGenerationFailed(true);
        }
      });
    return () => {
      active = false;
    };
  }, [configuration, counter]);

  useEffect(() => {
    if (configuration === null) {
      return;
    }
    const timer = window.setInterval(() => setTimestampMs(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [configuration]);

  const remainingSeconds = useMemo(
    () =>
      configuration === null
        ? null
        : totpRemainingSeconds(configuration.period, timestampMs),
    [configuration, timestampMs],
  );

  if (configuration === null || generationFailed) {
    return (
      <span className="totp-content-line" data-status="invalid" role="alert">
        <span className="totp-content-label">TOTP</span>
        <span className="totp-content-error">{labels.invalid}</span>
      </span>
    );
  }

  return (
    <span className="totp-content-line" data-status={code === null ? "loading" : "ready"}>
      <span className="totp-content-label">TOTP</span>
      <output aria-label="TOTP" className="totp-content-code">
        {code ?? labels.generating}
      </output>
      {remainingSeconds !== null && (
        <span className="totp-content-remaining">
          {labels.remaining(remainingSeconds)}
        </span>
      )}
      {code !== null && onCopySecret !== undefined && (
        <button
          className="nodrag nowheel totp-content-copy"
          onClick={(event) => {
            event.stopPropagation();
            onCopySecret(code);
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

export function maskedTotpLine(labels: TotpContentLabels): string {
  return `TOTP: ${labels.masked}`;
}
