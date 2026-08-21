import { invoke } from "@tauri-apps/api/core";
import type { ExtensionCapability } from "./builtinExtensionHost";
import type { ExtensionMetadataPayload } from "./workspaceStore";

export const extensionManagerAvailable =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface ExtensionProcessorContribution {
  id: string;
  labelKey: string;
}

export interface ExtensionActionContribution {
  id: string;
  labelKey: string;
  scope: "current-node" | "selection";
}

export interface ExtensionInstallPreview {
  preparedInstallId: string;
  id: string;
  version: string;
  publisherName: string;
  publisherFingerprint: string | null;
  packageSha256: string;
  signed: boolean;
  update: boolean;
  metadataMigrationRequired: boolean;
  capabilities: ExtensionCapability[];
  newlyRequestedCapabilities: ExtensionCapability[];
  processors: ExtensionProcessorContribution[];
  actions: ExtensionActionContribution[];
  locales: Record<string, Record<string, string>>;
  defaultLocale: string;
}

export interface InstalledExtension {
  id: string;
  version: string;
  publisherName: string;
  publisherFingerprint: string | null;
  packageSha256: string;
  signed: boolean;
  enabled: boolean;
  valid: boolean;
  errorCode: string | null;
  metadataSchemaVersion: number;
  grantedCapabilities: ExtensionCapability[];
  processors: ExtensionProcessorContribution[];
  actions: ExtensionActionContribution[];
  locales: Record<string, Record<string, string>>;
  defaultLocale: string | null;
}

export interface ExtensionMetadataMigrationInput {
  schemaVersion: number;
  workspace: ExtensionMetadataPayload;
  nodes: ExtensionMetadataPayload[];
}

export interface ExtensionMetadataMigrationPreview {
  metadataMigrationId: string;
  metadata: ExtensionMetadataMigrationInput | null;
}

export function chooseExtensionInstall(
  allowUnsignedDevelopment: boolean,
): Promise<ExtensionInstallPreview | null> {
  return invoke("choose_extension_install", { allowUnsignedDevelopment });
}

export function commitExtensionInstall(
  preview: ExtensionInstallPreview,
  enabled: boolean,
  metadataMigrationId: string | null = null,
): Promise<InstalledExtension[]> {
  return invoke("commit_extension_install", {
    preparedInstallId: preview.preparedInstallId,
    grantedCapabilities: preview.capabilities,
    enabled,
    metadataMigrationId,
  });
}

export function migratePreparedExtensionMetadata(
  preview: ExtensionInstallPreview,
  metadata: ExtensionMetadataMigrationInput | null,
): Promise<ExtensionMetadataMigrationPreview> {
  return invoke("migrate_prepared_extension_metadata", {
    preparedInstallId: preview.preparedInstallId,
    metadata,
  });
}

export function inspectInstalledExtensions(): Promise<InstalledExtension[]> {
  return invoke("inspect_installed_extensions");
}

export function setExtensionEnabled(
  extensionId: string,
  enabled: boolean,
): Promise<InstalledExtension[]> {
  return invoke("set_extension_enabled", { extensionId, enabled });
}

export function uninstallExtension(
  extensionId: string,
): Promise<InstalledExtension[]> {
  return invoke("uninstall_extension", { extensionId });
}
