import type { Rect } from "../api/types.js";

export interface DetectedBox {
  box: Rect; // integer, clamped, source-image pixels
  score: number;
}

export interface DetectionOutputs {
  /** Flat [N*K*4] float boxes for batch item 0 (we always run N=1). */
  boxes: Float32Array | number[];
  /** Flat [N*K] float scores. */
  scores: Float32Array | number[];
  /** Number of candidate boxes K. */
  count: number;
}

/**
 * Port of `_postprocess_detection_results`:
 *  - keep `score > threshold` (strict),
 *  - clip to [0, w] / [0, h],
 *  - cast to int32 (truncation),
 *  - stable sort by y0.
 * Non-finite predictions are dropped and reported as warnings.
 */
export function postprocessDetection(
  out: DetectionOutputs,
  imgW: number,
  imgH: number,
  threshold: number,
  warnings: string[],
): DetectedBox[] {
  const kept: DetectedBox[] = [];
  let dropped = 0;
  for (let k = 0; k < out.count; k++) {
    const s = out.scores[k]!;
    if (!(s > threshold)) continue;
    const b0 = out.boxes[k * 4]!;
    const b1 = out.boxes[k * 4 + 1]!;
    const b2 = out.boxes[k * 4 + 2]!;
    const b3 = out.boxes[k * 4 + 3]!;
    if (!Number.isFinite(b0) || !Number.isFinite(b1) || !Number.isFinite(b2) || !Number.isFinite(b3)) {
      dropped++;
      continue;
    }
    const x0 = Math.trunc(clamp(b0, 0, imgW));
    const y0 = Math.trunc(clamp(b1, 0, imgH));
    const x1 = Math.trunc(clamp(b2, 0, imgW));
    const y1 = Math.trunc(clamp(b3, 0, imgH));
    kept.push({ box: [x0, y0, x1, y1], score: s });
  }
  if (dropped > 0) warnings.push(`detector: dropped ${dropped} non-finite box(es)`);
  // Array.prototype.sort is stable (ES2019+), matching Python's list.sort.
  kept.sort((a, b) => a.box[1] - b.box[1]);
  return kept;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
