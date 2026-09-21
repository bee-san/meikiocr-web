import { describe, expect, it } from "vitest";
import { postprocessDetection } from "../../src/ocr/detect.js";
import { buildCandidates, fixSwappedPairs, resolveCandidates, toOcrLine, type CharCandidate } from "../../src/ocr/postprocess.js";
import { concatOutputs, runPipeline, validateFrame, type InferenceEngine } from "../../src/ocr/pipeline.js";
import { InputTooLargeError, InvalidInputError } from "../../src/errors.js";

describe("postprocessDetection", () => {
  it("keeps score > threshold strictly, clamps, truncates and sorts by y0 (stable)", () => {
    const warnings: string[] = [];
    const out = {
      count: 4,
      scores: [0.5, 0.9, 0.7, 0.8],
      boxes: [
        0, 0, 10, 10, // exactly threshold -> dropped
        -5.7, 50.9, 120.2, 60.1, // clamp x0->0, x1->100
        10.5, 20.5, 30.5, 40.5,
        3, 20.9, 9, 25, // same y0 (20) as previous after trunc -> stable order
      ],
    };
    const r = postprocessDetection(out, 100, 80, 0.5, warnings);
    expect(r.map((b) => [...b.box])).toEqual([
      [10, 20, 30, 40],
      [3, 20, 9, 25],
      [0, 50, 100, 60],
    ]);
    expect(warnings).toEqual([]);
  });
  it("drops non-finite boxes with a warning", () => {
    const warnings: string[] = [];
    const r = postprocessDetection({ count: 1, scores: [0.9], boxes: [NaN, 0, 1, 1] }, 10, 10, 0.5, warnings);
    expect(r).toEqual([]);
    expect(warnings[0]).toMatch(/non-finite/);
  });
});

describe("resolveCandidates (NMS + ordering + punctuation weighting)", () => {
  const cand = (char: string, x0: number, x1: number, conf: number): CharCandidate => ({
    char,
    box: [x0, 0, x1, 10],
    conf,
    interval: [x0, x1],
  });
  it("suppresses overlapping lower-confidence candidates using the interval ratio", () => {
    const r = resolveCandidates([cand("a", 0, 10, 0.5), cand("b", 0, 10, 0.9), cand("c", 12, 20, 0.4), cand("d", 19, 21, 0.3)], 1.0, false);
    // 'b' beats 'a'; 'd' overlaps 'c' by 1 / min(8,2)=0.5 > 0.3 -> suppressed
    expect(r.text).toBe("bc");
  });
  it("accepts overlap below threshold", () => {
    const r = resolveCandidates([cand("a", 0, 10, 0.9), cand("b", 8, 20, 0.8)], 1.0, false);
    // overlap 2 / min(10,12) = 0.2 <= 0.3 -> both kept, ordered by start
    expect(r.text).toBe("ab");
  });
  it("weights punctuation confidence so text wins overlaps in meikipop-v2", () => {
    const withoutFactor = resolveCandidates([cand("。", 0, 10, 0.6), cand("の", 0, 10, 0.5)], 1.0, false);
    expect(withoutFactor.text).toBe("。");
    const withFactor = resolveCandidates([cand("。", 0, 10, 0.6), cand("の", 0, 10, 0.5)], 0.2, false);
    expect(withFactor.text).toBe("の");
    expect(withFactor.chars[0]!.conf).toBe(0.5);
  });
  it("ties preserve candidate insertion order (stable sort)", () => {
    const r = resolveCandidates([cand("x", 0, 10, 0.5), cand("y", 0, 10, 0.5)], 1.0, false);
    expect(r.text).toBe("x");
  });
});

