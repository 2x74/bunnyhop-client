export interface PackAsset { mime: "image/png" | "image/webp" | "image/ktx2"; sha256: string; width: number; height: number; data: string }
export interface PackEntry { texturePath: string; mapSha256?: string; color: PackAsset; fallback?: PackAsset; normal?: PackAsset; roughness?: PackAsset; normalConvention?: "opengl" | "directx"; normalStrength?: number; roughnessFactor?: number }
export interface TexturePack { schemaVersion: 1; id: string; name: string; version: string; description?: string; entries: PackEntry[] }
export const PACK_LIMITS = { entries: 256, dimension: 4096, compressed: 64 * 1024 ** 2, decoded: 128 * 1024 ** 2, file: 90 * 1024 ** 2 };
export function normalizeTexturePath(value: string): string {
  if (typeof value !== "string" || value.length > 240 || /[\x00-\x1f?#:]/.test(value)) throw new Error("Invalid texture path");
  const path = value.toLowerCase().replace(/\\/g, "/").replace(/^materials\//, "").replace(/\.vtf$/, "");
  if (!/^[a-z0-9_./{} -]+$/.test(path) || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Unsafe texture path");
  return path;
}
export function decodeAsset(asset: PackAsset): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(asset.data) || asset.data.length % 4) throw new Error("Invalid base64 asset");
  const binary = atob(asset.data); return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
export async function validatePack(input: unknown, signal?: AbortSignal): Promise<TexturePack> {
  const pack = input as TexturePack;
  if (!pack || pack.schemaVersion !== 1 || typeof pack.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(pack.id) || typeof pack.name !== "string" || !pack.name.length || pack.name.length > 100 || typeof pack.version !== "string" || pack.version.length > 40 || !pack.version.length || !Array.isArray(pack.entries) || !pack.entries.length || pack.entries.length > PACK_LIMITS.entries) throw new Error("Invalid texture pack manifest");
  let compressed = 0, decoded = 0; const seen = new Set<string>(); const assets = new Set<string>();
  for (const entry of pack.entries) {
    signal?.throwIfAborted();
    if (!entry || typeof entry !== "object") throw new Error("Invalid texture mapping");
    if ("metalness" in entry || "ao" in entry) throw new Error("Metalness/AO channels are unsupported by the baked-light material renderer");
    if (entry.normalConvention !== undefined && !["opengl", "directx"].includes(entry.normalConvention)) throw new Error("Invalid normal convention");
    for (const value of [entry.normalStrength, entry.roughnessFactor]) if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 2)) throw new Error("Invalid material channel strength");
    entry.texturePath = normalizeTexturePath(entry.texturePath);
    if (entry.mapSha256 !== undefined && !/^[a-f0-9]{64}$/.test(entry.mapSha256)) throw new Error("Invalid map SHA-256");
    const key = `${entry.mapSha256 ?? "*"}:${entry.texturePath}`;
    if (seen.has(key)) throw new Error("Duplicate texture mapping"); seen.add(key);
    for (const [role, asset] of [["color", entry.color], ["color", entry.fallback], ["data", entry.normal], ["data", entry.roughness]] as const) {
      if (!asset) { if (role === "color" && asset === entry.color) throw new Error("Missing color asset"); continue; }
      if (!asset || !["image/png", "image/webp", "image/ktx2"].includes(asset.mime) || !/^[a-f0-9]{64}$/.test(asset.sha256) || typeof asset.data !== "string" || !Number.isInteger(asset.width) || !Number.isInteger(asset.height) || asset.width < 1 || asset.height < 1 || asset.width > PACK_LIMITS.dimension || asset.height > PACK_LIMITS.dimension) throw new Error("Invalid texture asset dimensions or format");
      const assetKey = `${asset.sha256}:${role}`;
      if (!assets.has(assetKey)) { compressed += Math.floor(asset.data.length * 3 / 4); decoded += Math.ceil(asset.width * asset.height * 4 * 4 / 3); assets.add(assetKey); }
      if (compressed > PACK_LIMITS.compressed || decoded > PACK_LIMITS.decoded) throw new Error("Texture pack exceeds memory budget");
      const bytes = decodeAsset(asset);
      validateAssetHeader(asset, bytes);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer)), (v) => v.toString(16).padStart(2, "0")).join("");
      signal?.throwIfAborted();
      if (hash !== asset.sha256) throw new Error(`Texture hash mismatch: ${entry.texturePath}`);
    }
  }
  return pack;
}
/** Later enabled installs win; a matching map-specific entry wins over a global entry. */
export function matchEntries(packs: readonly TexturePack[], mapSha256: string): Map<string, { pack: TexturePack; entry: PackEntry }> {
  const matches = new Map<string, { pack: TexturePack; entry: PackEntry }>();
  for (const pack of packs) {
    for (const entry of pack.entries) if (!entry.mapSha256) matches.set(normalizeTexturePath(entry.texturePath), { pack, entry });
    for (const entry of pack.entries) if (entry.mapSha256 === mapSha256) matches.set(normalizeTexturePath(entry.texturePath), { pack, entry });
  }
  return matches;
}


/** Check image dimensions before a decoder can allocate based on an untrusted header. */
export function validateAssetHeader(asset: PackAsset, bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0;
  if (asset.mime === "image/png") {
    if (bytes.length < 24 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a || view.getUint32(12) !== 0x49484452) throw new Error("Invalid PNG header");
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (asset.mime === "image/ktx2") {
    const identifier = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < 80 || identifier.some((v, i) => bytes[i] !== v) || view.getUint32(28, true) > 1 || view.getUint32(32, true) !== 0 || view.getUint32(36, true) !== 1 || view.getUint32(40, true) > 13) throw new Error("Only 2D KTX2 textures are supported");
    width = view.getUint32(20, true); height = view.getUint32(24, true);
  } else {
    if (bytes.length < 30 || view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57454250) throw new Error("Invalid WebP header");
    const tag = view.getUint32(12);
    if (tag === 0x56503858) { // VP8X
      if (bytes[20]! & 2) throw new Error("Animated WebP replacements are unsupported");
      width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16); height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
    } else if (tag === 0x5650384c && bytes[20] === 0x2f) { // VP8L
      const bits = view.getUint32(21, true); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (tag === 0x56503820 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      width = view.getUint16(26, true) & 0x3fff; height = view.getUint16(28, true) & 0x3fff;
    } else throw new Error("Unsupported WebP header");
  }
  if (width !== asset.width || height !== asset.height) throw new Error("Image header dimensions differ from manifest");
}

export function tryTexturePath(value: string): string | null { try { return normalizeTexturePath(value); } catch { return null; } }
