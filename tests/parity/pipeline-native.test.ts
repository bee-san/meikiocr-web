/**
 * Full-pipeline parity against the pinned native MeikiOCR reference.
 *
 * Fixtures are produced by tools/generate-reference-fixtures.py (native
 * onnxruntime + OpenCV). This test runs the TypeScript port on ONNX Runtime
 * Web's WASM build under Node and compares, per profile:
 *   - detector tensor snapshot (shape, sum, sampled values) and int64 metadata,
 *   - accepted text per line, in order,
 *   - per-character boxes (exact integers) and confidences (tolerance below).
 *
 * Tolerances (recorded here, not broadened retroactively):
 *   detector tensor sampled values: exact (uint8/255 in float32)
 *   detector tensor sum: |Δ| <= 1e-2 (float32 accumulation order)
 *   character confidence: |Δ| <= 2e-3 (CPU EP vs WASM EP kernels)
 *   boxes: exact
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type * as OrtNs from "onnxruntime-web";
import type { OcrProfile } from "../../src/api/types.js";
import { PROFILES } from "../../src/defaults.js";
import { preprocessForDetection } from "../../src/image/preprocess.js";
import { runPipeline } from "../../src/ocr/pipeline.js";
import { OrtEngine } from "../../src/runtime/session.js";

interface RefChar {
  char: string;
  bbox: number[];
  conf: number;
}
interface RefLine {
  text: string;
  isVertical: boolean;
  chars: RefChar[];
}
interface RefProfile {
  detector: {
    scale: number;
    origTargetSizes: [number, number];
    tensor: { shape: number[]; sum: number; sampleIdx: number[]; sampleVal: number[] };
    boxes: number[][];
  };
  lines: RefLine[];
}
interface RefCase {
  name: string;
  rgba: string;
  width: number;
  height: number;
  profiles: Record<OcrProfile, RefProfile>;
}

const fixtureDir = join(__dirname, "..", "fixtures", "parity");
const modelDir = join(__dirname, "..", "..", "models");
const manifestPath = join(fixtureDir, "manifest.json");
const modelsPresent = ["meiki.text.detect.v0.1.960x544.onnx", "meiki.text.rec.v0.960x32.onnx", "meiki.text.rec.v0.vertical.32x480.onnx"].every(
  (f) => existsSync(join(modelDir, f)),
);
const manifest = existsSync(manifestPath)
  ? (JSON.parse(readFileSync(manifestPath, "utf8")) as { cases: RefCase[]; onnxruntime: string; opencv: string })
  : null;

const CONF_TOL = 2e-3;
const SUM_TOL = 1e-2;

describe.skipIf(!manifest || !modelsPresent)("pipeline parity vs native MeikiOCR", () => {
  let engine: OrtEngine;

  beforeAll(async () => {
    const ort = (await import("onnxruntime-web")) as unknown as typeof OrtNs;
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = "error";
    const load = (f: string) =>
      ort.InferenceSession.create(new Uint8Array(readFileSync(join(modelDir, f))), {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
    const [detector, recognizerH, recognizerV] = await Promise.all([
      load("meiki.text.detect.v0.1.960x544.onnx"),
      load("meiki.text.rec.v0.960x32.onnx"),
      load("meiki.text.rec.v0.vertical.32x480.onnx"),
    ]);
    engine = new OrtEngine(ort, { detector, recognizerH, recognizerV }, "wasm", "parity-test");
  }, 120_000);

  for (const c of manifest?.cases ?? []) {
    for (const profile of ["meikipop-v2", "meikiocr-native"] as const) {
      const ref = c.profiles[profile];

      it(`${c.name} [${profile}] detector tensor + int64 metadata match`, () => {
        const rgba = new Uint8Array(readFileSync(join(fixtureDir, c.rgba)));
        const det = preprocessForDetection(rgba, c.width, c.height, PROFILES[profile].channelOrder);
        expect([Number(det.origTargetSizes[0]), Number(det.origTargetSizes[1])]).toEqual(ref.detector.origTargetSizes);
        expect(det.scale).toBeCloseTo(ref.detector.scale, 12);
        let sum = 0;
        for (let i = 0; i < det.tensor.length; i++) sum += det.tensor[i]!;
        expect(Math.abs(sum - ref.detector.tensor.sum)).toBeLessThanOrEqual(SUM_TOL);
        ref.detector.tensor.sampleIdx.forEach((idx, k) => {
          expect(det.tensor[idx]).toBeCloseTo(ref.detector.tensor.sampleVal[k]!, 7);
        });
      });

      it(`${c.name} [${profile}] text, boxes and confidences match`, async () => {
        const rgba = new Uint8Array(readFileSync(join(fixtureDir, c.rgba)));
        const snap = await runPipeline(
          engine,
          { frameId: c.name, width: c.width, height: c.height, capturedAtMs: 0, rgba: rgba.buffer as ArrayBuffer },
          { profile, recognitionBatchSize: 8, maxInputPixels: 4_000_000, verticalEnabled: true },
        );
        // Reference keeps empty lines; the port omits lines with no accepted chars.
        const refLines = ref.lines.filter((l) => l.chars.length > 0);
        expect(snap.lines.map((l) => l.text)).toEqual(refLines.map((l) => l.text));
        expect(snap.lines.map((l) => l.orientation === "vertical")).toEqual(refLines.map((l) => l.isVertical));
        snap.lines.forEach((line, li) => {
          const rl = refLines[li]!;
          expect(line.glyphs.map((g) => [...g.box])).toEqual(rl.chars.map((ch) => ch.bbox));
          line.glyphs.forEach((g, gi) => {
            expect(Math.abs(g.confidence - rl.chars[gi]!.conf)).toBeLessThanOrEqual(CONF_TOL);
          });
          // invariant: text === concat(glyph.text) and offsets are contiguous
          expect(line.glyphs.map((g) => g.text).join("")).toBe(line.text);
          let off = 0;
          for (const g of line.glyphs) {
            expect(g.utf16Start).toBe(off);
            off = g.utf16End;
          }
          expect(off).toBe(line.text.length);
        });
      }, 60_000);
    }
  }
});
