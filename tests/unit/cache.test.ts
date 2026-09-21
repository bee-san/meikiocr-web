/**
 * AssetCache tests: integrity, interrupted/oversized downloads, quota failure,
 * offline operation after provisioning, missing assets, namespace-scoped clear.
 * Uses an in-memory CacheStorage double installed on globalThis.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { ModelAsset } from "../../src/api/types.js";
import { AssetCache } from "../../src/assets/cache.js";
import { AssetError } from "../../src/errors.js";

const bytesA = new Uint8Array(1500).map((_, i) => (i * 7) & 255);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const asset: ModelAsset = { role: "detector", path: "det.onnx", sha256: sha(bytesA), byteLength: bytesA.byteLength };

class FakeCache {
  store = new Map<string, Uint8Array>();
  putFails = false;
  async match(key: string) {
    const v = this.store.get(key);
    return v ? new Response(v.slice(0)) : undefined;
  }
  async put(key: string, res: Response) {
    if (this.putFails) throw new DOMException("quota", "QuotaExceededError");
    this.store.set(key, new Uint8Array(await res.arrayBuffer()));
  }
  async delete(key: string) {
    return this.store.delete(key);
  }
}
class FakeCaches {
  caches = new Map<string, FakeCache>();
  async open(name: string) {
    let c = this.caches.get(name);
    if (!c) this.caches.set(name, (c = new FakeCache()));
    return c as unknown as Cache;
  }
  async delete(name: string) {
    return this.caches.delete(name);
  }
  async keys() {
    return [...this.caches.keys()];
  }
}

/** fetch double: streams `body` in `chunk`-sized pieces; `failAfter` bytes -> network error mid-stream. */
function fakeFetch(body: Uint8Array | null, opts: { status?: number; chunk?: number; failAfter?: number } = {}) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    if (body === null) throw new TypeError("Failed to fetch");
    if (opts.status && opts.status !== 200) return new Response(null, { status: opts.status });
    const chunk = opts.chunk ?? 512;
    let off = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (opts.failAfter !== undefined && off >= opts.failAfter) {
          controller.error(new TypeError("network error"));
          return;
        }
        if (off >= body.byteLength) return controller.close();
        controller.enqueue(body.slice(off, Math.min(off + chunk, body.byteLength)));
        off += chunk;
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

let fakeCaches: FakeCaches;
beforeEach(() => {
  fakeCaches = new FakeCaches();
  (globalThis as { caches?: unknown }).caches = fakeCaches;
});
afterEach(() => {
  delete (globalThis as { caches?: unknown }).caches;
});

