// Browser harness: real worker + real ORT WASM in Chromium. Bundled by esbuild (see run-browser.mjs).
import { createMeikiOcr } from "../../src/index.js";
import { buildMeikiPopLayout, hitTestMeikiPop } from "../../src/compat/meikipop/index.js";

declare global {
  interface Window {
    runCase: (name: string, width: number, height: number, profile: "meikipop-v2" | "meikiocr-native") => Promise<unknown>;
    harnessReady: boolean;
  }
}

const assetBaseUrl = new URL("/assets-export/", location.href).href;
const manifest = await (await fetch(assetBaseUrl + "manifest.json")).json();
const progress: string[] = [];
const clients = new Map<string, Awaited<ReturnType<typeof createMeikiOcr>>>();

async function client(profile: "meikipop-v2" | "meikiocr-native") {
  let c = clients.get(profile);
  if (!c) {
    c = await createMeikiOcr({
      manifest,
      assetBaseUrl,
      profile,
      execution: "wasm",
      wasmThreads: 1,
      vertical: "lazy",
      persistentCache: true,
      worker: new Worker(new URL("/tests/browser/dist/worker.js", location.href), { type: "module" }),
      onProgress: (e) => progress.push(`${e.phase}:${e.asset ?? ""}`),
    });
    clients.set(profile, c);
  }
  return c;
}

window.runCase = async (name, width, height, profile) => {
  const rgba = await (await fetch(`/tests/fixtures/parity/${name}.rgba`)).arrayBuffer();
  const c = await client(profile);
  const t0 = performance.now();
  const snap = await c.scan({ frameId: name, width, height, capturedAtMs: t0, rgba });
  const layout = buildMeikiPopLayout(snap);
  const firstGlyph = layout.paragraphs[0]?.glyphs[0];
  const hit = firstGlyph ? hitTestMeikiPop(layout, { x: (firstGlyph.box[0] + firstGlyph.box[2]) / 2, y: (firstGlyph.box[1] + firstGlyph.box[3]) / 2 }) : null;
  return {
    lines: snap.lines.map((l) => ({ text: l.text, boxes: l.glyphs.map((g) => [...g.box]) })),
    backend: snap.diagnostics.backend,
    elapsedMs: snap.diagnostics.elapsedMs,
    wallMs: performance.now() - t0,
    paragraphs: layout.paragraphs.map((p) => p.text),
    hit: hit ? { fullText: hit.fullText, suffix: hit.suffix } : null,
    progress: progress.splice(0),
    crossOriginIsolated: self.crossOriginIsolated,
  };
};
window.harnessReady = true;
