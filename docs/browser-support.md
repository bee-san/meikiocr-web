# Browser support (tested vs. expected)

| Environment | Backend | Status |
|---|---|---|
| Node 22 (vitest) | onnxruntime-web 1.30.0 WASM, 1 thread | **Tested**: real inference, full parity suite (`tests/parity/pipeline-native.test.ts`). |
| Chromium (headed) | WASM 1 thread | Pending. The runtime path is identical to Node's WASM build; a Playwright run against `examples/hover-image` is the next gate. |
| Firefox (headed) | WASM 1 thread | Pending. |
| Any | WASM multi-thread | Requires cross-origin isolation; falls back to 1 thread otherwise. Untested. |
| Any | WebGPU | `auto` resolves to `wasm`. Explicit `webgpu` creates sessions with `["webgpu","wasm"]` and falls back once on failure. Not validated for these graphs (`GridSample`, `TopK`, `ScatterND`). |
| Safari / mobile | — | Not tested; not claimed. |

Report only what is in this table.
