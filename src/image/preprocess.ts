import { MODEL_DIMS } from "../defaults.js";
import type { Rect } from "../api/types.js";
import { cropInterleaved, pyRound, resizeLinearCv } from "./resize.js";

export type ChannelOrder = "rgb" | "bgr";

/**
 * Pack an interleaved RGBA8 image into an NCHW float32 tensor plane set of
 * `planeW` x `planeH`, placing content at the upper-left and leaving zeros
 * (black) elsewhere. Values are divided by 255. Channel order selects whether
 * plane 0 is R (rgb) or B (bgr), mirroring numpy RGB vs OpenCV BGR arrays.
 */
export function packNchw(
  rgba: Uint8Array | Uint8ClampedArray,
  contentW: number,
  contentH: number,
  planeW: number,
  planeH: number,
  order: ChannelOrder,
  out?: Float32Array,
  outOffset = 0,
): Float32Array {
  const planeSize = planeW * planeH;
  const tensor = out ?? new Float32Array(3 * planeSize);
  if (out === undefined) {
    // fresh array is already zero
  } else {
    tensor.fill(0, outOffset, outOffset + 3 * planeSize);
  }
  const c0 = order === "rgb" ? 0 : 2;
  const c2 = order === "rgb" ? 2 : 0;
  const inv = 1 / 255;
  for (let y = 0; y < contentH; y++) {
    const srcRow = y * contentW * 4;
    const dstRow = y * planeW;
    for (let x = 0; x < contentW; x++) {
      const s = srcRow + x * 4;
      const d = outOffset + dstRow + x;
      tensor[d] = rgba[s + c0]! * inv;
      tensor[d + planeSize] = rgba[s + 1]! * inv;
      tensor[d + 2 * planeSize] = rgba[s + c2]! * inv;
    }
  }
  return tensor;
}

export interface DetectorInput {
  tensor: Float32Array; // [1,3,544,960]
  /** int64 [[DET_WIDTH/scale, DET_HEIGHT/scale]] truncated like numpy int64 cast. */
  origTargetSizes: BigInt64Array;
  scale: number;
  resizedWidth: number;
  resizedHeight: number;
}

/** Port of `_preprocess_for_detection` + `_run_detection_inference` size metadata. */
export function preprocessForDetection(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  order: ChannelOrder,
): DetectorInput {
  const { DET_WIDTH, DET_HEIGHT } = MODEL_DIMS;
  const scale = Math.min(DET_WIDTH / width, DET_HEIGHT / height);
  // Python int() truncates toward zero.
  const wResized = Math.max(1, Math.trunc(width * scale));
  const hResized = Math.max(1, Math.trunc(height * scale));
  const resized = resizeLinearCv(rgba, width, height, wResized, hResized, 4);
  const tensor = packNchw(resized.data, wResized, hResized, DET_WIDTH, DET_HEIGHT, order);
  const origTargetSizes = new BigInt64Array([
    BigInt(Math.trunc(DET_WIDTH / scale)),
    BigInt(Math.trunc(DET_HEIGHT / scale)),
  ]);
  return { tensor, origTargetSizes, scale, resizedWidth: wResized, resizedHeight: hResized };
}

export interface CropMeta {
  /** Index of the detected text box this tensor belongs to. */
  boxIndex: number;
  /** Original crop rectangle in source-image pixels (integers, x1/y1 exclusive). */
  origBox: Rect;
  effectiveW: number;
  effectiveH: number;
  segmentIdx: number;
}

export interface RecognitionBatch {
  /** [N, 3, H, W] contiguous. */
  tensor: Float32Array;
  count: number;
  planeW: number;
  planeH: number;
  metas: CropMeta[];
}

/**
 * Port of `_preprocess_for_recognition` for horizontal lines.
 * Boxes must already be integer, clamped, with x1 > x0 and y1 > y0.
 */
