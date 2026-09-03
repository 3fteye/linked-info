import { describe, expect, it } from "vitest";
import { unavailableCapsuleHost } from "./capsuleHost";

describe("unavailableCapsuleHost", () => {
  it("keeps browser and injected-test owners inert without a desktop capsule", async () => {
    expect(unavailableCapsuleHost.available).toBe(false);
    await expect(unavailableCapsuleHost.setReady(true)).resolves.toBeUndefined();
    await expect(unavailableCapsuleHost.take()).resolves.toBeNull();
    const unsubscribe = await unavailableCapsuleHost.subscribePending(() => {
      throw new Error("an unavailable host must not publish notes");
    });
    unsubscribe();
    await expect(unavailableCapsuleHost.open()).rejects.toThrow("capsule_unavailable");
    await expect(unavailableCapsuleHost.commit("synthetic-id", "synthetic-workspace"))
      .rejects.toThrow("capsule_unavailable");
    await expect(unavailableCapsuleHost.reject("synthetic-id", "busy"))
      .rejects.toThrow("capsule_unavailable");
  });
});
