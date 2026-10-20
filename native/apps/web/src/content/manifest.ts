// Hosted stock content: storage layout and the per-map manifest format.
//
// Stock CS:S/HL2 files a map references (but doesn't pack) are extracted by tools/content/extract.ts
// and stored content-addressed:
//
//   content/<sha256>                       raw file bytes (VMT text, VTF in its native DXT/RGB form)
//   content-manifests/<map sha256>.json    ContentManifest for one exact BSP (sha256 of the .bsp file)
//
// Same layout locally (content-cache/, served by the Vite dev server) and in R2 (served by apps/api
// at GET /content/:sha and GET /content-manifests/:mapSha.json, denylist applied).

export const MANIFEST_VERSION = 1;

export const contentKey = (sha256: string) => `content/${sha256}`;
export const manifestKey = (mapSha256: string) => `content-manifests/${mapSha256}.json`;

export interface ManifestFile {
  sha256: string;
  size: number;
}

/** A stock material as core resolved it (pakfile first, then stock content). */
export interface ManifestMaterial {
  /** VMT game path, if the VMT itself is stock (patch materials keep their pakfile VMT). */
  vmt?: string;
  shader: string;
  kind: "textured" | "water" | "missing" | "glass" | "flat";
  /** MAT_* flags (core.ts). */
  flags: number;
  alpha: number;
  alphaRef: number;
  color: [number, number, number];
  /** VTF game paths (look them up in `files` for hashes). */
  basetexture?: string;
  basetexture2?: string;
  detail?: string;
  detailScale?: number;
  detailBlend?: number;
}

export interface ContentManifest {
  version: typeof MANIFEST_VERSION;
  map: string;
  /** sha256 of the .bsp file this manifest is for. */
  mapSha256: string;
  /** worldspawn skyname (faces are materials `skybox/<sky>{rt,lf,bk,ft,up,dn}`). */
  sky: string | null;
  generated: string;
  /** Every stock file the map needs: game path -> content. Loaded into core behind the pakfile. */
  files: Record<string, ManifestFile>;
  /** Resolved stock materials (material name -> VMT params already resolved). Informational for the client. */
  materials: Record<string, ManifestMaterial>;
  /**
   * Collision models the simulation reads for the map's props (static props with collision, prop_physics*,
   * prop_dynamic*, prop_door_rotating): `.phy` (VPhysics) or `.mdl` (bbox) files that the map doesn't pack.
   * Also listed in `files`. Clients register them for every simulation instance (core.ts
   * registerPhysicsContent); the verifier's physics BSP packs them (apps/api/src/bsp-strip.ts).
   */
  physics?: { files: Record<string, ManifestFile> };
  /** Static props: model paths in the BSP's prop dictionary (their files and materials are in `files`). */
  props?: { models: string[]; instances: number; builtModels: number };
  /**
   * Files in `files` that aren't stock content: recovered from another map's pakfile, a FastDL mirror, or a stock file
   * served under the name the map uses (tools/content/third-party.ts; provenance in maps/<map>.json). Path -> origin.
   */
  thirdParty?: Record<string, { sha256: string; source: string }>;
  /**
   * Material overrides from maps/<map>.json `materialOverrides` (material name -> replacement material name). The
   * client resolves each overridden material as its replacement ahead of the pakfile (core contentMaterialOverrides),
   * e.g. to cover a map's own packed art; the replacement's files are in `files`. Rendering only.
   */
  materialOverrides?: Record<string, string>;
  /** Content not needed to render the map; clients fetch it only on demand. */
  optional?: {
    /**
     * CS:S player models (models/player/{ct,t}_*.mdl + .vvd + .dx90.vtx), their `$includemodel` animation models
     * (models/player/cs_player_shared.mdl, ak_anims_{ct,t}.mdl), the knife world models and all their materials
     * ($basetexture + $bumpmap). Loaded on demand by apps/web/src/player/studio for ghosts, replays and other players.
     */
    player?: ContentGroup;
    /**
     * CS:S sounds for the "Classic CS:S sounds" option (apps/web/src/audio/classic.ts): player footsteps per surface,
     * water splashes / wading, the knife (sound/<path>.wav game paths). Fetched only when the option is on.
     */
    sounds?: SoundGroup;
  };
}

export interface SoundGroup {
  files: Record<string, ManifestFile>;
}

export interface ContentGroup {
  models: string[];
  /** Animation-only models the `models` include (`$includemodel`). */
  includes?: string[];
  /** Weapon world models (bone-merged onto the player). */
  weapons?: string[];
  /** Weapon view models; only their animations are used (the first-person viewmodel, apps/web/src/viewmodel/). */
  viewmodels?: string[];
  files: Record<string, ManifestFile>;
  materials: Record<string, ManifestMaterial>;
}

export function isManifest(v: unknown): v is ContentManifest {
  const m = v as ContentManifest;
  return !!m && m.version === MANIFEST_VERSION && typeof m.mapSha256 === "string" && !!m.files && typeof m.files === "object";
}
