#!/usr/bin/env python3
"""
Generate MeikiPop layout/hit-test parity references.

Uses the pinned upstream MeikiPop code (GPLv3, vendored under tools/reference/meikipop/):
  - providers/postprocessing.py  (group_lines_into_paragraphs)
  - providers/meikiocr/provider.py logic (_to_meikipop_paragraphs, reproduced here
    without the MeikiOCR/PIL dependencies)
  - hit_scan.py pure geometry (reproduced verbatim minus threading/screen code)

Input: tests/fixtures/parity/manifest.json (native OCR results) plus synthetic
layout cases defined below (multi-line, furigana, vertical columns).
Output: tests/fixtures/meikipop/manifest.json
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "reference"))
from meikipop_reference.interface import BoundingBox, Paragraph, Word  # noqa: E402
from meikipop_reference.postprocessing import group_lines_into_paragraphs  # noqa: E402

JAPANESE_REGEX = re.compile(r'[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]')


def to_normalized_bbox(bbox_pixels, img_width, img_height):
    x1, y1, x2, y2 = bbox_pixels
    box_w, box_h = x2 - x1, y2 - y1
    center_x = (x1 + box_w / 2) / img_width
    center_y = (y1 + box_h / 2) / img_height
    return BoundingBox(center_x, center_y, box_w / img_width, box_h / img_height)


def to_meikipop_paragraphs(ocr_results, img_width, img_height):
    lines = []
    for line_result in ocr_results:
        full_text = line_result.get("text", "").strip()
        chars = line_result.get("chars", [])
        if not full_text or not chars or not JAPANESE_REGEX.search(full_text):
            continue
        words_in_line = []
        for char_info in chars:
            char_box = to_normalized_bbox(char_info['bbox'], img_width, img_height)
            words_in_line.append(Word(text=char_info['char'], separator="", box=char_box))
        min_x = min(c['bbox'][0] for c in chars)
        min_y = min(c['bbox'][1] for c in chars)
        max_x = max(c['bbox'][2] for c in chars)
        max_y = max(c['bbox'][3] for c in chars)
        line_box = to_normalized_bbox([min_x, min_y, max_x, max_y], img_width, img_height)
        lines.append(Paragraph(full_text=full_text, words=words_in_line, box=line_box,
                               is_vertical=line_box.width * 1.5 < line_box.height))
    return group_lines_into_paragraphs(lines)


def hit_scan(paragraphs, norm_x, norm_y):
    """Verbatim geometry from meikipop/ocr/hit_scan.py (returns full tuple)."""
    def is_in_box(point, box):
        if not box: return False
        px, py = point
        half_w, half_h = box.width / 2, box.height / 2
        return (box.center_x - half_w <= px <= box.center_x + half_w) and \
            (box.center_y - half_h <= py <= box.center_y + half_h)

    def is_in_box_ex(point, box_before, box, box_after, is_vertical_flag):
        if not box: return False
        left = box.center_x - box.width / 2
        right = box.center_x + box.width / 2
        top = box.center_y - box.height / 2
        bottom = box.center_y + box.height / 2
        if not is_vertical_flag and box_before: left = min(left, box_before.center_x + box_before.width / 2)
        if not is_vertical_flag and box_after: right = max(right, box_after.center_x - box_after.width / 2)
        if is_vertical_flag and box_before: top = min(top, box_before.center_y + box_before.height / 2)
        if is_vertical_flag and box_after: bottom = max(bottom, box_after.center_y - box_after.height / 2)
        px, py = point
        return (left <= px <= right) and (top <= py <= bottom)

    for pi, para in enumerate(paragraphs):
        if not is_in_box((norm_x, norm_y), para.box):
            continue
        target_word = None
        words = list(para.words)
        for i, word in enumerate(words):
            box_before = words[i - 1].box if i > 0 else None
            box_after = words[i + 1].box if i < len(words) - 1 else None
            if is_in_box_ex((norm_x, norm_y), box_before, word.box, box_after, para.is_vertical):
                target_word = word
                break
        if not target_word:
            continue
        char_offset = 0
        if para.is_vertical:
            if target_word.box.height > 0:
                top_edge = target_word.box.center_y - (target_word.box.height / 2)
                char_percent = max(0.0, min((norm_y - top_edge) / target_word.box.height, 1.0))
                char_offset = int(char_percent * len(target_word.text))
        else:
            if target_word.box.width > 0:
                left_edge = target_word.box.center_x - (target_word.box.width / 2)
                char_percent = max(0.0, min((norm_x - left_edge) / target_word.box.width, 1.0))
                char_offset = int(char_percent * len(target_word.text))
        char_offset = min(char_offset, len(target_word.text) - 1)
        word_start_index = 0
        for word in para.words:
            if word is target_word:
                break
            word_start_index += len(word.text)
        final_char_index = word_start_index + char_offset
        full_text = para.full_text
        if final_char_index >= len(full_text):
            continue
        return {"paragraphIndex": pi, "fullText": full_text, "codePointIndex": final_char_index,
                "char": full_text[final_char_index], "suffix": full_text[final_char_index:]}
    return None


def synth_line(text, x, y, cw, ch, gap=0, conf=0.9):
    chars = []
    cx = x
    for c in text:
        chars.append({"char": c, "bbox": [cx, y, cx + cw, y + ch], "conf": conf})
        cx += cw + gap
    return {"text": text, "chars": chars, "is_vertical": False}


def synth_vline(text, x, y, cw, ch, gap=0, conf=0.9):
    chars = []
    cy = y
    for c in text:
        chars.append({"char": c, "bbox": [x, cy, x + cw, cy + ch], "conf": conf})
        cy += ch + gap
    return {"text": text, "chars": chars, "is_vertical": True}


SYNTHETIC = [
    # name, (w,h), lines
    ("two_line_paragraph_with_gap", (400, 200), [
        synth_line("一生懸命に", 40, 40, 24, 24, gap=4),
        synth_line("走った。", 40, 76, 24, 24, gap=4),
    ]),
    ("furigana_above_main", (400, 200), [
        synth_line("いっしょう", 40, 30, 12, 12, gap=0),
        synth_line("一生懸命", 40, 46, 26, 26, gap=2),
        synth_line("走った", 40, 82, 26, 26, gap=2),
    ]),
    ("two_separate_blocks", (600, 300), [
        synth_line("セーブ", 30, 30, 20, 20),
        synth_line("ロード", 30, 60, 20, 20),
        synth_line("これは別の段落です", 300, 200, 20, 20),
    ]),
    ("vertical_columns_rtl", (300, 500), [
        synth_vline("吾輩は猫である", 200, 40, 26, 26, gap=2),
        synth_vline("名前はまだ無い", 160, 40, 26, 26, gap=2),
        synth_vline("どこで生れたか", 120, 40, 26, 26, gap=2),
    ]),
    ("vertical_with_furigana", (300, 500), [
        synth_vline("吾輩は猫", 200, 40, 26, 26, gap=2),
        synth_vline("わがはい", 228, 40, 10, 10, gap=1),
        synth_vline("名前はまだ", 160, 40, 26, 26, gap=2),
    ]),
    ("wide_spacing_not_grouped", (400, 400), [
        synth_line("上の行", 40, 40, 24, 24),
        synth_line("下の行", 40, 200, 24, 24),
    ]),
    ("mixed_non_japanese_filtered", (400, 200), [
        synth_line("HP 100", 40, 40, 16, 16),
        synth_line("体力", 40, 80, 24, 24),
    ]),
    ("speaker_label_and_dialogue", (480, 120), [
        synth_line("桜", 20, 20, 22, 22),
        synth_line("「ねえ、聞いてる？」", 20, 60, 24, 24, gap=1),
    ]),
]


def grid_points(w, h, step):
    pts = []
    for y in range(0, h, step):
        for x in range(0, w, step):
            pts.append((x + 0.5, y + 0.5))
    return pts


def run_case(name, w, h, ocr_results, out_cases, step):
    paragraphs = to_meikipop_paragraphs(ocr_results, w, h)
    para_json = [{
        "fullText": p.full_text, "isVertical": p.is_vertical,
        "box": [p.box.center_x, p.box.center_y, p.box.width, p.box.height],
        "wordCount": len(p.words),
    } for p in paragraphs]
    hits = []
    for (px, py) in grid_points(w, h, step):
        r = hit_scan(paragraphs, px / w, py / h)
        if r is not None:
            hits.append({"x": px, "y": py, **r})
    # add deterministic edge/gap probes: centres of each char and midpoints of gaps
    probes = []
    for p in paragraphs:
        for i, wd in enumerate(p.words):
            b = wd.box
            probes.append((b.center_x * w, b.center_y * h))
            if i + 1 < len(p.words):
                nb = p.words[i + 1].box
                probes.append(((b.center_x + nb.center_x) / 2 * w, (b.center_y + nb.center_y) / 2 * h))
    for (px, py) in probes:
        r = hit_scan(paragraphs, px / w, py / h)
        hits.append({"x": px, "y": py, **(r or {"miss": True})})
    out_cases.append({"name": name, "width": w, "height": h, "ocr": ocr_results,
                      "paragraphs": para_json, "hits": hits, "gridStep": step})


def main():
    out_dir = os.path.join(HERE, "..", "tests", "fixtures", "meikipop")
    os.makedirs(out_dir, exist_ok=True)
    cases = []
    # 1) synthetic geometry cases
    for name, (w, h), lines in SYNTHETIC:
        run_case(name, w, h, lines, cases, step=8)
    # 2) native OCR results from parity fixtures (meikipop-v2 profile)
    parity = os.path.join(HERE, "..", "tests", "fixtures", "parity", "manifest.json")
    if os.path.exists(parity):
        pm = json.load(open(parity, encoding="utf-8"))
        for c in pm["cases"]:
            lines = [{"text": l["text"], "chars": l["chars"], "is_vertical": l["isVertical"]}
                     for l in c["profiles"]["meikipop-v2"]["lines"]]
            run_case("native_" + c["name"], c["width"], c["height"], lines, cases, step=6)
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"cases": cases}, f, ensure_ascii=False, indent=0)
    for c in cases:
        print(f"{c['name']}: {len(c['paragraphs'])} paragraphs, {len(c['hits'])} hits -> {[p['fullText'] for p in c['paragraphs']]}")


if __name__ == "__main__":
    main()
