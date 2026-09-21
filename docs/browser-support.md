# Browser support (tested vs. expected)

| Environment | Backend | Status |
|---|---|---|
| Node 22 (vitest) | onnxruntime-web 1.30.0 WASM, 1 thread | **Tested**: real inference, full parity suite (`tests/parity/pipeline-native.test.ts`). |
| Chromium (headless, Playwright 1.63 / chromium-1243) | WASM 1 thread, cross-origin isolated | **Tested 2026-09-21**: `npm run test:browser` runs the real worker + client protocol + Cache Storage path; 24/24 fixture cases (12 × 2 profiles) match the native reference text and integer boxes. Per-scan latency 375–714 ms on the CI-class Linux host (see benchmarks.md caveats). |
| Firefox (headed) | WASM 1 thread | Pending. |
| Any | WASM multi-thread | Requires cross-origin isolation; falls back to 1 thread otherwise. Untested. |
| Any | WebGPU | `auto` resolves to `wasm`. Explicit `webgpu` creates sessions with `["webgpu","wasm"]` and falls back once on failure. Not validated for these graphs (`GridSample`, `TopK`, `ScatterND`). |
| Safari / mobile | — | Not tested; not claimed. |

Report only what is in this table.
