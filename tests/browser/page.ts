// Browser harness: real worker + real ORT WASM in Chromium. Bundled by esbuild (see run-browser.mjs).
import { createMeikiOcr } from "../../src/index.js";
import { buildMeikiPopLayout, hitTestMeikiPop } from "../../src/compat/meikipop/index.js";

declare global {
  interface Window {
    runCase: (name: string, width: number, height: number, profile: "meikipop-v2" | "meikiocr-native") => Promise<unknown>;
    runVerticalOff: (name: string, width: number, height: number) => Promise<unknown>;
    runVariant: (name: string, width: number, height: number, opts: { execution: "wasm" | "webgpu" | "auto"; wasmThreads: number }) => Promise<unknown>;
    progressLog: string[];
    harnessReady: boolean;
  }
}

const assetBaseUrl = new URL("/assets-export/", location.href).href;
const manifest = await (await fetch(assetBaseUrl + "manifest.json")).json();
const progress: string[] = [];
window.progressLog = progress;
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
window.runVerticalOff = async (name, width, height) => {
  const rgba = await (await fetch(`/tests/fixtures/parity/${name}.rgba`)).arrayBuffer();
  const log: string[] = [];
  const c = await createMeikiOcr({
    manifest,
    assetBaseUrl,
    profile: "meikipop-v2",
    execution: "wasm",
    wasmThreads: 1,
    vertical: "off",
    persistentCache: true,
    worker: new Worker(new URL("/tests/browser/dist/worker.js", location.href), { type: "module" }),
    onProgress: (e) => log.push(`${e.phase}:${e.asset ?? ""}`),
  });
  const snap = await c.scan({ frameId: name, width, height, capturedAtMs: 0, rgba });
  await c.dispose();
  return { lines: snap.lines.length, warnings: snap.diagnostics.warnings, assetsTouched: log.filter((l) => l.includes("vertical")) };
};
/** Optional variants: threaded WASM (needs COI) and WebGPU (controlled fallback expected where unavailable). */
window.runVariant = async (name, width, height, opts) => {
  const rgba = await (await fetch(`/tests/fixtures/parity/${name}.rgba`)).arrayBuffer();
  const log: string[] = [];
  const c = await createMeikiOcr({
    manifest,
    assetBaseUrl,
    profile: "meikipop-v2",
    execution: opts.execution,
    wasmThreads: opts.wasmThreads,
    vertical: "off",
    persistentCache: true,
    worker: new Worker(new URL("/tests/browser/dist/worker.js", location.href), { type: "module" }),
    onProgress: (e) => log.push(`${e.phase}:${e.message ?? ""}`),
  });
  const snap = await c.scan({ frameId: name, width, height, capturedAtMs: 0, rgba });
  await c.dispose();
  return { text: snap.lines.map((l) => l.text), backend: snap.diagnostics.backend, ready: log.find((l) => l.startsWith("ready")), warnings: snap.diagnostics.warnings };
};
window.harnessReady = true;