describe("AssetCache", () => {
  it("fetches, verifies, caches under its own namespace, then serves offline", async () => {
    const net = fakeFetch(bytesA);
    const c1 = new AssetCache({ cacheName: "meikiocr-web-test", persistent: true, fetchImpl: net.fetch });
    const got = await c1.load(asset, "https://o/det.onnx");
    expect(new Uint8Array(got)).toEqual(bytesA);
    expect(net.calls.length).toBe(1);
    expect(await fakeCaches.keys()).toEqual(["meikiocr-web-test"]);

    // New instance (new page load), network down: must succeed from Cache Storage.
    const offline = fakeFetch(null);
    const c2 = new AssetCache({ cacheName: "meikiocr-web-test", persistent: true, fetchImpl: offline.fetch });
    const again = await c2.load(asset, "https://o/det.onnx");
    expect(new Uint8Array(again)).toEqual(bytesA);
    expect(offline.calls.length).toBe(0);
  });

  it("rejects bytes whose hash does not match with ASSET_INTEGRITY_FAILED and caches nothing", async () => {
    const wrong = bytesA.slice();
    wrong[3] ^= 1;
    const c = new AssetCache({ cacheName: "n", persistent: true, fetchImpl: fakeFetch(wrong).fetch });
    await expect(c.load(asset, "u")).rejects.toMatchObject({ code: "ASSET_INTEGRITY_FAILED" });
    expect((await fakeCaches.open("n") as unknown as FakeCache).store.size).toBe(0);
  });

  it("short (interrupted) downloads are integrity failures, not silent truncation", async () => {
    const c = new AssetCache({ cacheName: "n", persistent: false, fetchImpl: fakeFetch(bytesA.slice(0, 1000)).fetch });
    await expect(c.load(asset, "u")).rejects.toMatchObject({ code: "ASSET_INTEGRITY_FAILED" });
  });

  it("oversized downloads are integrity failures", async () => {
    const big = new Uint8Array(bytesA.byteLength + 10);
    big.set(bytesA);
    const c = new AssetCache({ cacheName: "n", persistent: false, fetchImpl: fakeFetch(big).fetch });
    await expect(c.load(asset, "u")).rejects.toMatchObject({ code: "ASSET_INTEGRITY_FAILED" });
  });

  it("a connection dropped mid-stream is ASSET_FETCH_FAILED (retryable, non-fatal)", async () => {
    const c = new AssetCache({ cacheName: "n", persistent: false, fetchImpl: fakeFetch(bytesA, { failAfter: 1024 }).fetch });
    const err = await c.load(asset, "u").catch((e) => e);
    expect(err).toBeInstanceOf(AssetError);
    expect(err.code).toBe("ASSET_FETCH_FAILED");
  });

  it("404 is ASSET_MISSING; network refusal is ASSET_FETCH_FAILED", async () => {
    const c404 = new AssetCache({ cacheName: "n", persistent: false, fetchImpl: fakeFetch(bytesA, { status: 404 }).fetch });
    await expect(c404.load(asset, "u")).rejects.toMatchObject({ code: "ASSET_MISSING" });
    const cNet = new AssetCache({ cacheName: "n", persistent: false, fetchImpl: fakeFetch(null).fetch });
    await expect(cNet.load(asset, "u")).rejects.toMatchObject({ code: "ASSET_FETCH_FAILED" });
  });

  it("a corrupt persisted entry is discarded and refetched", async () => {
    const cache = (await fakeCaches.open("n")) as unknown as FakeCache;
    cache.store.set(`https://meikiocr-web.invalid/n/${asset.sha256}`, new Uint8Array(1500)); // wrong bytes
    const net = fakeFetch(bytesA);
    const c = new AssetCache({ cacheName: "n", persistent: true, fetchImpl: net.fetch });
    expect(new Uint8Array(await c.load(asset, "u"))).toEqual(bytesA);
    expect(net.calls.length).toBe(1);
    expect(sha(cache.store.get(`https://meikiocr-web.invalid/n/${asset.sha256}`)!)).toBe(asset.sha256);
  });

  it("quota failure on put keeps an in-memory copy and does not fail the load", async () => {
    const cache = (await fakeCaches.open("n")) as unknown as FakeCache;
    cache.putFails = true;
    const net = fakeFetch(bytesA);
    const c = new AssetCache({ cacheName: "n", persistent: true, fetchImpl: net.fetch });
    expect(new Uint8Array(await c.load(asset, "u"))).toEqual(bytesA);
    expect(new Uint8Array(await c.load(asset, "u"))).toEqual(bytesA); // memory hit
    expect(net.calls.length).toBe(1);
    expect(cache.store.size).toBe(0);
  });

  it("works with persistence disabled or Cache Storage absent (memory only)", async () => {
    delete (globalThis as { caches?: unknown }).caches;
    const net = fakeFetch(bytesA);
    const c = new AssetCache({ cacheName: "n", persistent: true, fetchImpl: net.fetch });
    await c.load(asset, "u");
    await c.load(asset, "u");
    expect(net.calls.length).toBe(1);
  });

  it("reports fetching then verifying progress with byte counts", async () => {
    const events: string[] = [];
    const c = new AssetCache({ cacheName: "n", persistent: false, fetchImpl: fakeFetch(bytesA, { chunk: 400 }).fetch, onProgress: (e) => events.push(`${e.phase}:${e.loadedBytes}/${e.totalBytes}`) });
    await c.load(asset, "u");
    expect(events[0]).toBe("fetching:0/1500");
    expect(events.at(-1)).toBe("verifying:1500/1500");
    expect(events.filter((e) => e.startsWith("fetching")).length).toBeGreaterThanOrEqual(2);
  });

  it("clear() deletes only its own cache namespace", async () => {
    await fakeCaches.open("ppsspp-web-app-v4");
    const c = new AssetCache({ cacheName: "meikiocr-web-assets-v1", persistent: true, fetchImpl: fakeFetch(bytesA).fetch });
    await c.load(asset, "u");
    expect((await fakeCaches.keys()).sort()).toEqual(["meikiocr-web-assets-v1", "ppsspp-web-app-v4"]);
    await c.clear();
    expect(await fakeCaches.keys()).toEqual(["ppsspp-web-app-v4"]);
  });
});
