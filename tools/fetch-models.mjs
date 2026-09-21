#!/usr/bin/env node
/**
 * Fetch the pinned MeikiOCR ONNX models and verify them against models.lock.json.
 *
 *   node tools/fetch-models.mjs [--out models] [--lock models.lock.json] [--write-lock]
 *
 * Without --write-lock the download MUST match the lock (revision-pinned URL,
 * SHA-256, byte length) or the tool exits non-zero. With --write-lock, the
 * downloaded bytes are hashed and the lock is (re)generated from the pinned
 * revisions declared in this file. Never point releases at mutable `main` URLs.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const PINNED = {
  detector: {
    repo: "rtr46/meiki.text.detect.v0",
    revision: "a9cffa4f60cbf72ddb87edf19c6f98a01cd042e6",
    file: "meiki.text.detect.v0.1.960x544.onnx",
    license: "lgpl-3.0",
    signature: {
      inputs: { images: "float32[N,3,544,960]", orig_target_sizes: "int64[N,2]" },
      outputs: { labels: "int64[N,64]", boxes: "float32[N,64,4]", scores: "float32[N,64]" },
    },
  },
  "recognizer-horizontal": {
    repo: "rtr46/meiki.txt.recognition.v0",
    revision: "a28cf5874dc2438ebb1c86336be26bcec51e3375",
    file: "meiki.text.rec.v0.960x32.onnx",
    license: "lgpl-3.0",
    signature: {
      inputs: { images: "float32[N,3,32,960]", orig_target_sizes: "int64[N,2]" },
      outputs: { char_codes: "int32[N,48]", boxes: "float32[N,48,4]", scores: "float32[N,48]" },
    },
  },
  "recognizer-vertical": {
    repo: "rtr46/meiki.txt.recognition.v0",
    revision: "a28cf5874dc2438ebb1c86336be26bcec51e3375",
    file: "meiki.text.rec.v0.vertical.32x480.onnx",
    license: "lgpl-3.0",
    signature: {
      inputs: { images: "float32[N,3,480,32]", orig_target_sizes: "int64[N,2]" },
      outputs: { char_codes: "int32[N,24]", boxes: "float32[N,24,4]", scores: "float32[N,24]" },
    },
  },
};

const MODEL_META = { irVersion: 8, opset: 16, producer: "pytorch 2.8.0", externalData: false };

function urlFor(m) {
  return `https://huggingface.co/${m.repo}/resolve/${m.revision}/${m.file}`;
}

async function sha256File(path) {
  const buf = await readFile(path);
  return { sha256: createHash("sha256").update(buf).digest("hex"), byteLength: buf.byteLength };
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  return buf.byteLength;
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string", default: "models" },
      lock: { type: "string", default: "models.lock.json" },
      "write-lock": { type: "boolean", default: false },
      "skip-download": { type: "boolean", default: false },
    },
  });
  const outDir = resolve(values.out);
  await mkdir(outDir, { recursive: true });

  let lock = null;
  if (!values["write-lock"]) {
    lock = JSON.parse(await readFile(resolve(values.lock), "utf8"));
  }

  const entries = [];
  let failed = false;
  for (const [role, m] of Object.entries(PINNED)) {
    const dest = join(outDir, m.file);
    const url = urlFor(m);
    let exists = false;
    try {
      await stat(dest);
      exists = true;
    } catch {
      /* not present */
    }
    if (!exists && !values["skip-download"]) {
      process.stdout.write(`fetching ${role}: ${url}\n`);
      await download(url, dest);
    } else if (!exists) {
      throw new Error(`${dest} missing and --skip-download given`);
    }
    const { sha256, byteLength } = await sha256File(dest);
    const entry = {
      role,
      file: m.file,
      repository: m.repo,
      revision: m.revision,
      url,
      license: m.license,
      sha256,
      byteLength,
      model: MODEL_META,
      signature: m.signature,
    };
    entries.push(entry);
    if (lock) {
      const expected = lock.models.find((e) => e.role === role);
      const ok = expected && expected.sha256 === sha256 && expected.byteLength === byteLength && expected.url === url;
      process.stdout.write(`${ok ? "OK  " : "FAIL"} ${role} ${m.file} sha256=${sha256} bytes=${byteLength}\n`);
      if (!ok) failed = true;
    } else {
      process.stdout.write(`hashed ${role} ${m.file} sha256=${sha256} bytes=${byteLength}\n`);
    }
  }

  if (values["write-lock"]) {
    const lockOut = {
      $schema: "./docs/models.lock.schema.json",
      generatedBy: "tools/fetch-models.mjs",
      modelSetId: `meiki-v0-det-${PINNED.detector.revision.slice(0, 7)}-rec-${PINNED["recognizer-horizontal"].revision.slice(0, 7)}`,
      models: entries,
    };
    await writeFile(resolve(values.lock), JSON.stringify(lockOut, null, 2) + "\n");
    process.stdout.write(`wrote ${values.lock}\n`);
  }
  if (failed) {
    process.stderr.write("model verification FAILED\n");
    process.exit(1);
  }
}

main().catch((e) => {
  process.stderr.write(`${e.stack ?? e}\n`);
  process.exit(1);
});
