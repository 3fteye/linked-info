import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronUp, GripVertical, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CaptureBridge } from "./captureBridge";
import { CaptureEditor } from "./captureEditor";
import "./CaptureApp.css";

interface CaptureAppProps {
  bridge: CaptureBridge;
  now?: () => number;
  utcOffsetMinutes?: () => number;
}

const systemTime = () => Date.now();
const systemOffset = () => -new Date().getTimezoneOffset();

export default function CaptureApp({ bridge, now = systemTime, utcOffsetMinutes = systemOffset }: CaptureAppProps) {
  const { t } = useTranslation();
  const [editor] = useState(() => new CaptureEditor(bridge));
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot);
  const [expanded, setExpanded] = useState(false);
  const [windowError, setWindowError] = useState(false);
  const [windowBusy, setWindowBusy] = useState(false);
  const windowBusyRef = useRef(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const submitting = useRef<() => void>(() => {});

  submitting.current = () => {
    if (!composing.current) void editor.submit(now(), utcOffsetMinutes());
  };

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void editor.initialize();
    void bridge.subscribeCloseRequested(() => { void editor.exit(); }).then((dispose) => {
      if (active) unsubscribe = dispose;
      else dispose();
    }).catch(() => { if (active) setWindowError(true); });
    // A Tauri event from this process cannot observe another process's SQLite
    // writes. Poll only bounded summaries and the selected immutable record.
    const timer = setInterval(() => { void editor.refresh(); }, 1_000);
    const blur = () => {
      if (editorRef.current?.contains(document.activeElement)) submitting.current();
    };
    window.addEventListener("blur", blur);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("blur", blur);
      unsubscribe?.();
    };
  }, [bridge, editor]);

  const editable = state.loaded && !state.busy && state.record?.state === "draft";
  useEffect(() => {
    if (expanded && editable) inputRef.current?.focus();
  }, [expanded, editable, state.record?.id]);

  async function windowAction(action: () => Promise<void>, after?: () => void) {
    if (windowBusyRef.current) return;
    windowBusyRef.current = true;
    setWindowBusy(true);
    setWindowError(false);
    try {
      await action();
      after?.();
    } catch {
      setWindowError(true);
    } finally {
      windowBusyRef.current = false;
      setWindowBusy(false);
    }
  }

  const status = state.local === "saving" ? "capture.saving"
    : state.notice ?? (state.record === null ? "capture.loading"
      : state.record.state === "draft" ? "capture.localSaved"
        : `capture.state.${state.record.state}`);
  const currentFailure = state.record?.failure;

  return (
    <section className="capsule-note capture-app" data-testid="capture-app" data-expanded={expanded} aria-label={t("capture.title")}>
      <header className="capsule-header">
        <button
          className="capsule-icon capsule-drag" type="button" aria-label={t("capture.drag")}
          disabled={windowBusy}
          onPointerDown={(event) => {
            if (event.button === 0) {
              event.preventDefault();
              void windowAction(() => bridge.drag());
            }
          }}
        >
          <GripVertical size={17} aria-hidden="true" />
        </button>
        <button
          className="capsule-toggle" type="button" aria-expanded={expanded}
          data-testid="capture-toggle"
          aria-label={t(expanded ? "capture.collapse" : "capture.expand")}
          disabled={windowBusy}
          onPointerDown={(event) => { if (event.button === 0) event.preventDefault(); }}
          onClick={() => void windowAction(async () => {
            await editor.flush();
            await bridge.setExpanded(!expanded);
          }, () => setExpanded(!expanded))}
        >
          <span>{t(expanded ? "capture.title" : status)}</span>
          {expanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
        </button>
        <button
          className="capsule-icon" type="button" aria-label={t("capture.new")}
          data-testid="capture-new"
          disabled={state.busy || windowBusy}
          onPointerDown={(event) => { if (event.button === 0) event.preventDefault(); }}
          onClick={() => { void editor.newDraft(); }}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
        <button
          className="capsule-icon" type="button" aria-label={t("capture.exit")}
          data-testid="capture-exit"
          disabled={state.busy || windowBusy}
          onPointerDown={(event) => { if (event.button === 0) event.preventDefault(); }}
          onClick={() => { void editor.exit(); }}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      {expanded && (
        <div className="capsule-body">
          <p className="capsule-warning">{t("capture.plaintextWarning")}</p>
          <div
            className="capsule-editor" ref={editorRef} role="group" aria-label={t("capture.editor")}
            onBlur={(event) => {
              if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                submitting.current();
              }
            }}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.ctrlKey && !event.altKey && !event.shiftKey &&
                !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !composing.current) {
                event.preventDefault();
                submitting.current();
              }
            }}
          >
            <input
              type="text" aria-label={t("capture.name")} placeholder={t("capture.name")}
              data-testid="capture-name"
              autoComplete="off" spellCheck={false} readOnly={!editable} value={state.name}
              onChange={(event) => editor.edit("name", event.currentTarget.value)}
            />
            <textarea
              ref={inputRef} aria-label={t("capture.content")} placeholder={t("capture.contentPlaceholder")}
              data-testid="capture-content"
              autoComplete="off" spellCheck={false} readOnly={!editable} value={state.content}
              onChange={(event) => editor.edit("content", event.currentTarget.value)}
            />
          </div>
          <div className="capture-feedback">
            <p className="capsule-status" data-testid="capture-status" role="status" data-state={state.record?.state} data-local={state.local}>{t(status)}</p>
            {(state.record?.state === "pending" || state.record?.state === "failed") && (
              <button data-testid="capture-edit" type="button" disabled={state.busy} onClick={() => { void editor.beginEdit(); }}>
                {t("capture.edit")}
              </button>
            )}
            {state.local === "failed" && (
              <button type="button" disabled={state.busy} onClick={() => { void editor.flush().catch(() => undefined); }}>
                {t("capture.retrySave")}
              </button>
            )}
          </div>
          {currentFailure && <p className="capsule-warning">{t(`capture.failure.${currentFailure}`)}</p>}
          {windowError && <p className="capsule-warning" role="alert">{t("capture.windowFailed")}</p>}
          <p className="capsule-draft-warning">{t("capture.hint")}</p>
          <nav className="capture-list" data-testid="capture-list" aria-label={t("capture.records")}>
            {state.summaries.map((item) => (
              <button
                key={item.id} type="button" disabled={state.busy}
                aria-current={state.record?.id === item.id ? "true" : undefined}
                onPointerDown={(event) => { if (event.button === 0) event.preventDefault(); }}
                onClick={() => {
                  void (async () => {
                    if (!composing.current) await editor.submit(now(), utcOffsetMinutes());
                    await editor.open(item.id);
                  })();
                }}
              >
                <span>{item.name || t("capture.unnamed")}</span>
                <small>{t(`capture.state.${item.state}`)}</small>
              </button>
            ))}
          </nav>
        </div>
      )}
    </section>
  );
}
