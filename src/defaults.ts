import type { ExecutionPreference, OcrProfile, VerticalMode } from "./api/types.js";

/**
 * Pipeline constants ported from meikiocr/ocr.py at
 * rtr46/meikiocr@ebb8d2aedf69e62cbec57efb0bd00fb3e0e07297.
 */
export const MODEL_DIMS = Object.freeze({
  DET_WIDTH: 960,
  DET_HEIGHT: 544,
  REC_HEIGHT: 32,
  REC_WIDTH: 960,
  VREC_WIDTH: 32,
  VREC_HEIGHT: 480,
  /** Height of segments when a vertical split is forced. */
  VREC_MAX_CONTENT_HEIGHT: 420,
  /** Overlap in the scaled space when splitting vertical lines. */
  VREC_OVERLAP_PX: 64,
});

export const NMS = Object.freeze({
  X_OVERLAP_THRESHOLD: 0.3,
  Y_OVERLAP_THRESHOLD: 0.3,
  EPSILON: 1e-6,
});

/** Upstream swapped-pair corrections (applied atomically to text and glyphs). */
export const SWAPPED_PAIRS: ReadonlyMap<string, string> = new Map([
  ["儡傀", "傀儡"],
  ["談冗", "冗談"],
  ["汰淘", "淘汰"],
  ["沱滂", "滂沱"],
  ["攣痙", "痙攣"],
  ["酊酩", "酩酊"],
  ["麭麺", "麺麭"],
  ["哭慟", "慟哭"],
]);

export interface ProfileParams {
  /** Channel order packed into the model tensor from RGBA input. */
  channelOrder: "rgb" | "bgr";
  detThreshold: number;
  recThreshold: number;
  punctConfFactor: number;
}

/**
 * Profiles. `meikipop-v2` reproduces MeikiPop's provider (RGB array from PIL,
 * det 0.5, rec 0.1, punct 0.2). `meikiocr-native` reproduces the native
 * OpenCV path (BGR, det 0.5, rec 0.1, punct 1.0 = run_ocr default).
 */
export const PROFILES: Readonly<Record<OcrProfile, ProfileParams>> = Object.freeze({
  "meikipop-v2": Object.freeze({
    channelOrder: "rgb",
    detThreshold: 0.5,
    recThreshold: 0.1,
    punctConfFactor: 0.2,
  }),
  "meikiocr-native": Object.freeze({
    channelOrder: "bgr",
    detThreshold: 0.5,
    recThreshold: 0.1,
    punctConfFactor: 1.0,
  }),
});

/** Horizontal recognizer's published capacity (per model card). */
export const HORIZONTAL_RECOGNIZER_MAX_CHARS = 48;

export const DEFAULTS = Object.freeze({
  profile: "meikipop-v2" as OcrProfile,
  execution: "wasm" as ExecutionPreference,
  wasmThreads: 1,
  vertical: "lazy" as VerticalMode,
  recognitionBatchSize: 4,
  maxRecognitionBatchSize: 8,
  /** 4 megapixels */
  maxInputPixels: 4_000_000,
  persistentCache: true,
  /** Cache Storage namespace owned exclusively by this library. */
  cacheName: "meikiocr-web-assets-v1",
  /** Bounded worker restart policy on fatal failures. */
  maxWorkerRestarts: 2,
  /** Consumer-side scheduling default (mirrors MeikiPop auto_scan_interval_seconds). */
  scanIntervalMs: 500,
});

/** Model filenames as referenced by the pinned upstream implementation. */
export const UPSTREAM_MODEL_FILES = Object.freeze({
  detector: "meiki.text.detect.v0.1.960x544.onnx",
  recognizerHorizontal: "meiki.text.rec.v0.960x32.onnx",
  recognizerVertical: "meiki.text.rec.v0.vertical.32x480.onnx",
});
