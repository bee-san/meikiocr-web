import type { ModelAsset, ProgressEvent } from "../api/types.js";
import { DEFAULTS } from "../defaults.js";
import { AssetError } from "../errors.js";
import { verifyBytes } from "./manifest.js";

export interface AssetCacheOptions {
  cacheName?: string;
  persistent: boolean;
  fetchImpl?: typeof fetch;
  onProgress?: (e: ProgressEvent) => void;
}

/**
 * Loads model bytes with verification, using Cache Storage (when available and
 * enabled) under a namespace owned solely by this library. Cache keys are
 * content-addressed (`<cacheName>/<sha256>`), so a manifest update never reuses
 * stale bytes, and `clear()` removes only this library's entries.
 */
export class AssetCache {
  private readonly cacheName: string;
  private readonly persistent: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly onProgress: ((e: ProgressEvent) => void) | undefined;
  private readonly memory = new Map<string, ArrayBuffer>();

  constructor(opts: AssetCacheOptions) {
    this.cacheName = opts.cacheName ?? DEFAULTS.cacheName;
    this.persistent = opts.persistent && typeof caches !== "undefined";
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.onProgress = opts.onProgress;
  }

  private keyFor(asset: ModelAsset): string {
    // Synthetic same-origin-looking URL; never fetched from the network.
    return `https://meikiocr-web.invalid/${this.cacheName}/${asset.sha256.toLowerCase()}`;
  }

  private async openCache(): Promise<Cache | null> {
    if (!this.persistent) return null;
    try {
      return await caches.open(this.cacheName);
    } catch {
      return null; // storage unavailable: fall back to memory
    }
  }

  async load(asset: ModelAsset, url: string): Promise<ArrayBuffer> {
    const mem = this.memory.get(asset.sha256);
    if (mem) return mem;

    const cache = await this.openCache();
    if (cache) {
      try {
        const hit = await cache.match(this.keyFor(asset));
        if (hit) {
          const bytes = await hit.arrayBuffer();
          this.onProgress?.({ phase: "verifying", asset: asset.path, loadedBytes: bytes.byteLength, totalBytes: asset.byteLength });
          try {
            await verifyBytes(asset, bytes);
            this.memory.set(asset.sha256, bytes);
            return bytes;
          } catch {
            // Corrupt/partial cache entry: delete and refetch.
            await cache.delete(this.keyFor(asset)).catch(() => undefined);
          }
        }
      } catch {
        /* treat as miss */
      }
    }

    const bytes = await this.fetchWithProgress(asset, url);
    this.onProgress?.({ phase: "verifying", asset: asset.path, loadedBytes: bytes.byteLength, totalBytes: asset.byteLength });
    await verifyBytes(asset, bytes);
    this.memory.set(asset.sha256, bytes);

    if (cache) {
      try {
        await cache.put(
          this.keyFor(asset),
          new Response(bytes.slice(0), {
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(bytes.byteLength),
              "x-meikiocr-asset": asset.path,
            },
          }),
        );
      } catch {
        // Quota or storage failure: keep in-memory copy; do not fail the scan path.
      }
    }
    return bytes;
  }

  private async fetchWithProgress(asset: ModelAsset, url: string): Promise<ArrayBuffer> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { credentials: "same-origin" });
    } catch (e) {
      throw new AssetError("ASSET_FETCH_FAILED", `${asset.path}: network error fetching ${url}`, e);
    }
    if (res.status === 404) throw new AssetError("ASSET_MISSING", `${asset.path}: 404 at ${url}`);
    if (!res.ok) throw new AssetError("ASSET_FETCH_FAILED", `${asset.path}: HTTP ${res.status} at ${url}`);
    const total = asset.byteLength;
    this.onProgress?.({ phase: "fetching", asset: asset.path, loadedBytes: 0, totalBytes: total });

    if (!res.body) {
      const buf = await res.arrayBuffer();
      this.onProgress?.({ phase: "fetching", asset: asset.path, loadedBytes: buf.byteLength, totalBytes: total });
      return buf;
    }
    const reader = res.body.getReader();
    const out = new Uint8Array(total);
    let loaded = 0;
    let lastReport = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (loaded + value.byteLength > total) {
        // Larger than declared: integrity will fail; collect anyway to report precisely.
        const grown = new Uint8Array(loaded + value.byteLength);
        grown.set(out.subarray(0, loaded));
        grown.set(value, loaded);
        loaded += value.byteLength;
        return this.drain(reader, grown, loaded, asset, total);
      }
      out.set(value, loaded);
      loaded += value.byteLength;
      if (loaded - lastReport > 262_144 || loaded === total) {
        lastReport = loaded;
        this.onProgress?.({ phase: "fetching", asset: asset.path, loadedBytes: loaded, totalBytes: total });
      }
    }
    if (loaded !== total) {
      throw new AssetError("ASSET_INTEGRITY_FAILED", `${asset.path}: received ${loaded} bytes, expected ${total} (interrupted?)`);
    }
    return out.buffer;
  }

  private async drain(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    acc: Uint8Array,
    loaded: number,
    asset: ModelAsset,
    total: number,
  ): Promise<ArrayBuffer> {
    const chunks: Uint8Array[] = [acc];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.byteLength;
      }
    }
    throw new AssetError("ASSET_INTEGRITY_FAILED", `${asset.path}: received ${loaded} bytes, expected ${total}`);
  }

  /** Remove only this library's cache namespace. Never touches other caches. */
  async clear(): Promise<void> {
    this.memory.clear();
    if (typeof caches === "undefined") return;
    try {
      await caches.delete(this.cacheName);
    } catch {
      /* ignore */
    }
  }
}
