import { describe, expect, it } from "vitest";
import { cropInterleaved, pyRound, resizeLinearCv } from "../../src/image/resize.js";
import { packNchw, preprocessForDetection, preprocessHorizontal, preprocessVertical } from "../../src/image/preprocess.js";
import { MODEL_DIMS } from "../../src/defaults.js";

describe("pyRound (Python banker's rounding)", () => {
  it("rounds half to even", () => {
    expect(pyRound(0.5)).toBe(0);
    expect(pyRound(1.5)).toBe(2);
    expect(pyRound(2.5)).toBe(2);
    expect(pyRound(3.5)).toBe(4);
    expect(pyRound(-0.5) === 0).toBe(true);
    expect(pyRound(-1.5)).toBe(-2);
    expect(pyRound(-2.5)).toBe(-2);
  });
  it("matches Math.round away from .5", () => {
    for (const v of [0.49, 0.51, 2.2, 2.7, -2.2, -2.7, 100.001]) expect(pyRound(v)).toBe(Math.round(v));
  });
});

function solid(w: number, h: number, rgba: [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) out.set(rgba, i * 4);
  return out;
}

describe("resizeLinearCv", () => {
  it("is identity at same size", () => {
    const src = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const r = resizeLinearCv(src, 2, 1, 2, 1, 4);
    expect(Array.from(r.data)).toEqual(Array.from(src));
  });
  it("preserves solid colors at any scale", () => {
    const src = solid(37, 11, [200, 100, 50, 255]);
    for (const [dw, dh] of [
      [10, 3],
      [960, 32],
      [18, 5],
    ] as const) {
      const r = resizeLinearCv(src, 37, 11, dw, dh, 4);
      for (let i = 0; i < r.data.length; i += 4) {
        expect(r.data[i]).toBe(200);
        expect(r.data[i + 1]).toBe(100);
        expect(r.data[i + 2]).toBe(50);
      }
    }
  });
  it("uses the OpenCV INTER_AREA fast path for exact 2x downscale", () => {
    // 2x2 block of 0,0,255,255 -> average 127.5 -> (510+2)>>2 = 128
    const src = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255]);
    const r = resizeLinearCv(src, 2, 2, 1, 1, 4);
    expect(r.data[0]).toBe(128);
  });
  it("bilinear upscale with half-pixel centres matches OpenCV fixed-point", () => {
    // 2x1 grayscale-in-RGBA [0, 255] -> 4x1.
    // OpenCV INTER_LINEAR gives [0, 64, 191, 255].
    const src = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]);
    const r = resizeLinearCv(src, 2, 1, 4, 1, 4);
    expect([r.data[0], r.data[4], r.data[8], r.data[12]]).toEqual([0, 64, 191, 255]);
  });
  it("rejects invalid dimensions", () => {
    expect(() => resizeLinearCv(new Uint8Array(4), 1, 1, 0, 1)).toThrow(RangeError);
  });
});

describe("cropInterleaved", () => {
  it("extracts the right region", () => {
    const w = 3;
    const src = new Uint8Array(w * 2 * 4);
    for (let i = 0; i < src.length; i++) src[i] = i;
    const c = cropInterleaved(src, w, 1, 1, 3, 2, 4);
    expect(c.width).toBe(2);
    expect(c.height).toBe(1);
    expect(Array.from(c.data)).toEqual(Array.from(src.subarray((1 * w + 1) * 4, (1 * w + 3) * 4)));
  });
});

describe("packNchw", () => {
  it("packs rgb vs bgr order and normalizes by 255", () => {
    const px = new Uint8Array([255, 0, 51, 255]);
    const rgb = packNchw(px, 1, 1, 2, 2, "rgb");
    const bgr = packNchw(px, 1, 1, 2, 2, "bgr");
    expect(rgb.length).toBe(12);
    expect(rgb[0]).toBeCloseTo(1);
    expect(rgb[4]).toBeCloseTo(0);
    expect(rgb[8]).toBeCloseTo(51 / 255);
    expect(bgr[0]).toBeCloseTo(51 / 255);
    expect(bgr[8]).toBeCloseTo(1);
    // padding stays zero
    expect(rgb[1]).toBe(0);
    expect(rgb[3]).toBe(0);
  });
});

