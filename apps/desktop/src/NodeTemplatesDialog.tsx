import { useState } from "react";
import { useTranslation } from "react-i18next";
import { readNodeTemplates, templateFromNode, prepareTemplateContent, type NodeTemplate } from "./nodeTemplates";
import type { WorkspaceSnapshot } from "./workspaceData";

interface Props {
  workspace: WorkspaceSnapshot;
  onClose(): void;
  onSave(template: NodeTemplate): boolean;
  onDelete(id: string): void;
  onPlace(id: string, name: string, skipMissing: boolean): void;
}

export default function NodeTemplatesDialog({ workspace, onClose, onSave, onDelete, onPlace }: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<NodeTemplate | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [nodeName, setNodeName] = useState("");
  const [skipMissing, setSkipMissing] = useState(false);
  const [error, setError] = useState(false);
  let templates: NodeTemplate[] = [];
  let invalidLibrary = false;
  try { templates = readNodeTemplates(workspace); } catch { invalidLibrary = true; }
  const selected = templates.find((item) => item.id === selectedId);
  const nodeById = new Map(workspace.nodes.map((item) => [item.id, item]));
  const missing = selected?.targetNodeIds.filter((id) => !nodeById.has(id)) ?? [];
  return <div className="modal-backdrop">
    <section aria-modal="true" aria-labelledby="node-template-title" role="dialog" className="node-template-dialog">
      <h2 id="node-template-title">{t("nodeTemplates.title")}</h2>
      <p>{t("nodeTemplates.warning")}</p>
      {(error || invalidLibrary) && <p role="alert">{t("nodeTemplates.invalid")}</p>}
      {!invalidLibrary && <>
        <label>{t("nodeTemplates.source")}
          <select data-testid="template-source" value="" onChange={(event) => {
            try { setDraft(templateFromNode(workspace, event.target.value, crypto.randomUUID())); setError(false); }
            catch { setError(true); }
          }}>
            <option value="">{t("nodeTemplates.choose")}</option>
            {workspace.nodes.map((node) => <option key={node.id} value={node.id}>{node.name || t("nodeTemplates.unnamed")}</option>)}
          </select>
        </label>
        {draft !== null && <fieldset>
          <legend>{t("nodeTemplates.preview")}</legend>
          <label>{t("nodeTemplates.name")}<input data-testid="template-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
          <label>{t("nodeTemplates.content")}<textarea data-testid="template-content" rows={8} value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} /></label>
          <p>{t("nodeTemplates.references")}</p>
          {draft.targetNodeIds.map((id) => <label key={id} className="template-reference">
            <input type="checkbox" checked onChange={() => setDraft({ ...draft, targetNodeIds: draft.targetNodeIds.filter((item) => item !== id) })} />
            {nodeById.get(id)?.name || t("nodeTemplates.unnamed")}
          </label>)}
          <button type="button" onClick={() => {
            try {
              const cleaned = prepareTemplateContent(draft.content);
              if (cleaned !== draft.content) { setDraft({ ...draft, content: cleaned }); setError(true); return; }
              if (onSave({ ...draft, name: draft.name.trim() })) { setDraft(null); setError(false); } else setError(true);
            } catch { setError(true); }
          }}>{t("nodeTemplates.save")}</button>
        </fieldset>}
        <label>{t("nodeTemplates.saved")}
          <select data-testid="template-saved" value={selectedId} onChange={(e) => { setSelectedId(e.target.value); setSkipMissing(false); setError(false); }}>
            <option value="">{t("nodeTemplates.choose")}</option>
            {templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        {selected && <>
          <pre className="template-preview">{selected.content}</pre>
          <button type="button" onClick={() => setDraft({ ...selected, targetNodeIds: [...selected.targetNodeIds] })}>{t("nodeTemplates.edit")}</button>
          <button type="button" onClick={() => { onDelete(selected.id); setSelectedId(""); setDraft(null); }}>{t("nodeTemplates.remove")}</button>
          <label>{t("nodeTemplates.nodeName")}<input data-testid="template-node-name" value={nodeName} onChange={(e) => setNodeName(e.target.value)} /></label>
          {missing.length > 0 && <>
            <ul>{missing.map((id) => <li key={id}>{id}</li>)}</ul>
            <label><input type="checkbox" checked={skipMissing} onChange={(e) => setSkipMissing(e.target.checked)} />{t("nodeTemplates.skipMissing", { count: missing.length })}</label>
          </>}
          <button data-testid="template-place" type="button" disabled={missing.length > 0 && !skipMissing} onClick={() => onPlace(selected.id, nodeName, skipMissing)}>{t("nodeTemplates.place")}</button>
        </>}
      </>}
      <button type="button" onClick={onClose}>{t("actions.cancel")}</button>
    </section>
  </div>;
}
