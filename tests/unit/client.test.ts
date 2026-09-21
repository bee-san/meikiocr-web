import { describe, expect, it, vi } from "vitest";
import type { AssetManifest, OcrSnapshot, ProgressEvent } from "../../src/api/types.js";
import { createMeikiOcrWithFactory, type WorkerLike } from "../../src/client.js";
import { AbortedError, BusyError, DisposedError, InvalidInputError, WorkerCrashedError, WorkerProtocolError } from "../../src/errors.js";
import type { ClientToWorker, WorkerToClient } from "../../src/protocol.js";
import { DEFAULTS } from "../../src/defaults.js";

const manifest: AssetManifest = {
  modelSetId: "test-set",
  models: [
    { role: "detector", path: "det.onnx", sha256: "a".repeat(64), byteLength: 10 },
    { role: "recognizer-horizontal", path: "rec.onnx", sha256: "b".repeat(64), byteLength: 10 },
  ],
};

function snapshotFor(frameId: string): OcrSnapshot {
  return {
    frameId,
    width: 2,
    height: 2,
    profile: "meikipop-v2",
    lines: [],
    diagnostics: { backend: "wasm", elapsedMs: 1, modelSetId: "test-set", warnings: [] },
  };
}

/** Scriptable fake worker. `behaviour` decides how to answer scan requests. */
class FakeWorker implements WorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;
  sent: ClientToWorker[] = [];
  terminated = false;
  scanDelayMs = 0;
  replyMode: "ok" | "malformed" | "fatal" | "never" | "bad-shape" = "ok";
  constructor(private readonly initMode: "ready" | "error" = "ready") {}

  private reply(msg: unknown) {
    queueMicrotask(() => this.onmessage?.({ data: msg } as MessageEvent));
  }

  postMessage(message: unknown): void {
    const msg = message as ClientToWorker;
    this.sent.push(msg);
    switch (msg.type) {
      case "init":
        this.reply({ type: "progress", generation: msg.generation, event: { phase: "fetching", asset: "det.onnx", loadedBytes: 0, totalBytes: 10 } });
        if (this.initMode === "ready") {
          this.reply({
            type: "ready",
            generation: msg.generation,
            backend: "wasm",
            backendReason: "test",
            threads: 1,
            modelSetId: "test-set",
            warnings: [],
          } satisfies WorkerToClient);
        } else {
          this.reply({ type: "error", generation: msg.generation, error: { code: "ASSET_MISSING", message: "no det", name: "AssetError" }, fatal: true });
        }
        break;
      case "scan": {
        const send = () => {
          if (this.replyMode === "never") return;
          if (this.replyMode === "malformed") return this.reply({ nonsense: true });
          if (this.replyMode === "bad-shape") return this.reply({ type: "result", generation: msg.generation, requestId: msg.requestId, snapshot: { nope: 1 } });
          if (this.replyMode === "fatal") {
            return this.reply({ type: "error", generation: msg.generation, requestId: msg.requestId, error: { code: "WORKER_CRASHED", message: "boom", name: "WorkerCrashedError" }, fatal: true });
          }
          this.reply({ type: "result", generation: msg.generation, requestId: msg.requestId, snapshot: snapshotFor(msg.frame.frameId) });
        };
        if (this.scanDelayMs > 0) setTimeout(send, this.scanDelayMs);
        else send();
        break;
      }
      case "clear-cache":
        this.reply({ type: "cache-cleared", generation: msg.generation, requestId: msg.requestId });
        break;
      case "dispose":
        this.reply({ type: "disposed", generation: msg.generation });
        break;
      case "cancel":
        break;
    }
  }
  terminate(): void {
    this.terminated = true;
  }
}

const frame = () => ({ frameId: "f1", width: 2, height: 2, capturedAtMs: 0, rgba: new ArrayBuffer(16) });

