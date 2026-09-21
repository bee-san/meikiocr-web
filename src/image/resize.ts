/**
 * Deterministic 8-bit interleaved-channel resizer that reproduces OpenCV's
 * `cv2.resize(..., interpolation=cv2.INTER_LINEAR)` for uint8 images.
 *
 * OpenCV specifics reproduced here:
 *  - Half-pixel-centre source mapping: fx = (dx + 0.5) * (sw / dw) - 0.5.
 *    On the x axis OpenCV zeroes the fractional weight at the edges
 *    (`sx < 0 -> sx = 0, fx = 0`; `sx >= sw - 1 -> sx = sw - 1, fx = 0`).
 *    On the y axis it keeps the raw weights and clamps the two row indices
 *    into range instead, which changes fixed-point truncation on edge rows.
 *  - `fx` is evaluated in single precision (OpenCV stores it in a float).
 *  - Fixed-point coefficients: each weight is independently rounded to
 *    `short(w * 2^11)` (INTER_RESIZE_COEF_SCALE); the horizontal pass produces
 *    int32 sums and the uchar vertical pass computes
 *    `(((b0 * (S0 >> 4)) >> 16) + ((b1 * (S1 >> 4)) >> 16) + 2) >> 2`.
 *  - Special case: INTER_LINEAR with an exact integer 2x downscale in both
 *    axes is redirected to INTER_AREA, which averages the 2x2 block with
 *    rounding `(sum + 2) >> 2`.
 *
 * The resizer works on any channel count (RGBA here); channels are independent.
 */

const COEF_BITS = 11;
const COEF_SCALE = 1 << COEF_BITS; // 2048

/** cvRound: round half to even (lrint semantics). */
function cvRound(x: number): number {
  const r = Math.round(x);
  if (Math.abs(x % 1) === 0.5) {
    const f = Math.floor(x);
    return f % 2 === 0 ? f : f + 1;
  }
  return r;
}

