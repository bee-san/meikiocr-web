import { MODEL_DIMS, NMS, SWAPPED_PAIRS } from "../defaults.js";
import type { OcrGlyph, OcrLine, Orientation, Rect } from "../api/types.js";
import type { CropMeta } from "../image/preprocess.js";

export interface RecognitionOutputs {
  /** Per batch item: K code points (int32/int64 acceptable). */
  labels: ArrayLike<number> | BigInt64Array;
  /** Flat [N*K*4] boxes in model-input pixels. */
  boxes: ArrayLike<number>;
  /** Flat [N*K] scores. */
  scores: ArrayLike<number>;
  /** Candidates per item (48 horizontal, 24 vertical). */
  perItem: number;
}

export interface CharCandidate {
  char: string;
  box: Rect;
  conf: number;
  interval: readonly [number, number];
}

export interface LineResult {
  boxIndex: number;
  text: string;
  chars: { char: string; box: Rect; conf: number }[];
  isVertical: boolean;
}

const PUNCT_RE = /^\p{P}$/u;

function labelAt(labels: ArrayLike<number> | BigInt64Array, i: number): number {
  const v = (labels as ArrayLike<number | bigint>)[i]!;
  return typeof v === "bigint" ? Number(v) : v;
}

/**
 * Port of the candidate-building half of `_postprocess_recognition_results`.
 * Returns candidates grouped by original box index (insertion-ordered).
 */
export function buildCandidates(
  out: RecognitionOutputs,
  metas: readonly CropMeta[],
  recThreshold: number,
  isVertical: boolean,
): Map<number, CharCandidate[]> {
  const byIdx = new Map<number, CharCandidate[]>();
  const K = out.perItem;
  for (let i = 0; i < metas.length; i++) {
    const meta = metas[i]!;
    const [gx1, gy1, gx2, gy2] = meta.origBox;
    const cropW = gx2 - gx1;
    const cropH = gy2 - gy1;
    let list = byIdx.get(meta.boxIndex);
    if (!list) {
      list = [];
      byIdx.set(meta.boxIndex, list);
    }
    for (let k = 0; k < K; k++) {
      const scr = out.scores[i * K + k]!;
      if (scr < recThreshold) continue;
      const code = labelAt(out.labels, i * K + k);
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) continue;
      const char = String.fromCodePoint(code);
      const o = (i * K + k) * 4;
      let rx1 = out.boxes[o]!;
      const ry1i = out.boxes[o + 1]!;
      let rx2 = out.boxes[o + 2]!;
      const ry2i = out.boxes[o + 3]!;
      let ry1 = ry1i;
      let ry2 = ry2i;
      if (![rx1, ry1, rx2, ry2].every(Number.isFinite)) continue;

      if (!isVertical) {
        const effW = meta.effectiveW;
        if (rx1 >= effW) continue;
        rx1 = Math.min(rx1, effW);
        rx2 = Math.min(rx2, effW);
        const cx1 = (rx1 / effW) * cropW;
        const cx2 = (rx2 / effW) * cropW;
        const cy1 = (ry1 / MODEL_DIMS.REC_HEIGHT) * cropH;
        const cy2 = (ry2 / MODEL_DIMS.REC_HEIGHT) * cropH;
        const ax1 = gx1 + Math.trunc(cx1);
        const ay1 = gy1 + Math.trunc(cy1);
        const ax2 = gx1 + Math.trunc(cx2);
        const ay2 = gy1 + Math.trunc(cy2);
        list.push({ char, box: [ax1, ay1, ax2, ay2], conf: scr, interval: [ax1, ax2] });
      } else {
        const effH = meta.effectiveH;
        if (ry1 >= effH) continue;
        ry1 = Math.min(ry1, effH);
        ry2 = Math.min(ry2, effH);
        const cx1 = (rx1 / MODEL_DIMS.VREC_WIDTH) * cropW;
        const cx2 = (rx2 / MODEL_DIMS.VREC_WIDTH) * cropW;
        const cy1 = (ry1 / effH) * cropH;
        const cy2 = (ry2 / effH) * cropH;
        const ax1 = gx1 + Math.trunc(cx1);
        const ay1 = gy1 + Math.trunc(cy1);
        const ax2 = gx1 + Math.trunc(cx2);
        const ay2 = gy1 + Math.trunc(cy2);
        if (ay2 <= ay1) continue;
        list.push({ char, box: [ax1, ay1, ax2, ay2], conf: scr, interval: [ay1, ay2] });
      }
    }
  }
  return byIdx;
}

