export type EmbeddingVectorRole = "query" | "document";

export interface EmbeddingVectorCacheKey {
  fingerprint: string;
  role: EmbeddingVectorRole;
  contentHash: string;
}

export interface EmbeddingVectorCacheEntry extends EmbeddingVectorCacheKey {
  vector: number[];
}

export interface EmbeddingVectorCacheStatus {
  persistent: boolean;
  entryCount: number;
  diskBytes: number;
  maxBytes: number;
}

export interface EmbeddingVectorCache {
  read(keys: EmbeddingVectorCacheKey[]): Promise<Array<number[] | null>>;
  write(entries: EmbeddingVectorCacheEntry[]): Promise<void>;
  inspect(): Promise<EmbeddingVectorCacheStatus>;
  clear(): Promise<EmbeddingVectorCacheStatus>;
}

export const embeddingMemoryCacheLimitBytes = 64 * 1024 * 1024;
export const embeddingDiskCacheLimitBytes = 512 * 1024 * 1024;

interface MemoryEntry {
  bytes: number;
  vector: Float32Array;
}

function memoryEntryBytes(key: string, vector: Float32Array): number {
  return key.length * 2 + vector.byteLength + 64;
}

export class EmbeddingMemoryLru {
  private readonly entries = new Map<string, MemoryEntry>();
  private usedBytesValue = 0;

  constructor(readonly maxBytes = embeddingMemoryCacheLimitBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError("embedding memory cache limit must be a non-negative integer");
    }
  }

  get entryCount(): number {
    return this.entries.size;
  }

  get usedBytes(): number {
    return this.usedBytesValue;
  }

  get(key: string): Float32Array | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.vector;
  }

  set(key: string, vector: Float32Array): void {
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.entries.delete(key);
      this.usedBytesValue -= previous.bytes;
    }

    const bytes = memoryEntryBytes(key, vector);
    if (bytes > this.maxBytes) {
      return;
    }
    this.entries.set(key, { bytes, vector });
    this.usedBytesValue += bytes;
    while (this.usedBytesValue > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        break;
      }
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldest !== undefined) {
        this.usedBytesValue -= oldest.bytes;
      }
    }
  }

  clear(): void {
    this.entries.clear();
    this.usedBytesValue = 0;
  }
}

export const unavailableEmbeddingVectorCache: EmbeddingVectorCache = {
  read(keys) {
    return Promise.resolve(keys.map(() => null));
  },
  write() {
    return Promise.resolve();
  },
  inspect() {
    return Promise.resolve({
      persistent: false,
      entryCount: 0,
      diskBytes: 0,
      maxBytes: embeddingDiskCacheLimitBytes,
    });
  },
  clear() {
    return this.inspect();
  },
};
