// Serve the repo root (e.g. `npx serve .`) after `npm run build && npm run export-assets`.
// Then open /examples/hover-image/. Assets are loaded from /assets-export/.
import { createMeikiOcr } from "../../dist/index.js";
import { buildMeikiPopLayout, hitTestMeikiPop } from "../../dist/meikipop.js";

const status = document.getElementById("status");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const boxes = document.getElementById("boxes");
const out = document.getElementById("out");

const assetBaseUrl = new URL("../../assets-export/", import.meta.url).href;
const manifest = await (await fetch(assetBaseUrl + "manifest.json")).json();

let client = null;
let layout = null;

async function ensureClient() {
  if (client) return client;
  status.textContent = "initializing…";
  client = await createMeikiOcr({
    manifest,
    assetBaseUrl,
    profile: document.getElementById("profile").value,
    onProgress: (e) => (status.textContent = `${e.phase} ${e.asset ?? ""} ${e.loadedBytes ?? ""}/${e.totalBytes ?? ""}`),
    // Note: this example imports ORT from the bare specifier inside dist/worker.js; a bundler
    // resolves it. For a no-bundler demo, pre-bundle the worker or use an import map.
    worker: new Worker(new URL("../../dist/worker.js", import.meta.url), { type: "module" }),
  });
  return client;
}

document.getElementById("file").addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  const bmp = await createImageBitmap(file);
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const c = await ensureClient();
  status.textContent = "scanning…";
  const t = performance.now();
  const snap = await c.scan({ frameId: String(Date.now()), width: img.width, height: img.height, capturedAtMs: t, rgba: img.data.buffer }, { transfer: "move" });
  status.textContent = `done in ${snap.diagnostics.elapsedMs.toFixed(0)} ms (${snap.diagnostics.backend}); ${snap.lines.length} lines`;
  layout = buildMeikiPopLayout(snap);
  boxes.replaceChildren(
    ...layout.paragraphs.flatMap((p) =>
      p.glyphs.map((g) => {
        const d = document.createElement("div");
        d.className = "box";
        d.dataset.glyph = g.glyphId;
        d.style.left = g.box[0] + "px";
        d.style.top = g.box[1] + "px";
        d.style.width = g.box[2] - g.box[0] + "px";
        d.style.height = g.box[3] - g.box[1] + "px";
        return d;
      }),
    ),
  );
  out.textContent = layout.paragraphs.map((p) => `[${p.orientation}${p.isFurigana ? ", furigana" : ""}] ${p.text}`).join("\n");
});

canvas.addEventListener("pointermove", (ev) => {
  if (!layout) return;
  const r = canvas.getBoundingClientRect();
  const x = ((ev.clientX - r.left) * canvas.width) / r.width;
  const y = ((ev.clientY - r.top) * canvas.height) / r.height;
  const hit = hitTestMeikiPop(layout, { x, y });
  for (const el of boxes.children) el.classList.toggle("active", !!hit && el.dataset.glyph === hit.glyphId);
  if (hit) out.textContent = `${hit.fullText}\n@${hit.utf16Offset} (cp ${hit.codePointIndex}) → ${hit.suffix}`;
});
