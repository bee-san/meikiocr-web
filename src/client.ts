import type {
  Backend,
  MeikiOcrClient,
  MeikiOcrOptions,
  OcrProfile,
  OcrSnapshot,
  RgbaFrame,
  ScanOptions,
} from "./api/types.js";
import { validateManifest } from "./assets/manifest.js";
import { DEFAULTS } from "./defaults.js";
import {
  AbortedError,
  BusyError,
  deserializeError,
  DisposedError,
  InvalidInputError,
  MeikiOcrError,
  WorkerCrashedError,
  WorkerProtocolError,
} from "./errors.js";
import { validateFrame } from "./ocr/pipeline.js";
import {
  isSnapshotShape,
  isWorkerReply,
  PROTOCOL_VERSION,
  type ClientToWorker,
  type InitRequest,
  type ReadyReply,
  type WorkerToClient,
} from "./protocol.js";

interface Pending {
  requestId: number;
  resolve: (s: OcrSnapshot) => void;
  reject: (e: unknown) => void;
  settled: boolean;
}

interface ResolvedOptions {
  profile: OcrProfile;
  execution: NonNullable<MeikiOcrOptions["execution"]>;
  wasmThreads: number;
  vertical: NonNullable<MeikiOcrOptions["vertical"]>;
  recognitionBatchSize: number;
  maxInputPixels: number;
  persistentCache: boolean;
  runtimeBaseUrl: string;
}

export function resolveOptions(o: MeikiOcrOptions): ResolvedOptions {
  if (typeof o.assetBaseUrl !== "string" || !o.assetBaseUrl.endsWith("/")) {
    throw new InvalidInputError("assetBaseUrl is required and must end with '/'");
  }
  validateManifest(o.manifest);
  const batch = o.recognitionBatchSize ?? DEFAULTS.recognitionBatchSize;
  return {
    profile: o.profile ?? DEFAULTS.profile,
    execution: o.execution ?? DEFAULTS.execution,
    wasmThreads: o.wasmThreads ?? DEFAULTS.wasmThreads,
    vertical: o.vertical ?? DEFAULTS.vertical,
    recognitionBatchSize: Math.max(1, Math.min(batch, DEFAULTS.maxRecognitionBatchSize)),
    maxInputPixels: o.maxInputPixels ?? DEFAULTS.maxInputPixels,
    persistentCache: o.persistentCache ?? DEFAULTS.persistentCache,
    runtimeBaseUrl: o.assetBaseUrl,
  };
}

