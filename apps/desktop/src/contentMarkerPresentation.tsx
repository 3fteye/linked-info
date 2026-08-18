import type { ReactNode } from "react";
import {
  contentMarkerRegistry,
  type ContentMarkerRegistry,
  type ParsedContentMarker,
} from "./contentMarker";
import { SecretContent, maskedSecretText, type SecretContentLabels } from "./secretContent";
import { parseTotpPayload, type TotpDirective } from "./totp";
import { TotpContentLine, maskedTotpLine, type TotpContentLabels } from "./totpContent";

export interface ContentMarkerPresentationLabels {
  secret: SecretContentLabels;
  totp: TotpContentLabels;
}

export interface ContentMarkerPresentationContext {
  labels: ContentMarkerPresentationLabels;
  onCopySecret?: (value: string) => void;
}

export interface ContentMarkerPresentation {
  readonly id: string;
  renderCanvas(
    marker: ParsedContentMarker,
    context: ContentMarkerPresentationContext,
  ): ReactNode;
  renderList(
    marker: ParsedContentMarker,
    labels: ContentMarkerPresentationLabels,
  ): string;
}

export class ContentMarkerPresentationRegistry {
  private readonly presentations: ReadonlyMap<string, ContentMarkerPresentation>;

  constructor(presentations: readonly ContentMarkerPresentation[]) {
    const byId = new Map<string, ContentMarkerPresentation>();
    for (const presentation of presentations) {
      if (byId.has(presentation.id)) {
        throw new Error(`duplicate content marker presentation id: ${presentation.id}`);
      }
      byId.set(presentation.id, presentation);
    }
    this.presentations = byId;
  }

  assertExactCoverage(markerRegistry: ContentMarkerRegistry): void {
    const markerIds = new Set(markerRegistry.list().map((definition) => definition.id));
    const presentationIds = new Set(this.presentations.keys());
    const missing = [...markerIds].filter((id) => !presentationIds.has(id));
    const orphaned = [...presentationIds].filter((id) => !markerIds.has(id));
    if (missing.length > 0 || orphaned.length > 0) {
      throw new Error(
        `content marker presentation coverage mismatch: missing=${missing.join(",")}; orphaned=${orphaned.join(",")}`,
      );
    }
  }

  renderCanvas(
    marker: ParsedContentMarker,
    context: ContentMarkerPresentationContext,
  ): ReactNode | null {
    return this.presentations.get(marker.id)?.renderCanvas(marker, context) ?? null;
  }

  renderList(
    marker: ParsedContentMarker,
    labels: ContentMarkerPresentationLabels,
  ): string | null {
    return this.presentations.get(marker.id)?.renderList(marker, labels) ?? null;
  }
}

function totpDirective(payload: string): TotpDirective {
  const configuration = parseTotpPayload(payload);
  return configuration === null
    ? { valid: false }
    : { configuration, valid: true };
}

export function missingContentMarkerPresentation(marker: ParsedContentMarker): string {
  const note = marker.attributes.note?.trim();
  const prefix = note === undefined || note.length === 0 ? "" : `${note}: `;
  return marker.definition?.excludeFromSemanticAnalysis === true
    ? `${prefix}${marker.id}: ••••••••`
    : marker.raw;
}

function withMarkerNote(marker: ParsedContentMarker, content: ReactNode): ReactNode {
  const note = marker.attributes.note?.trim();
  if (note === undefined || note.length === 0) {
    return content;
  }
  return (
    <span className="content-marker-presentation">
      <span className="content-marker-note">{note}</span>
      {content}
    </span>
  );
}

function markerListText(marker: ParsedContentMarker, masked: string): string {
  const note = marker.attributes.note?.trim();
  return note === undefined || note.length === 0 ? masked : `${note}: ${masked}`;
}

export const contentMarkerPresentationRegistry = new ContentMarkerPresentationRegistry([
  {
    id: "totp",
    renderCanvas(marker, context) {
      return withMarkerNote(
        marker,
        <TotpContentLine
          directive={totpDirective(marker.payload)}
          labels={context.labels.totp}
          onCopySecret={context.onCopySecret}
        />,
      );
    },
    renderList(marker, labels) {
      return markerListText(marker, maskedTotpLine(labels.totp));
    },
  },
  {
    id: "secret",
    renderCanvas(marker, context) {
      return withMarkerNote(
        marker,
        <SecretContent
          labels={context.labels.secret}
          onCopySecret={context.onCopySecret}
          value={marker.payload}
        />,
      );
    },
    renderList(marker, labels) {
      return markerListText(marker, maskedSecretText(labels.secret));
    },
  },
]);

contentMarkerPresentationRegistry.assertExactCoverage(contentMarkerRegistry);
