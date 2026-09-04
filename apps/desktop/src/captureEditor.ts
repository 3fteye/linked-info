import type { CaptureBridge, CaptureRecord, CaptureSummary } from "./captureBridge";

interface EditorState {
  loaded: boolean;
  record: CaptureRecord | null;
  name: string;
  content: string;
  summaries: CaptureSummary[];
  local: "saving" | "saved" | "failed";
  busy: boolean;
  notice: string | null;
}

function errorNotice(error: unknown): string {
  switch (error) {
    case "capture_capacity": return "capture.capacity";
    case "capture_conflict":
    case "capture_read_only": return "capture.changed";
    case "capture_invalid_input": return "capture.invalid";
    case "capture_schema_unsupported":
    case "capture_corrupt": return "capture.storageInvalid";
    default: return "capture.localSaveFailed";
  }
}

/** Serializes local edits separately from the main process's claim transaction. */
export class CaptureEditor {
  private state: EditorState = {
    loaded: false, record: null, name: "", content: "", summaries: [],
    local: "saved", busy: false, notice: null,
  };
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private savedVersion = 0;
  private saving: Promise<void> | null = null;
  private initializing: Promise<void> | null = null;
  private polling = false;
  private pendingExit = false;
  private readonly submitting = new Set<string>();

  constructor(private readonly bridge: CaptureBridge) {}

