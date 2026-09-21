import type { Backend, ExecutionPreference } from "../api/types.js";

export interface Capabilities {
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  webgpu: boolean;
  /** Hardware threads reported by the environment (may be capped by the browser). */
  hardwareConcurrency: number;
}

export function detectCapabilities(): Capabilities {
  const g = globalThis as unknown as {
    crossOriginIsolated?: boolean;
    SharedArrayBuffer?: unknown;
    navigator?: { gpu?: unknown; hardwareConcurrency?: number };
  };
  return {
    crossOriginIsolated: g.crossOriginIsolated === true,
    sharedArrayBuffer: typeof g.SharedArrayBuffer !== "undefined",
    webgpu: typeof g.navigator?.gpu !== "undefined",
    hardwareConcurrency: g.navigator?.hardwareConcurrency ?? 1,
  };
}

/**
 * Resolve the execution preference to an initial backend to try.
 *
 * `auto` currently resolves to `wasm`: WebGPU is only advertised after the
 * exact graph/provider combination has passed tests (see docs/browser-support.md).
 * An explicit `webgpu` request is honoured when the adapter exists, with a
 * single controlled fallback to wasm performed by the worker.
 */
export function chooseBackend(pref: ExecutionPreference, caps: Capabilities): { backend: Backend; reason: string } {
  if (pref === "webgpu") {
    if (caps.webgpu) return { backend: "webgpu", reason: "explicitly requested; navigator.gpu present" };
    return { backend: "wasm", reason: "webgpu requested but navigator.gpu unavailable" };
  }
  if (pref === "auto") {
    return { backend: "wasm", reason: "auto resolves to wasm until webgpu graph validation is recorded" };
  }
  return { backend: "wasm", reason: "explicitly requested" };
}

/** Effective thread count; >1 requires SharedArrayBuffer + isolation. */
export function effectiveThreads(requested: number, caps: Capabilities): { threads: number; reason?: string } {
  const req = Math.max(1, Math.floor(requested || 1));
  if (req === 1) return { threads: 1 };
  if (!caps.crossOriginIsolated || !caps.sharedArrayBuffer) {
    return { threads: 1, reason: "multi-threaded wasm requires cross-origin isolation; falling back to 1 thread" };
  }
  return { threads: Math.min(req, Math.max(1, caps.hardwareConcurrency)) };
}
