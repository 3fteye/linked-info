import { useEffect, useMemo, useRef, useState } from "react";
import {
  generateTotp,
  totpRemainingSeconds,
  type TotpConfiguration,
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

function sameConfiguration(
  left: TotpConfiguration | null,
  right: TotpConfiguration | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (
    left === null ||
    right === null ||
    left.algorithm !== right.algorithm ||
    left.digits !== right.digits ||
    left.period !== right.period ||
    left.secret.length !== right.secret.length
  ) {
    return false;
  }
  return left.secret.every((value, index) => value === right.secret[index]);
}

export function TotpContentLine({
  directive,
  labels,
  onCopySecret,
}: TotpContentLineProps) {
  const [timestampMs, setTimestampMs] = useState(() => Date.now());
  const [generated, setGenerated] = useState<{
    code: string;
    configuration: TotpConfiguration;
    counter: number;
  } | null>(null);
  const [failedConfiguration, setFailedConfiguration] =
    useState<TotpConfiguration | null>(null);
  const nextConfiguration = directive.valid ? directive.configuration : null;
  const stableConfigurationRef = useRef<TotpConfiguration | null>(null);
  if (!sameConfiguration(stableConfigurationRef.current, nextConfiguration)) {
    stableConfigurationRef.current = nextConfiguration;
  }
  const configuration = stableConfigurationRef.current;
  const counter =
    configuration === null
      ? null
      : Math.floor(timestampMs / 1_000 / configuration.period);
  const code =
    generated?.configuration === configuration ? generated.code : null;
  const codeIsCurrent = code !== null && generated?.counter === counter;
  const generationFailed = failedConfiguration === configuration;

  useEffect(() => {
    if (configuration === null || counter === null) {
      return;
    }
    let active = true;
    setFailedConfiguration(null);
    void generateTotp(
      configuration,
      counter * configuration.period * 1_000,
    )
      .then((nextCode) => {
        if (active) {
          setGenerated({ code: nextCode, configuration, counter });
        }
      })
      .catch(() => {
        if (active) {
          setFailedConfiguration(configuration);
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
    let timer: number | null = null;
    const scheduleNextSecond = () => {
      const now = Date.now();
      const delay = Math.max(50, 1_020 - (now % 1_000));
      timer = window.setTimeout(() => {
        setTimestampMs(Date.now());
        scheduleNextSecond();
      }, delay);
    };
    scheduleNextSecond();
    return () => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
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
    <span
      className="totp-content-line"
      data-status={code === null ? "loading" : codeIsCurrent ? "ready" : "refreshing"}
    >
      <span className="totp-content-label">TOTP</span>
      <output aria-label="TOTP" className="totp-content-code">
        {code ?? labels.generating}
      </output>
      {remainingSeconds !== null && (
        <span className="totp-content-remaining">
          {labels.remaining(remainingSeconds)}
        </span>
      )}
      {onCopySecret !== undefined && (
        <button
          className="nodrag nowheel totp-content-copy"
          disabled={!codeIsCurrent}
          onClick={(event) => {
            event.stopPropagation();
            if (code !== null && codeIsCurrent) {
              onCopySecret(code);
            }
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
