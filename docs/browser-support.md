# Browser support (tested vs. expected)

| Environment | Backend | Status |
|---|---|---|
| Node 22 (vitest) | onnxruntime-web 1.30.0 WASM, 1 thread | **Tested**: real inference, full parity suite (`tests/parity/pipeline-native.test.ts`). |
| Chromium 153 (headless, Playwright 1.63) | WASM 1 thread, cross-origin isolated | **Tested 2026-09-21**: `npm run test:browser` runs the real worker + client protocol + Cache Storage path; 35/35 cases (17 fixtures × 2 profiles incl. 3 vertical, furigana, 60-char saturation; plus `vertical:"off"` diagnostics) match the native reference text and integer boxes. Lazy vertical provisioning observed (fetched on first vertical line only; cache hit on the second client). Per-scan 380–830 ms on a Linux x86-64 cloud desktop. |
| Firefox 155 (headless, Playwright 1.63) | WASM 1 thread, cross-origin isolated | **Tested 2026-09-21**: `npm run test:browser firefox` — 35/35 identical results. |
| Chromium / Firefox | WASM 2 threads (opt-in, COI) | **Tested 2026-09-21** on the `white_on_dark_single` case: `threads=2` reported, text matches. Not a full-suite run; no speed claim. |
| Chromium 153 headless | WebGPU (explicit) | **Ran 2026-09-21** on one case via the headless software adapter: backend `webgpu`, text matches. This is not a GPU validation; treat as "graph loads and produces the same text on one input". |
| Firefox 155 headless | WebGPU (explicit) | `navigator.gpu` unavailable → one controlled fallback to WASM, reported as `webgpu requested but navigator.gpu unavailable`. |
| Any | `auto` | Resolves to `wasm` (WebGPU is never auto-selected until validated on real hardware). |
| Safari / mobile | — | Not tested; not claimed. |

Report only what is in this table.