/** Testing seam: anything with the Worker messaging surface. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  onmessageerror?: ((ev: MessageEvent) => void) | null;
}

export type WorkerFactory = () => WorkerLike;

class Client implements MeikiOcrClient {
  readonly profile: OcrProfile;
  private _backend: Backend = "wasm";
  private _modelSetId: string;
  private readonly opts: MeikiOcrOptions;
  private readonly resolved: ResolvedOptions;
  private readonly factory: WorkerFactory;
  private worker: WorkerLike | null = null;
  private generation = 0;
  private nextRequestId = 1;
  private pending: Pending | null = null;
  private cacheClears = new Map<number, { resolve: () => void; reject: (e: unknown) => void }>();
  private disposed = false;
  private disposing: Promise<void> | null = null;
  private readyPromise: Promise<ReadyReply> | null = null;
  private restarts = 0;
  private lastFatal: MeikiOcrError | null = null;

  constructor(opts: MeikiOcrOptions, resolved: ResolvedOptions, factory: WorkerFactory) {
    this.opts = opts;
    this.resolved = resolved;
    this.factory = factory;
    this.profile = resolved.profile;
    this._modelSetId = opts.manifest.modelSetId;
  }

  get backend(): Backend {
    return this._backend;
  }
  get modelSetId(): string {
    return this._modelSetId;
  }

  /** Create a worker and initialise it; resolves when 'ready' arrives. */
  start(): Promise<ReadyReply> {
    if (this.readyPromise) return this.readyPromise;
    this.generation++;
    const generation = this.generation;
    const worker = this.factory();
    this.worker = worker;

    this.readyPromise = new Promise<ReadyReply>((resolve, reject) => {
      let settled = false;
      const settleReject = (e: unknown) => {
        if (settled) return;
        settled = true;
        reject(e);
      };
      worker.onerror = (ev) => {
        const err = new WorkerCrashedError(`worker error: ${ev?.message ?? "unknown"}`);
        this.onFatal(err);
        settleReject(err);
      };
      if ("onmessageerror" in worker) {
        worker.onmessageerror = () => {
          const err = new WorkerProtocolError("worker message could not be deserialized");
          this.onFatal(err);
          settleReject(err);
        };
      }
      worker.onmessage = (ev: MessageEvent) => {
        const msg = ev.data as unknown;
        if (!isWorkerReply(msg)) {
          this.onFatal(new WorkerProtocolError("malformed worker reply"));
          settleReject(this.lastFatal);
          return;
        }
        if (msg.generation !== this.generation) return; // stale generation
        this.handleReply(msg, (r) => {
          if (settled) return;
          settled = true;
          resolve(r);
        }, settleReject);
      };

      const init: InitRequest = {
        type: "init",
        protocol: PROTOCOL_VERSION,
        generation,
        manifest: this.opts.manifest,
        assetBaseUrl: this.opts.assetBaseUrl,
        runtimeBaseUrl: this.resolved.runtimeBaseUrl,
        profile: this.resolved.profile,
        execution: this.resolved.execution,
        wasmThreads: this.resolved.wasmThreads,
        vertical: this.resolved.vertical,
        recognitionBatchSize: this.resolved.recognitionBatchSize,
        maxInputPixels: this.resolved.maxInputPixels,
        persistentCache: this.resolved.persistentCache,
        cacheName: DEFAULTS.cacheName,
      };
      this.send(init);
    });
    return this.readyPromise;
  }

  private send(msg: ClientToWorker, transfer?: Transferable[]): void {
    this.worker?.postMessage(msg, transfer);
  }

  private handleReply(msg: WorkerToClient, onReady: (r: ReadyReply) => void, onInitError: (e: unknown) => void): void {
    switch (msg.type) {
      case "progress":
        this.opts.onProgress?.(msg.event);
        break;
      case "ready":
        this._backend = msg.backend;
        this._modelSetId = msg.modelSetId;
        this.opts.onProgress?.({ phase: "ready", message: `${msg.backend} (${msg.backendReason}); threads=${msg.threads}` });
        onReady(msg);
        break;
      case "result": {
        const p = this.pending;
        if (!p || p.requestId !== msg.requestId) return; // unwanted/late result
        if (!isSnapshotShape(msg.snapshot)) {
          this.settle(p, undefined, new WorkerProtocolError("result snapshot has invalid shape"));
          return;
        }
        this.settle(p, msg.snapshot);
        break;
      }
      case "error": {
        const err = deserializeError(msg.error);
        if (msg.requestId === undefined) {
          // init failure
          this.lastFatal = err;
          this.readyPromise = null;
          onInitError(err);
          if (msg.fatal) this.teardownWorker();
          return;
        }
        const p = this.pending;
        if (p && p.requestId === msg.requestId) this.settle(p, undefined, err);
        const cc = this.cacheClears.get(msg.requestId);
        if (cc) {
          this.cacheClears.delete(msg.requestId);
          cc.reject(err);
        }
        if (msg.fatal) this.onFatal(new WorkerCrashedError(`fatal worker error: ${err.message}`, err));
        break;
      }
      case "cache-cleared": {
        const cc = this.cacheClears.get(msg.requestId);
        if (cc) {
          this.cacheClears.delete(msg.requestId);
          cc.resolve();
        }
        break;
      }
      case "disposed":
        break;
    }
  }

  private settle(p: Pending, snapshot?: OcrSnapshot, err?: unknown): void {
    if (p.settled) return;
    p.settled = true;
    if (this.pending === p) this.pending = null;
    if (snapshot) p.resolve(snapshot);
    else p.reject(err);
  }

  private onFatal(err: MeikiOcrError): void {
    this.lastFatal = err;
    if (this.pending) this.settle(this.pending, undefined, err);
    for (const [, cc] of this.cacheClears) cc.reject(err);
    this.cacheClears.clear();
    this.teardownWorker();
    this.readyPromise = null;
  }

  private teardownWorker(): void {
    const w = this.worker;
    this.worker = null;
    if (w) {
      w.onmessage = null;
      w.onerror = null;
      try {
        w.terminate();
      } catch {
        /* ignore */
      }
    }
  }

  async scan(frame: RgbaFrame, options: ScanOptions = {}): Promise<OcrSnapshot> {
    if (this.disposed) throw new DisposedError();
    if (this.pending) throw new BusyError();
    validateFrame(frame, this.resolved.maxInputPixels);
    if (options.signal?.aborted) throw new AbortedError();

    if (!this.worker) {
      // Bounded restart after a fatal failure.
      if (this.restarts >= DEFAULTS.maxWorkerRestarts) {
        throw new WorkerCrashedError(
          `worker unavailable after ${this.restarts} restart(s): ${this.lastFatal?.message ?? "unknown"}`,
          this.lastFatal,
        );
      }
      this.restarts++;
      await this.start();
    } else if (this.readyPromise) {
      await this.readyPromise;
    }
    if (this.disposed) throw new DisposedError();
    if (this.pending) throw new BusyError();
    if (options.signal?.aborted) throw new AbortedError();

    const requestId = this.nextRequestId++;
    const generation = this.generation;
    const move = options.transfer === "move";
    const rgba = move ? frame.rgba : frame.rgba.slice(0);
    const payload: RgbaFrame = { ...frame, rgba };

    return new Promise<OcrSnapshot>((resolve, reject) => {
      const p: Pending = { requestId, resolve, reject, settled: false };
      this.pending = p;
      const onAbort = () => {
        // Mark unwanted; the worker may still finish the ORT run.
        this.send({ type: "cancel", generation, requestId });
        this.settle(p, undefined, new AbortedError());
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
      const origResolve = p.resolve;
      const origReject = p.reject;
      p.resolve = (s) => {
        cleanup();
        origResolve(s);
      };
      p.reject = (e) => {
        cleanup();
        origReject(e);
      };
      this.send({ type: "scan", generation, requestId, frame: payload }, [rgba]);
    });
  }

  async clearCache(): Promise<void> {
    if (this.disposed) throw new DisposedError();
    if (!this.worker) {
      // No worker: clear directly from this thread.
      if (typeof caches !== "undefined") await caches.delete(DEFAULTS.cacheName).catch(() => undefined);
      return;
    }
    const requestId = this.nextRequestId++;
    return new Promise<void>((resolve, reject) => {
      this.cacheClears.set(requestId, { resolve, reject });
      this.send({ type: "clear-cache", generation: this.generation, requestId });
    });
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    this.disposing = (async () => {
      if (this.pending) this.settle(this.pending, undefined, new DisposedError("Client disposed while scan was in flight."));
      for (const [, cc] of this.cacheClears) cc.reject(new DisposedError());
      this.cacheClears.clear();
      const w = this.worker;
      if (w) {
        this.send({ type: "dispose", generation: this.generation });
        // Give the worker a moment to release sessions, then terminate regardless.
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      this.teardownWorker();
      this.readyPromise = null;
    })();
    return this.disposing;
  }
}

function defaultWorkerFactory(opts: MeikiOcrOptions): WorkerFactory {
  return () => {
    if (opts.worker) return opts.worker as unknown as WorkerLike;
    const url = opts.workerUrl ?? new URL("./worker.js", import.meta.url);
    return new Worker(url, { type: "module", name: "meikiocr-web" }) as unknown as WorkerLike;
  };
}

/**
 * Create and initialise a client. Resolves once models are fetched, verified
 * and sessions are created (progress reported via `onProgress`).
 */
export async function createMeikiOcr(options: MeikiOcrOptions): Promise<MeikiOcrClient> {
  return createMeikiOcrWithFactory(options, defaultWorkerFactory(options));
}

/** Testing entry: inject a worker factory (fake worker). */
export async function createMeikiOcrWithFactory(options: MeikiOcrOptions, factory: WorkerFactory): Promise<MeikiOcrClient> {
  const resolved = resolveOptions(options);
  const client = new Client(options, resolved, factory);
  await client.start();
  return client;
}
