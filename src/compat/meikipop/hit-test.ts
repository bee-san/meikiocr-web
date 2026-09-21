/**
 * Port of MeikiPop's `HitScanner.hit_scan` (src/meikipop/ocr/hit_scan.py at
 * ed1b70c40f38a6bd397e277ed4106c26d34dab97), minus the dictionary lookup
 * length limit. Returns the full paragraph, the offset of the pointed character
 * and the suffix from that character.
 *
 * Boundary semantics (upstream): all comparisons are inclusive (`<=`).
 */
import type { TextHit } from "../../api/types.js";
import type { LayoutParagraph, LayoutSnapshot, NormBox } from "./layout.js";

export interface HitPoint {
  x: number;
  y: number;
}

function isInBox(px: number, py: number, box: NormBox): boolean {
  const hw = box.w / 2;
  const hh = box.h / 2;
  return box.cx - hw <= px && px <= box.cx + hw && box.cy - hh <= py && py <= box.cy + hh;
}

/**
 * `is_in_box_ex`: extend the character box toward its neighbours so gaps
 * between adjacent characters still resolve to a character.
 */
export function isInBoxEx(
  px: number,
  py: number,
  before: NormBox | null,
  box: NormBox,
  after: NormBox | null,
  isVertical: boolean,
): boolean {
  let left = box.cx - box.w / 2;
  let right = box.cx + box.w / 2;
  let top = box.cy - box.h / 2;
  let bottom = box.cy + box.h / 2;
  if (!isVertical && before) left = Math.min(left, before.cx + before.w / 2);
  if (!isVertical && after) right = Math.max(right, after.cx - after.w / 2);
  if (isVertical && before) top = Math.min(top, before.cy + before.h / 2);
  if (isVertical && after) bottom = Math.max(bottom, after.cy - after.h / 2);
  return left <= px && px <= right && top <= py && py <= bottom;
}

/**
 * Hit-test a point given in source-image pixels against a layout.
 * Returns the first matching paragraph/character in MeikiPop's iteration order.
 */
export function hitTestMeikiPop(layout: LayoutSnapshot, point: HitPoint): TextHit | null {
  if (layout.paragraphs.length === 0) return null;
  if (!(layout.width > 0 && layout.height > 0)) return null;
  const nx = point.x / layout.width;
  const ny = point.y / layout.height;

  for (const para of layout.paragraphs) {
    if (!isInBox(nx, ny, para.norm)) continue;
    const hit = hitWithinParagraph(para, nx, ny);
    if (hit) return hit;
  }
  return null;
}

function hitWithinParagraph(para: LayoutParagraph, nx: number, ny: number): TextHit | null {
  const words = para.glyphs;
  const isVertical = para.orientation === "vertical";
  let target: LayoutParagraph["glyphs"][number] | null = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const before = i > 0 ? words[i - 1]!.norm : null;
    const after = i < words.length - 1 ? words[i + 1]!.norm : null;
    if (isInBoxEx(nx, ny, before, w.norm, after, isVertical)) {
      target = w;
      break;
    }
  }
  if (!target) return null;

  // Upstream computes a character offset within the word; each MeikiOCR word is
  // a single character, so the offset is always clamped to 0. Reproduced for
  // completeness with multi-code-point glyph text.
  const cpLen = Array.from(target.text).length;
  let charOffset = 0;
  if (isVertical) {
    if (target.norm.h > 0) {
      const top = target.norm.cy - target.norm.h / 2;
      const pct = Math.max(0, Math.min((ny - top) / target.norm.h, 1));
      charOffset = Math.trunc(pct * cpLen);
    }
  } else if (target.norm.w > 0) {
    const left = target.norm.cx - target.norm.w / 2;
    const pct = Math.max(0, Math.min((nx - left) / target.norm.w, 1));
    charOffset = Math.trunc(pct * cpLen);
  }
  charOffset = Math.min(charOffset, cpLen - 1);

  // Map the (code point) offset within the glyph to a UTF-16 offset.
  const glyphCps = Array.from(target.text);
  let utf16Offset = target.utf16Start;
  for (let i = 0; i < charOffset; i++) utf16Offset += glyphCps[i]!.length;
  const codePointIndex = target.codePointIndex + charOffset;
  if (utf16Offset >= para.text.length) return null;

  return {
    paragraphId: para.id,
    lineId: target.lineId,
    glyphId: target.glyphId,
    fullText: para.text,
    utf16Offset,
    codePointIndex,
    suffix: para.text.slice(utf16Offset),
    sourceBox: target.box,
  };
}
