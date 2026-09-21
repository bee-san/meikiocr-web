/**
 * `meikiocr-web/meikipop` — optional, pure MeikiPop layout/hit-testing helpers.
 * Importing this module has no side effects and requires no DOM.
 */
export {
  buildMeikiPopLayout,
  areLinesAdjacent,
  toNormBox,
  normToRect,
  median,
  JAPANESE_REGEX,
  FURIGANA_HORIZONTAL_HEIGHT_THRESHOLD,
  FURIGANA_VERTICAL_WIDTH_THRESHOLD,
  ADJACENT_DISTANCE_FACTOR,
  ADJACENT_OVERLAP_RATIO,
  VERTICAL_ASPECT_FACTOR,
} from "./layout.js";
export type { LayoutSnapshot, LayoutParagraph, LayoutGlyph, LayoutOptions, NormBox } from "./layout.js";
export { hitTestMeikiPop, isInBoxEx } from "./hit-test.js";
export type { HitPoint } from "./hit-test.js";
export type { TextHit, Rect, Orientation } from "../../api/types.js";