/**
 * Port of the NMS/ordering/swap half of `_postprocess_recognition_results`.
 * Mutates candidate confidences for punctuation weighting like the reference.
 */
export function resolveCandidates(
  candidates: CharCandidate[],
  punctConfFactor: number,
  isVertical: boolean,
): { text: string; chars: { char: string; box: Rect; conf: number }[] } {
  const overlapThreshold = isVertical ? NMS.Y_OVERLAP_THRESHOLD : NMS.X_OVERLAP_THRESHOLD;
  if (punctConfFactor !== 1.0) {
    for (const c of candidates) {
      if (PUNCT_RE.test(c.char)) c.conf *= punctConfFactor;
    }
  }
  // Stable descending sort by confidence (Python sort(reverse=True) is stable).
  candidates.sort((a, b) => b.conf - a.conf);

  const accepted: CharCandidate[] = [];
  const acceptedIntervals: (readonly [number, number])[] = [];
  for (const cand of candidates) {
    const [i1c, i2c] = cand.interval;
    const lenC = i2c - i1c + NMS.EPSILON;
    let isOverlap = false;
    for (const [i1a, i2a] of acceptedIntervals) {
      if (i1c >= i2a || i1a >= i2c) continue;
      const interStart = Math.max(i1c, i1a);
      const interEnd = Math.min(i2c, i2a);
      const interLen = Math.max(0, interEnd - interStart);
      const lenA = i2a - i1a + NMS.EPSILON;
      const minLen = Math.min(lenC, lenA);
      if (interLen / minLen > overlapThreshold) {
        isOverlap = true;
        break;
      }
    }
    if (!isOverlap) {
      accepted.push(cand);
      acceptedIntervals.push(cand.interval);
    }
  }
  accepted.sort((a, b) => a.interval[0] - b.interval[0]);
  const chars = accepted.map((c) => ({ char: c.char, box: c.box, conf: c.conf }));
  return fixSwappedPairs(chars);
}

/**
 * Port of `_fix_swapped_pairs`. Operates on the code-point-indexed char array so
 * indices match Python string indexing (each char is a single code point).
 * Only the first occurrence of each pair is corrected, as upstream does.
 */
export function fixSwappedPairs(chars: { char: string; box: Rect; conf: number }[]): {
  text: string;
  chars: { char: string; box: Rect; conf: number }[];
} {
  const cps = chars.map((c) => c.char);
  for (const [wrong, correct] of SWAPPED_PAIRS) {
    const w = Array.from(wrong);
    const idx = findSeq(cps, w);
    if (idx !== -1 && idx + 1 < chars.length) {
      const c = Array.from(correct);
      // Upstream swaps the two char entries (text and glyph metadata move together).
      const a = chars[idx]!;
      const b = chars[idx + 1]!;
      chars[idx] = { char: b.char, box: a.box, conf: a.conf };
      chars[idx + 1] = { char: a.char, box: b.box, conf: b.conf };
      // Text takes `correct`, which equals the swapped chars for every upstream pair.
      cps[idx] = c[0]!;
      cps[idx + 1] = c[1]!;
    }
  }
  return { text: cps.join(""), chars };
}

function findSeq(hay: string[], needle: string[]): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Build an OcrLine (with UTF-16 offsets) from a resolved line result. */
export function toOcrLine(lineId: string, res: LineResult): OcrLine {
  const glyphs: OcrGlyph[] = [];
  let utf16 = 0;
  let text = "";
  for (let i = 0; i < res.chars.length; i++) {
    const ch = res.chars[i]!;
    const start = utf16;
    utf16 += ch.char.length;
    text += ch.char;
    glyphs.push({
      id: `${lineId}g${i}`,
      text: ch.char,
      box: ch.box,
      confidence: ch.conf,
      utf16Start: start,
      utf16End: utf16,
    });
  }
  const orientation: Orientation = res.isVertical ? "vertical" : "horizontal";
  return { id: lineId, text, box: unionBoxes(glyphs.map((g) => g.box)), orientation, glyphs };
}

export function unionBoxes(boxes: readonly Rect[]): Rect {
  if (boxes.length === 0) return [0, 0, 0, 0];
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const b of boxes) {
    if (b[0] < x0) x0 = b[0];
    if (b[1] < y0) y0 = b[1];
    if (b[2] > x1) x1 = b[2];
    if (b[3] > y1) y1 = b[3];
  }
  return [x0, y0, x1, y1];
}
