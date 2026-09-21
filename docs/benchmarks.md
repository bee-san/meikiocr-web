# Benchmarks

No numbers are claimed yet. When measuring, record:

- hardware (CPU model, RAM), OS, browser + version
- `onnxruntime-web` version, model set id (`models.lock.json`), backend, thread count
- input crop size and profile
- warm-up procedure (first scan discarded)

Measure separately:

1. cold fetch of assets (network) vs cached initialization (Cache Storage hit → sessions ready)
2. detector latency, recognizer latency per batch, total `scan` latency (p50/p95)
3. worker memory if observable (`performance.measureUserAgentSpecificMemory` under isolation)
4. `buildMeikiPopLayout` + `hitTestMeikiPop` cost for representative layouts (target p95 < 1 ms; verify, do not assume)
5. teardown/recreate stability (dispose → create ×N without leaks)

The consumer's 500 ms scan interval is a scheduling choice, not a latency claim.

## First measurement (not a target)

2026-09-21, headless Chromium (Playwright 1.63, chromium-1243), Linux x86-64
cloud desktop, onnxruntime-web 1.30.0 WASM, 1 thread, cross-origin isolated,
model set `meiki-v0-det-a9cffa4-rec-a28cf58`, profile meikipop-v2, inputs
200×150 – 800×90 px synthetic fixtures, first scan per client not excluded:
total `scan` 375–714 ms per fixture (`diagnostics.elapsedMs`). Cold asset fetch
was from a local HTTP server and is not representative of network conditions.
