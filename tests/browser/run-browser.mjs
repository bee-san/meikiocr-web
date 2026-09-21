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
import { chromium } from "playwright";

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
const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.harnessReady, null, { timeout: 60_000 });

let failures = 0;
let total = 0;
const report = [];
for (const profile of ["meikipop-v2", "meikiocr-native"]) {
  for (const c of manifest.cases) {
    total++;
    const r = await page.evaluate(([n, w, h, p]) => window.runCase(n, w, h, p), [c.name, c.width, c.height, profile]);
    const refLines = c.profiles[profile].lines.filter((l) => l.chars.length > 0);
    const ok =
      JSON.stringify(r.lines.map((l) => l.text)) === JSON.stringify(refLines.map((l) => l.text)) &&
      JSON.stringify(r.lines.map((l) => l.boxes)) === JSON.stringify(refLines.map((l) => l.chars.map((ch) => ch.bbox)));
    if (!ok) failures++;
    report.push({ profile, name: c.name, ok, text: r.lines.map((l) => l.text).join(" | "), elapsedMs: Math.round(r.elapsedMs), backend: r.backend, coi: r.crossOriginIsolated, progress: r.progress.length });
    console.log(`${ok ? "PASS" : "FAIL"} [${profile}] ${c.name} (${Math.round(r.elapsedMs)} ms, ${r.backend}, coi=${r.crossOriginIsolated}) ${r.lines.map((l) => l.text).join(" | ")}`);
  }
}
await browser.close();
server.close();
if (logs.length) console.log("browser console:\n" + logs.join("\n"));
console.log(`\n${total - failures}/${total} browser cases match the native reference (Chromium ${chromium.name()} via Playwright).`);
process.exit(failures ? 1 : 0);
