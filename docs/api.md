# API contract

Entry points:

- `meikiocr-web` — client/core (`createMeikiOcr`, errors, defaults, pure pipeline pieces).
- `meikiocr-web/meikipop` — pure layout/hit-testing helpers. No DOM.
- `meikiocr-web/worker` — the module-worker entry to bundle.

Importing any entry has no side effects (no worker, no fetch, no DOM).

## Types

See `src/api/types.ts`. Summary:

```ts
type Rect = readonly [x0, y0, x1, y1];                // source-image pixels, increasing edges
type OcrProfile = "meikipop-v2" | "meikiocr-native";

interface RgbaFrame { frameId; width; height; capturedAtMs; rgba: ArrayBuffer /* w*h*4 */ }
interface OcrGlyph  { id; text; box: Rect; confidence; utf16Start; utf16End }
interface OcrLine   { id; text; box: Rect; orientation; glyphs }
interface OcrSnapshot { frameId; width; height; profile; lines; diagnostics: { backend; elapsedMs; modelSetId; warnings } }
interface TextHit { paragraphId; lineId; glyphId; fullText; utf16Offset; codePointIndex; suffix; sourceBox }
```

## Functions

```ts
createMeikiOcr(options: MeikiOcrOptions): Promise<MeikiOcrClient>
client.scan(frame, { signal?, transfer?: "copy" | "move" }): Promise<OcrSnapshot>
client.dispose(): Promise<void>
client.clearCache(): Promise<void>

buildMeikiPopLayout(snapshot, { japaneseFilter?: boolean }): LayoutSnapshot
hitTestMeikiPop(layout, { x, y } /* image pixels */): TextHit | null
```

`MeikiOcrOptions`: `manifest` (AssetManifest), `assetBaseUrl` (must end with `/`),
`profile`, `execution` (`wasm` | `webgpu` | `auto`), `wasmThreads`, `vertical`
(`lazy` | `off`), `onProgress`, `recognitionBatchSize`, `maxInputPixels`,
`persistentCache`, and one of `workerFactory` (preferred for bundlers; called for
the first worker and each bounded restart), `workerUrl`, or `worker` (a single
instance: after a fatal failure it cannot be restarted and `scan` rejects with
`WorkerCrashedError`).

Defaults are exported once as `DEFAULTS` and `PROFILES` (import them; do not copy).

## Invariants

1. All public boxes are source-image pixels with increasing edges. Hit-testing
   boundaries are inclusive on all edges (MeikiPop semantics). Crop slicing in
   the pipeline is half-open `[x0, x1)` like numpy.
2. `line.text === line.glyphs.map(g => g.text).join("")`; glyph UTF-16 offsets
   are contiguous and cover the line. `LayoutParagraph.text` likewise equals
   the concatenation of its glyphs; `LayoutGlyph.utf16Start/End` and
   `codePointIndex` are paragraph-relative.
3. IDs are snapshot-local. Use your own generations to identify a current result.
4. Offsets are UTF-16; code point indices are provided alongside.
5. Empty results are `lines: []` snapshots. Failures are typed `MeikiOcrError`s
   with a `code` (`BUSY`, `DISPOSED`, `ABORTED`, `INVALID_INPUT`,
   `INPUT_TOO_LARGE`, `ASSET_*`, `MODEL_SIGNATURE_MISMATCH`,
   `RUNTIME_INIT_FAILED`, `INFERENCE_FAILED`, `WORKER_PROTOCOL_ERROR`,
   `WORKER_CRASHED`).
6. One active `scan`. A second concurrent call rejects with `BusyError`. There is
   no hidden queue: the integration coalesces intents.
7. `transfer: "copy"` (default) copies the buffer; `"move"` transfers it and the
   caller's `ArrayBuffer` is detached afterwards.
8. `dispose` is idempotent, rejects in-flight work with `DisposedError` once,
   releases sessions, terminates the worker, and makes further calls fail.

## Abort semantics

`signal.abort()` rejects the caller's promise immediately with `AbortedError` and
marks the request unwanted in the worker. An in-progress ONNX `run` is not
interrupted; its result is discarded when it finishes. The worker is not
recreated for cancellations. Until the worker reports that unwanted result, a
new `scan` rejects with `BusyError` (one active request, no hidden queue); the
consumer's latest-intent scheduler simply retries on its next opportunity.

## Fatal failures

A malformed reply, worker `error` event, or fatal worker error terminates the
worker. A scan with no reply within `scanTimeoutMs` (default 30 s) is treated as a
hung or silently terminated worker (browsers may kill workers without an error
event) and rejects with `WorkerCrashedError`. The next `scan` recreates it (up to `DEFAULTS.maxWorkerRestarts` times),
after which `WorkerCrashedError` is returned until `dispose`. A per-request
failure (asset fetch during lazy vertical loading, invalid input, an unexpected
exception that is not a WebAssembly trap) rejects only that request; the worker
and its sessions stay alive. `dispose()` during a pending (re)initialization
rejects the waiting callers with `DisposedError`.

## Diagnostics

`snapshot.diagnostics.backend` is the backend actually used. A WebGPU fallback to
WASM is reported in the `ready` progress message and in `warnings`; it is never
disguised as GPU acceleration. `warnings` also flags horizontal recognizer
saturation (48 candidates), skipped vertical lines when `vertical: "off"`, and
dropped non-finite detector predictions.
