import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, GripVertical, LockKeyhole, PanelTop, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  CapsuleBridge,
  CapsuleContext,
  CapsuleState,
  CapsuleSubmission,
  CapsuleSubmissionResult,
} from "./capsuleBridge";
import "./CapsuleNote.css";

interface CapsuleNoteProps {
  bridge: CapsuleBridge;
  newId?: () => string;
  now?: () => number;
  utcOffsetMinutes?: () => number;
}

type SaveState = "idle" | "saving" | "saved" | "failed" | "unknown";

interface Attempt {
  request: CapsuleSubmission;
  generation: number;
  state: "saving" | "failed" | "unknown";
  polling: boolean;
}

const maximumNameLength = 512;
const maximumContentLength = 100_000;
const contextPollMs = 2_000;
const submissionPollMs = 800;
const randomId = () => crypto.randomUUID();
const systemTime = () => Date.now();
const systemUtcOffset = () => -new Date().getTimezoneOffset();

function contextKey(context: CapsuleContext): string {
  return `${context.ownerId}:${context.contextId}`;
}

function readyContext(state: CapsuleState): CapsuleContext | null {
  return state.ready && state.ownerId !== null && state.contextId !== null
    ? { ownerId: state.ownerId, contextId: state.contextId }
    : null;
}

function failureLabel(reason: string | undefined): string {
  switch (reason) {
    case "duplicateName":
      return "capsule.duplicateName";
    case "empty":
      return "capsule.empty";
    case "busy":
      return "capsule.busy";
    case "invalid":
      return "capsule.invalid";
    case "recoveryRequired":
      return "capsule.recoveryRequired";
    default:
      return "capsule.saveFailed";
  }
}