  snapshot = (): EditorState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private update(patch: Partial<EditorState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private select(record: CaptureRecord) {
    this.version += 1;
    this.savedVersion = this.version;
    this.update({ record, name: record.name, content: record.content, local: "saved", notice: null });
  }

  initialize(): Promise<void> {
    if (this.initializing !== null) return this.initializing;
    this.initializing = this.action(async () => {
      const summaries = await this.bridge.list();
      this.update({ summaries, loaded: true });
      // Resume an actual local draft before allocating a new identity. Pending
      // and claimed items remain available in the list without blocking entry.
      const draft = summaries.find((item) => item.state === "draft");
      const record = draft === undefined ? await this.bridge.create() : await this.bridge.get(draft.id);
      if (record === null) throw "capture_not_found";
      this.select(record);
      this.update({ loaded: true, summaries: await this.bridge.list() });
    });
    return this.initializing;
  }

  edit(field: "name" | "content", value: string) {
    if (this.state.busy || this.state.record?.state !== "draft") return;
    const limit = field === "name" ? 512 : 100_000;
    if ([...value].length > limit) {
      this.update({ notice: "capture.invalid" });
      return;
    }
    this.version += 1;
    this.update({ [field]: value, local: "saving", notice: null });
    void this.flush().catch(() => undefined);
  }

  flush(): Promise<void> {
    if (this.saving !== null) return this.saving;
    if (this.savedVersion === this.version) return Promise.resolve();
    const task = this.saveLoop();
    this.saving = task;
    void task.finally(() => {
      if (this.saving === task) this.saving = null;
    }).catch(() => undefined);
    return task;
  }

  private async saveLoop() {
    this.update({ local: "saving" });
    try {
      while (this.savedVersion !== this.version) {
        const record = this.state.record;
        if (record === null || record.state !== "draft") throw "capture_read_only";
        const version = this.version;
        const name = this.state.name;
        const content = this.state.content;
        let saved: CaptureRecord;
        try {
          saved = await this.bridge.save(record.id, record.revision, name, content);
        } catch (error) {
          // An IPC response can be lost after SQLite committed. Re-read this
          // fixed identity before retrying; never overwrite a newer revision.
          const current = await this.bridge.get(record.id).catch(() => null);
          if (current?.state === "draft" && current.name === name && current.content === content &&
            current.revision >= record.revision) {
            saved = current;
          } else {
            if (current !== null) this.update({ record: current });
            throw error;
          }
        }
        this.savedVersion = version;
        // Keep newer input visible while this older snapshot's write completes.
        this.update({ record: saved });
      }
      this.update({ local: "saved", notice: null });
    } catch (error) {
      this.update({ local: "failed", notice: errorNotice(error) });
      throw error;
    }
  }

  private async action(operation: () => Promise<void>) {
    if (this.state.busy) return;
    this.update({ busy: true, notice: null });
    try {
      await operation();
    } catch (error) {
      this.update({ notice: errorNotice(error) });
    } finally {
      this.update({ busy: false });
      if (this.pendingExit) {
        this.pendingExit = false;
        void this.exit();
      }
    }
  }

  newDraft(): Promise<void> {
    return this.action(async () => {
      await this.flush();
      if (this.state.record?.state === "draft" && this.state.name === "" && this.state.content === "") return;
      const record = await this.bridge.create();
      this.select(record);
      this.update({ loaded: true, summaries: await this.bridge.list() });
    });
  }

  open(id: string): Promise<void> {
    return this.action(async () => {
      await this.flush();
      const record = await this.bridge.get(id);
      if (record === null) throw "capture_not_found";
      this.select(this.submitting.has(id) ? { ...record, state: "uncertain" } : record);
    });
  }

  beginEdit(): Promise<void> {
    return this.action(async () => {
      const record = this.state.record;
      if (record === null || (record.state !== "pending" && record.state !== "failed")) return;
      try {
        // Claim and this CAS compete in the same SQLite transaction order.
        // The editor remains read-only until the draft transition is confirmed.
        const draft = await this.bridge.save(record.id, record.revision, record.name, record.content);
        this.select(draft);
      } catch (error) {
        const current = await this.bridge.get(record.id);
        if (current !== null) this.select(current);
        throw error;
      }
    });
  }

  async submit(capturedAtMs: number, utcOffsetMinutes: number): Promise<void> {
    // A focus change on a pending/read-only item must not briefly acquire the
    // local action gate and swallow the user's Edit or New button click.
    if (this.state.busy || this.state.record?.state !== "draft" ||
      (this.state.name.trim().length === 0 && this.state.content.trim().length === 0)) return;
    this.update({ busy: true, notice: null });
    try {
      await this.flush();
    } catch {
      this.update({ busy: false });
      this.pendingExit = false;
      return;
    }
    const record = this.state.record;
    if (record === null || record.state !== "draft") {
      this.update({ busy: false });
      return;
    }
    const version = this.version;
    this.submitting.add(record.id);
    // This note is durably saved. Only its fixed revision becomes read-only;
    // another draft can be created even while the native response is pending.
    this.update({ record: { ...record, state: "uncertain" }, busy: false, notice: "capture.submitting" });
    if (this.pendingExit) {
      this.pendingExit = false;
      void this.exit();
    }
    let result: CaptureRecord | null = null;
    let notice: string | null = null;
    try {
      result = await this.bridge.submit(record.id, record.revision, capturedAtMs, utcOffsetMinutes);
    } catch (error) {
      // A failed IPC response cannot prove whether the submit transaction ran.
      // Only the same identity is inspected; unreadable outcomes stay read-only.
      result = await this.bridge.get(record.id).catch(() => null);
      notice = result === null ? "capture.submitUnconfirmed"
        : result.state === "draft" ? errorNotice(error) : null;
    } finally {
      this.submitting.delete(record.id);
    }
    if (this.state.record?.id === record.id && this.version === version && !this.state.busy) {
      if (result !== null) this.select(result);
      this.update({ notice });
    }
    await this.refresh();
  }

  async refresh() {
    if (!this.state.loaded || this.state.busy || this.polling) return;
    this.polling = true;
    const selected = this.state.record;
    const version = this.version;
    try {
      const summaries = await this.bridge.list();
      this.update({ summaries });
      if (selected === null || this.savedVersion !== version || this.saving !== null ||
        selected.state === "draft" || this.submitting.has(selected.id)) return;
      const current = await this.bridge.get(selected.id);
      if (current !== null && this.state.record === selected && this.version === version && !this.state.busy) {
        this.select(current);
      }
    } catch {
      this.update({ notice: "capture.refreshFailed" });
    } finally {
      this.polling = false;
    }
  }

  exit(): Promise<void> {
    if (this.state.busy) {
      this.pendingExit = true;
      return Promise.resolve();
    }
    return this.action(async () => {
      await this.flush();
      await this.bridge.exit();
    });
  }
}
