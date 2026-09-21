/**
 * meikiocr-web — browser-local Japanese OCR (MeikiOCR ONNX models on ONNX Runtime Web).
 * Importing this module has no side effects: no worker, no downloads, no DOM.
 */
export type * from "./api/types.js";
export { createMeikiOcr, createMeikiOcrWithFactory, resolveOptions } from "./client.js";
export type { WorkerFactory, WorkerLike } from "./client.js";
export {
  MeikiOcrError,
  BusyError,
  DisposedError,
  AbortedError,
  InvalidInputError,
  InputTooLargeError,
  AssetError,
  ModelSignatureError,
  RuntimeInitError,
  InferenceError,
  WorkerProtocolError,
  WorkerCrashedError,
} from "./errors.js";
export type { MeikiOcrErrorCode } from "./errors.js";
export {
  DEFAULTS,
  PROFILES,
  MODEL_DIMS,
  NMS,
  SWAPPED_PAIRS,
  HORIZONTAL_RECOGNIZER_MAX_CHARS,
  UPSTREAM_MODEL_FILES,
} from "./defaults.js";
export type { ProfileParams } from "./defaults.js";
export { PROTOCOL_VERSION } from "./protocol.js";
export type { ClientToWorker, WorkerToClient } from "./protocol.js";
export { detectCapabilities, chooseBackend, effectiveThreads } from "./runtime/capabilities.js";
export type { Capabilities } from "./runtime/capabilities.js";
export { resolveAssetUrl, validateManifest, sha256Hex } from "./assets/manifest.js";
// Pure pipeline pieces, exported for parity testing and advanced consumers.
export { runPipeline, validateFrame } from "./ocr/pipeline.js";
export type { InferenceEngine, PipelineConfig } from "./ocr/pipeline.js";
export { preprocessForDetection, preprocessHorizontal, preprocessVertical, packNchw } from "./image/preprocess.js";
export type { DetectorInput, RecognitionBatch, CropMeta, ChannelOrder } from "./image/preprocess.js";
export { resizeLinearCv, cropInterleaved, pyRound } from "./image/resize.js";
export { postprocessDetection } from "./ocr/detect.js";
export type { DetectionOutputs, DetectedBox } from "./ocr/detect.js";
export { buildCandidates, resolveCandidates, fixSwappedPairs, toOcrLine, unionBoxes } from "./ocr/postprocess.js";
export type { RecognitionOutputs, CharCandidate, LineResult } from "./ocr/postprocess.js";
