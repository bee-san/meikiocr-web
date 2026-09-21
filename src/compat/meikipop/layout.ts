/**
 * Port of MeikiPop's paragraph construction:
 *   - src/meikipop/ocr/providers/meikiocr/provider.py (`_to_meikipop_paragraphs`)
 *   - src/meikipop/ocr/providers/postprocessing.py (`group_lines_into_paragraphs`)
 * at rtr46/meikipop@ed1b70c40f38a6bd397e277ed4106c26d34dab97.
 *
 * Pure functions; no DOM. Geometry is computed in MeikiPop's normalized
 * centre/size representation to reproduce its heuristics exactly, and exposed
 * back in source-image pixels.
 */
import type { OcrLine, OcrSnapshot, Orientation, Rect } from "../../api/types.js";

export const FURIGANA_VERTICAL_WIDTH_THRESHOLD = 0.65;
export const FURIGANA_HORIZONTAL_HEIGHT_THRESHOLD = 0.65;
export const ADJACENT_OVERLAP_RATIO = 0.5;
export const ADJACENT_DISTANCE_FACTOR = 1.9;
/** MeikiPop's `is_vertical = box.width * 1.5 < box.height` on normalized boxes. */
export const VERTICAL_ASPECT_FACTOR = 1.5;

/** JAPANESE_REGEX from the provider (hiragana, katakana, CJK unified). */
export const JAPANESE_REGEX = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/;

/** MeikiPop BoundingBox: normalized centre/size. */
export interface NormBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

export interface LayoutGlyph {
  glyphId: string;
  lineId: string;
  text: string;
  /** Source-image pixels. */
  box: Rect;
  norm: NormBox;
  /** UTF-16 offsets within the owning paragraph's text. */
  utf16Start: number;
  utf16End: number;
  /** Code point index within the paragraph text. */
  codePointIndex: number;
}

export interface LayoutParagraph {
  id: string;
  text: string;
  /** MeikiPop's orientation decision for this paragraph (normalized aspect heuristic). */
  orientation: Orientation;
  /** True when separated as a furigana candidate. */
  isFurigana: boolean;
  /** Source-image pixel union box. */
  box: Rect;
  norm: NormBox;
  lineIds: readonly string[];
  glyphs: readonly LayoutGlyph[];
}

export interface LayoutSnapshot {
  frameId: string;
  width: number;
  height: number;
  paragraphs: readonly LayoutParagraph[];
  /** Line IDs excluded by the Japanese-content filter (for diagnostics). */
  filteredLineIds: readonly string[];
}

export interface LayoutOptions {
  /**
   * Apply MeikiPop's `JAPANESE_REGEX.search(full_text)` filter (default true).
   * Set false to lay out raw OCR output regardless of script.
   */
  japaneseFilter?: boolean;
}

/** Internal single-line "Paragraph" as the provider produces before grouping. */
interface LineUnit {
  line: OcrLine;
  text: string;
  words: LayoutGlyph[]; // one per glyph, separator ""
  norm: NormBox;
  isVertical: boolean;
}

export function toNormBox(px: Rect, imgW: number, imgH: number): NormBox {
  const [x1, y1, x2, y2] = px;
  const bw = x2 - x1;
  const bh = y2 - y1;
  return {
    cx: (x1 + bw / 2) / imgW,
    cy: (y1 + bh / 2) / imgH,
    w: bw / imgW,
    h: bh / imgH,
  };
}

export function normToRect(n: NormBox, imgW: number, imgH: number): Rect {
  return [(n.cx - n.w / 2) * imgW, (n.cy - n.h / 2) * imgH, (n.cx + n.w / 2) * imgW, (n.cy + n.h / 2) * imgH];
}

function mergeNormBoxes(boxes: readonly NormBox[]): NormBox {
  if (boxes.length === 0) return { cx: 0, cy: 0, w: 0, h: 0 };
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.cx - b.w / 2);
    maxX = Math.max(maxX, b.cx + b.w / 2);
    minY = Math.min(minY, b.cy - b.h / 2);
    maxY = Math.max(maxY, b.cy + b.h / 2);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  return { cx: minX + w / 2, cy: minY + h / 2, w, h };
}

/** Port of `_are_lines_adjacent`. */
export function areLinesAdjacent(b1: NormBox, b2: NormBox, isVertical: boolean): boolean {
  if (isVertical) {
    const yOverlap = Math.max(0, Math.min(b1.cy + b1.h / 2, b2.cy + b2.h / 2) - Math.max(b1.cy - b1.h / 2, b2.cy - b2.h / 2));
    const enough = yOverlap > Math.min(b1.h, b2.h) * ADJACENT_OVERLAP_RATIO;
    const distOk = Math.abs(b1.cx - b2.cx) < ADJACENT_DISTANCE_FACTOR * Math.max(b1.w, b2.w);
    return enough && distOk;
  }
  const xOverlap = Math.max(0, Math.min(b1.cx + b1.w / 2, b2.cx + b2.w / 2) - Math.max(b1.cx - b1.w / 2, b2.cx - b2.w / 2));
  const enough = xOverlap > Math.min(b1.w, b2.w) * ADJACENT_OVERLAP_RATIO;
  const distOk = Math.abs(b1.cy - b2.cy) < ADJACENT_DISTANCE_FACTOR * Math.max(b1.h, b2.h);
  return enough && distOk;
}

/** Python statistics.median. */
export function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  const mid = n >> 1;
  return n % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Port of `_classify_lines_by_size`. Preserves upstream ordering of results. */
