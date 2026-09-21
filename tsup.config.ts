import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    meikipop: "src/compat/meikipop/index.ts",
    worker: "src/worker.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: "es2022",
  platform: "browser",
  // onnxruntime-web is loaded by the worker at runtime; keep it external so the
  // consumer controls which ORT build (and matching .wasm) is served.
  external: ["onnxruntime-web"],
});
