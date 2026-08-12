import { describe, expect, it } from "vitest";
import {
  resolveS3Endpoint,
  s3EndpointPlaceholder,
  s3TemplateDefaults,
} from "./s3ProviderTemplates";

describe("S3 provider templates", () => {
  it("supplies the fixed Tigris endpoint and region", () => {
    expect(s3TemplateDefaults("tigris")).toEqual({
      endpoint: "https://fly.storage.tigris.dev",
      region: "auto",
      prefix: "linked-info/v1",
    });
  });

  it("derives a Backblaze endpoint from its region", () => {
    expect(resolveS3Endpoint("backblazeB2", "", "us-west-004")).toBe(
      "https://s3.us-west-004.backblazeb2.com",
    );
  });

  it("never replaces an explicitly entered endpoint", () => {
    expect(
      resolveS3Endpoint(
        "backblazeB2",
        "https://private.example.test",
        "us-west-004",
      ),
    ).toBe("https://private.example.test");
  });

  it("explains OCI's namespace-based endpoint", () => {
    expect(s3EndpointPlaceholder("oracleOci", "eu-frankfurt-1")).toContain(
      "<namespace>",
    );
  });
});
