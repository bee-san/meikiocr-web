import type { AssetManifest, ModelAsset } from "../api/types.js";
import { AssetError, InvalidInputError } from "../errors.js";

export function resolveAssetUrl(baseUrl: string, path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path; // absolute URL
  if (!baseUrl.endsWith("/")) {
    throw new InvalidInputError(`assetBaseUrl must end with '/': ${baseUrl}`);
  }
  return new URL(path, baseUrl).toString();
}

export function validateManifest(m: AssetManifest): void {
  if (!m || typeof m.modelSetId !== "string" || !m.modelSetId) {
    throw new InvalidInputError("manifest.modelSetId is required");
  }
  const roles = new Set<string>();
  for (const a of m.models) {
    if (!a.path || !/^[0-9a-f]{64}$/i.test(a.sha256) || !(a.byteLength > 0)) {
      throw new InvalidInputError(`manifest model ${a.role} needs path, 64-hex sha256 and byteLength`);
    }
    if (roles.has(a.role)) throw new InvalidInputError(`duplicate model role ${a.role}`);
    roles.add(a.role);
  }
  if (!roles.has("detector") || !roles.has("recognizer-horizontal")) {
    throw new InvalidInputError("manifest must include detector and recognizer-horizontal");
  }
}

export function findModel(m: AssetManifest, role: ModelAsset["role"]): ModelAsset | undefined {
  return m.models.find((a) => a.role === role);
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view =
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Ensure a plain ArrayBuffer-backed view for SubtleCrypto.
  const buf = view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
    ? (view.buffer as ArrayBuffer)
    : view.slice().buffer;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyBytes(asset: ModelAsset, bytes: ArrayBuffer): Promise<void> {
  if (bytes.byteLength !== asset.byteLength) {
    throw new AssetError(
      "ASSET_INTEGRITY_FAILED",
      `${asset.path}: byte length ${bytes.byteLength} != expected ${asset.byteLength}`,
    );
  }
  const actual = await sha256Hex(bytes);
  if (actual.toLowerCase() !== asset.sha256.toLowerCase()) {
    throw new AssetError("ASSET_INTEGRITY_FAILED", `${asset.path}: sha256 ${actual} != expected ${asset.sha256}`);
  }
}