describe("client", () => {
  it("initialises, reports progress, and scans", async () => {
    const worker = new FakeWorker();
    const progress: ProgressEvent[] = [];
    const client = await createMeikiOcrWithFactory({ manifest, assetBaseUrl: "https://example.test/assets/", onProgress: (e) => progress.push(e) }, () => worker);
    expect(progress.map((p) => p.phase)).toEqual(["fetching", "ready"]);
    expect(client.backend).toBe("wasm");
    expect(client.modelSetId).toBe("test-set");
    const snap = await client.scan(frame());
    expect(snap.frameId).toBe("f1");
    const init = worker.sent[0]!;
    expect(init.type).toBe("init");
    if (init.type === "init") expect(init.profile).toBe(DEFAULTS.profile);
  });

  it("rejects invalid options", async () => {
    await expect(createMeikiOcrWithFactory({ manifest, assetBaseUrl: "https://example.test/assets" }, () => new FakeWorker())).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("rejects init failures with the typed error", async () => {
    await expect(createMeikiOcrWithFactory({ manifest, assetBaseUrl: "https://x.test/" }, () => new FakeWorker("error"))).rejects.toMatchObject({ code: "ASSET_MISSING" });
  });

  it("a second concurrent scan rejects with BusyError", async () => {
    const worker = new FakeWorker();
    worker.scanDelayMs = 20;
    const client = await createMeikiOcrWithFactory({ manifest, assetBaseUrl: "https://x.test/" }, () => worker);
    const p1 = client.scan(frame());
    await expect(client.scan(frame())).rejects.toBeInstanceOf(BusyError);
    await expect(p1).resolves.toBeTruthy();
    // and after settling, scanning works again
    await expect(client.scan(frame())).resolves.toBeTruthy();
  });

  it("abort rejects with AbortedError and sends cancel; late result is ignored", async () => {
    const worker = new FakeWorker();
    worker.scanDelayMs = 30;
    const client = await createMeikiOcrWithFactory({ manifest, assetBaseUrl: "https://x.test/" }, () => worker);
    const ac = new AbortController();
    // Pre-aborted signal short-circuits before any message is sent.
    const pre = new AbortController();
    pre.abort();
    await expect(client.scan(frame(), { signal: pre.signal })).rejects.toBeInstanceOf(AbortedError);
    expect(worker.sent.filter((m) => m.type === "scan").length).toBe(0);

    const p = client.scan(frame(), { signal: ac.signal });
    while (!worker.sent.some((m) => m.type === "scan")) await new Promise((r) => setTimeout(r, 1));
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AbortedError);
    expect(worker.sent.some((m) => m.type === "cancel")).toBe(true);
    await new Promise((r) => setTimeout(r, 50)); // late result arrives; must not throw
    await expect(client.scan(frame())).resolves.toBeTruthy();
  });

  it("copy transfer leaves caller buffer intact; move detaches it", async () => {
    const worker = new FakeWorker();
    const client = await createMeikiOcrWithFactory({ manifest, assetBaseUrl: "https://x.test/" }, () => worker);
    const f = frame();
    await client.scan(f, { transfer: "copy" });
    expect(f.rgba.byteLength).toBe(16);
    const sentCopy = worker.sent.find((m) => m.type === "scan");
    expect(sentCopy && sentCopy.type === "scan" && sentCopy.frame.rgba !== f.rgba).toBe(true);
    const f2 = frame();
    await client.scan(f2, { transfer: "move" });
    const sentMove = worker.sent.filter((m) => m.type === "scan")[1];
    expect(sentMove && sentMove.type === "scan" && sentMove.frame.rgba === f2.rgba).toBe(true);
  });

  it("malformed reply is a protocol error and tears down the worker", async () => {
    const worker = new FakeWorker();
    worker.replyMode = "malformed";
    const client = await createMeikiOcrWithFactory({ manifest, assetBaseUrl: "https://x.test/" }, () => worker);
    await expect(client.scan(frame())).rejects.toBeInstanceOf(WorkerProtocolError);
    expect(worker.terminated).toBe(true);
  });

  it("invalid snapshot shape is a protocol error", async () => {
    const worker = new FakeWorker();
    worker.replyMode = "bad-shape";
    const client = await createMeikiOcrWithFactory({ manifest, assetBaseUrl: "https://x.test/" }, () => worker);
    await expect(client.scan(frame())).rejects.toBeInstanceOf(WorkerProtocolError);
  });

  it("fatal error triggers bounded restart via factory, then gives up", async () => {
    const workers: FakeWorker[] = [];
    const factory = () => {
      const w = new FakeWorker();
      w.replyMode = "fatal";
      workers.push(w);
      return w;
    };
    const client = await createMeikiOcrWithFactory({ manifest, assetBaseUrl: "https://x.test/" }, factory);
    for (let i = 0; i <= DEFAULTS.maxWorkerRestarts; i++) {
      await expect(client.scan(frame())).rejects.toBeInstanceOf(WorkerCrashedError);
    }
    expect(workers.length).toBe(1 + DEFAULTS.maxWorkerRestarts);
    // Exhausted: no new worker is created.
    await expect(client.scan(frame())).rejects.toBeInstanceOf(WorkerCrashedError);
    expect(workers.length).toBe(1 + DEFAULTS.maxWorkerRestarts);
  });

  it("stale-generation replies are ignored", async () => {
    const worker = new FakeWorker();
    const client = await createMeikiOcrWithFactory({ manifest, assetBaseUrl: "https://x.test/" }, () => worker);
    const spy = vi.fn();
    worker.onmessage?.({ data: { type: "result", generation: 999, requestId: 1, snapshot: snapshotFor("zzz") } } as MessageEvent);
    spy();
    await expect(client.scan(frame())).resolves.toMatchObject({ frameId: "f1" });
  });

  it("dispose is idempotent, rejects in-flight work once, and blocks further calls", async () => {
    const worker = new FakeWorker();
    worker.scanDelayMs = 50;
    const client = await createMeikiOcrWithFactory({ manifest, assetBaseUrl: "https://x.test/" }, () => worker);
    const inflight = client.scan(frame());
    const d1 = client.dispose();
    const d2 = client.dispose();
    expect(d1).toBe(d2);
    await expect(inflight).rejects.toBeInstanceOf(DisposedError);
    await d1;
    expect(worker.sent.some((m) => m.type === "dispose")).toBe(true);
    expect(worker.terminated).toBe(true);
    await expect(client.scan(frame())).rejects.toBeInstanceOf(DisposedError);
    await expect(client.clearCache()).rejects.toBeInstanceOf(DisposedError);
  });

  it("clearCache round-trips through the worker", async () => {
    const worker = new FakeWorker();
    const client = await createMeikiOcrWithFactory({ manifest, assetBaseUrl: "https://x.test/" }, () => worker);
    await expect(client.clearCache()).resolves.toBeUndefined();
    expect(worker.sent.some((m) => m.type === "clear-cache")).toBe(true);
  });

  it("validates frames before touching the worker", async () => {
    const worker = new FakeWorker();
    const client = await createMeikiOcrWithFactory({ manifest, assetBaseUrl: "https://x.test/" }, () => worker);
    await expect(client.scan({ ...frame(), rgba: new ArrayBuffer(3) })).rejects.toBeInstanceOf(InvalidInputError);
    expect(worker.sent.filter((m) => m.type === "scan").length).toBe(0);
  });
});
