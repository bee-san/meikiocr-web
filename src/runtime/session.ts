/**
 * ONNX Runtime Web session layer. Runs inside the worker.
 *
 * Signatures below were audited from the pinned models (see docs/upstream-baseline.md):
 *   detector:   images f32[N,3,544,960], orig_target_sizes i64[N,2]
 *               -> labels i64[N,64], boxes f32[N,64,4], scores f32[N,64]
 *   rec (h):    images f32[N,3,32,960],  orig_target_sizes i64[N,2]
 *               -> char_codes i32[N,48], boxes f32[N,48,4], scores f32[N,48]
 *   rec (v):    images f32[N,3,480,32],  orig_target_sizes i64[N,2]
 *               -> char_codes i32[N,24], boxes f32[N,24,4], scores f32[N,24]
 */
import type * as OrtNs from "onnxruntime-web";
import type { Backend } from "../api/types.js";
import { MODEL_DIMS } from "../defaults.js";
import { InferenceError, ModelSignatureError, RuntimeInitError } from "../errors.js";
import type { DetectionOutputs } from "../ocr/detect.js";
import type { InferenceEngine } from "../ocr/pipeline.js";
import type { RecognitionOutputs } from "../ocr/postprocess.js";

export type Ort = typeof OrtNs;

export interface SessionSet {
  detector: OrtNs.InferenceSession;
  recognizerH: OrtNs.InferenceSession;
  recognizerV?: OrtNs.InferenceSession;
}

export interface SessionConfig {
  backend: Backend;
  wasmThreads: number;
  /** Directory URL containing ort-wasm-simd-threaded.{wasm,mjs}. */
  runtimeBaseUrl: string;
}

export function configureOrtEnv(ort: Ort, cfg: SessionConfig): void {
  // Use the same ORT build for JS and WASM assets; the consumer serves them
  // from `runtimeBaseUrl` (see docs/deployment.md).
  ort.env.wasm.wasmPaths = cfg.runtimeBaseUrl;
  ort.env.wasm.numThreads = Math.max(1, cfg.wasmThreads | 0);
  // We already run in our own worker; do not let ORT spawn a proxy worker.
  ort.env.wasm.proxy = false;
  ort.env.logLevel = "error";
}

export async function createSession(
  ort: Ort,
  bytes: Uint8Array,
  backend: Backend,
  label: string,
): Promise<OrtNs.InferenceSession> {
  const providers: OrtNs.InferenceSession.ExecutionProviderConfig[] = backend === "webgpu" ? ["webgpu", "wasm"] : ["wasm"];
  try {
    return await ort.InferenceSession.create(bytes, {
      executionProviders: providers,
      graphOptimizationLevel: "all",
      // Mirror upstream: disable spinning so an idle worker does not burn CPU.
      extra: {
        session: {
          intra_op: { allow_spinning: "0" },
          inter_op: { allow_spinning: "0" },
        },
      },
    });
  } catch (e) {
    throw new RuntimeInitError(`failed to create ${label} session on ${backend}: ${(e as Error)?.message ?? e}`, e);
  }
}

export function assertSignature(
  s: OrtNs.InferenceSession,
  label: string,
  inputs: readonly string[],
  outputs: readonly string[],
): void {
  const missingIn = inputs.filter((n) => !s.inputNames.includes(n));
  const missingOut = outputs.filter((n) => !s.outputNames.includes(n));
  if (missingIn.length || missingOut.length) {
    throw new ModelSignatureError(
      `${label}: unexpected signature. inputs=${JSON.stringify(s.inputNames)} outputs=${JSON.stringify(s.outputNames)}; ` +
        `missing inputs=${JSON.stringify(missingIn)} outputs=${JSON.stringify(missingOut)}`,
    );
  }
}

export const SIGNATURES = Object.freeze({
  detector: { inputs: ["images", "orig_target_sizes"], outputs: ["labels", "boxes", "scores"] },
  recognizer: { inputs: ["images", "orig_target_sizes"], outputs: ["char_codes", "boxes", "scores"] },
});

/** InferenceEngine implementation over ORT sessions. */
export class OrtEngine implements InferenceEngine {
  readonly backend: Backend;
  readonly modelSetId: string;
  private readonly ort: Ort;
  private readonly sessions: SessionSet;
  readonly recognizeVertical?: (batch: Float32Array, count: number) => Promise<RecognitionOutputs>;

