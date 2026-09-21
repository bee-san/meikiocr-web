#!/usr/bin/env node
/**
 * Export the runtime asset directory a consumer must serve from its origin:
 *   <out>/
 *     manifest.json                       AssetManifest for createMeikiOcr()
 *     meiki.text.detect.v0.1.960x544.onnx (+ recognizers)          from models.lock.json
 *     ort-wasm-simd-threaded.wasm / .mjs  (+ .jsep variants)        from the pinned onnxruntime-web
 *
 * Usage: node tools/export-assets.mjs --out assets-export [--models models]
 * The ORT JS and WASM files come from the SAME installed onnxruntime-web
 * version; never mix versions (see docs/deployment.md).
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);

const ORT_RUNTIME_FILES = [
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
];

async function sha256(path) {
  const buf = await readFile(path);
  return { sha256: createHash("sha256").update(buf).digest("hex"), byteLength: buf.byteLength };
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string", default: "assets-export" },
      models: { type: "string", default: "models" },
      lock: { type: "string", default: "models.lock.json" },
    },
  });
  const out = resolve(values.out);
  await mkdir(out, { recursive: true });
  const lock = JSON.parse(await readFile(resolve(values.lock), "utf8"));

  const models = [];
  for (const m of lock.models) {
    const src = join(resolve(values.models), m.file);
    const { sha256: h, byteLength } = await sha256(src);
    if (h !== m.sha256 || byteLength !== m.byteLength) {
      throw new Error(`${m.file} does not match models.lock.json (run tools/fetch-models.mjs)`);
    }
    await copyFile(src, join(out, m.file));
    models.push({ role: m.role, path: m.file, sha256: h, byteLength });
  }

  // onnxruntime-web's `exports` map does not expose package.json; resolve a
  // known dist file and walk up to the package root.
  const ortDistFile = require.resolve("onnxruntime-web/ort-wasm-simd-threaded.wasm");
  const distDir = dirname(ortDistFile);
  const ortVersion = JSON.parse(await readFile(join(distDir, "..", "package.json"), "utf8")).version;
  const runtime = [];
  for (const f of ORT_RUNTIME_FILES) {
    const src = join(distDir, f);
    try {
      const { sha256: h, byteLength } = await sha256(src);
      await copyFile(src, join(out, f));
      runtime.push({ path: f, sha256: h, byteLength });
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      process.stderr.write(`warning: ${f} not present in onnxruntime-web@${ortVersion}\n`);
    }
  }

  const manifest = {
    modelSetId: lock.modelSetId,
    onnxruntimeWeb: ortVersion,
    models,
    runtime,
  };
  await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(`exported ${models.length} models and ${runtime.length} runtime files (onnxruntime-web@${ortVersion}) to ${out}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e.stack ?? e}\n`);
  process.exit(1);
});
