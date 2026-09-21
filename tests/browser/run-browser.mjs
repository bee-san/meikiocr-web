#!/usr/bin/env node
/**
 * Real-browser inference check (Chromium via Playwright):
 *  1. bundle page + worker (ORT included) with esbuild,
 *  2. serve the repo root over HTTP,
 *  3. for each parity fixture run createMeikiOcr().scan() in the page and compare
 *     text + integer boxes with the native reference for both profiles.
 * Usage: node tests/browser/run-browser.mjs   (needs `npm run export-assets` first)
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFileSync, existsSync, createReadStream, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { chromium, firefox, webkit } from "playwright";

// Usage: node tests/browser/run-browser.mjs [chromium|firefox|webkit]
const browserName = process.argv[2] ?? "chromium";
const engine = { chromium, firefox, webkit }[browserName];
if (!engine) {
  console.error(`unknown browser '${browserName}'`);
  process.exit(2);
}

const root = resolve(".");
await build({
  entryPoints: { page: "tests/browser/page.ts", worker: "src/worker.ts" },
  outdir: "tests/browser/dist",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  splitting: false,
  sourcemap: false,
  logLevel: "warning",
});

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".onnx": "application/octet-stream", ".rgba": "application/octet-stream" };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = join(root, path === "/" ? "/tests/browser/index.html" : path);
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
    "cache-control": "no-store",
  });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const manifest = JSON.parse(readFileSync("tests/fixtures/parity/manifest.json", "utf8"));
const browser = await engine.launch();
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.harnessReady, null, { timeout: 60_000 });

let failures = 0;
let total = 0;
const report = [];
const verticalAsset = manifest.models?.find?.((m) => m.role === "recognizer-vertical")?.path ?? "vertical";
for (const profile of ["meikipop-v2", "meikiocr-native"]) {
  let sawVerticalLoad = false;
  for (const c of manifest.cases) {
    total++;
    const r = await page.evaluate(([n, w, h, p]) => window.runCase(n, w, h, p), [c.name, c.width, c.height, profile]);
    // Lazy vertical provisioning: the vertical recognizer must only be fetched/initialised
    // when the first vertical line is encountered, never during initial ready.
    const verticalEvents = r.progress.filter((e) => e.includes("vertical"));
    const hasVertical = c.profiles[profile].lines.some((l) => l.isVertical && l.chars.length);
    if (verticalEvents.length) {
      if (!hasVertical || sawVerticalLoad) {
        failures++;
        console.log(`FAIL [${profile}] ${c.name}: unexpected vertical asset activity ${JSON.stringify(verticalEvents)}`);
      } else {
        console.log(`  lazy vertical load observed on first vertical case (${c.name}): ${verticalEvents.length} progress events`);
      }
      sawVerticalLoad = true;
    } else if (hasVertical && !sawVerticalLoad) {
      failures++;
      console.log(`FAIL [${profile}] ${c.name}: vertical result without observed vertical provisioning`);
    }
    const refLines = c.profiles[profile].lines.filter((l) => l.chars.length > 0);
    const ok =
      JSON.stringify(r.lines.map((l) => l.text)) === JSON.stringify(refLines.map((l) => l.text)) &&
      JSON.stringify(r.lines.map((l) => l.boxes)) === JSON.stringify(refLines.map((l) => l.chars.map((ch) => ch.bbox)));
    if (!ok) failures++;
    report.push({ profile, name: c.name, ok, text: r.lines.map((l) => l.text).join(" | "), elapsedMs: Math.round(r.elapsedMs), backend: r.backend, coi: r.crossOriginIsolated, progress: r.progress.length });
    console.log(`${ok ? "PASS" : "FAIL"} [${profile}] ${c.name} (${Math.round(r.elapsedMs)} ms, ${r.backend}, coi=${r.crossOriginIsolated}) ${r.lines.map((l) => l.text).join(" | ")}`);
  }
}
// vertical: "off" must yield an empty, successful snapshot with a visible diagnostic.
{
  const vc = manifest.cases.find((c) => c.name === "vertical_single_column");
  const r = await page.evaluate(([n, w, h]) => window.runVerticalOff(n, w, h), [vc.name, vc.width, vc.height]);
  const ok = r.lines === 0 && r.warnings.some((w) => /vertical recognition disabled/.test(w)) && r.assetsTouched.length === 0;
  total++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} vertical:"off" -> lines=${r.lines} warnings=${JSON.stringify(r.warnings)} verticalAssetsTouched=${r.assetsTouched.length}`);
}
// Optional variants (reported, not gated): 2 WASM threads under COI; WebGPU request.
{
  const c = manifest.cases.find((x) => x.name === "white_on_dark_single");
  const ref = c.profiles["meikipop-v2"].lines.map((l) => l.chars.map((ch) => ch.char).join(""));
  for (const opts of [{ execution: "wasm", wasmThreads: 2 }, { execution: "webgpu", wasmThreads: 1 }]) {
    try {
      const r = await page.evaluate(([n, w, h, o]) => window.runVariant(n, w, h, o), [c.name, c.width, c.height, opts]);
      const same = JSON.stringify(r.text) === JSON.stringify(ref);
      console.log(`VARIANT ${JSON.stringify(opts)} -> backend=${r.backend} ready="${r.ready}" text ${same ? "matches" : "DIFFERS"}`);
    } catch (e) {
      console.log(`VARIANT ${JSON.stringify(opts)} -> error: ${e.message.split("\n")[0]}`);
    }
  }
}
const browserVersion = browser.version();
await browser.close();
server.close();
if (logs.length) console.log("browser console:\n" + logs.join("\n"));
console.log(`\n${total - failures}/${total} browser cases match the native reference (${browserName} ${browserVersion} via Playwright).`);
process.exit(failures ? 1 : 0);