function classifyLinesBySize(lines: LineUnit[]): { main: LineUnit[]; furigana: LineUnit[] } {
  const main: LineUnit[] = [];
  const furigana: LineUnit[] = [];
  const vertical = lines.filter((l) => l.isVertical);
  const horizontal = lines.filter((l) => !l.isVertical);

  if (vertical.length) {
    if (vertical.length > 1) {
      const thr = median(vertical.map((l) => l.norm.w)) * FURIGANA_VERTICAL_WIDTH_THRESHOLD;
      for (const l of vertical) (l.norm.w < thr ? furigana : main).push(l);
    } else {
      main.push(...vertical);
    }
  }
  if (horizontal.length) {
    if (horizontal.length > 1) {
      const thr = median(horizontal.map((l) => l.norm.h)) * FURIGANA_HORIZONTAL_HEIGHT_THRESHOLD;
      for (const l of horizontal) (l.norm.h < thr ? furigana : main).push(l);
    } else {
      main.push(...horizontal);
    }
  }
  return { main, furigana };
}

function lineToUnit(line: OcrLine, imgW: number, imgH: number): LineUnit | null {
  if (line.glyphs.length === 0) return null;
  const words: LayoutGlyph[] = line.glyphs.map((g) => ({
    glyphId: g.id,
    lineId: line.id,
    text: g.text,
    box: g.box,
    norm: toNormBox(g.box, imgW, imgH),
    utf16Start: g.utf16Start,
    utf16End: g.utf16End,
    codePointIndex: 0, // filled during merge
  }));
  // Line box = union of character boxes (upstream computes it explicitly).
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const g of line.glyphs) {
    minX = Math.min(minX, g.box[0]);
    minY = Math.min(minY, g.box[1]);
    maxX = Math.max(maxX, g.box[2]);
    maxY = Math.max(maxY, g.box[3]);
  }
  const norm = toNormBox([minX, minY, maxX, maxY], imgW, imgH);
  return {
    line,
    text: line.text,
    words,
    norm,
    isVertical: norm.w * VERTICAL_ASPECT_FACTOR < norm.h,
  };
}

function mergeUnits(units: LineUnit[], id: string, isFurigana: boolean, imgW: number, imgH: number): LayoutParagraph {
  const isVertical = units[0]!.isVertical;
  if (isVertical) units.sort((a, b) => b.norm.cx - a.norm.cx); // right-to-left
  else units.sort((a, b) => a.norm.cy - b.norm.cy); // top-to-bottom

  const glyphs: LayoutGlyph[] = [];
  let text = "";
  let cpIndex = 0;
  const lineIds: string[] = [];
  for (const u of units) {
    const base = text.length;
    for (const w of u.words) {
      glyphs.push({
        ...w,
        utf16Start: base + w.utf16Start,
        utf16End: base + w.utf16End,
        codePointIndex: cpIndex,
      });
      cpIndex += Array.from(w.text).length;
    }
    text += u.text;
    lineIds.push(u.line.id);
  }
  const norm = mergeNormBoxes(units.map((u) => u.norm));
  return {
    id,
    text,
    orientation: isVertical ? "vertical" : "horizontal",
    isFurigana,
    box: normToRect(norm, imgW, imgH),
    norm,
    lineIds,
    glyphs,
  };
}

/**
 * Build MeikiPop-style paragraphs from an OcrSnapshot.
 * Port of `_to_meikipop_paragraphs` + `group_lines_into_paragraphs`.
 */
export function buildMeikiPopLayout(snapshot: OcrSnapshot, options: LayoutOptions = {}): LayoutSnapshot {
  const japaneseFilter = options.japaneseFilter ?? true;
  const { width: imgW, height: imgH } = snapshot;
  const filtered: string[] = [];
  const units: LineUnit[] = [];
  for (const line of snapshot.lines) {
    const trimmed = line.text.trim();
    if (!trimmed || line.glyphs.length === 0 || (japaneseFilter && !JAPANESE_REGEX.test(trimmed))) {
      filtered.push(line.id);
      continue;
    }
    const u = lineToUnit(line, imgW, imgH);
    if (u) units.push(u);
  }

  if (units.length === 0) {
    return { frameId: snapshot.frameId, width: imgW, height: imgH, paragraphs: [], filteredLineIds: filtered };
  }

  const { main, furigana } = classifyLinesBySize(units);
  const verticalLines = main.filter((l) => l.isVertical);
  const horizontalLines = main.filter((l) => !l.isVertical);

  const paragraphs: LayoutParagraph[] = [];
  let pid = 0;
  for (const lineSet of [verticalLines, horizontalLines]) {
    while (lineSet.length) {
      const group = [lineSet.shift()!];
      let i = 0;
      while (i < lineSet.length) {
        const cand = lineSet[i]!;
        const adjacent = group.some((g) => areLinesAdjacent(g.norm, cand.norm, g.isVertical));
        if (adjacent) {
          group.push(lineSet.splice(i, 1)[0]!);
          i = 0; // restart, group grew
        } else {
          i++;
        }
      }
      paragraphs.push(mergeUnits(group, `p${pid++}`, false, imgW, imgH));
    }
  }
  for (const f of furigana) paragraphs.push(mergeUnits([f], `p${pid++}`, true, imgW, imgH));

  return { frameId: snapshot.frameId, width: imgW, height: imgH, paragraphs, filteredLineIds: filtered };
}