  constructor(ort: Ort, sessions: SessionSet, backend: Backend, modelSetId: string) {
    this.ort = ort;
    this.sessions = sessions;
    this.backend = backend;
    this.modelSetId = modelSetId;
    assertSignature(sessions.detector, "detector", SIGNATURES.detector.inputs, SIGNATURES.detector.outputs);
    assertSignature(sessions.recognizerH, "recognizer-horizontal", SIGNATURES.recognizer.inputs, SIGNATURES.recognizer.outputs);
    if (sessions.recognizerV) {
      assertSignature(sessions.recognizerV, "recognizer-vertical", SIGNATURES.recognizer.inputs, SIGNATURES.recognizer.outputs);
      this.recognizeVertical = (batch, count) =>
        this.runRecognizer(sessions.recognizerV!, batch, count, MODEL_DIMS.VREC_WIDTH, MODEL_DIMS.VREC_HEIGHT);
    }
  }

  attachVertical(session: OrtNs.InferenceSession): void {
    assertSignature(session, "recognizer-vertical", SIGNATURES.recognizer.inputs, SIGNATURES.recognizer.outputs);
    this.sessions.recognizerV = session;
    (this as { recognizeVertical?: OrtEngine["recognizeVertical"] }).recognizeVertical = (batch, count) =>
      this.runRecognizer(session, batch, count, MODEL_DIMS.VREC_WIDTH, MODEL_DIMS.VREC_HEIGHT);
  }

  async detect(tensor: Float32Array, origTargetSizes: BigInt64Array): Promise<DetectionOutputs> {
    const { Tensor } = this.ort;
    const feeds: Record<string, OrtNs.Tensor> = {
      images: new Tensor("float32", tensor, [1, 3, MODEL_DIMS.DET_HEIGHT, MODEL_DIMS.DET_WIDTH]),
      orig_target_sizes: new Tensor("int64", origTargetSizes, [1, 2]),
    };
    let out: OrtNs.InferenceSession.OnnxValueMapType;
    try {
      out = await this.sessions.detector.run(feeds);
    } catch (e) {
      throw new InferenceError(`detector run failed: ${(e as Error)?.message ?? e}`, e);
    }
    const boxes = out["boxes"]!;
    const scores = out["scores"]!;
    const count = Number(scores.dims[1] ?? 0);
    return {
      boxes: boxes.data as Float32Array,
      scores: scores.data as Float32Array,
      count,
    };
  }

  recognizeHorizontal(batch: Float32Array, count: number): Promise<RecognitionOutputs> {
    return this.runRecognizer(this.sessions.recognizerH, batch, count, MODEL_DIMS.REC_WIDTH, MODEL_DIMS.REC_HEIGHT);
  }

  private async runRecognizer(
    session: OrtNs.InferenceSession,
    batch: Float32Array,
    count: number,
    w: number,
    h: number,
  ): Promise<RecognitionOutputs> {
    const { Tensor } = this.ort;
    const feeds: Record<string, OrtNs.Tensor> = {
      images: new Tensor("float32", batch, [count, 3, h, w]),
      orig_target_sizes: new Tensor("int64", new BigInt64Array([BigInt(w), BigInt(h)]), [1, 2]),
    };
    let out: OrtNs.InferenceSession.OnnxValueMapType;
    try {
      out = await session.run(feeds);
    } catch (e) {
      throw new InferenceError(`recognizer run failed: ${(e as Error)?.message ?? e}`, e);
    }
    const codes = out["char_codes"]!;
    const boxes = out["boxes"]!;
    const scores = out["scores"]!;
    const perItem = Number(scores.dims[1] ?? 0);
    return {
      labels: codes.data as Int32Array | BigInt64Array,
      boxes: boxes.data as Float32Array,
      scores: scores.data as Float32Array,
      perItem,
    };
  }

  async release(): Promise<void> {
    const all = [this.sessions.detector, this.sessions.recognizerH, this.sessions.recognizerV].filter(Boolean);
    await Promise.allSettled(all.map((s) => s!.release()));
  }
}
