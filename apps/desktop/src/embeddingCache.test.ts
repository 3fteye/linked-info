import { describe, expect, it } from "vitest";
import { EmbeddingMemoryLru } from "./embeddingCache";
import { sha256Text } from "./embeddingService";

describe("embedding caches", () => {
  it("uses SHA-256 instead of raw text in cache identities", async () => {
    await expect(sha256Text("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("evicts the least recently used vector within its byte limit", () => {
    const cache = new EmbeddingMemoryLru(164);
    cache.set("a", new Float32Array([1, 2, 3, 4]));
    cache.set("b", new Float32Array([5, 6, 7, 8]));
    expect(cache.entryCount).toBe(2);
    expect(cache.get("a")).toBeDefined();

    cache.set("c", new Float32Array([9, 10, 11, 12]));

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.usedBytes).toBeLessThanOrEqual(cache.maxBytes);
  });

  it("does not retain an entry larger than the configured limit", () => {
    const cache = new EmbeddingMemoryLru(32);
    cache.set("large", new Float32Array(64));
    expect(cache.entryCount).toBe(0);
    expect(cache.usedBytes).toBe(0);
  });
});
