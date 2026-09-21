/**
 * Dedicated OCR worker. Owns ORT sessions and the model cache. Communicates
 * with the client via the typed protocol in ./protocol.ts.
 *
 * Bundle this file as a module worker. `onnxruntime-web` is imported here so
 * the consumer's bundler resolves the pinned ORT build; the matching
 * `.wasm`/`.mjs` runtime files must be served from `runtimeBaseUrl`.
 */
import type { Backend, ModelAsset } from "./api/types.js";
import { AssetCache } from "./assets/cache.js";
import { findModel, resolveAssetUrl, validateManifest } from "./assets/manifest.js";
import { DEFAULTS } from "./defaults.js";
import { AbortedError, AssetError, MeikiOcrError, serializeError } from "./errors.js";
import { runPipeline, type InferenceEngine, type PipelineConfig } from "./ocr/pipeline.js";
import type { RecognitionOutputs } from "./ocr/postprocess.js";
import type { ClientToWorker, InitRequest, WorkerToClient } from "./protocol.js";
import { chooseBackend, detectCapabilities, effectiveThreads } from "./runtime/capabilities.js";
import { configureOrtEnv, createSession, OrtEngine, type Ort } from "./runtime/session.js";

interface WorkerState {
  generation: number;
  init: InitRequest | null;
  ort: Ort | null;
  engine: OrtEngine | null;
  cache: AssetCache | null;
  pipeline: PipelineConfig | null;
  activeRequestId: number | null;
  cancelled: Set<number>;
  disposed: boolean;
  verticalLoading: Promise<void> | null;
}

const state: WorkerState = {
  generation: 0,
  init: null,
  ort: null,
  engine: null,
  cache: null,
  pipeline: null,
  activeRequestId: null,
  cancelled: new Set(),
  disposed: false,
  verticalLoading: null,
};

const scope = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: WorkerToClient, transfer?: Transferable[]): void {
  if (transfer && transfer.length) scope.postMessage(msg, transfer);
  else scope.postMessage(msg);
}

function fail(generation: number, error: unknown, fatal: boolean, requestId?: number): void {
  const reply: WorkerToClient = {
    type: "error",
    generation,
    error: serializeError(error),
    fatal,
    ...(requestId !== undefined ? { requestId } : {}),
  };
  post(reply);
}

async function loadModel(req: InitRequest, cache: AssetCache, role: ModelAsset["role"]): Promise<Uint8Array> {
  const asset = findModel(req.manifest, role);
  if (!asset) throw new AssetError("ASSET_MISSING", `manifest lacks ${role}`);
  const url = resolveAssetUrl(req.assetBaseUrl, asset.path);
  const bytes = await cache.load(asset, url);
  return new Uint8Array(bytes);
}

async function handleInit(req: InitRequest): Promise<void> {
  state.generation = req.generation;
  state.init = req;
  state.disposed = false;
  validateManifest(req.manifest);

  const caps = detectCapabilities();
  const chosen = chooseBackend(req.execution, caps);
  const threads = effectiveThreads(req.wasmThreads, caps);
  const warnings: string[] = [];
  if (threads.reason) warnings.push(threads.reason);

  const cache = new AssetCache({
    cacheName: req.cacheName,
    persistent: req.persistentCache,
    onProgress: (event) => post({ type: "progress", generation: req.generation, event }),
  });
  state.cache = cache;

  const ort = (await import("onnxruntime-web")) as unknown as Ort;
  state.ort = ort;
  configureOrtEnv(ort, { backend: chosen.backend, wasmThreads: threads.threads, runtimeBaseUrl: req.runtimeBaseUrl });

  const [detBytes, recBytes] = await Promise.all([
    loadModel(req, cache, "detector"),
    loadModel(req, cache, "recognizer-horizontal"),
  ]);
  post({ type: "progress", generation: req.generation, event: { phase: "initializing", message: "creating sessions" } });

  let backend: Backend = chosen.backend;
  let backendReason = chosen.reason;
  const tryCreate = async (b: Backend) => {
    const detector = await createSession(ort, detBytes, b, "detector");
    const recognizerH = await createSession(ort, recBytes, b, "recognizer-horizontal");
    return new OrtEngine(ort, { detector, recognizerH }, b, req.manifest.modelSetId);
  };
  let engine: OrtEngine;
  try {
    engine = await tryCreate(backend);
  } catch (e) {
    if (backend === "webgpu") {
      // One controlled fallback; report it honestly.
      backendReason = `webgpu session creation failed (${(e as Error).message}); fell back to wasm`;
      warnings.push(backendReason);
      backend = "wasm";
      engine = await tryCreate("wasm");
    } else {
      throw e;
    }
  }
  state.engine = engine;
  state.pipeline = {
    profile: req.profile,
    recognitionBatchSize: req.recognitionBatchSize,
    maxInputPixels: req.maxInputPixels,
    verticalEnabled: req.vertical !== "off",
  };
  post({
    type: "ready",
    generation: req.generation,
    backend,
    backendReason,
    threads: threads.threads,
    modelSetId: req.manifest.modelSetId,
    warnings,
  });
}

