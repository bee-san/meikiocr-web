import type { Backend, OcrLine, OcrProfile, OcrSnapshot, Rect, RgbaFrame } from "../api/types.js";
import { DEFAULTS, HORIZONTAL_RECOGNIZER_MAX_CHARS, MODEL_DIMS, PROFILES } from "../defaults.js";
import { InputTooLargeError, InvalidInputError } from "../errors.js";
import {
  preprocessForDetection,
  preprocessHorizontal,
  preprocessVertical,
  type RecognitionBatch,
} from "../image/preprocess.js";
import { postprocessDetection, type DetectionOutputs } from "./detect.js";
import {
  buildCandidates,
  resolveCandidates,
  toOcrLine,
  type CharCandidate,
  type LineResult,
  type RecognitionOutputs,
} from "./postprocess.js";

/** Minimal inference surface the pipeline needs; implemented over ORT in the worker. */
export interface InferenceEngine {
  readonly backend: Backend;
  readonly modelSetId: string;
  detect(tensor: Float32Array, origTargetSizes: BigInt64Array): Promise<DetectionOutputs>;
  recognizeHorizontal(batch: Float32Array, count: number): Promise<RecognitionOutputs>;
  /** May be undefined when vertical recognition is disabled. */
  recognizeVertical?: (batch: Float32Array, count: number) => Promise<RecognitionOutputs>;
}

export interface PipelineConfig {
  profile: OcrProfile;
  recognitionBatchSize: number;
  maxInputPixels: number;
  verticalEnabled: boolean;
}

export function validateFrame(frame: RgbaFrame, maxInputPixels: number): void {
  if (!frame || typeof frame !== "object") throw new InvalidInputError("frame must be an object");
  if (typeof frame.frameId !== "string" || frame.frameId.length === 0) {
    throw new InvalidInputError("frame.frameId must be a non-empty string");
  }
  if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width <= 0 || frame.height <= 0) {
    throw new InvalidInputError(`frame dimensions must be positive integers (got ${frame.width}x${frame.height})`);
  }
  if (frame.width * frame.height > maxInputPixels) {
    throw new InputTooLargeError(
      `frame ${frame.width}x${frame.height} exceeds maxInputPixels=${maxInputPixels}; downsample before scanning`,
    );
  }
  if (!(frame.rgba instanceof ArrayBuffer)) throw new InvalidInputError("frame.rgba must be an ArrayBuffer");
  const expected = frame.width * frame.height * 4;
  if (frame.rgba.byteLength !== expected) {
    throw new InvalidInputError(`frame.rgba has ${frame.rgba.byteLength} bytes; expected ${expected} (tightly packed RGBA8)`);
  }
}

/**
 * Run the full MeikiOCR pipeline (port of `MeikiOCR.run_ocr`) on an RGBA frame.
 */