describe("fixSwappedPairs", () => {
  it("swaps upstream pairs atomically, keeping boxes in place", () => {
    const chars = [
      { char: "談", box: [0, 0, 10, 10] as const, conf: 0.9 },
      { char: "冗", box: [10, 0, 20, 10] as const, conf: 0.8 },
      { char: "だ", box: [20, 0, 30, 10] as const, conf: 0.7 },
    ];
    const r = fixSwappedPairs(chars);
    expect(r.text).toBe("冗談だ");
    expect(r.chars.map((c) => c.char)).toEqual(["冗", "談", "だ"]);
    expect(r.chars[0]!.box).toEqual([0, 0, 10, 10]);
    expect(r.chars[0]!.conf).toBe(0.9);
  });
  it("only fixes the first occurrence per pair (upstream behavior)", () => {
    const mk = (s: string) => Array.from(s).map((ch, i) => ({ char: ch, box: [i, 0, i + 1, 1] as const, conf: 1 }));
    expect(fixSwappedPairs(mk("談冗x談冗")).text).toBe("冗談x談冗");
  });
});

describe("buildCandidates", () => {
  it("maps model boxes back through effective dims and rejects padded area", () => {
    const metas = [{ boxIndex: 0, origBox: [100, 50, 300, 90] as const, effectiveW: 480, effectiveH: 32, segmentIdx: 0 }];
    const out = {
      perItem: 3,
      labels: new Int32Array([0x3042, 0x3044, 0x3046]),
      scores: new Float32Array([0.9, 0.05, 0.8]),
      boxes: new Float32Array([
        0, 0, 48, 32, // -> x 100..120, y 50..90
        50, 0, 60, 32, // below threshold
        480, 0, 500, 32, // rx1 >= effectiveW -> rejected (padded area)
      ]),
    };
    const m = buildCandidates(out, metas, 0.1, false);
    const list = m.get(0)!;
    expect(list.length).toBe(1);
    expect(list[0]!.char).toBe("あ");
    expect(list[0]!.box).toEqual([100, 50, 120, 90]);
    expect(list[0]!.interval).toEqual([100, 120]);
  });
  it("supports supplementary-plane code points", () => {
    const metas = [{ boxIndex: 0, origBox: [0, 0, 10, 10] as const, effectiveW: 10, effectiveH: 32, segmentIdx: 0 }];
    const out = { perItem: 1, labels: new Int32Array([0x20b9f]), scores: new Float32Array([1]), boxes: new Float32Array([0, 0, 5, 32]) };
    const list = buildCandidates(out, metas, 0.1, false).get(0)!;
    expect(list[0]!.char).toBe("𠮟");
    expect(list[0]!.char.length).toBe(2);
  });
});

describe("toOcrLine", () => {
  it("builds UTF-16 offsets correctly for supplementary characters", () => {
    const line = toOcrLine("l0", {
      boxIndex: 0,
      text: "𠮟る",
      isVertical: false,
      chars: [
        { char: "𠮟", box: [0, 0, 10, 10], conf: 1 },
        { char: "る", box: [10, 0, 20, 10], conf: 1 },
      ],
    });
    expect(line.text).toBe("𠮟る");
    expect(line.glyphs.map((g) => [g.utf16Start, g.utf16End])).toEqual([
      [0, 2],
      [2, 3],
    ]);
    expect(line.box).toEqual([0, 0, 20, 10]);
  });
});

describe("validateFrame", () => {
  const ok = { frameId: "f", width: 2, height: 2, capturedAtMs: 0, rgba: new ArrayBuffer(16) };
  it("accepts a valid frame", () => expect(() => validateFrame(ok, 100)).not.toThrow());
  it("rejects wrong byte length", () => expect(() => validateFrame({ ...ok, rgba: new ArrayBuffer(15) }, 100)).toThrow(InvalidInputError));
  it("rejects oversize", () => expect(() => validateFrame(ok, 3)).toThrow(InputTooLargeError));
  it("rejects non-integer dims", () => expect(() => validateFrame({ ...ok, width: 1.5 }, 100)).toThrow(InvalidInputError));
});

