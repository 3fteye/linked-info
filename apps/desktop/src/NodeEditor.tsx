import { Save, X } from "lucide-react";
import type { NodeDraft } from "./workspaceStore";

interface EditorLabels {
  createTitle: string;
  editTitle: string;
  name: string;
  namePlaceholder: string;
  content: string;
  contentPlaceholder: string;
  save: string;
  cancel: string;
  close: string;
}

interface NodeEditorProps {
  draft: NodeDraft;
  error: string | null;
  labels: EditorLabels;
  onCancel: () => void;
  onChange: (draft: NodeDraft) => void;
  onSubmit: () => void;
}

export default function NodeEditor({
  draft,
  error,
  labels,
  onCancel,
  onChange,
  onSubmit,
}: NodeEditorProps) {
  return (
    <aside className="node-editor" aria-label={draft.nodeId ? labels.editTitle : labels.createTitle}>
      <header className="node-editor-header">
        <h2>{draft.nodeId ? labels.editTitle : labels.createTitle}</h2>
        <button
          aria-label={labels.close}
          className="icon-button"
          onClick={onCancel}
          title={labels.close}
          type="button"
        >
          <X size={18} />
        </button>
      </header>

      <form
        className="node-editor-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label className="field-group">
          <span>{labels.name}</span>
          <input
            aria-invalid={error !== null}
            autoFocus
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            placeholder={labels.namePlaceholder}
            value={draft.name}
          />
        </label>

        <label className="field-group field-group-content">
          <span>{labels.content}</span>
          <textarea
            onChange={(event) => onChange({ ...draft, content: event.target.value })}
            placeholder={labels.contentPlaceholder}
            value={draft.content}
          />
        </label>

        {error !== null && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}

        <div className="editor-actions">
          <button className="secondary-button" onClick={onCancel} type="button">
            {labels.cancel}
          </button>
          <button className="primary-button" type="submit">
            <Save size={16} />
            <span>{labels.save}</span>
          </button>
        </div>
      </form>
    </aside>
  );
}
