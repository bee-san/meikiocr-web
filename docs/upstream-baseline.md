# Upstream baseline (pinned)

| Project | Revision | Material used |
|---|---|---|
| `rtr46/meikiocr` | `ebb8d2aedf69e62cbec57efb0bd00fb3e0e07297` | `meikiocr/ocr.py`: constants, preprocessing, inference feeds, postprocessing, `SWAPPED_PAIRS`. |
| `rtr46/meikipop` | `ed1b70c40f38a6bd397e277ed4106c26d34dab97` | `ocr/providers/meikiocr/provider.py`, `ocr/providers/postprocessing.py`, `ocr/hit_scan.py`, `config/config.py`, `utils/lastest_queue.py`, `gui/input.py`, `gui/popup.py`, `screenshot/screenmanager.py`. |
| ONNX Runtime Web | npm `onnxruntime-web@1.30.0` | `dist/ort.bundle.min.mjs` (default import), `ort-wasm-simd-threaded.{wasm,mjs}`, `.jsep.*` for WebGPU. |
| OpenCV (reference generation only) | `opencv-python-headless` 5.0.0 | `cv2.resize(INTER_LINEAR)` ground truth. |
| onnxruntime (reference generation only) | 1.x CPU EP (see `tests/fixtures/parity/manifest.json`) | native reference outputs. |

## Model audit (from `tools/inspect-models.py`, 2026-09-21)

| Role | File | Repo revision | SHA-256 | Bytes |
|---|---|---|---|---|
| detector | `meiki.text.detect.v0.1.960x544.onnx` | `a9cffa4f60cbf72ddb87edf19c6f98a01cd042e6` | `40b6a016667745cae7d3055929ae3b8b1e7716aac795f5904cd3c2c7c3b8404b` | 14 503 825 |
| recognizer-horizontal | `meiki.text.rec.v0.960x32.onnx` | `a28cf5874dc2438ebb1c86336be26bcec51e3375` | `3e96bc772fbee9717e536a6353032bb944c3382dd2f6960ef4890decda43b000` | 18 593 254 |
| recognizer-vertical | `meiki.text.rec.v0.vertical.32x480.onnx` | `a28cf5874dc2438ebb1c86336be26bcec51e3375` | `2c2a83a23bc3b7e6c63962175f507ecc6c5e85cc174f17bdec37d9bbd0bf895a` | 12 872 961 |

All three: IR version 8, opset 16 (`ai.onnx`), producer `pytorch 2.8.0`, no
external data. Operators include `GridSample`, `TopK`, `GatherElements`,
`ScatterND`, `Resize` — all supported by the ORT WASM CPU EP (verified by running
inference under Node in `tests/parity/pipeline-native.test.ts`).

Signatures:

```
detector:   images f32[N,3,544,960], orig_target_sizes i64[N,2] -> labels i64[N,64], boxes f32[N,64,4], scores f32[N,64]
rec (h):    images f32[N,3,32,960],  orig_target_sizes i64[N,2] -> char_codes i32[N,48], boxes f32[N,48,4], scores f32[N,48]
rec (v):    images f32[N,3,480,32],  orig_target_sizes i64[N,2] -> char_codes i32[N,24], boxes f32[N,24,4], scores f32[N,24]
```

The library binds by name and asserts these at session creation
(`ModelSignatureError` otherwise). Output order is not assumed.

## Licenses

- meikiocr (code): Apache-2.0
- meikipop (code): GPL-3.0
- model repositories: `lgpl-3.0` per their model cards
- onnxruntime-web: MIT

See `THIRD_PARTY_NOTICES.md`.

## Color order

MeikiOCR's docstrings describe OpenCV BGR input. MeikiPop's provider passes a
PIL-derived **RGB** array to `run_ocr` with `det_threshold=0.5`,
`rec_threshold=0.1`, `punct_conf_factor=0.2`. Both are implemented as named
profiles (`meikipop-v2`, `meikiocr-native`); the public input is always RGBA8.
