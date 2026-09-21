# MeikiPop / MeikiOCR parity

Reference: `rtr46/meikipop@ed1b70c40f38a6bd397e277ed4106c26d34dab97`,
`rtr46/meikiocr@ebb8d2aedf69e62cbec57efb0bd00fb3e0e07297`.

## Exact behaviours (verified by tests)

| Behaviour | Upstream | Port | Test |
|---|---|---|---|
| Detector scale/truncation | `scale=min(960/w,544/h)`, `int()` truncation | same | `tests/unit/image.test.ts`, parity |
| Detector resize | `cv2.resize INTER_LINEAR` | `resizeLinearCv` — byte-identical incl. fixed-point, x-edge weight zeroing, y-edge index clipping, 2x-downscale INTER_AREA redirect | `tests/parity/resize-opencv.test.ts` |
| Padding | top-left content, zeros bottom/right | same | unit |
| `orig_target_sizes` | `int64([[960/scale, 544/scale]])` (float→int64 truncation) | `BigInt64Array` with `Math.trunc` | unit + parity |
| Detection filter | `scores > thr` strict; clip to `[0,w]/[0,h]`; `astype(int32)`; stable sort by `y0` | same | unit + parity |
| Orientation split | `h > w` → vertical | same | pipeline |
| Horizontal rec resize | `int(round(w*32/h))`, cap 960, `int(round(32*960/new_w))`; Python banker's rounding | `pyRound` | unit |
| Vertical rec | scale to width 32; split when scaled `h > 480` into 420-px segments, 64-px overlap, last segment appended when `last_y > prev + 1.0` | same | unit |
| Candidate mapping | reject `rx1 >= effective_w` (or `ry1 >= effective_h`), clamp, scale by effective dims, `int()` truncation; vertical rejects `gy2<=gy1` | same | unit + parity |
| Punctuation weighting | `unicodedata.category(c).startswith('P')` × factor | `/^\p{P}$/u` | unit |
| NMS | stable desc sort by conf; interval overlap ratio `> 0.3` against min length (+1e-6) | same | unit + parity |
| Ordering | by interval start (stable) | same | parity |
| Swapped pairs | first occurrence of each of 8 pairs; swap char fields only | same (code-point indexed) | unit + parity |
| Batch chunking | `max_batch_size` chunks concatenated | `recognitionBatchSize` (default 4, max 8) | unit |
| Japanese filter | `[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]` on stripped text | same (`japaneseFilter: true` default) | layout parity |
| Normalized boxes | centre/size divided by image w/h | same | layout parity |
| Line orientation heuristic | `box.width * 1.5 < box.height` on normalized box | same (differs from pixel `h > w` by design; both retained) | layout parity |
| Furigana | `< 0.65 × median` height (horizontal) / width (vertical), only when > 1 line of that orientation | same | layout parity |
| Adjacency | overlap `> 0.5 × min extent`; centre distance `< 1.9 × max thickness` | same | layout parity |
| Grouping | transitive, restart-on-grow; vertical set first then horizontal; furigana appended as own paragraphs | same | layout parity |
| Reading order | horizontal top→bottom by centre y; vertical right→left by centre x; text joined without separators | same | layout parity |
| Hit test | inclusive `<=` bounds; paragraph box first; `is_in_box_ex` neighbour extension; per-word offset by percent (always 0 for single-char words) | same | layout parity (~3000 probes) |

## Adaptations (browser / library scope)

| Topic | Upstream | Here | Why |
|---|---|---|---|
| Lookup suffix | truncated to `max_lookup_length` (25) by MeikiPop's dictionary path | full `suffix` plus `fullText`, `utf16Offset`, `codePointIndex` | no dictionary here |
| Empty lines | `run_ocr` returns `{'text': '', 'chars': []}` entries | omitted from `OcrSnapshot.lines` | they carry no geometry; parity tests filter them on the reference side |
| Whitespace strip | provider `.strip()`s `full_text` but keeps all chars | lines whose trimmed text is empty are filtered; otherwise text is **not** stripped, so glyph offsets stay exact | MeikiOCR labels do not produce whitespace in practice; stripping would desynchronise offsets |
| Offsets | Python code point indices | UTF-16 offsets plus code point index | DOM APIs use UTF-16 |
| IDs | none | snapshot-local line/glyph/paragraph IDs | consumers need stable references within a snapshot |
| Scheduling | threads + latest-value queues | not in library; consumer owns it (Plan 2) | library boundary |
| Screenshot lock | desktop-wide lock to avoid photographing the popup | not needed: consumers capture raw canvas pixels | browser architecture |

## Known limits

- Horizontal recognizer capacity is 48 candidates; saturation is flagged in `diagnostics.warnings`.
- Fixture coverage for vertical text is synthetic (layout) and unit-level (segmentation); native vertical recognition fixtures should be added.
- Confidence values differ from the native CPU EP by up to ~2e-3 (kernel differences); recorded tolerance, not broadened.
