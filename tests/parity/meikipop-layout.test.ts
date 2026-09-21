/**
 * Parity of buildMeikiPopLayout / hitTestMeikiPop against the pinned upstream
 * MeikiPop postprocessing + hit_scan geometry (tools/generate-meikipop-fixtures.py).
 * Exact matches required: paragraph text/order/orientation, and for every
 * probed point the same paragraph, code point index, character and suffix.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OcrLine, OcrSnapshot, Rect } from "../../src/api/types.js";
import { buildMeikiPopLayout, hitTestMeikiPop } from "../../src/compat/meikipop/index.js";
import { toOcrLine } from "../../src/ocr/postprocess.js";

interface RefLine {
  text: string;
  chars: { char: string; bbox: number[]; conf: number }[];
  is_vertical: boolean;
}
interface RefHit {
  x: number;
  y: number;
  miss?: boolean;
  paragraphIndex?: number;
  fullText?: string;
  codePointIndex?: number;
  char?: string;
  suffix?: string;
}
interface RefCase {
  name: string;
  width: number;
  height: number;
  ocr: RefLine[];
  paragraphs: { fullText: string; isVertical: boolean; box: number[]; wordCount: number }[];
  hits: RefHit[];
}

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "meikipop", "manifest.json"), "utf8")) as {
  cases: RefCase[];
};

function toSnapshot(c: RefCase): OcrSnapshot {
  const lines: OcrLine[] = c.ocr
    .filter((l) => l.chars.length > 0)
    .map((l, i) =>
      toOcrLine(`l${i}`, {
        boxIndex: i,
        text: l.text,
        isVertical: l.is_vertical,
        chars: l.chars.map((ch) => ({ char: ch.char, box: ch.bbox as unknown as Rect, conf: ch.conf })),
      }),
    );
  return {
    frameId: c.name,
    width: c.width,
    height: c.height,
    profile: "meikipop-v2",
    lines,
    diagnostics: { backend: "wasm", elapsedMs: 0, modelSetId: "fixture", warnings: [] },
  };
}

describe("MeikiPop layout parity", () => {
  for (const c of manifest.cases) {
    it(`${c.name}: paragraphs match upstream grouping`, () => {
      const layout = buildMeikiPopLayout(toSnapshot(c));
      expect(layout.paragraphs.map((p) => p.text)).toEqual(c.paragraphs.map((p) => p.fullText));
      expect(layout.paragraphs.map((p) => p.orientation === "vertical")).toEqual(c.paragraphs.map((p) => p.isVertical));
      layout.paragraphs.forEach((p, i) => {
        const r = c.paragraphs[i]!;
        expect([p.norm.cx, p.norm.cy, p.norm.w, p.norm.h].map((v) => +v.toFixed(9))).toEqual(r.box.map((v) => +v.toFixed(9)));
        expect(p.glyphs.length).toBe(r.wordCount);
        // paragraph text equals glyph concatenation; offsets contiguous
        expect(p.glyphs.map((g) => g.text).join("")).toBe(p.text);
        let off = 0;
        for (const g of p.glyphs) {
          expect(g.utf16Start).toBe(off);
          off = g.utf16End;
        }
      });
    });

    it(`${c.name}: ${c.hits.length} probed hits match upstream hit_scan`, () => {
      const layout = buildMeikiPopLayout(toSnapshot(c));
      for (const h of c.hits) {
        const hit = hitTestMeikiPop(layout, { x: h.x, y: h.y });
        if (h.miss) {
          expect(hit, `expected miss at ${h.x},${h.y}`).toBeNull();
          continue;
        }
        expect(hit, `expected hit at ${h.x},${h.y}`).not.toBeNull();
        expect(hit!.fullText).toBe(h.fullText);
        expect(hit!.codePointIndex).toBe(h.codePointIndex);
        expect(hit!.suffix).toBe(h.suffix);
        expect(hit!.fullText.slice(hit!.utf16Offset)).toBe(h.suffix);
        expect(Array.from(hit!.fullText)[hit!.codePointIndex]).toBe(h.char);
        expect(layout.paragraphs.findIndex((p) => p.id === hit!.paragraphId)).toBe(h.paragraphIndex);
      }
    });
  }
});
