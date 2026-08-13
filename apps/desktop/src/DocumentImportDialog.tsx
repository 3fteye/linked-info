import { useEffect, useState } from "react";
import { FileJson, FileText, Sparkles, Upload, X } from "lucide-react";
import type { DocumentImportCandidate, DocumentImportDraft } from "./documentImport";

export interface DocumentImportDialogLabels {
  title: string;
  description: string;
  sourceName: string;
  sourceNamePlaceholder: string;
  sourceText: string;
  sourceTextPlaceholder: string;
  chooseFile: string;
  chooseExternalDraft: string;
  analyze: string;
  analyzing: string;
  cancel: string;
  close: string;
  draftTitle: string;
  draftDescription: string;
  preview: string;
  selectedCount: (count: number) => string;
  existingMatch: string;
  newNode: string;
  existingReadOnly: string;
  content: string;
  references: string;
  referencesPlaceholder: string;
  noCandidates: string;
}

interface DocumentImportDialogProps {
  busy: boolean;
  draft: DocumentImportDraft | null;
  error: string | null;
  labels: DocumentImportDialogLabels;
  progress: { current: number; total: number } | null;
  sourceName: string;
  sourceText: string;
  onAnalyze: () => void;
  onCancel: () => void;
  onChooseFile: () => void;
  onChooseExternalDraft: () => void;
  onPreview: () => void;
  onSourceNameChange: (value: string) => void;
  onSourceTextChange: (value: string) => void;
  onUpdateCandidate: (candidateId: string, patch: Partial<DocumentImportCandidate>) => void;
}

function splitReferenceNames(value: string): string[] {
  return [...new Set(value.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean))];
}

function CandidateReferencesInput({
  candidate,
  disabled,
  label,
  placeholder,
  onCommit,
}: {
  candidate: DocumentImportCandidate;
  disabled: boolean;
  label: string;
  placeholder: string;
  onCommit: (referenceNames: string[]) => void;
}) {
  const [value, setValue] = useState(candidate.referenceNames.join(", "));
  useEffect(() => {
    setValue(candidate.referenceNames.join(", "));
  }, [candidate.id, candidate.referenceNames]);
  const commit = () => onCommit(splitReferenceNames(value));
  return (
    <label>
      <span>{label}</span>
      <input
        disabled={disabled}
        onBlur={commit}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          }
        }}
        placeholder={placeholder}
        value={value}
      />
    </label>
  );
}

export default function DocumentImportDialog({
  busy,
  draft,
  error,
  labels,
  progress,
  sourceName,
  sourceText,
  onAnalyze,
  onCancel,
  onChooseFile,
  onChooseExternalDraft,
  onPreview,
  onSourceNameChange,
  onSourceTextChange,
  onUpdateCandidate,
}: DocumentImportDialogProps) {
  const selectedCount = draft?.candidates.filter((candidate) => candidate.selected).length ?? 0;
  return (
    <div className="modal-backdrop document-import-backdrop" role="presentation">
      <section
        aria-labelledby="document-import-title"
        aria-modal="true"
        className="document-import-dialog"
        role="dialog"
      >
        <header className="document-import-heading">
          <div>
            <h2 id="document-import-title">{labels.title}</h2>
            <p>{labels.description}</p>
          </div>
          <button aria-label={labels.close} onClick={onCancel} type="button">
            <X aria-hidden="true" size={18} />
          </button>
        </header>

        {draft === null ? (
          <div className="document-import-input">
            <label>
              <span>{labels.sourceName}</span>
              <input
                disabled={busy}
                maxLength={240}
                onChange={(event) => onSourceNameChange(event.target.value)}
                placeholder={labels.sourceNamePlaceholder}
                value={sourceName}
              />
            </label>
            <label>
              <span>{labels.sourceText}</span>
              <textarea
                disabled={busy}
                maxLength={120_000}
                onChange={(event) => onSourceTextChange(event.target.value)}
                placeholder={labels.sourceTextPlaceholder}
                value={sourceText}
              />
            </label>
            {progress !== null && (
              <p className="document-import-progress" role="status">
                {labels.analyzing} {progress.current} / {progress.total}
              </p>
            )}
          </div>
        ) : (
          <div className="document-import-draft">
            <header>
              <div>
                <h3>{labels.draftTitle}</h3>
                <p>{labels.draftDescription}</p>
              </div>
              <strong>{labels.selectedCount(selectedCount)}</strong>
            </header>
            {draft.candidates.length === 0 ? (
              <p className="document-import-empty">{labels.noCandidates}</p>
            ) : (
              <div className="document-import-candidates">
                {draft.candidates.map((candidate) => {
                  const existing = candidate.matchedNodeId !== null;
                  return (
                    <article data-selected={candidate.selected} key={candidate.id}>
                      <header>
                        <label>
                          <input
                            checked={candidate.selected}
                            onChange={(event) =>
                              onUpdateCandidate(candidate.id, { selected: event.target.checked })
                            }
                            type="checkbox"
                          />
                          <span>{existing ? labels.existingMatch : labels.newNode}</span>
                        </label>
                      </header>
                      <input
                        aria-label={labels.sourceName}
                        disabled={existing || !candidate.selected}
                        maxLength={160}
                        onChange={(event) =>
                          onUpdateCandidate(candidate.id, { name: event.target.value })
                        }
                        value={candidate.name}
                      />
                      {existing ? (
                        <small>{labels.existingReadOnly}</small>
                      ) : (
                        <label>
                          <span>{labels.content}</span>
                          <textarea
                            disabled={!candidate.selected}
                            maxLength={6_000}
                            onChange={(event) =>
                              onUpdateCandidate(candidate.id, {
                                content: event.target.value || null,
                              })
                            }
                            value={candidate.content ?? ""}
                          />
                        </label>
                      )}
                      <CandidateReferencesInput
                        candidate={candidate}
                        disabled={!candidate.selected}
                        label={labels.references}
                        onCommit={(referenceNames) =>
                          onUpdateCandidate(candidate.id, { referenceNames })
                        }
                        placeholder={labels.referencesPlaceholder}
                      />
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {error !== null && <p className="document-import-error" role="alert">{error}</p>}
        <footer className="document-import-actions">
          {draft === null && (
            <div className="document-import-file-actions">
              <button className="secondary-button" disabled={busy} onClick={onChooseFile} type="button">
                <Upload aria-hidden="true" size={15} />
                {labels.chooseFile}
              </button>
              <button className="secondary-button" disabled={busy} onClick={onChooseExternalDraft} type="button">
                <FileJson aria-hidden="true" size={15} />
                {labels.chooseExternalDraft}
              </button>
            </div>
          )}
          <span />
          <button className="secondary-button" onClick={onCancel} type="button">
            {labels.cancel}
          </button>
          {draft === null ? (
            <button
              className="primary-button"
              disabled={busy || sourceText.trim().length === 0}
              onClick={onAnalyze}
              type="button"
            >
              <Sparkles aria-hidden="true" size={15} />
              {busy ? labels.analyzing : labels.analyze}
            </button>
          ) : (
            <button
              className="primary-button"
              disabled={selectedCount === 0}
              onClick={onPreview}
              type="button"
            >
              <FileText aria-hidden="true" size={15} />
              {labels.preview}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
