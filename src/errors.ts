/** Typed errors. Empty OCR results are NOT errors; they are `lines: []` snapshots. */

export type MeikiOcrErrorCode =
  | "BUSY"
  | "DISPOSED"
  | "ABORTED"
  | "INVALID_INPUT"
  | "INPUT_TOO_LARGE"
  | "ASSET_FETCH_FAILED"
  | "ASSET_INTEGRITY_FAILED"
  | "ASSET_MISSING"
  | "MODEL_SIGNATURE_MISMATCH"
  | "RUNTIME_INIT_FAILED"
  | "INFERENCE_FAILED"
  | "WORKER_PROTOCOL_ERROR"
  | "WORKER_CRASHED"
  | "UNSUPPORTED";

export class MeikiOcrError extends Error {
  readonly code: MeikiOcrErrorCode;
  override readonly cause?: unknown;
  constructor(code: MeikiOcrErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "MeikiOcrError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export class BusyError extends MeikiOcrError {
  constructor(message = "A scan is already in progress; coalesce intents in the caller.") {
    super("BUSY", message);
    this.name = "BusyError";
  }
}

export class DisposedError extends MeikiOcrError {
  constructor(message = "Client has been disposed.") {
    super("DISPOSED", message);
    this.name = "DisposedError";
  }
}

export class AbortedError extends MeikiOcrError {
  constructor(message = "Scan aborted by caller.") {
    super("ABORTED", message);
    this.name = "AbortedError";
  }
}

export class InvalidInputError extends MeikiOcrError {
  constructor(message: string) {
    super("INVALID_INPUT", message);
    this.name = "InvalidInputError";
  }
}

export class InputTooLargeError extends MeikiOcrError {
  constructor(message: string) {
    super("INPUT_TOO_LARGE", message);
    this.name = "InputTooLargeError";
  }
}

export class AssetError extends MeikiOcrError {
  constructor(
    code: "ASSET_FETCH_FAILED" | "ASSET_INTEGRITY_FAILED" | "ASSET_MISSING",
    message: string,
    cause?: unknown,
  ) {
    super(code, message, cause);
    this.name = "AssetError";
  }
}

export class ModelSignatureError extends MeikiOcrError {
  constructor(message: string) {
    super("MODEL_SIGNATURE_MISMATCH", message);
    this.name = "ModelSignatureError";
  }
}

export class RuntimeInitError extends MeikiOcrError {
  constructor(message: string, cause?: unknown) {
    super("RUNTIME_INIT_FAILED", message, cause);
    this.name = "RuntimeInitError";
  }
}

export class InferenceError extends MeikiOcrError {
  constructor(message: string, cause?: unknown) {
    super("INFERENCE_FAILED", message, cause);
    this.name = "InferenceError";
  }
}

export class WorkerProtocolError extends MeikiOcrError {
  constructor(message: string) {
    super("WORKER_PROTOCOL_ERROR", message);
    this.name = "WorkerProtocolError";
  }
}

export class WorkerCrashedError extends MeikiOcrError {
  constructor(message: string, cause?: unknown) {
    super("WORKER_CRASHED", message, cause);
    this.name = "WorkerCrashedError";
  }
}

export interface SerializedError {
  code: MeikiOcrErrorCode;
  message: string;
  name: string;
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof MeikiOcrError) {
    return { code: err.code, message: err.message, name: err.name };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: "INFERENCE_FAILED", message, name: "Error" };
}

export function deserializeError(s: SerializedError): MeikiOcrError {
  switch (s.code) {
    case "BUSY":
      return new BusyError(s.message);
    case "DISPOSED":
      return new DisposedError(s.message);
    case "ABORTED":
      return new AbortedError(s.message);
    case "INVALID_INPUT":
      return new InvalidInputError(s.message);
    case "INPUT_TOO_LARGE":
      return new InputTooLargeError(s.message);
    case "ASSET_FETCH_FAILED":
    case "ASSET_INTEGRITY_FAILED":
    case "ASSET_MISSING":
      return new AssetError(s.code, s.message);
    case "MODEL_SIGNATURE_MISMATCH":
      return new ModelSignatureError(s.message);
    case "RUNTIME_INIT_FAILED":
      return new RuntimeInitError(s.message);
    case "WORKER_PROTOCOL_ERROR":
      return new WorkerProtocolError(s.message);
    case "WORKER_CRASHED":
      return new WorkerCrashedError(s.message);
    case "INFERENCE_FAILED":
    case "UNSUPPORTED":
    default:
      return new MeikiOcrError(s.code, s.message);
  }
}
