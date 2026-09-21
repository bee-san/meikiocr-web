import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resizeLinearCv } from "../../src/image/resize.js";

const dir = join(__dirname, "..", "fixtures", "resize");
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
  src: string;
  sw: number;
  sh: number;
  opencv: string;
  cases: { dw: number; dh: number; file: string }[];
};

describe(`resizeLinearCv vs OpenCV ${manifest.opencv} INTER_LINEAR`, () => {
  const src = new Uint8Array(readFileSync(join(dir, manifest.src)));
  for (const c of manifest.cases) {
    it(`${manifest.sw}x${manifest.sh} -> ${c.dw}x${c.dh} is byte-identical`, () => {
      const expected = new Uint8Array(readFileSync(join(dir, c.file)));
      const got = resizeLinearCv(src, manifest.sw, manifest.sh, c.dw, c.dh, 4);
      expect(got.data.length).toBe(expected.length);
      let maxDiff = 0;
      let diffs = 0;
      for (let i = 0; i < expected.length; i++) {
        const d = Math.abs(got.data[i]! - expected[i]!);
        if (d > 0) diffs++;
        if (d > maxDiff) maxDiff = d;
      }
      expect({ diffs, maxDiff }).toEqual({ diffs: 0, maxDiff: 0 });
    });
  }
});
