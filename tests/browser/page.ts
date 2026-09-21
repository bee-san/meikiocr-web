// Browser harness: real worker + real ORT WASM in Chromium. Bundled by esbuild (see run-browser.mjs).
import { createMeikiOcr } from "../../src/index.js";
import { buildMeikiPopLayout, hitTestMeikiPop } from "../../src/compat/meikipop/index.js";

declare global {
  interface Window {
    runCase: (name: string, width: number, height: number, profile: "meikipop-v2" | "meikiocr-native") => Promise<unknown>;
    runVerticalOff: (name: string, width: number, height: number) => Promise<unknown>;
    runStress: (name: string, width: number, height: number) => Promise<unknown>;
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
/** Stress + lifecycle probes with the real worker (see run-browser.mjs --stress). */
window.runStress = async (name, width, height) => {
  const rgba = await (await fetch(`/tests/fixtures/parity/${name}.rgba`)).arrayBuffer();
  const mk = (workers: Worker[]) => createMeikiOcr({
    manifest, assetBaseUrl, profile: "meikipop-v2", execution: "wasm", wasmThreads: 1, vertical: "lazy", persistentCache: true,
    workerFactory: () => { const w = new Worker(new URL("/tests/browser/dist/worker.js", location.href), { type: "module" }); workers.push(w); return w; },
  });
  const workers: Worker[] = [];
  const c = await mk(workers);
  const frame = (i: number) => ({ frameId: `s${i}`, width, height, capturedAtMs: i, rgba });
  // 1) 60 sequential scans: latency + JS heap trend (main thread) ; results identical
  const times: number[] = [];
  let firstText = "";
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  const heap0 = mem?.usedJSHeapSize ?? 0;
  for (let i = 0; i < 60; i++) {
    const t0 = performance.now();
    const snap = await c.scan(frame(i));
    times.push(performance.now() - t0);
    const text = snap.lines.map((l) => l.text).join("|");
    if (i === 0) firstText = text;
    else if (text !== firstText) throw new Error(`scan ${i} differs: ${text} vs ${firstText}`);
  }
  const heap1 = mem?.usedJSHeapSize ?? 0;
  const sorted = [...times].sort((a, b) => a - b);
  // 2) abort storm: 30 scans aborted after random short delays, then a normal scan must work
  let aborted = 0, busy = 0;
  for (let i = 0; i < 30; i++) {
    const ac = new AbortController();
    const p = c.scan(frame(1000 + i), { signal: ac.signal });
    setTimeout(() => ac.abort(), Math.random() * 40);
    try { await p; } catch (e) { if ((e as { code?: string }).code === "ABORTED") aborted++; else throw e; }
    // worker may still be finishing → BusyError until it reports; wait it out by polling
    for (;;) {
      try { await c.scan(frame(2000 + i)); break; } catch (e) { if ((e as { code?: string }).code === "BUSY") { busy++; await new Promise((r) => setTimeout(r, 20)); } else throw e; }
    }
  }
  // 3) kill the worker mid-scan → WORKER_CRASHED, then bounded restart via factory
  const pKill = c.scan(frame(3000));
  await new Promise((r) => setTimeout(r, 30));
  workers[workers.length - 1]!.terminate(); // simulate a crash: the client sees no reply...
  // ...a terminated worker emits no error event; the client cannot detect it without a timeout. Force via dispatch:
  workers[workers.length - 1]!.dispatchEvent(new ErrorEvent("error", { message: "simulated crash" }));
  let crashCode = "none";
  try { await pKill; } catch (e) { crashCode = (e as { code?: string }).code ?? "?"; }
  const afterRestart = await c.scan(frame(3001));
  // 3b) SILENT termination (no error event) mid-scan → watchdog → restart. Use a short watchdog client.
  const workers2: Worker[] = [];
  const c2 = await createMeikiOcr({
    manifest, assetBaseUrl, profile: "meikipop-v2", execution: "wasm", wasmThreads: 1, vertical: "off", persistentCache: true, scanTimeoutMs: 1500,
    workerFactory: () => { const w = new Worker(new URL("/tests/browser/dist/worker.js", location.href), { type: "module" }); workers2.push(w); return w; },
  });
  const pSilent = c2.scan(frame(5000));
  await new Promise((r) => setTimeout(r, 30));
  workers2[0]!.terminate();
  const tW = performance.now();
  let silentCode = "none";
  try { await pSilent; } catch (e) { silentCode = (e as { code?: string }).code ?? "?"; }
  const watchdogMs = performance.now() - tW;
  const afterSilent = (await c2.scan(frame(5001))).lines.map((l) => l.text).join("|") === firstText;
  await c2.dispose();
  // 4) dispose mid-scan
  const pDisp = c.scan(frame(4000));
  const disp = c.dispose();
  let dispCode = "none";
  try { await pDisp; } catch (e) { dispCode = (e as { code?: string }).code ?? "?"; }
  await disp;
  let afterDispose = "none";
  try { await c.scan(frame(4001)); } catch (e) { afterDispose = (e as { code?: string }).code ?? "?"; }
  return {
    n: times.length, p50: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)], min: sorted[0], max: sorted[sorted.length - 1],
    heapDeltaMB: mem ? (heap1 - heap0) / 1048576 : null, text: firstText,
    aborted, busyRetries: busy, crashCode, restarted: afterRestart.lines.map((l) => l.text).join("|") === firstText, workersCreated: workers.length,
    dispCode, afterDispose, silentCode, watchdogMs: Math.round(watchdogMs), afterSilent, workers2: workers2.length,
  };
};
window.harnessReady = true;
