import type { S3ProviderTemplate } from "./offsiteBackup";

export interface S3TemplateDefaults {
  endpoint: string;
  region: string;
  prefix: string;
}

export function s3TemplateDefaults(
  template: S3ProviderTemplate,
): S3TemplateDefaults {
  switch (template) {
    case "cloudflareR2":
      return {
        endpoint: "",
        region: "auto",
        prefix: "linked-info/v1",
      };
    case "tigris":
      return {
        endpoint: "https://fly.storage.tigris.dev",
        region: "auto",
        prefix: "linked-info/v1",
      };
    case "backblazeB2":
    case "oracleOci":
    case "custom":
      return { endpoint: "", region: "", prefix: "linked-info/v1" };
  }
}

export function resolveS3Endpoint(
  template: S3ProviderTemplate,
  endpoint: string,
  region: string,
): string {
  const explicit = endpoint.trim();
  if (explicit.length > 0) {
    return explicit;
  }
  if (template === "backblazeB2" && region.trim().length > 0) {
    return `https://s3.${region.trim()}.backblazeb2.com`;
  }
  return "";
}

export function s3EndpointPlaceholder(
  template: S3ProviderTemplate,
  region: string,
): string {
  if (template === "backblazeB2") {
    return region.trim().length > 0
      ? `https://s3.${region.trim()}.backblazeb2.com`
      : "https://s3.<region>.backblazeb2.com";
  }
  if (template === "oracleOci") {
    return "https://<namespace>.compat.objectstorage.<region>.oci.customer-oci.com";
  }
  if (template === "cloudflareR2") {
    return "https://<ACCOUNT_ID>.r2.cloudflarestorage.com";
  }
  return "https://s3.example.com";
}