describe("preprocessForDetection", () => {
  it("computes scale, truncated sizes and int64 metadata like the reference", () => {
    const w = 301,
      h = 45;
    const d = preprocessForDetection(solid(w, h, [10, 20, 30, 255]), w, h, "rgb");
    const scale = Math.min(960 / w, 544 / h);
    expect(d.scale).toBe(scale);
    expect(d.resizedWidth).toBe(Math.trunc(w * scale));
    expect(d.resizedHeight).toBe(Math.trunc(h * scale));
    expect(d.tensor.length).toBe(3 * 960 * 544);
    expect(Number(d.origTargetSizes[0])).toBe(Math.trunc(960 / scale));
    expect(Number(d.origTargetSizes[1])).toBe(Math.trunc(544 / scale));
    // content top-left, padded bottom/right
    expect(d.tensor[0]).toBeCloseTo(10 / 255);
    expect(d.tensor[(d.resizedHeight - 1) * 960 + d.resizedWidth - 1]).toBeCloseTo(10 / 255);
    if (d.resizedWidth < 960) expect(d.tensor[d.resizedWidth]).toBe(0);
    expect(d.tensor[d.resizedHeight * 960]).toBe(0); // first padded row
  });
});

describe("preprocessHorizontal", () => {
  it("scales to height 32 with Python rounding and pads to 960", () => {
    const img = solid(100, 40, [255, 255, 255, 255]);
    const b = preprocessHorizontal(img, 100, [[0, 0, 100, 40]], [0], "rgb")!;
    expect(b.count).toBe(1);
    expect(b.metas[0]!.effectiveH).toBe(32);
    expect(b.metas[0]!.effectiveW).toBe(Math.trunc(pyRound(100 * (32 / 40)))); // 80
    expect(b.tensor.length).toBe(3 * 960 * 32);
    // padded area is zero
    const planeW = MODEL_DIMS.REC_WIDTH;
    expect(b.tensor[80]).toBe(0);
    expect(b.tensor[79]).toBeCloseTo(1);
    expect(b.tensor[planeW * 31 + 79]).toBeCloseTo(1);
  });
  it("constrains oversized lines to 960 wide and reduces height", () => {
    const img = solid(4000, 32, [255, 255, 255, 255]);
    const b = preprocessHorizontal(img, 4000, [[0, 0, 4000, 32]], [0], "rgb")!;
    expect(b.metas[0]!.effectiveW).toBe(960);
    expect(b.metas[0]!.effectiveH).toBe(Math.trunc(pyRound(32 * (960 / 4000)))); // 8
  });
  it("skips empty crops", () => {
    const img = solid(10, 10, [0, 0, 0, 255]);
    expect(preprocessHorizontal(img, 10, [[5, 5, 5, 8]], [0], "rgb")).toBeNull();
  });
});

describe("preprocessVertical", () => {
  it("does not split lines that fit in 480 scaled px", () => {
    const img = solid(20, 200, [255, 255, 255, 255]);
    const b = preprocessVertical(img, 20, [[0, 0, 20, 200]], [0], "rgb")!;
    expect(b.count).toBe(1);
    expect(b.metas[0]!.effectiveH).toBe(320); // 200 * (32/20)
  });
  it("splits long vertical lines with 420 content / 64 overlap", () => {
    // width 32 -> scale 1; height 1000 > 480 -> segments of 420 with stride 356
    const img = solid(32, 1000, [255, 255, 255, 255]);
    const b = preprocessVertical(img, 32, [[0, 0, 32, 1000]], [0], "rgb")!;
    // y_starts: 0, 356 (356+420<1000), 712? 712+420=1132 not < 1000 -> stop; last = 580 > 356+1 -> append
    expect(b.metas.map((m) => m.origBox[1])).toEqual([0, 356, 580]);
    expect(b.metas.map((m) => m.origBox[3])).toEqual([420, 776, 1000]);
    expect(b.metas.every((m) => m.effectiveH === 420)).toBe(true);
  });
});
