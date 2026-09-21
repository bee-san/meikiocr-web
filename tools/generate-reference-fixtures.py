#!/usr/bin/env python3
"""
Generate parity fixtures from the pinned native MeikiOCR pipeline.

Renders synthetic Japanese text images with a locally available font (never
committed), then records for each fixture:
  - the RGBA input (PNG),
  - detector tensor metadata + a small tensor slice snapshot (channel order,
    resize, padding, int64 metadata),
  - the native `run_ocr` result for both profiles:
      meikipop-v2      : RGB input, det 0.5, rec 0.1, punct 0.2
      meikiocr-native  : BGR input, det 0.5, rec 0.1, punct 1.0

Requires: numpy, opencv-python-headless, pillow, onnxruntime, and the pinned
model files (see models.lock.json / tools/fetch-models.mjs).

Usage:
  python tools/generate-reference-fixtures.py --models ./models --out tests/fixtures/parity \
      --font /usr/share/fonts/google-droid-sans-fonts/DroidSansJapanese.ttf
"""
import argparse
import hashlib
import json
import os
import sys
import unicodedata

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "reference"))
import meikiocr_reference as ref  # noqa: E402  (vendored pinned ocr.py, Apache-2.0)

CASES = [
    # name, text lines [(text, x, y, size, color)], canvas size, background
    ("white_on_dark_single", [("一生懸命に走った。", 20, 40, 28, (255, 255, 255))], (480, 120), (16, 16, 32)),
    ("colored_text", [("今日はいい天気ですね", 24, 30, 26, (255, 200, 60)), ("明日も晴れるでしょう", 24, 70, 26, (120, 220, 255))], (480, 130), (30, 10, 10)),
    ("psp_lowres_dialogue", [("「おはよう、先輩！」", 12, 14, 18, (250, 250, 250)), ("こんな朝早くから何してるの？", 12, 40, 18, (250, 250, 250))], (400, 80), (20, 20, 60)),
    ("punctuation_collisions", [("えっ…！？そ、それは…。", 20, 30, 26, (255, 255, 255))], (460, 100), (0, 0, 0)),
    ("speaker_and_dialogue", [("桜", 20, 20, 22, (255, 180, 200)), ("「ねえ、聞いてる？」", 20, 60, 26, (255, 255, 255))], (480, 120), (10, 10, 40)),
    ("menu_items", [("セーブ", 30, 20, 22, (255, 255, 255)), ("ロード", 30, 60, 22, (255, 255, 255)), ("設定", 30, 100, 22, (200, 200, 200))], (200, 150), (40, 40, 40)),
    ("long_line", [("吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。", 10, 30, 20, (255, 255, 255))], (800, 90), (0, 0, 0)),
    ("empty_image", [], (320, 180), (0, 0, 0)),
    ("non_japanese", [("Hello World 1234", 20, 40, 28, (255, 255, 255))], (400, 120), (0, 0, 0)),
    ("border_clipped", [("画面の端に切れた文字", -8, 5, 26, (255, 255, 255))], (300, 40), (0, 0, 0)),
    ("half_integer_resize", [("半端な寸法", 10, 12, 21, (255, 255, 255))], (301, 45), (0, 0, 0)),
    ("swapped_pair_candidate", [("冗談だよ", 20, 30, 28, (255, 255, 255))], (300, 100), (0, 0, 0)),
]


def render(case, font_path):
    name, lines, size, bg = case
    img = Image.new("RGBA", size, bg + (255,))
    d = ImageDraw.Draw(img)
    for text, x, y, sz, color in lines:
        font = ImageFont.truetype(font_path, sz)
        d.text((x, y), text, font=font, fill=color + (255,))
    return img


def tensor_snapshot(tensor):
    # small deterministic snapshot: shape, sum, and a few sampled values
    flat = tensor.reshape(-1)
    idx = np.linspace(0, flat.size - 1, 64).astype(np.int64)
    return {
        "shape": list(tensor.shape),
        "sum": float(np.sum(flat, dtype=np.float64)),
        "sampleIdx": idx.tolist(),
        "sampleVal": [float(v) for v in flat[idx]],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--font", required=True)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    ocr = ref.MeikiOCR(model_dir=args.models, provider="CPUExecutionProvider")

    manifest = {"cases": [], "font": os.path.basename(args.font), "opencv": ref.cv2.__version__, "numpy": np.__version__, "onnxruntime": ref.ort.__version__}
    for case in CASES:
        name = case[0]
        img = render(case, args.font)
        png = os.path.join(args.out, f"{name}.png")
        img.save(png)
        rgba = np.array(img)  # HxWx4 RGBA
        with open(os.path.join(args.out, f"{name}.rgba"), "wb") as fh:
            fh.write(np.ascontiguousarray(rgba).tobytes())
        rgb = rgba[:, :, :3].copy()
        bgr = rgb[:, :, ::-1].copy()

        entry = {"name": name, "png": os.path.basename(png), "rgba": f"{name}.rgba", "width": img.width, "height": img.height, "profiles": {}}

        for prof, arr, det_thr, rec_thr, punct in [
            ("meikipop-v2", rgb, 0.5, 0.1, 0.2),
            ("meikiocr-native", bgr, 0.5, 0.1, 1.0),
        ]:
            det_input, scale = ocr._preprocess_for_detection(arr)
            det_meta = np.array([[ref.INPUT_DET_WIDTH / scale, ref.INPUT_DET_HEIGHT / scale]], dtype=np.int64)
            results = ocr.run_ocr(arr, det_threshold=det_thr, rec_threshold=rec_thr, punct_conf_factor=punct)
            boxes = ocr.run_detection(arr, det_thr)
            entry["profiles"][prof] = {
                "detector": {
                    "scale": scale,
                    "origTargetSizes": [int(det_meta[0, 0]), int(det_meta[0, 1])],
                    "tensor": tensor_snapshot(det_input),
                    "boxes": [tb["bbox"] for tb in boxes],
                },
                "lines": [
                    {
                        "text": r["text"],
                        "isVertical": bool(r["is_vertical"]),
                        "chars": [{"char": c["char"], "bbox": [int(v) for v in c["bbox"]], "conf": float(c["conf"])} for c in r["chars"]],
                    }
                    for r in results
                ],
            }
        manifest["cases"].append(entry)
        print(f"{name}: " + " | ".join(r["text"] for r in entry["profiles"]["meikipop-v2"]["lines"]))

    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    print("wrote", os.path.join(args.out, "manifest.json"))


if __name__ == "__main__":
    main()
