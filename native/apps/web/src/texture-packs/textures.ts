import * as THREE from "three";
import type { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { decodeAsset, matchEntries, tryTexturePath, PACK_LIMITS, type PackAsset } from "./manifest";
import type { MaterialChannels } from "../material-detail";
import { installedPacks } from "./store";
export interface TextureOverrides extends Map<string, THREE.Texture> { packs: { id: string; version: string }[]; materials: Map<string, MaterialChannels> }
/** Decode only matched assets; uploads remain render-only and never enter Core's content cache. */
export async function prepareTextureOverrides(renderer: THREE.WebGLRenderer, paths: readonly string[], mapSha256: string): Promise<TextureOverrides> {
  const result: TextureOverrides = Object.assign(new Map<string, THREE.Texture>(), { packs: [] as { id: string; version: string }[], materials: new Map<string, MaterialChannels>() });
  const installed = await installedPacks().catch((error) => { console.warn("Texture packs unavailable", error); return []; });
  const packs = installed.filter((record) => record.enabled).map((record) => record.pack);
  if (!packs.length) { return result; }
  const matches = matchEntries(packs, mapSha256);
  // The KTX2 / Basis decoder (and its zstd) loads only for packs that ship KTX2 assets.
  let ktx2: Promise<KTX2Loader> | null = null;
  const ktx2Loader = () => (ktx2 ??= import("three/addons/loaders/KTX2Loader.js").then(({ KTX2Loader }) => new KTX2Loader().setTranscoderPath("/texture-packs/basis/").setWorkerLimit(2).detectSupport(renderer)));
  const decoded = new Map<string, THREE.Texture>(); let memory = 0;
  const decode = async (asset: PackAsset, dataChannel = false): Promise<THREE.Texture> => {
    const cacheKey = `${asset.sha256}:${dataChannel ? "data" : "color"}`;
    const cached = decoded.get(cacheKey); if (cached) return cached;
    const bytes = decodeAsset(asset); let texture: THREE.Texture;
    if (asset.mime === "image/ktx2") {
      const loader = await ktx2Loader();
      texture = await new Promise<THREE.Texture>((resolve, reject) => loader.parse(bytes.buffer as ArrayBuffer, resolve, reject));
    } else {
      const image = await createImageBitmap(new Blob([bytes.buffer as ArrayBuffer], { type: asset.mime }), { imageOrientation: "none", premultiplyAlpha: "none", colorSpaceConversion: "none" });
      if (image.width !== asset.width || image.height !== asset.height) { image.close(); throw new Error("Decoded texture dimensions differ from manifest"); }
      texture = new THREE.Texture(image); texture.flipY = false;
      texture.generateMipmaps = true;
      texture.addEventListener("dispose", () => image.close());
    }
    const image = texture.image as { width: number; height: number };
    if (image.width !== asset.width || image.height !== asset.height || image.width > renderer.capabilities.maxTextureSize || image.height > renderer.capabilities.maxTextureSize) { texture.dispose(); throw new Error("Texture dimensions exceed device limits"); }
    const estimatedBytes = Math.ceil(asset.width * asset.height * 4 * 4 / 3);
    if (memory + estimatedBytes > PACK_LIMITS.decoded) { texture.dispose(); throw new Error("Texture overrides exceed decoded memory budget"); }
    memory += estimatedBytes;
    texture.minFilter = texture.generateMipmaps || texture.mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter; texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = dataChannel ? THREE.NoColorSpace : THREE.SRGBColorSpace; texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); texture.needsUpdate = true;
    texture.userData.texturePackAsset = { sha256: asset.sha256, width: asset.width, height: asset.height, estimatedDecodedBytes: Math.ceil(asset.width * asset.height * 4 * 4 / 3) };
    decoded.set(cacheKey, texture); return texture;
  };
  const used = new Set<string>();
  try { for (const path of paths) {
    const normalized = tryTexturePath(path); if (!normalized) continue; const match = matches.get(normalized); if (!match) continue;
    try {
      let texture: THREE.Texture;
      try { texture = await decode(match.entry.color); } catch (error) { if (!match.entry.fallback) throw error; texture = await decode(match.entry.fallback); }
      result.set(normalized, texture); used.add(match.pack.id);
      const channels: MaterialChannels = { normalStrength: match.entry.normalStrength, roughnessFactor: match.entry.roughnessFactor, normalConvention: match.entry.normalConvention };
      for (const channel of ["normal", "roughness"] as const) {
        const asset = match.entry[channel]; if (!asset) continue;
        try { channels[channel] = await decode(asset, true); }
        catch (error) { console.warn(`Texture pack ${channel} fallback: ${path}`, error); }
      }
      result.materials.set(normalized, channels);
    } catch (error) { console.warn(`Texture pack fallback to original: ${path}`, error); }
  } } finally { void (ktx2 as Promise<KTX2Loader> | null)?.then((loader) => loader.dispose()); }
  result.packs = packs.filter((pack) => used.has(pack.id)).map(({ id, version }) => ({ id, version }));
  return result;
}