describe("runPipeline with a fake engine", () => {
  const fake: InferenceEngine = {
    backend: "wasm",
    modelSetId: "fake",
    detect: async () => ({ count: 1, scores: [0.99], boxes: [10, 10, 60, 30] }),
    recognizeHorizontal: async (_b, count) => ({
      perItem: 2,
      labels: new Int32Array(Array(count).fill([0x65e5, 0x672c]).flat()),
      scores: new Float32Array(Array(count).fill([0.9, 0.8]).flat()),
      boxes: new Float32Array(Array(count).fill([0, 0, 40, 32, 40, 0, 80, 32]).flat()),
    }),
  };
  it("produces a snapshot with lines/glyphs and diagnostics", async () => {
    const w = 100,
      h = 50;
    const snap = await runPipeline(
      fake,
      { frameId: "x", width: w, height: h, capturedAtMs: 1, rgba: new ArrayBuffer(w * h * 4) },
      { profile: "meikipop-v2", recognitionBatchSize: 4, maxInputPixels: 1e6, verticalEnabled: true },
    );
    expect(snap.lines.length).toBe(1);
    expect(snap.lines[0]!.text).toBe("日本");
    expect(snap.lines[0]!.glyphs[0]!.box).toEqual([10, 10, 35, 30]); // 40/80*50 = 25 wide
    expect(snap.diagnostics.backend).toBe("wasm");
    expect(snap.diagnostics.modelSetId).toBe("fake");
  });
  it("returns lines: [] for no detections", async () => {
    const snap = await runPipeline(
      { ...fake, detect: async () => ({ count: 0, scores: [], boxes: [] }) },
      { frameId: "x", width: 4, height: 4, capturedAtMs: 1, rgba: new ArrayBuffer(64) },
      { profile: "meikipop-v2", recognitionBatchSize: 4, maxInputPixels: 1e6, verticalEnabled: true },
    );
    expect(snap.lines).toEqual([]);
  });
  it("warns and skips vertical boxes when vertical is disabled", async () => {
    const snap = await runPipeline(
      { ...fake, detect: async () => ({ count: 1, scores: [0.9], boxes: [10, 0, 20, 40] }) },
      { frameId: "x", width: 50, height: 50, capturedAtMs: 1, rgba: new ArrayBuffer(50 * 50 * 4) },
      { profile: "meikipop-v2", recognitionBatchSize: 4, maxInputPixels: 1e6, verticalEnabled: false },
    );
    expect(snap.lines).toEqual([]);
    expect(snap.diagnostics.warnings.join()).toMatch(/vertical recognition disabled/);
  });
  it("chunks recognition by batch size and concatenates", async () => {
    const calls: number[] = [];
    const engine: InferenceEngine = {
      ...fake,
      detect: async () => ({ count: 5, scores: [0.9, 0.9, 0.9, 0.9, 0.9], boxes: [0, 0, 40, 10, 0, 10, 40, 20, 0, 20, 40, 30, 0, 30, 40, 40, 0, 40, 40, 50] }),
      recognizeHorizontal: async (b, count) => {
        calls.push(count);
        return fake.recognizeHorizontal(b, count);
      },
    };
    const snap = await runPipeline(
      engine,
      { frameId: "x", width: 40, height: 50, capturedAtMs: 1, rgba: new ArrayBuffer(40 * 50 * 4) },
      { profile: "meikipop-v2", recognitionBatchSize: 2, maxInputPixels: 1e6, verticalEnabled: true },
    );
    expect(calls).toEqual([2, 2, 1]);
    expect(snap.lines.length).toBe(5);
  });
});

describe("concatOutputs", () => {
  it("concatenates label/score/box arrays preserving per-item stride", () => {
    const a = { perItem: 2, labels: new Int32Array([1, 2]), scores: new Float32Array([0.1, 0.2]), boxes: new Float32Array(8).fill(1) };
    const b = { perItem: 2, labels: new BigInt64Array([3n, 4n]), scores: new Float32Array([0.3, 0.4]), boxes: new Float32Array(8).fill(2) };
    const m = concatOutputs([a, b]);
    expect(Array.from(m.labels as ArrayLike<number>)).toEqual([1, 2, 3, 4]);
    expect(Array.from(m.scores)).toEqual([0.1, 0.2, 0.3, 0.4].map((v) => Math.fround(v)));
    expect(m.boxes[8]).toBe(2);
  });
});