export interface ResizeResult {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

interface Axis {
  idx: Int32Array; // source index of first sample per destination coordinate
  a0: Int32Array; // fixed-point weight of first sample
  a1: Int32Array; // fixed-point weight of second sample
}

function computeAxis(srcSize: number, dstSize: number, clampWeights: boolean): Axis {
  const idx = new Int32Array(dstSize);
  const a0 = new Int32Array(dstSize);
  const a1 = new Int32Array(dstSize);
  const scale = srcSize / dstSize;
  for (let d = 0; d < dstSize; d++) {
    // OpenCV: fx = (float)((dx + 0.5) * scale_x - 0.5); sx = cvFloor(fx); fx -= sx;
    let f = Math.fround((d + 0.5) * scale - 0.5);
    let s = Math.floor(f);
    f = Math.fround(f - s);
    if (clampWeights) {
      if (s < 0) {
        f = 0;
        s = 0;
      }
      if (s >= srcSize - 1) {
        f = 0;
        s = srcSize - 1;
      }
    }
    idx[d] = s;
    // saturate_cast<short>(cbuf[k] * INTER_RESIZE_COEF_SCALE), each rounded independently.
    a0[d] = cvRound(Math.fround(Math.fround(1 - f) * COEF_SCALE));
    a1[d] = cvRound(Math.fround(f * COEF_SCALE));
  }
  return { idx, a0, a1 };
}

function resizeArea2x(
  src: Uint8Array | Uint8ClampedArray,
  sw: number,
  sh: number,
  channels: number,
): ResizeResult {
  const dw = sw >> 1;
  const dh = sh >> 1;
  const out = new Uint8ClampedArray(dw * dh * channels);
  for (let y = 0; y < dh; y++) {
    const r0 = 2 * y * sw * channels;
    const r1 = r0 + sw * channels;
    for (let x = 0; x < dw; x++) {
      const c0 = 2 * x * channels;
      const c1 = c0 + channels;
      const o = (y * dw + x) * channels;
      for (let c = 0; c < channels; c++) {
        const sum =
          src[r0 + c0 + c]! + src[r0 + c1 + c]! + src[r1 + c0 + c]! + src[r1 + c1 + c]!;
        out[o + c] = (sum + 2) >> 2;
      }
    }
  }
  return { data: out, width: dw, height: dh };
}

/**
 * Resize an interleaved uint8 image with `channels` channels to `dw` x `dh`.
 * Throws on non-positive dimensions.
 */
export function resizeLinearCv(
  src: Uint8Array | Uint8ClampedArray,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  channels = 4,
): ResizeResult {
  if (!(sw > 0 && sh > 0 && dw > 0 && dh > 0)) {
    throw new RangeError(`resize: invalid dimensions ${sw}x${sh} -> ${dw}x${dh}`);
  }
  if (src.length < sw * sh * channels) {
    throw new RangeError("resize: source buffer too small");
  }
  if (sw === dw && sh === dh) {
    return { data: Uint8ClampedArray.from(src.subarray(0, sw * sh * channels)), width: dw, height: dh };
  }
  if (sw === dw * 2 && sh === dh * 2) {
    return resizeArea2x(src, sw, sh, channels);
  }

  const ax = computeAxis(sw, dw, true);
  const ay = computeAxis(sh, dh, false);
  const out = new Uint8ClampedArray(dw * dh * channels);
  // Horizontal pass into two int32 row buffers, then vertical blend.
  const rowBuf0 = new Int32Array(dw * channels);
  const rowBuf1 = new Int32Array(dw * channels);

  const hResize = (sy: number, buf: Int32Array): void => {
    const rowOff = sy * sw * channels;
    for (let x = 0; x < dw; x++) {
      const sx = ax.idx[x]!;
      const w0 = ax.a0[x]!;
      const w1 = ax.a1[x]!;
      const sx1 = sx + 1 < sw ? sx + 1 : sx;
      const p0 = rowOff + sx * channels;
      const p1 = rowOff + sx1 * channels;
      const o = x * channels;
      for (let c = 0; c < channels; c++) {
        buf[o + c] = src[p0 + c]! * w0 + src[p1 + c]! * w1;
      }
    }
  };

  let cached0 = -1;
  let cached1 = -1;
  for (let y = 0; y < dh; y++) {
    // Row indices are clipped into [0, sh-1] (OpenCV `clip`), weights untouched.
    const sy = clipIndex(ay.idx[y]!, sh);
    const sy1 = clipIndex(ay.idx[y]! + 1, sh);
    if (cached0 !== sy) {
      if (cached1 === sy) {
        rowBuf0.set(rowBuf1);
      } else {
        hResize(sy, rowBuf0);
      }
      cached0 = sy;
    }
    if (cached1 !== sy1) {
      hResize(sy1, rowBuf1);
      cached1 = sy1;
    }
    const b0 = ay.a0[y]!;
    const b1 = ay.a1[y]!;
    const oRow = y * dw * channels;
    for (let i = 0; i < dw * channels; i++) {
      // OpenCV VResizeLinear<uchar,...> fixed-point formula (all operands non-negative).
      const v = (((b0 * (rowBuf0[i]! >> 4)) >> 16) + ((b1 * (rowBuf1[i]! >> 4)) >> 16) + 2) >> 2;
      out[oRow + i] = v; // Uint8ClampedArray saturates
    }
  }
  return { data: out, width: dw, height: dh };
}

function clipIndex(x: number, size: number): number {
  return x < 0 ? 0 : x >= size ? size - 1 : x;
}

/** Crop a region [x0,x1) x [y0,y1) from an interleaved image. */
export function cropInterleaved(
  src: Uint8Array | Uint8ClampedArray,
  sw: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  channels = 4,
): ResizeResult {
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return { data: new Uint8ClampedArray(0), width: Math.max(0, w), height: Math.max(0, h) };
  const out = new Uint8ClampedArray(w * h * channels);
  for (let y = 0; y < h; y++) {
    const s = ((y0 + y) * sw + x0) * channels;
    out.set(src.subarray(s, s + w * channels), y * w * channels);
  }
  return { data: out, width: w, height: h };
}

/**
 * Python's `round()` (round half to even), which differs from JS Math.round
 * on exact .5 values. Used where the reference uses `int(round(x))`.
 */
export function pyRound(x: number): number {
  const r = Math.round(x);
  if (Math.abs(x % 1) === 0.5) {
    // exact half: choose even
    const f = Math.floor(x);
    return f % 2 === 0 ? f : f + 1;
  }
  return r;
}