/** Lazily load the vertical recognizer on first vertical line. */
/** WebAssembly traps / aborts leave ORT unusable; other exceptions do not. */
function isRuntimeTrap(e: unknown): boolean {
  if (typeof WebAssembly !== "undefined" && e instanceof WebAssembly.RuntimeError) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /abort\(|RuntimeError|memory access out of bounds|unreachable/i.test(msg);
}

function engineWithLazyVertical(engine: OrtEngine): InferenceEngine {
  if (!state.init || state.init.vertical === "off") {
    return { backend: engine.backend, modelSetId: engine.modelSetId, detect: engine.detect.bind(engine), recognizeHorizontal: engine.recognizeHorizontal.bind(engine) };
  }
  return {
    backend: engine.backend,
    modelSetId: engine.modelSetId,
    detect: engine.detect.bind(engine),
    recognizeHorizontal: engine.recognizeHorizontal.bind(engine),
    recognizeVertical: async (batch: Float32Array, count: number): Promise<RecognitionOutputs> => {
      if (!engine.recognizeVertical) {
        if (!state.verticalLoading) {
          state.verticalLoading = (async () => {
            const req = state.init!;
            const bytes = await loadModel(req, state.cache!, "recognizer-vertical");
            const session = await createSession(state.ort!, bytes, engine.backend, "recognizer-vertical");
            engine.attachVertical(session);
          })().finally(() => {
            state.verticalLoading = null;
          });
        }
        await state.verticalLoading;
      }
      return engine.recognizeVertical!(batch, count);
    },
  };
}

async function handleScan(generation: number, requestId: number, frame: Parameters<typeof runPipeline>[1]): Promise<void> {
  if (!state.engine || !state.pipeline) {
    fail(generation, new MeikiOcrError("RUNTIME_INIT_FAILED", "worker not initialized"), false, requestId);
    return;
  }
  if (state.activeRequestId !== null) {
    fail(generation, new MeikiOcrError("BUSY", "worker busy"), false, requestId);
    return;
  }
  state.activeRequestId = requestId;
  try {
    const snapshot = await runPipeline(engineWithLazyVertical(state.engine), frame, state.pipeline);
    if (state.cancelled.delete(requestId) || state.disposed) {
      fail(generation, new AbortedError(), false, requestId);
      return;
    }
    post({ type: "result", generation, requestId, snapshot });
  } catch (e) {
    state.cancelled.delete(requestId);
    // Typed errors (asset, input, aborted...) are per-request. Unknown errors are
    // reported as INFERENCE_FAILED; they are fatal only if ORT itself is now unusable
    // (a WASM trap leaves the runtime in an undefined state).
    const fatal = e instanceof MeikiOcrError ? e.code === "WORKER_CRASHED" : isRuntimeTrap(e);
    fail(generation, e, fatal, requestId);
  } finally {
    state.activeRequestId = null;
  }
}

async function handleDispose(generation: number): Promise<void> {
  state.disposed = true;
  const engine = state.engine;
  state.engine = null;
  state.pipeline = null;
  if (engine) await engine.release().catch(() => undefined);
  post({ type: "disposed", generation });
  scope.close();
}

scope.onmessage = (ev: MessageEvent<ClientToWorker>) => {
  const msg = ev.data;
  if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") return;
  switch (msg.type) {
    case "init":
      handleInit(msg).catch((e) => fail(msg.generation, e, true));
      break;
    case "scan":
      if (msg.generation !== state.generation) return; // stale
      void handleScan(msg.generation, msg.requestId, msg.frame);
      break;
    case "cancel":
      if (msg.generation !== state.generation) return;
      if (state.activeRequestId === msg.requestId) state.cancelled.add(msg.requestId);
      break;
    case "clear-cache":
      (state.cache?.clear() ?? Promise.resolve())
        .then(() => post({ type: "cache-cleared", generation: msg.generation, requestId: msg.requestId }))
        .catch((e) => fail(msg.generation, e, false, msg.requestId));
      break;
    case "dispose":
      void handleDispose(msg.generation);
      break;
    default:
      break;
  }
};

export { DEFAULTS };