export default function CapsuleNote({
  bridge,
  newId = randomId,
  now = systemTime,
  utcOffsetMinutes = systemUtcOffset,
}: CapsuleNoteProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<CapsuleState | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [windowBusy, setWindowBusy] = useState(false);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const contentInputRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef({ name: "", content: "" });
  const contextRef = useRef<CapsuleContext | null>(null);
  const lastContextRef = useRef<CapsuleContext | null>(null);
  const revokedContextRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const attemptRef = useRef<Attempt | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composingRef = useRef(false);
  const mountedRef = useRef(false);
  const windowBusyRef = useRef(false);
  const activityAtRef = useRef(-Infinity);

  const clearDraft = useCallback((message: string | null) => {
    generationRef.current += 1;
    draftRef.current = { name: "", content: "" };
    attemptRef.current = null;
    composingRef.current = false;
    if (pollRef.current !== null) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    setName("");
    setContent("");
    setSaveState("idle");
    setNotice(message);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    clearDraft(null);
    setState(null);
    let active = true;
    let subscribed = false;
    let probe = 0;
    const unsubscribers: Array<() => void> = [];

    function failClosed() {
      contextRef.current = null;
      clearDraft("capsule.unavailable");
      setState((current) => current === null ? null : { ...current, ready: false });
    }

    async function inspect() {
      if (!active || !subscribed) {
        return;
      }
      const currentProbe = ++probe;
      try {
        const next = await bridge.inspect();
        if (!active || currentProbe !== probe) {
          return;
        }
        let nextContext = readyContext(next);
        if (
          nextContext !== null &&
          contextKey(nextContext) === revokedContextRef.current
        ) {
          nextContext = null;
        }
        const previous = contextRef.current;
        if (previous !== null && (
          nextContext === null || contextKey(previous) !== contextKey(nextContext)
        )) {
          clearDraft("capsule.contextCleared");
        } else if (
          nextContext !== null && lastContextRef.current !== null &&
          contextKey(nextContext) !== contextKey(lastContextRef.current)
        ) {
          clearDraft("capsule.contextCleared");
        }
        contextRef.current = nextContext;
        if (nextContext !== null) {
          lastContextRef.current = nextContext;
        }
        setState({ ...next, ready: nextContext !== null });
      } catch {
        if (active && currentProbe === probe) {
          failClosed();
        }
      }
    }

    function onLocked() {
      if (!active) {
        return;
      }
      probe += 1;
      const previous = contextRef.current ?? lastContextRef.current;
      if (previous !== null) {
        revokedContextRef.current = contextKey(previous);
      }
      contextRef.current = null;
      clearDraft("capsule.contextCleared");
      setState((current) => current === null ? null : { ...current, ready: false });
    }

    async function subscribe() {
      try {
        for (const register of [
          () => bridge.subscribeLocked(onLocked),
          () => bridge.subscribeStateChanged(() => {
            probe += 1;
            void inspect();
          }),
        ]) {
          const unsubscribe = await register();
          if (!active) {
            unsubscribe();
            return;
          }
          unsubscribers.push(unsubscribe);
        }
        subscribed = true;
        await inspect();
      } catch {
        if (active) {
          failClosed();
          for (const unsubscribe of unsubscribers.splice(0)) {
            unsubscribe();
          }
        }
      }
    }

    void subscribe();
    const interval = setInterval(() => void inspect(), contextPollMs);
    return () => {
      active = false;
      mountedRef.current = false;
      probe += 1;
      generationRef.current += 1;
      contextRef.current = null;
      draftRef.current = { name: "", content: "" };
      attemptRef.current = null;
      clearInterval(interval);
      if (pollRef.current !== null) {
        clearTimeout(pollRef.current);
        pollRef.current = null;
      }
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, [bridge, clearDraft]);

  const isCurrentAttempt = useCallback((attempt: Attempt) => (
    mountedRef.current && attemptRef.current === attempt &&
    generationRef.current === attempt.generation &&
    contextRef.current !== null &&
    contextKey(contextRef.current) === contextKey(attempt.request)
  ), []);

  const resolveAttempt = useCallback((attempt: Attempt, result: CapsuleSubmissionResult): void => {
    if (!isCurrentAttempt(attempt) || attempt.state === "failed") {
      return;
    }
    if (result.status === "saved") {
      clearDraft(null);
      setSaveState("saved");
      return;
    }
    if (result.status === "failed") {
      attempt.state = "failed";
      if (pollRef.current !== null) {
        clearTimeout(pollRef.current);
        pollRef.current = null;
      }
      setSaveState("failed");
      setNotice(failureLabel(result.reason));
      return;
    }
    attempt.state = result.status === "unknown" ? "unknown" : "saving";
    setSaveState(attempt.state);
    setNotice(result.status === "unknown" ? "capsule.unknown" : null);
    if (pollRef.current !== null || attempt.polling) {
      return;
    }
    pollRef.current = setTimeout(() => {
      pollRef.current = null;
      if (!isCurrentAttempt(attempt)) {
        return;
      }
      attempt.polling = true;
      const { ownerId, contextId, input } = attempt.request;
      void bridge.inspectSubmission({ ownerId, contextId, nodeId: input.nodeId })
        .then((next) => {
          attempt.polling = false;
          resolveAttempt(attempt, next);
        })
        .catch(() => {
          attempt.polling = false;
          resolveAttempt(attempt, { status: "unknown" });
        });
    }, submissionPollMs);
  }, [bridge, clearDraft, isCurrentAttempt]);

  const submit = useCallback(() => {
    const context = contextRef.current;
    const draft = draftRef.current;
    const previous = attemptRef.current;
    if (
      context === null || composingRef.current ||
      (previous !== null && previous.state !== "failed") ||
      (draft.name.trim().length === 0 && draft.content.trim().length === 0)
    ) {
      return;
    }
    const attempt: Attempt = {
      request: previous?.request ?? {
        ...context,
        input: {
          nodeId: newId(),
          name: draft.name,
          content: draft.content,
          capturedAtMs: now(),
          utcOffsetMinutes: utcOffsetMinutes(),
        },
      },
      generation: generationRef.current,
      state: "saving",
      polling: false,
    };
    attemptRef.current = attempt;
    resolveAttempt(attempt, { status: "queued" });
    void bridge.submit(attempt.request)
      .then((result) => resolveAttempt(attempt, result))
      .catch(() => resolveAttempt(attempt, { status: "unknown" }));
  }, [bridge, newId, now, resolveAttempt, utcOffsetMinutes]);

  useEffect(() => {
    const onWindowBlur = () => {
      if (editorRef.current?.contains(document.activeElement)) {
        submit();
      }
    };
    window.addEventListener("blur", onWindowBlur);
    return () => window.removeEventListener("blur", onWindowBlur);
  }, [submit]);

  useEffect(() => {
    if (expanded && state?.ready) {
      contentInputRef.current?.focus();
    }
  }, [expanded, state?.ready, state?.contextId]);

  function recordActivity() {
    const context = contextRef.current;
    const timestamp = performance.now();
    if (context === null || timestamp - activityAtRef.current < 5_000) {
      return;
    }
    activityAtRef.current = timestamp;
    const generation = generationRef.current;
    void bridge.recordActivity(context).catch(() => {
      if (mountedRef.current && generation === generationRef.current) {
        contextRef.current = null;
        clearDraft("capsule.unavailable");
        setState((current) => current === null ? null : { ...current, ready: false });
      }
    });
  }

  function edit(field: "name" | "content", value: string) {
    if (contextRef.current === null || (
      attemptRef.current !== null && attemptRef.current.state !== "failed"
    )) {
      return;
    }
    const limit = field === "name" ? maximumNameLength : maximumContentLength;
    if (value.length > limit) {
      setNotice("capsule.invalid");
      return;
    }
    draftRef.current = { ...draftRef.current, [field]: value };
    const previous = attemptRef.current;
    if (previous !== null && value !== previous.request.input[field]) {
      // A confirmed failure may be edited; an uncertain write may not get a new ID.
      attemptRef.current = null;
    }
    if (field === "name") {
      setName(value);
    } else {
      setContent(value);
    }
    setSaveState("idle");
    setNotice(null);
    recordActivity();
  }

  async function windowAction(action: () => Promise<void>, after?: () => void) {
    if (windowBusyRef.current) {
      return;
    }
    windowBusyRef.current = true;
    setWindowBusy(true);
    try {
      await action();
      if (mountedRef.current) {
        after?.();
      }
    } catch {
      if (mountedRef.current) {
        setNotice("capsule.windowActionFailed");
      }
    } finally {
      windowBusyRef.current = false;
      if (mountedRef.current) {
        setWindowBusy(false);
      }
    }
  }

  const ready = state?.ready === true;
  const readOnly = saveState === "saving" || saveState === "unknown";
  const hasDraft = name.length > 0 || content.length > 0;
  const collapsedLabel = saveState === "saved" ? "capsule.saved"
    : !ready ? "capsule.lockedEntry" : hasDraft ? "capsule.draft" : "capsule.title";
  const statusLabel = notice ?? (saveState === "saving" ? "capsule.saving"
    : saveState === "saved" ? "capsule.saved" : "capsule.saveHint");

  return (
    <section className="capsule-note" data-expanded={expanded} aria-label={t("capsule.title")}>
      <header className="capsule-header">
        <button
          className="capsule-icon capsule-drag"
          type="button"
          aria-label={t("capsule.drag")}
          title={t("capsule.drag")}
          disabled={windowBusy}
          onPointerDown={(event) => {
            if (event.button === 0) {
              event.preventDefault();
              recordActivity();
              void windowAction(() => bridge.drag());
            }
          }}
        >
          <GripVertical size={17} aria-hidden="true" />
        </button>
        <button
          className="capsule-toggle"
          type="button"
          aria-expanded={expanded}
          title={t(expanded ? "capsule.collapse" : "capsule.expand")}
          disabled={windowBusy}
          onPointerDown={(event) => {
            // Collapsing keeps a draft; a pointer must not focus this button
            // first and turn the collapse action into an editor-blur save.
            if (expanded && event.button === 0) {
              event.preventDefault();
            }
          }}
          onClick={() => {
            if (!expanded && !ready) {
              void windowAction(() => bridge.focusMain());
              return;
            }
            void windowAction(
              () => bridge.setExpanded(!expanded),
              () => setExpanded(!expanded),
            );
          }}
        >
          {!ready && <LockKeyhole size={15} aria-hidden="true" />}
          {saveState === "saved" && <Check size={15} aria-hidden="true" />}
          <span>{t(expanded ? "capsule.title" : collapsedLabel)}</span>
          {expanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
        </button>
        <button
          className="capsule-icon"
          type="button"
          aria-label={t("capsule.openMain")}
          title={t("capsule.openMain")}
          disabled={windowBusy}
          onClick={() => void windowAction(() => bridge.focusMain())}
        >
          <PanelTop size={16} aria-hidden="true" />
        </button>
        <button
          className="capsule-icon"
          type="button"
          aria-label={t("capsule.hide")}
          title={t(hasDraft || readOnly ? "capsule.hideBlocked" : "capsule.hide")}
          disabled={windowBusy || hasDraft || readOnly}
          onClick={() => void windowAction(() => bridge.hide())}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      {expanded && (
        <div className="capsule-body">
          {ready ? (
            <>
              {state?.encrypted === false && <p className="capsule-warning">{t("capsule.unencryptedWarning")}</p>}
              <div
                ref={editorRef}
                className="capsule-editor"
                role="group"
                aria-label={t("capsule.editor")}
                onBlur={(event) => {
                  if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                    submit();
                  }
                }}
                onCompositionStart={() => { composingRef.current = true; }}
                onCompositionEnd={() => { composingRef.current = false; }}
                onKeyDown={(event) => {
                  recordActivity();
                  if (
                    event.key === "Enter" && event.ctrlKey && !event.shiftKey && !event.altKey &&
                    !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 &&
                    !composingRef.current
                  ) {
                    event.preventDefault();
                    submit();
                  }
                }}
              >
                <input
                  aria-label={t("capsule.name")}
                  autoComplete="off"
                  maxLength={maximumNameLength}
                  onChange={(event) => edit("name", event.currentTarget.value)}
                  placeholder={t("capsule.name")}
                  readOnly={readOnly}
                  spellCheck={false}
                  type="text"
                  value={name}
                />
                <textarea
                  ref={contentInputRef}
                  aria-label={t("capsule.content")}
                  autoComplete="off"
                  maxLength={maximumContentLength}
                  onChange={(event) => edit("content", event.currentTarget.value)}
                  placeholder={t("capsule.contentPlaceholder")}
                  readOnly={readOnly}
                  spellCheck={false}
                  value={content}
                />
              </div>
            </>
          ) : (
            <div className="capsule-unavailable">
              <LockKeyhole size={24} aria-hidden="true" />
              <p>{t("capsule.unavailable")}</p>
              <button type="button" disabled={windowBusy} onClick={() => void windowAction(() => bridge.focusMain())}>
                {t("capsule.openMain")}
              </button>
            </div>
          )}
          <p className="capsule-status" role="status" data-state={saveState}>{t(statusLabel)}</p>
          <p className="capsule-draft-warning">{t("capsule.draftWarning")}</p>
        </div>
      )}
    </section>
  );
}
