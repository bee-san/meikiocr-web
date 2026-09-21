# Third-party notices

This project (new code) is licensed under GPL-3.0-only (see `LICENSE`) because it
ports routines from MeikiPop, which is GPLv3. The components below keep their
own licenses and are recorded separately; nothing here is relabelled.

| Component | Origin | Revision | License | Use in this repo |
|---|---|---|---|---|
| MeikiOCR (`meikiocr/ocr.py`) | https://github.com/rtr46/meikiocr | `ebb8d2aedf69e62cbec57efb0bd00fb3e0e07297` | Apache-2.0 | Algorithms ported to TypeScript in `src/image/*`, `src/ocr/*`; pinned copy vendored at `tools/reference/meikiocr_reference.py` for fixture generation (`tools/reference/LICENSE.meikiocr`). |
| MeikiPop (`postprocessing.py`, `hit_scan.py`, `provider.py`, `popup.py`) | https://github.com/rtr46/meikipop | `ed1b70c40f38a6bd397e277ed4106c26d34dab97` | GPL-3.0 | Ported to TypeScript in `src/compat/meikipop/*`; pinned copies vendored at `tools/reference/meikipop_reference/` (`tools/reference/LICENSE.meikipop`). |
| `meiki.text.detect.v0.1.960x544.onnx` | https://huggingface.co/rtr46/meiki.text.detect.v0 | `a9cffa4f60cbf72ddb87edf19c6f98a01cd042e6` | LGPL-3.0 (per model card) | Downloaded at build time by `tools/fetch-models.mjs`; never committed. |
| `meiki.text.rec.v0.960x32.onnx`, `meiki.text.rec.v0.vertical.32x480.onnx` | https://huggingface.co/rtr46/meiki.txt.recognition.v0 | `a28cf5874dc2438ebb1c86336be26bcec51e3375` | LGPL-3.0 (per model card) | Same as above. |
| ONNX Runtime Web | https://github.com/microsoft/onnxruntime | npm `onnxruntime-web@1.30.0` | MIT | Runtime dependency; its `.wasm`/`.mjs` files are exported by `tools/export-assets.mjs`. |
| DroidSansJapanese (development only) | system font | — | Apache-2.0 | Used locally to render synthetic test fixtures; the font file is not redistributed. |

Model licensing note: the MeikiOCR Python repository declares Apache-2.0 while
the model repositories declare LGPL-3.0 and MeikiPop declares GPLv3. These are
kept distinct above. An attribution/license review is required before any
release that redistributes the model files themselves.
