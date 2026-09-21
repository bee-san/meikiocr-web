# meikiocr-web

Browser-local Japanese OCR built from [MeikiOCR](https://github.com/rtr46/meikiocr)'s
published ONNX models, running on ONNX Runtime Web (WASM baseline), with optional
[MeikiPop](https://github.com/rtr46/meikipop)-compatible paragraph layout and
pointer hit-testing helpers.

No server, no Python, no cloud OCR, no dictionary. You give it an RGBA frame; it
returns text, per-character geometry, confidences and offsets.

```ts
import { createMeikiOcr } from "meikiocr-web";
import { buildMeikiPopLayout, hitTestMeikiPop } from "meikiocr-web/meikipop";

const manifest = await (await fetch("/ocr-assets/manifest.json")).json();
const ocr = await createMeikiOcr({
  manifest,
  assetBaseUrl: new URL("/ocr-assets/", location.href).href,
  profile: "meikipop-v2",           // RGB, det 0.5, rec 0.1, punct 0.2 (MeikiPop parity)
  execution: "wasm",
  wasmThreads: 1,
  vertical: "lazy",
  onProgress: (e) => console.log(e.phase, e.asset, e.loadedBytes, e.totalBytes),
  // Bundler-friendly worker creation (Angular/Vite):
  worker: new Worker(new URL("meikiocr-web/worker", import.meta.url), { type: "module" }),
});

const snapshot = await ocr.scan({ frameId: "f1", width, height, capturedAtMs: performance.now(), rgba });
const layout = buildMeikiPopLayout(snapshot);
const hit = hitTestMeikiPop(layout, { x: 120, y: 40 }); // image pixels
console.log(hit?.fullText, hit?.utf16Offset, hit?.suffix);
```

## Status

| Area | State |
|---|---|
| Detector + horizontal recognizer preprocessing/postprocessing | Ported; **exact parity** with the pinned native pipeline on 12 fixtures × 2 profiles (text, integer boxes; confidences within 2e-3). See `tests/parity/pipeline-native.test.ts`. |
| Resize | Byte-identical to OpenCV 5.0.0 `INTER_LINEAR` (fixed-point emulation), `tests/parity/resize-opencv.test.ts`. |
| Vertical recognizer | Ported incl. 420/64 segmentation; lazy-loaded. Fixture coverage is currently horizontal-heavy (see `docs/meikipop-parity.md`). |
| MeikiPop layout/hit-test | Ported; exact parity on 20 cases / ~3000 probed points vs upstream code, `tests/parity/meikipop-layout.test.ts`. |
| Worker/client protocol | Implemented with busy/abort/dispose/malformed-reply/bounded-restart tests (fake worker). |
| Real browser run | **Verified in headless Chromium** (`npm run test:browser`): real worker, ORT WASM, Cache Storage; 24/24 fixtures match native. Firefox pending (see `docs/browser-support.md`). |
| WebGPU | `auto` resolves to `wasm`; explicit `webgpu` attempts it with one controlled fallback. Not yet validated. |

## Commands

```sh
npm install
npm run fetch-models          # downloads pinned models, verifies models.lock.json
npm test                      # unit + parity tests (parity tests skip if models are absent)
npm run build                 # dist/ (ESM + d.ts)
npm run export-assets         # assets-export/: models + matching ORT wasm/mjs + manifest.json
npm run test:browser          # real Chromium inference vs native reference (needs export-assets + playwright browsers)
```

Regenerating reference fixtures requires Python with `onnxruntime`, `opencv-python-headless`,
`numpy`, `pillow` and a Japanese font:

```sh
python tools/generate-reference-fixtures.py --models models --out tests/fixtures/parity --font /path/to/JapaneseFont.ttf
python tools/generate-meikipop-fixtures.py
```

## Documentation

- `docs/api.md` — public contract and invariants
- `docs/upstream-baseline.md` — pinned revisions, model signatures, licenses
- `docs/meikipop-parity.md` — exact behaviours, adaptations, deviations
- `docs/deployment.md` — serving assets, worker bundling, cache ownership, isolation
- `docs/browser-support.md` — what is tested where
- `docs/benchmarks.md` — methodology (no numbers are claimed until measured)

## License

New code: GPL-3.0-only. Ported/vendored components keep their own licenses; see
`THIRD_PARTY_NOTICES.md`.