export function preprocessHorizontal(
  rgba: Uint8Array | Uint8ClampedArray,
  imgW: number,
  boxes: readonly Rect[],
  indices: readonly number[],
  order: ChannelOrder,
): RecognitionBatch | null {
  const { REC_WIDTH, REC_HEIGHT } = MODEL_DIMS;
  const planeSize = REC_WIDTH * REC_HEIGHT;
  const metas: CropMeta[] = [];
  const tensors: Float32Array[] = [];

  for (const i of indices) {
    const [x1, y1, x2, y2] = boxes[i]!;
    const crop = cropInterleaved(rgba, imgW, x1, y1, x2, y2, 4);
    if (crop.width === 0 || crop.height === 0) continue;
    const h = crop.height;
    const w = crop.width;

    let newH: number = REC_HEIGHT;
    const scale = newH / h;
    let newW = Math.trunc(pyRound(w * scale));
    if (newW > REC_WIDTH) {
      const scaleW = REC_WIDTH / newW;
      newW = REC_WIDTH;
      newH = Math.trunc(pyRound(newH * scaleW));
    }
    if (newW < 1) newW = 1;
    if (newH < 1) newH = 1;

    const resized = resizeLinearCv(crop.data, w, h, newW, newH, 4);
    const t = new Float32Array(3 * planeSize);
    packNchw(resized.data, newW, newH, REC_WIDTH, REC_HEIGHT, order, t, 0);
    tensors.push(t);
    metas.push({ boxIndex: i, origBox: [x1, y1, x2, y2], effectiveW: newW, effectiveH: newH, segmentIdx: 0 });
  }
  if (tensors.length === 0) return null;
  const tensor = new Float32Array(tensors.length * 3 * planeSize);
  tensors.forEach((t, n) => tensor.set(t, n * 3 * planeSize));
  return { tensor, count: tensors.length, planeW: REC_WIDTH, planeH: REC_HEIGHT, metas };
}

/**
 * Port of `_preprocess_for_recognition` for vertical lines, including the
 * 420-px content / 64-px overlap segmentation when a line exceeds 480 scaled px.
 */
export function preprocessVertical(
  rgba: Uint8Array | Uint8ClampedArray,
  imgW: number,
  boxes: readonly Rect[],
  indices: readonly number[],
  order: ChannelOrder,
): RecognitionBatch | null {
  const { VREC_WIDTH, VREC_HEIGHT, VREC_MAX_CONTENT_HEIGHT, VREC_OVERLAP_PX } = MODEL_DIMS;
  const planeSize = VREC_WIDTH * VREC_HEIGHT;
  const metas: CropMeta[] = [];
  const tensors: Float32Array[] = [];

  for (const i of indices) {
    const [x1, y1, x2, y2] = boxes[i]!;
    const w = x2 - x1;
    const h = y2 - y1;
    if (w <= 0 || h <= 0) continue;

    const scale = VREC_WIDTH / w;
    const hScaledFull = h * scale;

    let maxHScaled: number;
    let yStarts: number[];
    let segmentHOrig: number;

    if (hScaledFull > VREC_HEIGHT) {
      maxHScaled = VREC_MAX_CONTENT_HEIGHT;
      segmentHOrig = VREC_MAX_CONTENT_HEIGHT / scale;
      const strideOrig = (VREC_MAX_CONTENT_HEIGHT - VREC_OVERLAP_PX) / scale;
      yStarts = [];
      let currY = y1;
      while (currY + segmentHOrig < y2) {
        yStarts.push(currY);
        currY += strideOrig;
      }
      const lastY = y2 - segmentHOrig;
      if (yStarts.length === 0 || lastY > yStarts[yStarts.length - 1]! + 1.0) {
        yStarts.push(lastY);
      }
    } else {
      maxHScaled = VREC_HEIGHT;
      yStarts = [y1];
      segmentHOrig = y2 - y1;
    }

    for (let segIdx = 0; segIdx < yStarts.length; segIdx++) {
      const sy1f = yStarts[segIdx]!;
      const sy1 = Math.trunc(pyRound(sy1f));
      let sy2 = Math.trunc(pyRound(sy1f + segmentHOrig));
      sy2 = Math.min(sy2, y2);
      const segCrop = cropInterleaved(rgba, imgW, x1, sy1, x2, sy2, 4);
      const segH = segCrop.height;
      if (segH <= 0) continue;

      let segNewH = Math.min(Math.trunc(pyRound(segH * scale)), maxHScaled);
      if (segNewH < 1) segNewH = 1;
      const resized = resizeLinearCv(segCrop.data, segCrop.width, segH, VREC_WIDTH, segNewH, 4);
      const t = new Float32Array(3 * planeSize);
      packNchw(resized.data, VREC_WIDTH, segNewH, VREC_WIDTH, VREC_HEIGHT, order, t, 0);
      tensors.push(t);
      metas.push({
        boxIndex: i,
        origBox: [x1, sy1, x2, sy2],
        effectiveW: VREC_WIDTH,
        effectiveH: segNewH,
        segmentIdx: segIdx,
      });
    }
  }
  if (tensors.length === 0) return null;
  const tensor = new Float32Array(tensors.length * 3 * planeSize);
  tensors.forEach((t, n) => tensor.set(t, n * 3 * planeSize));
  return { tensor, count: tensors.length, planeW: VREC_WIDTH, planeH: VREC_HEIGHT, metas };
}
