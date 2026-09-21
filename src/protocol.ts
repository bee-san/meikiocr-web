import type {
  AssetManifest,
  Backend,
  ExecutionPreference,
  OcrProfile,
  OcrSnapshot,
  ProgressEvent,
  RgbaFrame,
  VerticalMode,
} from "./api/types.js";
import type { SerializedError } from "./errors.js";

export const PROTOCOL_VERSION = 1 as const;

export interface InitRequest {
  type: "init";
  protocol: typeof PROTOCOL_VERSION;
  generation: number;
  manifest: AssetManifest;
  assetBaseUrl: string;
  runtimeBaseUrl: string;
  profile: OcrProfile;
  execution: ExecutionPreference;
  wasmThreads: number;
  vertical: VerticalMode;
  recognitionBatchSize: number;
  maxInputPixels: number;
  persistentCache: boolean;
  cacheName: string;
}

export interface ScanRequest {
  type: "scan";
  generation: number;
  requestId: number;
  frame: RgbaFrame;
}

export interface CancelRequest {
  type: "cancel";
  generation: number;
  requestId: number;
}

export interface DisposeRequest {
  type: "dispose";
  generation: number;
}

export interface ClearCacheRequest {
  type: "clear-cache";
  generation: number;
  requestId: number;
}

export type ClientToWorker = InitRequest | ScanRequest | CancelRequest | DisposeRequest | ClearCacheRequest;

export interface ReadyReply {
  type: "ready";
  generation: number;
  backend: Backend;
  backendReason: string;
  threads: number;
  modelSetId: string;
  warnings: string[];
}

export interface ProgressReply {
  type: "progress";
  generation: number;
  event: ProgressEvent;
}

export interface ResultReply {
  type: "result";
  generation: number;
  requestId: number;
  snapshot: OcrSnapshot;
}

export interface ErrorReply {
  type: "error";
  generation: number;
  /** Absent for init failures. */
  requestId?: number;
  error: SerializedError;
  /** True when the worker can no longer serve requests. */
  fatal: boolean;
}

export interface DisposedReply {
  type: "disposed";
  generation: number;
}

export interface CacheClearedReply {
  type: "cache-cleared";
  generation: number;
  requestId: number;
}

export type WorkerToClient = ReadyReply | ProgressReply | ResultReply | ErrorReply | DisposedReply | CacheClearedReply;

const REPLY_TYPES = new Set(["ready", "progress", "result", "error", "disposed", "cache-cleared"]);

export function isWorkerReply(v: unknown): v is WorkerToClient {
  if (!v || typeof v !== "object") return false;
  const o = v as { type?: unknown; generation?: unknown };
  return typeof o.type === "string" && REPLY_TYPES.has(o.type) && typeof o.generation === "number";
}

export function isSnapshotShape(v: unknown): v is OcrSnapshot {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<OcrSnapshot>;
  return (
    typeof s.frameId === "string" &&
    typeof s.width === "number" &&
    typeof s.height === "number" &&
    Array.isArray(s.lines) &&
    !!s.diagnostics &&
    typeof s.diagnostics.elapsedMs === "number"
  );
}