export async function runPipeline(
  engine: InferenceEngine,
  frame: RgbaFrame,
  cfg: PipelineConfig,
  now: () => number = () => performance.now(),
): Promise<OcrSnapshot> {
  validateFrame(frame, cfg.maxInputPixels);
  const t0 = now();
  const params = PROFILES[cfg.profile];
  const warnings: string[] = [];
  const rgba = new Uint8Array(frame.rgba);
  const { width, height } = frame;

  // --- detection ---
  const det = preprocessForDetection(rgba, width, height, params.channelOrder);
  const t1 = now();
  const detOut = await engine.detect(det.tensor, det.origTargetSizes);
  const t2 = now();
  const boxes = postprocessDetection(detOut, width, height, params.detThreshold, warnings);

  const results = new Map<number, LineResult>();
  const hIdx: number[] = [];
  const vIdx: number[] = [];
  const rects: Rect[] = boxes.map((b) => b.box);
  rects.forEach((r, i) => {
    const w = r[2] - r[0];
    const h = r[3] - r[1];
    if (w <= 0 || h <= 0) return;
    if (h > w) vIdx.push(i);
    else hIdx.push(i);
  });

  let recPre = 0;
  let recRun = 0;
  let post = 0;

  const process = async (
    indices: number[],
    isVertical: boolean,
    pre: (idx: number[]) => RecognitionBatch | null,
    run: (batch: Float32Array, count: number) => Promise<RecognitionOutputs>,
  ): Promise<void> => {
    const a = now();
    const batch = pre(indices);
    const b = now();
    recPre += b - a;
    if (!batch) return;

    // Chunked inference like upstream (max_batch_size); concat outputs.
    const planeSize = 3 * batch.planeW * batch.planeH;
    const chunkSize = Math.max(1, Math.min(cfg.recognitionBatchSize, DEFAULTS.maxRecognitionBatchSize));
    const outs: RecognitionOutputs[] = [];
    for (let s = 0; s < batch.count; s += chunkSize) {
      const n = Math.min(chunkSize, batch.count - s);
      const sub = batch.tensor.subarray(s * planeSize, (s + n) * planeSize);
      outs.push(await run(sub, n));
    }
    const c = now();
    recRun += c - b;
    const merged = concatOutputs(outs);
    const cands = buildCandidates(merged, batch.metas, params.recThreshold, isVertical);
    for (const [boxIndex, list] of cands) {
      const resolved = resolveCandidates(list as CharCandidate[], params.punctConfFactor, isVertical);
      results.set(boxIndex, { boxIndex, text: resolved.text, chars: resolved.chars, isVertical });
      if (!isVertical && countAccepted(merged, boxIndex, batch.metas, params.recThreshold) >= HORIZONTAL_RECOGNIZER_MAX_CHARS) {
        warnings.push(`line ${boxIndex}: horizontal recognizer saturated (${HORIZONTAL_RECOGNIZER_MAX_CHARS} candidates)`);
      }
    }
    post += now() - c;
  };

  if (hIdx.length > 0) {
    await process(
      hIdx,
      false,
      (idx) => preprocessHorizontal(rgba, width, rects, idx, params.channelOrder),
      (b, n) => engine.recognizeHorizontal(b, n),
    );
  }
  if (vIdx.length > 0) {
    if (cfg.verticalEnabled && engine.recognizeVertical) {
      await process(
        vIdx,
        true,
        (idx) => preprocessVertical(rgba, width, rects, idx, params.channelOrder),
        (b, n) => engine.recognizeVertical!(b, n),
      );
    } else {
      warnings.push(`vertical recognition disabled; skipped ${vIdx.length} vertical box(es)`);
    }
  }

  // Preserve detector order (sorted by y0). Lines with no accepted characters are
  // omitted; upstream returns them as empty entries, which carry no geometry.
  const lines: OcrLine[] = [];
  for (let i = 0; i < rects.length; i++) {
    const r = results.get(i);
    if (!r || r.chars.length === 0) continue;
    lines.push(toOcrLine(`l${i}`, r));
  }

  const t3 = now();
  return {
    frameId: frame.frameId,
    width,
    height,
    profile: cfg.profile,
    lines,
    diagnostics: {
      backend: engine.backend,
      elapsedMs: t3 - t0,
      modelSetId: engine.modelSetId,
      warnings,
      timings: {
        detectPreprocessMs: t1 - t0,
        detectMs: t2 - t1,
        recognizePreprocessMs: recPre,
        recognizeMs: recRun,
        postprocessMs: post,
      },
    },
  };
}

function countAccepted(
  out: RecognitionOutputs,
  boxIndex: number,
  metas: readonly { boxIndex: number }[],
  thr: number,
): number {
  let n = 0;
  for (let i = 0; i < metas.length; i++) {
    if (metas[i]!.boxIndex !== boxIndex) continue;
    for (let k = 0; k < out.perItem; k++) if (out.scores[i * out.perItem + k]! >= thr) n++;
  }
  return n;
}

export function concatOutputs(outs: RecognitionOutputs[]): RecognitionOutputs {
  if (outs.length === 1) return outs[0]!;
  const perItem = outs[0]!.perItem;
  let total = 0;
  for (const o of outs) total += o.scores.length;
  const labels = new Float64Array(total);
  const scores = new Float32Array(total);
  const boxes = new Float32Array(total * 4);
  let off = 0;
  for (const o of outs) {
    const n = o.scores.length;
    for (let i = 0; i < n; i++) {
      const v = (o.labels as ArrayLike<number | bigint>)[i]!;
      labels[off + i] = typeof v === "bigint" ? Number(v) : v;
      scores[off + i] = o.scores[i]!;
    }
    for (let i = 0; i < n * 4; i++) boxes[off * 4 + i] = o.boxes[i]!;
    off += n;
  }
  return { labels, scores, boxes, perItem };
}

export { MODEL_DIMS };
