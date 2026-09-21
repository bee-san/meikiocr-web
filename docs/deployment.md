# Deployment

## Assets

Run `npm run export-assets` (after `npm run fetch-models`) to produce a directory:

```
assets-export/
  manifest.json                      # AssetManifest (modelSetId, models[], runtime[])
  meiki.text.detect.v0.1.960x544.onnx
  meiki.text.rec.v0.960x32.onnx
  meiki.text.rec.v0.vertical.32x480.onnx
  ort-wasm-simd-threaded.wasm / .mjs
  ort-wasm-simd-threaded.jsep.wasm / .jsep.mjs   # only needed for webgpu
```

Serve it from your origin (e.g. `/ocr-assets/`) and pass
`assetBaseUrl: ".../ocr-assets/"`. ORT is configured with
`env.wasm.wasmPaths = assetBaseUrl`, so the `.wasm/.mjs` files must sit in the
same directory as the models. Use the **same** `onnxruntime-web` version for
the JS bundle and these files; `manifest.json` records `onnxruntimeWeb`.

## Worker

`meikiocr-web/worker` is a module worker that imports `onnxruntime-web`. Let
your bundler build it:

```ts
const worker = new Worker(new URL("meikiocr-web/worker", import.meta.url), { type: "module" });
await createMeikiOcr({ ..., worker });
```

Angular (esbuild builder) and Vite both support this pattern. Alternatively
pre-bundle the worker yourself and pass `workerUrl`.

## Caching

- Models are verified (byte length + SHA-256) on every load and cached in Cache
  Storage under `DEFAULTS.cacheName` (`meikiocr-web-assets-v1`) keyed by content
  hash. `client.clearCache()` deletes only that cache.
- Do **not** delete "all caches except mine" in your service worker; scope
  cleanup to your own namespace. Do not double-cache the ONNX files in your
  service worker either — let the library own them, or cache them immutably
  with versioned URLs and let the library's verification pass through.
- If Cache Storage is unavailable (quota, private mode), the library keeps the
  models in memory for the session and still works.

## Threads and isolation

Default `wasmThreads: 1` works without cross-origin isolation. Requesting more
threads without `crossOriginIsolated` falls back to 1 and reports a warning.
Do not force a reload to obtain isolation on behalf of the user.

## Privacy

No image or text leaves the page. The only network requests are the asset
downloads you serve.
