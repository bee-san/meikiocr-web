/**
 * Public data contract for meikiocr-web.
 *
 * All boxes are expressed in pixels of the image supplied to `scan()`, with
 * increasing edges (x0 <= x1, y0 <= y1). No CSS or model coordinates leak out.
 */

export type Rect = readonly [x0: number, y0: number, x1: number, y1: number];

/**
 * Preprocessing profile.
 *
 * - `meikipop-v2`: matches MeikiPop's MeikiOCR provider: RGB channel order,
 *   detection threshold 0.5, recognition threshold 0.1, punctuation confidence
 *   factor 0.2.
 * - `meikiocr-native`: matches the native MeikiOCR/OpenCV reference: BGR channel
 *   order, detection threshold 0.5, recognition threshold 0.1, punctuation
 *   confidence factor 1.0.
 */
export type OcrProfile = "meikipop-v2" | "meikiocr-native";

export type Orientation = "horizontal" | "vertical";

export type ExecutionPreference = "wasm" | "webgpu" | "auto";
export type Backend = "wasm" | "webgpu";
export type VerticalMode = "lazy" | "off";

export interface RgbaFrame {
  frameId: string;
  width: number;
  height: number;
  /** Caller's monotonic clock; same timebase for all of its frames. */
  capturedAtMs: number;
  /** Exactly width * height * 4 bytes, tightly packed RGBA8. */
  rgba: ArrayBuffer;
}

export interface OcrGlyph {
  /** Stable within this snapshot only. */
  id: string;
  /** One or more Unicode scalars; never assume a single UTF-16 code unit. */
  text: string;
  box: Rect;
  confidence: number;
  /** UTF-16 offsets within the owning OcrLine.text. */
  utf16Start: number;
  utf16End: number;
}

export interface OcrLine {
  id: string;
  /** Must equal the concatenation of glyph texts, in order. */
  text: string;
  box: Rect;
  orientation: Orientation;
  glyphs: readonly OcrGlyph[];
}

export interface OcrDiagnostics {
  backend: Backend;
  elapsedMs: number;
  modelSetId: string;
  warnings: readonly string[];
  /** Optional finer timings; not guaranteed to be present. */
  timings?: {
    detectPreprocessMs?: number;
    detectMs?: number;
    recognizePreprocessMs?: number;
    recognizeMs?: number;
    postprocessMs?: number;
  };
}

export interface OcrSnapshot {
  frameId: string;
  width: number;
  height: number;
  profile: OcrProfile;
  lines: readonly OcrLine[];
  diagnostics: OcrDiagnostics;
}

/** Result of a MeikiPop-style pointer hit test. */
export interface TextHit {
  paragraphId: string;
  lineId: string;
  glyphId: string;
  fullText: string;
  /** UTF-16 offset within fullText. */
  utf16Offset: number;
  codePointIndex: number;
  /** fullText.slice(utf16Offset) */
  suffix: string;
  sourceBox: Rect;
}

export type ProgressPhase =
  | "fetching"
  | "verifying"
  | "initializing"
  | "ready";

export interface ProgressEvent {
  phase: ProgressPhase;
  /** Asset currently in progress, when applicable. */
  asset?: string;
  loadedBytes?: number;
  totalBytes?: number;
  message?: string;
}

export interface ModelAsset {
  /** Logical role in the pipeline. */
  role: "detector" | "recognizer-horizontal" | "recognizer-vertical";
  /** Path relative to `assetBaseUrl`, or an absolute URL. */
  path: string;
  sha256: string;
  byteLength: number;
}

export interface RuntimeAsset {
  /** Path (relative to `assetBaseUrl`) of an ONNX Runtime Web file (.wasm/.mjs). */
  path: string;
  sha256?: string;
  byteLength?: number;
}

export interface AssetManifest {
  /** Identifies the model set; recorded in diagnostics and cache keys. */
  modelSetId: string;
  models: readonly ModelAsset[];
  /** Runtime files served alongside the models (ORT wasm/mjs). */
  runtime?: readonly RuntimeAsset[];
}

export interface MeikiOcrOptions {
  manifest: AssetManifest;
  /** Base URL from which relative manifest paths are resolved. Must end with '/'. */
  assetBaseUrl: string;
  profile?: OcrProfile;
  execution?: ExecutionPreference;
  /** Number of WASM threads. Default 1. >1 requires cross-origin isolation. */
  wasmThreads?: number;
  vertical?: VerticalMode;
  onProgress?: (event: ProgressEvent) => void;
  /** Recognition batch size; bounded. */
  recognitionBatchSize?: number;
  /** Maximum accepted scan input in pixels. */
  maxInputPixels?: number;
  /** Persistent model cache. Default true when Cache Storage is available. */
  persistentCache?: boolean;
  /**
   * Hang detection: if the worker has not answered a scan within this many ms it is
   * considered dead (a silently terminated worker emits no error event); the request
   * rejects with `WorkerCrashedError` and the next scan performs a bounded restart.
   * Default `DEFAULTS.scanTimeoutMs` (30 s); 0 disables.
   */
  scanTimeoutMs?: number;
  /**
   * URL of the worker script. Defaults to the library-provided worker entry.
   * Consumers bundling with Vite/Angular can pass `new URL('meikiocr-web/worker', import.meta.url)`.
   */
  workerUrl?: string | URL;
  /**
   * Preferred for bundlers that need a static `new Worker(new URL(...))` expression
   * (Angular, Vite, webpack): a factory the client calls for the first worker AND
   * for each bounded restart after a fatal failure.
   */
  workerFactory?: () => Worker;
  /**
   * A single pre-constructed Worker. Because a terminated Worker cannot be
   * restarted, a fatal failure is final for this client: further `scan` calls
   * reject with `WorkerCrashedError` (code `WORKER_CRASHED`) until it is
   * re-created by the caller. Prefer `workerFactory`.
   */
  worker?: Worker;
}

export interface ScanOptions {
  signal?: AbortSignal;
  /**
   * `copy` (default): the frame buffer is copied to the worker; the caller keeps it.
   * `move`: the buffer is transferred and detached; the caller must not reuse it.
   */
  transfer?: "copy" | "move";
}

export interface MeikiOcrClient {
  readonly profile: OcrProfile;
  readonly backend: Backend;
  readonly modelSetId: string;
  scan(frame: RgbaFrame, options?: ScanOptions): Promise<OcrSnapshot>;
  dispose(): Promise<void>;
  /** Removes only OCR assets owned by this library from Cache Storage. */
  clearCache(): Promise<void>;
}
