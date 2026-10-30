// Thin wrapper over the bunnyhop-core WASM exports (crates/core/src/wasm.rs).
// Works in the browser and in Bun (for headless replay verification).
import { coreBytes, coreWrite, coreF32, coreU32, type NativeRuntime } from "./native-runtime";

export interface MeshGroup {
  model: number;
  material: number;
  firstIndex: number;
  indexCount: number;
  /** In the 3D skybox set (see `Core.skyCamera`): drawn by the skybox pass, not the main view. */
  sky3d?: boolean;
}

/**
 * The map's `sky_camera` (Source's 3D skybox, crates/core/src/skybox.rs): the miniature around `origin` is drawn
 * behind the main view from `origin + eye / scale`, with this fog (distances in world units, colours 0..255).
 */
export interface SkyCamera {
  origin: [number, number, number];
  scale: number;
  area: number;
  fog: {
    enable: boolean;
    blend: boolean;
    color: [number, number, number];
    color2: [number, number, number];
    dir: [number, number, number];
    start: number;
    end: number;
    maxDensity: number;
  };
}

export interface MaterialInfo {
  name: string;
  width: number;
  height: number;
}

export enum MaterialKind {
  Textured = 0,
  /** VMT or base texture not available (usually stock game content). */
  Missing = 1,
  Water = 2,
  /** Refract (glass) without a base texture: tinted translucent glass (`color` = `$refracttint`). */
  Glass = 3,
  /** VMT without a `$basetexture` (Source uses white) or with a render target: flat `color`. */
  Flat = 4,
}

export const MAT_TRANSLUCENT = 1;
export const MAT_ALPHATEST = 2;
export const MAT_NOCULL = 4;
export const MAT_ADDITIVE = 8;
export const MAT_UNLIT = 16;
export const MAT_HAS_VMT = 32;

/** Resolved VMT state for a mesh material (same index as `MaterialInfo`). */
export interface MaterialDesc {
  kind: MaterialKind;
  flags: number;
  /** Index for `Core.texture()`, or -1. */
  texture: number;
  alpha: number;
  alphaRef: number;
  /** `$color` tint, or `$fogcolor` for water (0..1). */
  color: [number, number, number];
  shader: string;
}

export enum TextureFormat {
  RGBA8 = 0,
  DXT1 = 1,
  DXT1A = 2,
  DXT3 = 3,
  DXT5 = 4,
}

export interface TextureLevel {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface TexturePayload {
  format: TextureFormat;
  /** Mip levels, largest first. RGBA8 payloads carry only level 0. */
  levels: TextureLevel[];
}

export interface Lightmap {
  width: number;
  height: number;
  /** RGBA8, sRGB-encoded; the decoded texel divided by `scale` is linear light. */
  data: Uint8Array;
  scale: number;
  /** Built from the map's HDR lighting: CS:S would draw it with auto exposure and bloom. */
  hdr: boolean;
}

/** V20 newly categorized ground immediately before a same-command jump (absent on older physics / WASM). */
export interface CategorizedGroundJump {
  position: [number, number, number];
  velocity: [number, number, number];
  crouched: boolean;
}

export interface PlayerState {
  categorizedGroundJump?: CategorizedGroundJump;
  position: [number, number, number];
  velocity: [number, number, number];
  viewOffsetZ: number;
  grounded: boolean;
  crouched: boolean;
  tick: number;
  teleportAngles: [number, number, number];
  /** On a ladder (movement mode Ladder). False on wasm builds that don't export the mode. */
  onLadder: boolean;
  /** View angle change (pitch, yaw, roll) a rotating pusher applied this tick (EVENT_ANGLES_CHANGED). */
  angleChange: [number, number, number];
  /**
   * Feet position (and crouched hull) of this tick's trigger touch pass after the move, before any teleport that
   * pass caused (game.rs `touch_origin`). Absent after a reset / respawn, and on wasm builds without it.
   */
  touchPosition?: [number, number, number];
  touchCrouched?: boolean;
  /**
   * Weapons the player holds (WEAPON_* bits; physics v4 maps can hand out guns with game_player_equip and strip them
   * with player_weaponstrip) and the active one (a WEAPON_* bit, 0 = none). Absent on wasm builds without weapons
   * (knife only).
   */
  weapons?: number;
  activeWeapon?: number;
  /** Read-only clean movement observation for local LJ stats (absent on older WASM builds). */
  jumpStatsValid?: boolean;
}

/**
 * Stock collision models (`.phy` / `.mdl`) the simulation needs, shared by every Core instance (the live run,
 * the replay viewer, ghosts): registered once from the map's hosted content manifest (`physics` group) and
 * added to each instance before it loads a map, so all of them simulate the same prop collision as the
 * server verifier (whose physics BSP packs these files).
 */
const PHYSICS_CONTENT = new Map<string, Uint8Array>();

export function registerPhysicsContent(files: Iterable<[string, Uint8Array]>): void {
  for (const [path, bytes] of files) PHYSICS_CONTENT.set(path.toLowerCase(), bytes);
}

/** The registered collision models (for a simulation in a worker, selfcheck.ts, which registers them on its side). */
export function physicsContent(): [string, Uint8Array][] {
  return [...PHYSICS_CONTENT];
}

/** Brush entity transform: origin x, y, z and angles pitch, yaw, roll (Source degrees). */
/**
 * Brush entity model transform: origin x, y, z, pitch, yaw, roll; then 1 / 0 = drawn / hidden (toggled
 * func_wall_toggle, disabled func_brush, ...) when the wasm build has `brush_states` (the renderer only applies it to
 * 3D skybox models so far).
 */
export type BrushTransform = [number, number, number, number, number, number] | [number, number, number, number, number, number, number];
/** One overlay volume (`Core.overlayVolumes`): a convex brush as outward planes. */
export interface OverlayVolume {
  /** OVERLAY_* in crates/core/src/game/overlay.rs (triggers/volumes.ts Kind). */
  kind: number;
  /** Entity index (`entities()` order), -1 for world brushes. */
  entity: number;
  /** Brush model whose transform places it (`brushOrigins()`), -1 when the planes are in world space. */
  model: number;
  /** OVERLAY_WHEN_HIDDEN (1): counts only while its entity isn't drawn. */
  flags: number;
  /** nx, ny, nz, d per plane (n·p = d on the plane, outward normal). */
  planes: Float32Array;
}

/** `Core.mapSoundStates` layout: entity, flags, starts, stops, volume (0..100, -1 none), pitch (0..255, -1 none). */
export const MAP_SOUND_STRIDE = 6;
export const MAP_SOUND_ACTIVE = 1;
export const MAP_SOUND_REMOVED = 2;
export const MAP_SOUND_LAST_START = 4;

/** `Core.overlayStates()` bits: an enabled trigger / a solid brush entity, and drawn. */
export const OVERLAY_STATE_ACTIVE = 1;
export const OVERLAY_STATE_VISIBLE = 2;

/** `brushOrigins()` keys at or above this are moving entity props (prop_door_rotating): key - PROP_TRANSFORM_KEY = entity. */
export const PROP_TRANSFORM_KEY = 1 << 20;

/**
 * Physics versions (crates/core/src/game.rs PHYSICS_V*). Every replay records the version it was played with (replay
 * header v6 `physics`; older replays are v1) and is re-simulated with it, so a movement fix never changes an existing run.
 * - v1: the original port.
 * - v2: v1 + playerclip brushes block the player (MASK_PLAYERSOLID) + jumping during the unduck transition (ducking in
 *   the air and releasing as you land no longer blocks the jump).
 * - v3: v2 + VPhysics separation: landing on a func_door / func_brush no longer dead-stops the player when the landing
 *   leaves them a hair inside the 1/32 contact band (bhop_redwood's first blocks; engine-verified).
 * - v4: v3 + the knife: +attack / +attack2 (input.ts IN_ATTACK / IN_ATTACK2, recorded like any button) swing and stab
 *   like CS:S's knife and damage the func_button they hit (bhop_hive's keypad opens its first door) + func_water_analog
 *   brushes are water, moving with their parent (bhop_lost_world's flooding lab tank) + CS:S ladders.
 * - v5: v4 + map-given weapons (research/WEAPONS.md: floor pickups, game_player_equip, the guns' shots damage func_button
 *   / func_breakable; bhop_badges, bhop_badges_mini, bhop_lost_world), the SDK water-jump push, game_ui / point_template
 *   / pushable boxes and SDK output order. Auto-strafe's "S pauses the assist" rule starts here (styles.ts).
 * - v6: v5 + shot pads as on bhop servers (EventQueueFix): a damaged func_button fires OnDamaged with the shooter as
 *   activator, so the first shot at a bhop_badges / bhop_badges_mini pad boosts; the burst-mode Glock as on srcds (6
 *   ticks between rounds, one burst per trigger pull). research/maps/badges-real-replays.md section 6.
 * - v7: v6 + weapon commands (bhoptimer's !usp / !glock / !knife, and any gun outside ranked runs: a one-tick give request
 *   in buttons bits 16..20, weapon-rules.ts IN_GIVE_*, recorded like any button) and the USP's silencer on +attack2 (3.08 s
 *   lock-out, the CS:S viewmodel's attach / detach sequence). research/WEAPONS.md. Also the SDK's point_template name
 *   fixup: only the template entities another member targets are renamed (bhop_monster_jam's button walls break again).
 * - v8: v7 + per-map trigger fixes (crates/core/src/game/map_fixes.rs): bhop_2easy's stage-end teleports cover their end
 *   room's back wall, floor to ceiling, instead of the map's small spot in the middle that a hopping player clears.
 * - v9: v8 + shots and knife hits damage func_physbox / func_physbox_multiplayer (OnDamaged with the shooter as activator,
 *   through the physbox's damage filter): bhop_tesquo_v2's neon-stage boosters (shoot the platform you stand on).
 * - v10: v9 + a restart keeps the guns in hand: the client's re-give of the guns the player had (weapon-rules.ts
 *   KeptWeapons, IN_GIVE_RESTORE / IN_GIVE_MODE on the restart's first commands) puts each in hand without the draw, the
 *   USP's silencer and the Glock's burst mode as they were, like a bhop server's !r. research/WEAPONS.md.
 * - v11: v10 + finished crouch/uncrouch hull or origin changes recategorize ground support before movement.
 * - v12: v11 + linear doors honor their StartOpen / spawnpos initial position.
 * - v13: v12 + consistent downhill ramp boosts for collision and ground-probe landings.
 * - v14: v13 + per-map sv_maxvelocity (crates/core/src/game/map_fixes.rs MAX_VELOCITY: 10000 on bhop_sandtrap 1-3,
 *   bhop_icetrap and bhop_goldsrc, as their logic_auto sets it on a CS:S server; research/MAX-VELOCITY.md) and
 *   func_tracktrains that find their path before the map's spawn outputs (bhop_areaportal_v1's green platform moves).
 * - v15: v14 + Source's signed door travel on the maps in crates/core/src/game/map_fixes.rs SIGNED_DOOR_TRAVEL: a door
 *   whose lip is larger than its brush moves the other way (bhop_montana_fix's "UP" block rises and launches the player;
 *   research/RELEASE-MAPS-HOTFIX-1025.md). Every other map is unchanged.
 * - v16: v15 + the player's own outputs and filter tests on the maps in crates/core/src/game/map_fixes.rs PLAYER_IO
 *   (AddOutput "OnUser1 ..." on the player, FireUser1..4 on the player, filter TestActivator -> OnPass / OnFail):
 *   bhop_synthetic_fix's potion door, bhop_wonderland's key room and bhop_lego3's coins count the items collected and
 *   open (research/SYNTHETIC-DOOR-1025.md). Same version: DanZay's VScript objective gates, emulated natively on the maps in
 *   map_fixes.rs NONLINEAR_OBJECTIVES (crates/core/src/game/vscript.rs): bhop_cooksassistant's kitchen doors need its 4
 *   ingredients (research/COOKSASSISTANT-1025.md). Every other map is unchanged.
 * - v17: v16 + RNGFix parity (jason-e/rngfix, the plugin ranked CS:S bhop servers run; research/RNGFIX-1025.md): landing
 *   on or jumping into an uphill slope keeps the speed (RNGFix uphill), downhill boosts as RNGFix computes them, edge
 *   bugs still let the player jump, landing on a thin trigger always touches it, and a teleport touched in the same tick
 *   as a collision or landing keeps the speed (telehop). Slopes and ledges no longer depend on the sub-tick phase.
 * - v18: v17 + climbable surface properties.
 * - v19: v18 + scoped map mechanics, script equivalents and per-map maximum velocities.
 * - v20: v19 + bhoptimer autohop: clear the old jump latch while walking with jump held and water level < 2,
 *   keeping the current jump command so unducking or teleporting onto a floor jumps before friction.
 *   Scroll styles, ladder jumps and swimming keep their existing policy.
 */
export const PHYSICS_V1 = 1;
/** Weapon commands and the USP silencer (research/WEAPONS.md). */
export const PHYSICS_V7 = 7;
/** Per-map trigger fixes (bhop_2easy's stage-end teleports). */
export const PHYSICS_V8 = 8;
/** Weapon damage on func_physbox (bhop_tesquo_v2's shot boosters). */
export const PHYSICS_V9 = 9;
/** A restart keeps the guns in hand (the USP's silencer, no draw). */
export const PHYSICS_V10 = 10;
/** Finished crouch changes recategorize ground support before movement. */
export const PHYSICS_V11 = 11;
/** Linear doors honor their StartOpen / spawnpos initial position. */
export const PHYSICS_V12 = 12;
/** Consistent downhill ramp landing boosts. */
export const PHYSICS_V13 = 13;
/** Per-map sv_maxvelocity (10000 on the sandtraps, icetrap, goldsrc); trains started at map spawn move. */
export const PHYSICS_V14 = 14;
/** Source's signed door travel on bhop_montana_fix (its "UP" block launches the player). */
export const PHYSICS_V15 = 15;
/** Player outputs and filter tests on bhop_synthetic_fix, bhop_wonderland, bhop_lego3 (their item gates open); bhop_cooksassistant's VScript ingredient gates. */
export const PHYSICS_V16 = 16;
/** RNGFix parity: uphill / downhill inclines, edge bugs, trigger jumping and telehops as on RNGFix servers. */
export const PHYSICS_V17 = 17;
/** The physics version new runs are played and recorded with. */
export const PHYSICS_VERSION = 20;
/** Climbable surface properties used by bhop_synthetic_fix. */
export const PHYSICS_V18 = 18;
/** Scoped entity makers and known velocity-script equivalents. */
export const PHYSICS_V19 = 19;
/** bhoptimer autohop: unduck / teleport onto a floor jumps before friction. */
export const PHYSICS_V20 = 20;
/** Versions this code knows (the wasm build must support them too, see Core.setSettings). */
export const isPhysicsVersion = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= PHYSICS_V1 && (v as number) <= PHYSICS_VERSION;

export interface Settings {
  tickInterval: number;
  airAccelerate: number;
  accelerate: number;
  friction: number;
  stopSpeed: number;
  gravity: number;
  maxSpeed: number;
  autohop: boolean;
  /** CS:S jump fatigue and grounded slowdown; absent in legacy recordings. */
  stamina?: boolean;
  /** Physics version (PHYSICS_V1 .. PHYSICS_VERSION). */
  physics: number;
}

export const DEFAULT_SETTINGS: Settings = {
  tickInterval: 0.01,
  airAccelerate: 1000,
  accelerate: 5,
  friction: 4,
  stopSpeed: 75,
  gravity: 800,
  maxSpeed: 260,
  autohop: true,
  physics: PHYSICS_VERSION,
};

/** playsrc movement Mode::Ladder (player_state()[13]). */
export const MOVE_MODE_LADDER = 6;

export const EVENT_TELEPORTED = 1 << 0;
export const EVENT_JUMPED = 1 << 1;
export const EVENT_LANDED = 1 << 2;
/** A rotating platform turned the player's view (Source FIXANGLE_RELATIVE): add `angleChange` to the view. */
export const EVENT_ANGLES_CHANGED = 1 << 4;
/**
 * The player attacked this tick (physics v4): a knife slash / stab or a shot with a gun the map handed out
 * (game_player_equip). Details: `attackReport(core)`. Purely an output: the swing already happened in the sim.
 */
export const EVENT_ATTACK = 1 << 5;
/** The player's weapons changed this tick (physics v4): `weaponReport(core)` flags (research/WEAPONS.md). */
export const EVENT_WEAPON = 1 << 6;

interface Exports {
  memory: WebAssembly.Memory;
  nativeRead?: (pointer: number, length: number) => Uint8Array;
  nativeWrite?: (pointer: number, bytes: Uint8Array) => void;
  alloc(len: number): number;
  load_map(ptr: number, len: number): number;
  load_map_physics?: (ptr: number, len: number) => number;
  dealloc(ptr: number, len: number): void;
  error_ptr(): number;
  error_len(): number;
  mesh_vertices_ptr(): number;
  mesh_vertices_len(): number;
  mesh_indices_ptr(): number;
  mesh_indices_len(): number;
  mesh_groups(): number;
  mesh_materials(): number;
  entities_text(): number;
  scratch_u32_ptr(): number;
  scratch_f32_ptr(): number;
  scratch_str_ptr(): number;
  pak_ptr(): number;
  pak_len(): number;
  material_info(): number;
  texture_count(): number;
  texture_payload(index: number, allowS3tc: number, needAlpha: number): number;
  tex_bytes_ptr(): number;
  lightmap_size(): number;
  lightmap_ptr(): number;
  lightmap_scale(): number;
  mesh_vertex_floats(): number;
  set_settings(...args: number[]): void;
  set_stamina?: (enabled: number) => void;
  /** Physics version (crates/core/src/wasm.rs): 1 = accepted, 0 = unknown to this build. Absent: a v1-only build. */
  set_physics_version?: (version: number) => number;
  reset(): void;
  step(forward: number, side: number, yaw: number, pitch: number, buttons: number): number;
  player_state(): number;
  brush_origins(): number;
  prop_transforms?(): number;
  physics_files?(): number;
  physics_missing?(): number;
  physics_reload?(): void;
  mesh_sky_vertices_ptr?: () => number;
  mesh_sky_vertices_len?: () => number;
  mesh_sky_indices_ptr?: () => number;
  mesh_sky_indices_len?: () => number;
  mesh_sky_groups?: () => number;
  mesh_group_sky3d?: () => number;
  brush_states?: () => number;
  effect_states?: () => number;
  sky_camera?: () => number;
  map_sound_serial?: () => number;
  map_sound_states?: () => number;
  map_sound_commands?: () => number;
  overlay_volumes?: () => number;
  overlay_states?: () => number;
}

const decoder = new TextDecoder();

// Byte/stream instantiation (browser, Bun). Typed structurally because the Workers type set omits them: Workers may
// only instantiate precompiled modules (see Core.create).
interface WasmLoaders {
  instantiate(source: BufferSource, imports: object): Promise<{ instance: WebAssembly.Instance }>;
  instantiateStreaming(source: Response | Promise<Response>, imports: object): Promise<{ instance: WebAssembly.Instance }>;
}
const wasmLoaders = WebAssembly as unknown as WasmLoaders;

export class Core {
  private constructor(private x: Exports) {}
  readonly engine: "wasm" | "native" = "wasm";
  nativeBuild?: string;
  private nativeDispose?: () => void;

  /** Explicit opt-in for the live desktop sim. Workers, ghosts and verifier still call create(). */
  static createNative(runtime: NativeRuntime): Core {
    const session = runtime.createSession();
    const exports = Object.fromEntries(session.exports.map(name => [name, (...args: number[]) => session.call(name, args)]));
    const core = new Core({
      ...exports,
      memory: { buffer: new ArrayBuffer(0) },
      nativeRead: (ptr: number, length: number) => session.read(ptr, length),
      nativeWrite: (ptr: number, bytes: Uint8Array) => session.write(ptr, bytes),
    } as unknown as Exports);
    Object.defineProperty(core, "engine", { value: "native" });
    core.nativeBuild = runtime.build;
    core.nativeDispose = () => session.dispose();
    return core;
  }

  dispose(): void { this.nativeDispose?.(); this.nativeDispose = undefined; }

  /** From wasm bytes, a fetch Response, or an already compiled module (Workers can't compile bytes at runtime). */
  static async create(source: BufferSource | WebAssembly.Module | Response | Promise<Response>): Promise<Core> {
    let instance: WebAssembly.Instance;
    if (source instanceof WebAssembly.Module) instance = await WebAssembly.instantiate(source, {});
    else if (source instanceof Response || source instanceof Promise) instance = (await wasmLoaders.instantiateStreaming(source, {})).instance;
    else instance = (await wasmLoaders.instantiate(source, {})).instance;
    return new Core(instance.exports as unknown as Exports);
  }

  private str(ptr: number, len: number): string {
    return decoder.decode(coreBytes(this.x, ptr, len));
  }

  private f32(ptr: number, len: number): Float32Array {
    return coreF32(this.x, ptr, len);
  }

  private u32(ptr: number, len: number): Uint32Array {
    return coreU32(this.x, ptr, len);
  }

  loadMap(bsp: Uint8Array): void {
    this.addPhysicsContent();
    const ptr = this.x.alloc(bsp.length);
    coreWrite(this.x, ptr, bsp);
    if (!this.x.load_map(ptr, bsp.length)) throw new Error(this.lastError());
  }

  /**
   * Simulation-only load (collision, triggers, entities; no render mesh/pakfile/materials) for headless
   * verification. Same physics as loadMap.
   */
  loadMapPhysics(bsp: Uint8Array): void {
    this.addPhysicsContent();
    const ptr = this.x.alloc(bsp.length);
    coreWrite(this.x, ptr, bsp);
    this.commitPhysics(ptr, bsp.length);
  }

  /** loadMapPhysics, streaming `len` bytes straight into wasm memory (no full JS-side copy of the BSP). */
  async loadMapPhysicsStream(stream: ReadableStream<Uint8Array>, len: number): Promise<void> {
    this.addPhysicsContent();
    const ptr = this.x.alloc(len);
    let off = 0;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (off + value.length > len) throw new Error(`map stream longer than ${len} bytes`);
        // Re-take the view each chunk: memory.buffer is detached if the wasm memory grew.
        coreWrite(this.x, ptr + off, value);
        off += value.length;
      }
      if (off !== len) throw new Error(`map stream ended at ${off} of ${len} bytes`);
    } catch (e) {
      this.x.dealloc(ptr, len);
      throw e;
    } finally {
      reader.releaseLock();
    }
    this.commitPhysics(ptr, len);
  }

  private commitPhysics(ptr: number, len: number): void {
    if (!this.x.load_map_physics) throw new Error("wasm build lacks load_map_physics export; rebuild with tools/scripts/build-wasm.sh");
    if (!this.x.load_map_physics(ptr, len)) throw new Error(this.lastError());
  }

  private physicsAdded = new Set<string>();

  /** Hands registered physics content (registerPhysicsContent) to this instance before a map load. */
  private addPhysicsContent(): void {
    if (!this.hasContentApi()) return;
    for (const [path, bytes] of PHYSICS_CONTENT) {
      if (this.physicsAdded.has(path)) continue;
      this.contentAddFile(path, bytes);
      this.physicsAdded.add(path);
    }
  }

  /** Collision files (`.phy`, or `.mdl` for bbox props) the loaded map's props need. */
  physicsFiles(): string[] {
    if (!this.x.physics_files) return [];
    const len = this.x.physics_files();
    return this.str(this.x.scratch_str_ptr(), len).split("\n").filter(Boolean);
  }

  /** Prop models still without collision because their files weren't available (see physicsReload). */
  physicsMissing(): string[] {
    if (!this.x.physics_missing) return [];
    const len = this.x.physics_missing();
    return this.str(this.x.scratch_str_ptr(), len).split("\n").filter(Boolean);
  }

  /**
   * Rebuilds prop collision from the pakfile + the content added since the map loaded (after hosted content
   * arrived), and resets the map. Registered physics content is added first.
   */
  physicsReload(): void {
    if (!this.x.physics_reload) return;
    this.addPhysicsContent();
    this.x.physics_reload();
  }

  /** Current size of the wasm linear memory in bytes (it only grows). */
  memoryBytes(): number {
    return this.x.memory.buffer.byteLength;
  }

  lastError(): string {
    return this.str(this.x.error_ptr(), this.x.error_len());
  }

  /**
   * Copies of the render mesh buffers (safe to keep across calls).
   * Vertex layout (`stride` floats): position xyz, normal xyz, texture uv, lightmap uv.
   */
  mesh(): { vertices: Float32Array; indices: Uint32Array; stride: number; groups: MeshGroup[]; materials: MaterialInfo[] } {
    const vertices = this.f32(this.x.mesh_vertices_ptr(), this.x.mesh_vertices_len()).slice();
    const indices = this.u32(this.x.mesh_indices_ptr(), this.x.mesh_indices_len()).slice();
    const groupLen = this.x.mesh_groups();
    const g = this.u32(this.x.scratch_u32_ptr(), groupLen);
    const groups: MeshGroup[] = [];
    for (let i = 0; i < g.length; i += 4) {
      groups.push({ model: g[i], material: g[i + 1], firstIndex: g[i + 2], indexCount: g[i + 3] });
    }
    if (this.x.mesh_group_sky3d) {
      const n = this.x.mesh_group_sky3d();
      const f = this.u32(this.x.scratch_u32_ptr(), n);
      if (n === groups.length) groups.forEach((gr, i) => (gr.sky3d = f[i] !== 0));
    }
    const materialsLen = this.x.mesh_materials();
    const materials = this.str(this.x.scratch_str_ptr(), materialsLen)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(" ");
        const height = Number(parts.pop());
        const width = Number(parts.pop());
        return { name: parts.join(" "), width, height };
      });
    return { vertices, indices, stride: this.x.mesh_vertex_floats(), groups, materials };
  }

  /**
   * Sky faces (`tools/toolsskybox` & co., `SURF_SKY` / `SURF_SKY2D`) as positions only (3 floats per vertex, Source
   * space), grouped per brush model; copies. Not part of `mesh()`. The renderer draws them depth-only so the sky
   * shows through them and they hide what's behind them, as in Source. Null on wasm builds without the export.
   */
  skyMesh(): { vertices: Float32Array; indices: Uint32Array; groups: { model: number; firstIndex: number; indexCount: number }[] } | null {
    const x = this.x;
    if (!x.mesh_sky_vertices_ptr || !x.mesh_sky_vertices_len || !x.mesh_sky_indices_ptr || !x.mesh_sky_indices_len || !x.mesh_sky_groups) return null;
    const vertices = this.f32(x.mesh_sky_vertices_ptr(), x.mesh_sky_vertices_len()).slice();
    const indices = this.u32(x.mesh_sky_indices_ptr(), x.mesh_sky_indices_len()).slice();
    const groupLen = x.mesh_sky_groups();
    const g = this.u32(x.scratch_u32_ptr(), groupLen);
    const groups = [];
    for (let i = 0; i + 3 <= g.length; i += 3) groups.push({ model: g[i], firstIndex: g[i + 1], indexCount: g[i + 2] });
    return { vertices, indices, groups };
  }

  /**
   * The 3D skybox camera (`sky_camera`), or null: no sky_camera, no usable skybox area (see skybox.rs), or a wasm
   * build without the export (then nothing is flagged `sky3d` and the world draws as before).
   */
  skyCamera(): SkyCamera | null {
    if (!this.x.sky_camera) return null;
    const n = this.x.sky_camera();
    if (n < 19) return null;
    const f = this.f32(this.x.scratch_f32_ptr(), n).slice();
    return {
      origin: [f[0], f[1], f[2]],
      scale: f[3],
      area: f[4],
      fog: {
        enable: f[5] !== 0,
        blend: f[6] !== 0,
        color: [f[7], f[8], f[9]],
        color2: [f[10], f[11], f[12]],
        dir: [f[13], f[14], f[15]],
        start: f[16],
        end: f[17],
        maxDensity: f[18],
      },
    };
  }

  /** Resolved materials, parallel to `mesh().materials`. */
  materials(): MaterialDesc[] {
    const len = this.x.material_info();
    return this.str(this.x.scratch_str_ptr(), len)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const p = line.split(" ");
        return {
          kind: Number(p[0]) as MaterialKind,
          flags: Number(p[1]),
          texture: Number(p[2]),
          alpha: Number(p[3]),
          alphaRef: Number(p[4]),
          color: [Number(p[5]), Number(p[6]), Number(p[7])],
          shader: p.slice(8).join(" "),
        };
      });
  }

  textureCount(): number {
    return this.x.texture_count();
  }

  /**
   * Texture data for `index`. With `allowS3tc`, DXT data is passed through (full mip chain when present);
   * otherwise it is decoded to RGBA8. `needAlpha` selects DXT1 with 1-bit alpha. Returns null on decode failure.
   */
  texture(index: number, allowS3tc: boolean, needAlpha: boolean): TexturePayload | null {
    const len = this.x.texture_payload(index, allowS3tc ? 1 : 0, needAlpha ? 1 : 0);
    if (!len) return null;
    const h = this.u32(this.x.scratch_u32_ptr(), len).slice();
    const base = this.x.tex_bytes_ptr();
    const levels: TextureLevel[] = [];
    for (let i = 0; i < h[1]; i++) {
      const [width, height, offset, size] = h.subarray(2 + i * 4, 6 + i * 4);
      levels.push({ width, height, data: coreBytes(this.x, base + offset, size).slice() });
    }
    return { format: h[0] as TextureFormat, levels };
  }

  /** The lightmap atlas built for the current map. */
  lightmap(): Lightmap {
    const len = this.x.lightmap_size();
    const [width, height, hdr] = this.u32(this.x.scratch_u32_ptr(), len);
    const data = coreBytes(this.x, this.x.lightmap_ptr(), width * height * 4).slice();
    return { width, height, data, scale: this.x.lightmap_scale(), hdr: hdr === 1 };
  }

  entities(): Record<string, string>[] {
    const len = this.x.entities_text();
    return this.str(this.x.scratch_str_ptr(), len)
      .split("\n")
      .filter(Boolean)
      .map((line) => Object.fromEntries(line.split("\t").map((kv) => {
        const i = kv.indexOf("=");
        return [kv.slice(0, i), kv.slice(i + 1)];
      })));
  }

  /** The BSP pakfile lump (a store-only zip of embedded content). */
  pakfile(): Uint8Array {
    const len = this.x.pak_len();
    return coreBytes(this.x, this.x.pak_ptr(), len).slice();
  }

  /** The pakfile lump in wasm memory: read it at once, it is invalid after the next allocation that grows the memory. */
  pakView(): Uint8Array {
    return coreBytes(this.x, this.x.pak_ptr(), this.x.pak_len());
  }

  /**
   * Map sounds (crates/core/src/game/map_sounds.rs): display only, nothing here reaches the simulation. 0 on a wasm
   * without the export, where only sounds that start by themselves can play. Changes when the two below may differ.
   */
  mapSoundSerial(): number {
    return this.x.map_sound_serial?.() ?? 0;
  }

  /**
   * The ambient_generics now, MAP_SOUND_STRIDE values each (see MAP_SOUND_* below), into `out`. Returns the value
   * count; `out` must hold it (no allocation, the client reads this when the serial moved).
   */
  mapSoundStates(out: Float32Array): number {
    if (!this.x.map_sound_states) return 0;
    const len = Math.min(this.x.map_sound_states(), out.length);
    out.set(this.f32(this.x.scratch_f32_ptr(), len));
    return len;
  }

  /** `play ...` commands the map ran since the last call. */
  mapSoundCommands(): string[] {
    if (!this.x.map_sound_commands) return [];
    const len = this.x.map_sound_commands();
    return len ? this.str(this.x.scratch_str_ptr(), len).split("\n").filter(Boolean) : [];
  }

  /** Physics settings and version (call after loading the map). Throws if this wasm build can't simulate the version. */
  setSettings(s: Settings): void {
    this.x.set_settings(s.tickInterval, s.airAccelerate, s.accelerate, s.friction, s.stopSpeed, s.gravity, s.maxSpeed, s.autohop ? 1 : 0);
    if (this.x.set_stamina) this.x.set_stamina(s.stamina ? 1 : 0);
    else if (s.stamina) throw new Error("wasm build lacks CS:S stamina; rebuild the movement core");
    const physics = s.physics ?? PHYSICS_V1;
    if (this.x.set_physics_version) {
      if (this.x.set_physics_version(physics) !== 1) throw new Error(`this wasm build can't simulate physics v${physics}`);
    } else if (physics !== PHYSICS_V1) {
      throw new Error(`wasm build lacks physics versions (set_physics_version), can't simulate physics v${physics}; rebuild with tools/scripts/build-wasm.sh`);
    }
  }

  reset(): void {
    this.x.reset();
  }

  step(forward: number, side: number, yaw: number, pitch: number, buttons: number): number {
    const events = this.x.step(forward, side, yaw, pitch, buttons);
    if (events === 0xffffffff) throw new Error(this.lastError());
    return events;
  }

  state(): PlayerState {
    const len = this.x.player_state();
    const s = this.f32(this.x.scratch_f32_ptr(), len);
    return {
      position: [s[0], s[1], s[2]],
      velocity: [s[3], s[4], s[5]],
      viewOffsetZ: s[6],
      grounded: s[7] !== 0,
      crouched: s[8] !== 0,
      tick: s[9],
      teleportAngles: [s[10], s[11], s[12]],
      onLadder: len > 13 && s[13] === MOVE_MODE_LADDER,
      angleChange: len > 16 ? [s[14], s[15], s[16]] : [0, 0, 0],
      ...(len > 20 && s[17] === s[17] ? { touchPosition: [s[17], s[18], s[19]] as [number, number, number], touchCrouched: s[20] !== 0 } : {}),
      ...(len > 22 ? { weapons: s[21], activeWeapon: s[22] } : {}),
      ...(len > 23 ? { jumpStatsValid: s[23] !== 0 } : {}),
      ...(len > 30 && s[24] === s[24] ? { categorizedGroundJump: {
        position: [s[24], s[25], s[26]] as [number, number, number],
        velocity: [s[27], s[28], s[29]] as [number, number, number], crouched: s[30] !== 0,
      } } : {}),
    };
  }

  /** Enabled smoke/trail/local-light entities, including map I/O and Kill; null on older wasm. */
  effectStates(only?: ReadonlySet<number>): Map<number, boolean> | undefined {
    if (!this.x.effect_states) return undefined;
    const len = this.x.effect_states();
    const data = this.f32(this.x.scratch_f32_ptr(), len);
    const states = new Map<number, boolean>();
    for (let i = 0; i + 1 < data.length; i += 2) if (!only || only.has(data[i])) states.set(data[i], data[i + 1] !== 0);
    return states;
  }

  /**
   * Current transforms of brush entity models: model index -> [x, y, z, pitch, yaw, roll] (Source degrees). `only`: just
   * these keys (the same values; the replay viewer's trail history reads a few models every tick).
   */
  brushOrigins(only?: ReadonlySet<number>): Map<number, BrushTransform> {
    const len = this.x.brush_origins();
    const b = this.f32(this.x.scratch_f32_ptr(), len);
    const out = new Map<number, BrushTransform>();
    for (let i = 0; i < b.length; i += 7) if (!only || only.has(b[i])) out.set(b[i], [b[i + 1], b[i + 2], b[i + 3], b[i + 4], b[i + 5], b[i + 6]]);
    if (this.x.brush_states) {
      const slen = this.x.brush_states();
      const st = this.f32(this.x.scratch_f32_ptr(), slen);
      for (let i = 0; i + 3 <= st.length; i += 3) {
        const t = out.get(st[i]);
        if (t && t.length === 6) out.set(st[i], [...t, st[i + 1]] as BrushTransform);
      }
    }
    // Moving props (doors) ride along under PROP_TRANSFORM_KEY + entity.
    const plen = this.x.prop_transforms?.() ?? 0;
    const p = this.f32(this.x.scratch_f32_ptr(), plen);
    for (let i = 0; i < p.length; i += 7) if (!only || only.has(PROP_TRANSFORM_KEY + p[i])) out.set(PROP_TRANSFORM_KEY + p[i], [p[i + 1], p[i + 2], p[i + 3], p[i + 4], p[i + 5], p[i + 6]]);
    return out;
  }

  /**
   * The volumes the trigger / clip overlays draw (crates/core/src/game/overlay.rs, triggers/): which brushes trigger or
   * block the player, as the simulation sees them. Null on wasm builds without the export. Read only.
   */
  overlayVolumes(): OverlayVolume[] | null {
    if (!this.x.overlay_volumes) return null;
    const len = this.x.overlay_volumes();
    const f = this.f32(this.x.scratch_f32_ptr(), len).slice();
    const out: OverlayVolume[] = [];
    for (let i = 0; i + 5 <= f.length; ) {
      const n = f[i + 4];
      out.push({ kind: f[i], entity: f[i + 1], model: f[i + 2], flags: f[i + 3], planes: f.subarray(i + 5, i + 5 + n * 4) });
      i += 5 + n * 4;
    }
    return out;
  }

  /** Every entity's overlay state now (OVERLAY_STATE_* bits), in entity order; null without the export. Read only. */
  overlayStates(): Uint32Array | null {
    if (!this.x.overlay_states) return null;
    // The call refills the scratch buffer (and may move it): only then read where it is.
    const n = this.x.overlay_states();
    return this.u32(this.x.scratch_u32_ptr(), n);
  }

  // ---- game content (see crates/core/src/wasm_content.rs, apps/web/src/content/) ----

  private get cx(): ContentExports {
    return this.x as unknown as ContentExports;
  }

  /** Copies bytes into a fresh wasm allocation (ownership passes to the callee). */
  private give(bytes: Uint8Array): [number, number] {
    const ptr = this.x.alloc(bytes.length);
    coreWrite(this.x, ptr, bytes);
    return [ptr, bytes.length];
  }

  private giveStr(s: string): [number, number] {
    return this.give(encoder.encode(s));
  }

  /** True if this wasm build has the content exports. */
  hasContentApi(): boolean {
    return typeof this.cx.content_resolve === "function";
  }

  /** Mounts a `_dir.vpk` tree (e.g. `cstrike/cstrike_pak_dir.vpk`). Returns the entry count; throws on parse errors. */
  contentMountVpk(name: string, dir: Uint8Array): number {
    const n = this.cx.content_mount_vpk(...this.giveStr(name), ...this.give(dir));
    if (!n) throw new Error(this.lastError());
    return n;
  }

  /** Mounts a list of paths the host can fetch by path (dev content cache). */
  contentMountListing(name: string, paths: string[]): number {
    return this.cx.content_mount_listing(...this.giveStr(name), ...this.giveStr(paths.join("\n")));
  }

  contentUnmountAll(): void {
    this.cx.content_unmount_all();
  }

  /** Adds a file with known bytes (cache restore). */
  contentAddFile(path: string, bytes: Uint8Array): void {
    this.cx.content_add_file(...this.giveStr(path), ...this.give(bytes));
  }

  /** Bytes of a file fetched via `contentProvide`/`contentAddFile` (assembled, CRC-checked), or null. */
  contentFile(path: string): Uint8Array | null {
    const len = this.cx.content_file(...this.giveStr(path));
    return len ? coreBytes(this.x, this.x.tex_bytes_ptr(), len).slice() : null;
  }

  /** Supplies bytes for a pending request (archive chunk for VPKs, whole file for listings). */
  contentProvide(path: string, bytes: Uint8Array): boolean {
    return this.cx.content_provide(...this.giveStr(path), ...this.give(bytes)) === 1;
  }

  /**
   * Per-map material overrides (material name -> replacement material name, no `materials/` or `.vmt`): from the next
   * `contentResolve` on, each overridden material resolves as its replacement, ahead of the pakfile. Rendering only (the
   * simulation's surface properties come from the BSP). `{}` clears them. Returns how many were set (0 if this wasm
   * build predates overrides).
   */
  contentMaterialOverrides(overrides: Record<string, string>): number {
    if (typeof this.cx.content_material_overrides !== "function") return 0;
    const text = Object.entries(overrides)
      .map(([from, to]) => `${from}\t${to}`)
      .join("\n");
    return this.cx.content_material_overrides(...this.giveStr(text));
  }

  /**
   * Re-resolves materials (mesh materials, then `extra` names) against pakfile → fetched files → mounts.
   * Returns the file reads still needed; supply them with `contentProvide` and call again until empty.
   */
  contentResolve(extra: string[] = []): ContentRequest[] {
    return this.requests(this.cx.content_resolve(...this.giveStr(extra.join("\n"))));
  }

  private requests(len: number): ContentRequest[] {
    if (!len) return [];
    return this.str(this.x.scratch_str_ptr(), len)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [path, mount, archive, offset, length] = line.split("\t");
        return { path, mount, archive: Number(archive), offset: Number(offset), length: Number(length) };
      });
  }

  private lines(len: number): string[] {
    return len ? this.str(this.x.scratch_str_ptr(), len).split("\n").filter(Boolean) : [];
  }

  /** Reads a file through the current VFS (pakfile → fetched → mounts), or null (a mount hit becomes pending). */
  contentRead(path: string): Uint8Array | null {
    if (!this.cx.content_read(...this.giveStr(path))) return null;
    return coreBytes(this.x, this.x.tex_bytes_ptr(), this.cx.tex_bytes_len()).slice();
  }

  /** Pending requests of the current VFS (materials and anything read since the last `contentResolve`). */
  contentPending(): ContentRequest[] {
    return this.requests(this.cx.content_pending());
  }

  /** Paths in the mounted VPKs under `prefix`. */
  contentList(prefix: string): string[] {
    return this.lines(this.cx.content_list(...this.giveStr(prefix)));
  }

  /** Material names a studio model uses ($cdmaterials resolved), or [] if its MDL isn't available yet. */
  modelMaterials(mdlPath: string): string[] {
    return this.lines(this.cx.model_materials(...this.giveStr(mdlPath)));
  }

  /** Parses the BSP's static props (the bytes are copied). Returns the dictionary of model paths. */
  propsLoad(bsp: Uint8Array): string[] {
    return this.lines(this.cx.props_load(...this.give(bsp)));
  }

  /** Builds the static prop mesh from the current VFS. Returns its material names (resolve them as extras). */
  propsBuild(): string[] {
    return this.lines(this.cx.props_build());
  }

  /** The static prop mesh from the last `propsBuild` (copies). Vertex layout: position, normal, uv. */
  propsMesh(): {
    vertices: Float32Array;
    indices: Uint32Array;
    /** `sky3d`: in the 3D skybox set (absent on wasm builds without `props_group_sky3d`). */
    groups: { material: number; firstIndex: number; indexCount: number; sky3d?: boolean }[];
    /** Moving props (model space, placed by `brushOrigins()` under PROP_TRANSFORM_KEY + entity). */
    dynamicGroups: { entity: number; material: number; firstIndex: number; indexCount: number }[];
    instances: number;
    models: number;
    missingModels: number;
  } {
    const infoLen = this.cx.props_info();
    const [instances, models, missingModels, vfloats, nidx] = this.u32(this.x.scratch_u32_ptr(), infoLen).slice();
    const vertices = this.f32(this.cx.props_vertices_ptr(), vfloats).slice();
    const indices = this.u32(this.cx.props_indices_ptr(), nidx).slice();
    // props_groups() replaces scratch_u32 (a new allocation): read the pointer only after the call.
    const groupLen = this.cx.props_groups();
    const g = this.u32(this.x.scratch_u32_ptr(), groupLen).slice();
    const groups: { material: number; firstIndex: number; indexCount: number; sky3d?: boolean }[] = [];
    for (let i = 0; i < g.length; i += 3) groups.push({ material: g[i], firstIndex: g[i + 1], indexCount: g[i + 2] });
    if (typeof this.cx.props_group_sky3d === "function") {
      const n = this.cx.props_group_sky3d();
      const f = this.u32(this.x.scratch_u32_ptr(), n);
      if (n === groups.length) groups.forEach((gr, i) => (gr.sky3d = f[i] !== 0));
    }
    const dgLen = typeof this.cx.props_dynamic_groups === "function" ? this.cx.props_dynamic_groups() : 0;
    const dg = this.u32(this.x.scratch_u32_ptr(), dgLen).slice();
    const dynamicGroups = [];
    for (let i = 0; i < dg.length; i += 4) dynamicGroups.push({ entity: dg[i], material: dg[i + 1], firstIndex: dg[i + 2], indexCount: dg[i + 3] });
    return { vertices, indices, groups, dynamicGroups, instances, models, missingModels };
  }

  /** Water parameters per resolved material (parallel to `materials()`); [] with an older core. */
  materialWater(): WaterParams[] {
    if (typeof this.cx.material_water !== "function") return [];
    const len = this.cx.material_water();
    const f = this.f32(this.x.scratch_f32_ptr(), len);
    const out: WaterParams[] = [];
    for (let i = 0; i < f.length; i += 4) out.push({ fogStart: f[i], fogEnd: f[i + 1], aboveWater: f[i + 2] !== 0 });
    return out;
  }

  /** Water volumes (water brush boxes, Source space) of the loaded map: `[minx, miny, minz, maxx, maxy, maxz]`. */
  waterVolumes(): number[][] {
    if (typeof this.cx.water_volumes !== "function") return [];
    const len = this.cx.water_volumes(); // replaces scratch_f32: read the pointer after the call
    const f = this.f32(this.x.scratch_f32_ptr(), len);
    const out: number[][] = [];
    for (let i = 0; i + 6 <= f.length; i += 6) out.push(Array.from(f.subarray(i, i + 6)));
    return out;
  }

  /** Non-axial brush planes parallel to waterVolumes(), in Source space: dot(normal, p) <= distance. */
  waterPlanes(): number[][][] {
    if (typeof this.cx.water_planes !== "function") return [];
    const len = this.cx.water_planes();
    const f = this.f32(this.x.scratch_f32_ptr(), len);
    const out: number[][][] = [];
    for (let i = 0; i < f.length;) {
      const count = f[i++];
      const planes: number[][] = [];
      for (let j = 0; j < count && i + 4 <= f.length; j++, i += 4) planes.push(Array.from(f.subarray(i, i + 4)));
      out.push(planes);
    }
    return out;
  }

  /** Game paths of resolved textures (`materials/....vtf`), indexed like `MaterialDesc.texture`. */
  texturePaths(): string[] {
    const len = this.cx.texture_paths();
    return len ? this.str(this.x.scratch_str_ptr(), len).split("\n") : [];
  }

  /** Secondary textures per resolved material (parallel to `materials()`). */
  materialExtras(): MaterialExtras[] {
    if (typeof this.cx.material_extras !== "function") return [];
    const len = this.cx.material_extras();
    const f = this.f32(this.x.scratch_f32_ptr(), len);
    const out: MaterialExtras[] = [];
    for (let i = 0; i < f.length; i += 4) out.push({ texture2: f[i], detail: f[i + 1], detailScale: f[i + 2], detailBlend: f[i + 3] });
    return out;
  }

  /** Per-vertex displacement blend alpha (0 = `$basetexture`, 1 = `$basetexture2`), parallel to mesh vertices. */
  meshBlend(): Float32Array | null {
    if (typeof this.cx.mesh_blend_ptr !== "function") return null;
    return this.f32(this.cx.mesh_blend_ptr(), this.cx.mesh_blend_len()).slice();
  }

  // ---- animated studio models (crates/core/src/studio.rs, apps/web/src/player/studio/) ----

  /** True if this wasm build has the studio model exports. */
  hasStudioApi(): boolean {
    return typeof this.cx.studio_load === "function";
  }

  /**
   * Loads a studio model (+ includes, VVD, VTX, materials) through the current VFS. Returns a handle, or 0 while
   * files are pending (see `contentPending`; supply them, `contentResolve`, retry) or on error (`lastError`).
   */
  studioLoad(path: string): number {
    return this.cx.studio_load(...this.giveStr(path));
  }

  /** Model metadata (JSON, see studio.rs `info_json`). */
  studioInfo(h: number): string {
    const n = this.cx.studio_info(h);
    return this.str(this.x.scratch_str_ptr(), n);
  }

  /** Skinned vertices (18 floats each: pos3 normal3 uv2 tangent4 weights3 bones3). */
  studioVertices(h: number): Float32Array {
    const n = this.cx.studio_vertices(h);
    return this.f32(this.x.scratch_f32_ptr(), n).slice();
  }

  studioIndices(h: number): Uint32Array {
    const n = this.cx.studio_indices(h);
    return this.u32(this.x.scratch_u32_ptr(), n).slice();
  }

  /** Decoded animation: frames x bones x [qx, qy, qz, qw, px, py, pz] (bone-local, Source axes). */
  studioAnim(h: number, anim: number): Float32Array {
    const n = this.cx.studio_anim(h, anim);
    return this.f32(this.x.scratch_f32_ptr(), n).slice();
  }

  /** Texture data of a VTF by game path (must be loaded in the VFS). Same as `texture()`. */
  texturePath(path: string, allowS3tc: boolean, needAlpha: boolean): TexturePayload | null {
    const len = this.cx.texture_payload_path(...this.giveStr(path), allowS3tc ? 1 : 0, needAlpha ? 1 : 0);
    if (!len) return null;
    const h = this.u32(this.x.scratch_u32_ptr(), len).slice();
    const base = this.x.tex_bytes_ptr();
    const levels: TextureLevel[] = [];
    for (let i = 0; i < h[1]; i++) {
      const [width, height, offset, size] = h.subarray(2 + i * 4, 6 + i * 4);
      levels.push({ width, height, data: coreBytes(this.x, base + offset, size).slice() });
    }
    return { format: h[0] as TextureFormat, levels };
  }
}

const encoder = new TextEncoder();

/** A file read the host must perform (see `Core.contentResolve`). */
export interface ContentRequest {
  path: string;
  /** VPK directory name (`cstrike/cstrike_pak_dir.vpk`) or listing name. */
  mount: string;
  /** VPK archive index (`<base>_NNN.vpk`), or CONTENT_ARCHIVE_LISTING (fetch `path` itself). */
  archive: number;
  offset: number;
  /** 0 = nothing to read (data preloaded in the directory): provide an empty chunk. */
  length: number;
}

export const CONTENT_ARCHIVE_LISTING = 0xffffffff;

export const MAT_BLEND = 64;

export interface WaterParams {
  /** `$fogstart` / `$fogend` (units; 0 = not set). */
  fogStart: number;
  fogEnd: number;
  /** false for the downward-facing "beneath" surface material (`$abovewater 0`). */
  aboveWater: boolean;
}

export interface MaterialExtras {
  /** `$basetexture2` texture index (WorldVertexTransition), or -1. */
  texture2: number;
  /** `$detail` texture index (mod2x), or -1. */
  detail: number;
  detailScale: number;
  detailBlend: number;
}

interface ContentExports {
  content_mount_vpk(namePtr: number, nameLen: number, dirPtr: number, dirLen: number): number;
  content_mount_listing(namePtr: number, nameLen: number, textPtr: number, textLen: number): number;
  content_unmount_all(): void;
  content_add_file(pathPtr: number, pathLen: number, dataPtr: number, dataLen: number): void;
  content_provide(pathPtr: number, pathLen: number, dataPtr: number, dataLen: number): number;
  content_file(pathPtr: number, pathLen: number): number;
  content_resolve(extraPtr: number, extraLen: number): number;
  content_material_overrides?(textPtr: number, textLen: number): number;
  material_extras(): number;
  material_water(): number;
  water_volumes(): number;
  water_planes(): number;
  texture_paths(): number;
  content_read(pathPtr: number, pathLen: number): number;
  tex_bytes_len(): number;
  content_pending(): number;
  content_list(prefixPtr: number, prefixLen: number): number;
  model_materials(pathPtr: number, pathLen: number): number;
  props_load(ptr: number, len: number): number;
  props_build(): number;
  props_info(): number;
  props_groups(): number;
  props_dynamic_groups?(): number;
  props_group_sky3d?(): number;
  props_vertices_ptr(): number;
  props_indices_ptr(): number;
  mesh_blend_ptr(): number;
  mesh_blend_len(): number;
  studio_load(pathPtr: number, pathLen: number): number;
  studio_info(h: number): number;
  studio_vertices(h: number): number;
  studio_indices(h: number): number;
  studio_anim(h: number, anim: number): number;
  texture_payload_path(pathPtr: number, pathLen: number, allowS3tc: number, needAlpha: number): number;
}

// ---- physics round two wrappers (appended; exports at the end of crates/core/src/wasm.rs) ----

interface RestartExports {
  memory: WebAssembly.Memory;
  nativeRead?: (pointer: number, length: number) => Uint8Array;
  nativeWrite?: (pointer: number, bytes: Uint8Array) => void;
  scratch_f32_ptr(): number;
  set_position?: (x: number, y: number, z: number, yaw: number) => void;
  restart_point?: () => number;
  set_restart_names?: (ptr: number, nameLen: number, classLen: number) => void;
  alloc?: (len: number) => number;
  set_movement_rules?: (flags: number) => void;
  prop_collision_mesh?: () => number;
}

const restartExports = (core: Core) => (core as unknown as { x: RestartExports }).x;

/** A start-zone restart point: feet position (settled onto the floor by the core) and yaw. */
export interface RestartPoint {
  position: [number, number, number];
  yaw: number;
  /**
   * Targetname / classname the player gets at the restart point (bhoptimer map fixes, see restart.ts); absent =
   * the defaults ("" / "player"). Recorded in the replay header (v5) and re-applied on re-simulation.
   */
  targetname?: string;
  classname?: string;
}

/** Restart names applied with setRestartNames since the last setPosition, per core. */
const RESTART_NAMES = new WeakMap<Core, { targetname: string; classname: string }>();

/**
 * Start-zone restart: respawns the player at (x, y, z) facing `yaw`, zero velocity, settled onto the
 * floor. Call right after core.reset() (tick 0). Replays record the resulting point in their header
 * (see restartPoint) and simulate() re-applies it after reset, so the run stays deterministic.
 */
export function setPosition(core: Core, x: number, y: number, z: number, yaw: number): void {
  const e = restartExports(core);
  if (!e.set_position) throw new Error("wasm build lacks set_position export; rebuild with tools/scripts/build-wasm.sh");
  e.set_position(x, y, z, yaw);
  RESTART_NAMES.delete(core);
}

/**
 * Names the player gets at the restart point set by the last setPosition (now and on respawns there): bhoptimer's
 * `shavit_zones_resettargetname_*` / `resetclassname_*` (restart.ts). Empty classname = "player".
 */
export function setRestartNames(core: Core, targetname: string, classname: string): void {
  const e = restartExports(core);
  if (!e.set_restart_names || !e.alloc) throw new Error("wasm build lacks set_restart_names export; rebuild with tools/scripts/build-wasm.sh");
  const name = new TextEncoder().encode(targetname);
  const cls = new TextEncoder().encode(classname);
  const ptr = e.alloc(name.length + cls.length);
  const mem = new Uint8Array(name.length + cls.length);
  mem.set(name, 0);
  mem.set(cls, name.length);
  coreWrite(e, ptr, mem);
  e.set_restart_names(ptr, name.length, cls.length);
  RESTART_NAMES.set(core, { targetname, classname });
}

/** Applies a restart point: setPosition, then its names if it has any. */
export function applyRestartPoint(core: Core, p: RestartPoint): void {
  setPosition(core, p.position[0], p.position[1], p.position[2], p.yaw);
  if (p.targetname || p.classname) setRestartNames(core, p.targetname ?? "", p.classname ?? "");
}

/** The restart point applied since the last reset (settled position), or null. */
export function restartPoint(core: Core): RestartPoint | null {
  const e = restartExports(core);
  if (!e.restart_point) return null;
  const len = e.restart_point();
  if (len < 4) return null;
  const s = coreF32(e, e.scratch_f32_ptr(), len);
  const names = RESTART_NAMES.get(core);
  const p: RestartPoint = { position: [s[0], s[1], s[2]], yaw: s[3] };
  if (names?.targetname) p.targetname = names.targetname;
  if (names?.classname) p.classname = names.classname;
  return p;
}

/** Optional movement rules (bit flags; 0 = vanilla CS:S). Resets the map. */
export const MOVEMENT_RULE_DOWNHILL = 1;
export const MOVEMENT_RULE_UPHILL = 2;
export const MOVEMENT_RULE_RAMPBUG = 4;
export const MOVEMENT_RULE_TELEHOP = 8;
export const MOVEMENT_RULE_NO_SURFACE_PROPS = 16;
export function setMovementRules(core: Core, flags: number): void {
  const e = restartExports(core);
  if (!e.set_movement_rules) throw new Error("wasm build lacks set_movement_rules export; rebuild with tools/scripts/build-wasm.sh");
  e.set_movement_rules(flags >>> 0);
}

/**
 * Prop collision hulls (static props + prop_dynamic with packed .phy) as a triangle soup, 9 floats per
 * triangle in world space. The client does not render .mdl props, so without this they are invisible walls.
 */
export function propCollisionMesh(core: Core): Float32Array {
  const e = restartExports(core);
  if (!e.prop_collision_mesh) return new Float32Array(0);
  const len = e.prop_collision_mesh();
  return coreF32(e, e.scratch_f32_ptr(), len).slice();
}

// ---- replay viewer wrappers (appended; exports at the end of crates/core/src/wasm.rs) ----

interface ViewerExports {
  state_snapshot?: () => number;
  state_restore?: (handle: number) => number;
  state_free?: (handle: number) => void;
  state_snapshot_bytes?: (handle: number) => number;
  trace_ray?: (sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, radius: number) => number;
}

const viewerExports = (core: Core) => (core as unknown as { x: ViewerExports }).x;

/** True if this wasm build can snapshot/restore the full sim state (keyframe seeking). */
export function hasStateSnapshots(core: Core): boolean {
  const e = viewerExports(core);
  return typeof e.state_snapshot === "function" && typeof e.state_restore === "function";
}

/**
 * Captures the full simulation state (player, doors/brush entities, triggers, entity I/O queue) inside the wasm
 * instance. Returns a handle for restoreState / freeState (0 = unavailable). Restore-then-step is bit-identical to
 * the continuous run (crates/core/tests/snapshot.rs).
 */
export function snapshotState(core: Core): number {
  return viewerExports(core).state_snapshot?.() ?? 0;
}

export function restoreState(core: Core, handle: number): boolean {
  return viewerExports(core).state_restore?.(handle) === 1;
}

export function freeState(core: Core, handle: number): void {
  viewerExports(core).state_free?.(handle);
}

/**
 * Runs `fn` against the core, then puts the simulation back exactly as it was (a state snapshot, plus the restart
 * names this module keeps for restartPoint). For probes in the middle of play (start-point.ts). Null without
 * running `fn` on a wasm build that can't snapshot.
 */
export function withRestoredState<T>(core: Core, fn: () => T): T | null {
  if (!hasStateSnapshots(core)) return null;
  const h = snapshotState(core);
  if (!h) return null;
  const names = RESTART_NAMES.get(core);
  try {
    return fn();
  } finally {
    restoreState(core, h);
    freeState(core, h);
    if (names) RESTART_NAMES.set(core, names);
    else RESTART_NAMES.delete(core);
  }
}

/** Approximate bytes a snapshot holds (for keyframe budgets). */
export function snapshotBytes(core: Core, handle: number): number {
  return viewerExports(core).state_snapshot_bytes?.(handle) ?? 0;
}

/**
 * Camera collision: sweeps a cube of half-size `radius` from `start` to `end` (Source units) through the world,
 * props and solid brush entities (MASK_SOLID; player clips ignored). Returns the clear fraction 0..1 (1 = no hit,
 * also when the wasm build lacks the export).
 */
export function traceRay(core: Core, start: ArrayLike<number>, end: ArrayLike<number>, radius = 6): number {
  const f = viewerExports(core).trace_ray;
  return f ? f(start[0], start[1], start[2], end[0], end[1], end[2], radius) : 1;
}

// ---- attacks and weapons (physics v4; exports at the end of crates/core/src/wasm.rs) ----

/** Weapon bits (PlayerState.weapons / activeWeapon, AttackReport.weapon). */
export const WEAPON_KNIFE = 1;
/** A pistol (weapon_usp, weapon_glock, ...): one shot per click, 0.15 s apart. */
export const WEAPON_PISTOL = 2;
/** A sniper rifle (weapon_awp, weapon_scout, ...): a shot every 1.5 s while held. */
export const WEAPON_SNIPER = 4;

/** What the player's attack this tick did (EVENT_ATTACK). */
export interface AttackReport {
  /** Weapon id (WEAPON_IDS): 1 = the knife, 2+ = guns. */
  weapon: number;
  /** 1 = primary (knife slash, gun shot), 2 = secondary (knife stab; v7: a silenced USP shot, CS:S Secondary_Mode). */
  mode: 1 | 2;
  /** The trace hit something (world, a prop or a brush entity). */
  hit: boolean;
  /** Trace start (the eye) and end (the hit point, or the end of the weapon's range). Source units. */
  start: [number, number, number];
  end: [number, number, number];
  /** Surface normal at the hit ([0, 0, 0] on a miss). */
  normal: [number, number, number];
  /** Brush entity index that was hit (the entities_text order), or -1 for the world, a prop or a miss. */
  entity: number;
}

interface AttackExports {
  attack_report?: () => number;
}

/** The last tick's attack (call after a step that returned EVENT_ATTACK), or null (none / older wasm build). */
export function attackReport(core: Core): AttackReport | null {
  const x = (core as unknown as { x: AttackExports & { memory: WebAssembly.Memory; scratch_f32_ptr(): number } }).x;
  if (!x.attack_report) return null;
  const len = x.attack_report();
  if (len < 13) return null;
  const s = coreF32(x, x.scratch_f32_ptr(), len);
  return {
    weapon: s[0],
    mode: s[1] === 2 ? 2 : 1,
    hit: s[2] !== 0,
    start: [s[3], s[4], s[5]],
    end: [s[6], s[7], s[8]],
    normal: [s[9], s[10], s[11]],
    entity: s[12],
  };
}

/** Weapon ids (research/WEAPONS.md; crates/core game/weapons.rs GUNS). Index = id. */
export const WEAPON_IDS = [
  "",
  "knife",
  "glock",
  "usp",
  "p228",
  "deagle",
  "elite",
  "fiveseven",
  "m3",
  "xm1014",
  "mac10",
  "tmp",
  "mp5navy",
  "ump45",
  "p90",
  "galil",
  "famas",
  "ak47",
  "m4a1",
  "sg552",
  "aug",
  "scout",
  "awp",
  "g3sg1",
  "sg550",
  "m249",
] as const;

/** weaponReport flags (EVENT_WEAPON). */
export const WEAPON_EVENT_SWITCHED = 1;
export const WEAPON_EVENT_PICKED_UP = 2;
export const WEAPON_EVENT_RELOAD_STARTED = 4;
export const WEAPON_EVENT_RELOAD_FINISHED = 8;
export const WEAPON_EVENT_DRY_FIRE = 16;
export const WEAPON_EVENT_DROPPED = 32;
export const WEAPON_EVENT_LOST = 64;
export const WEAPON_EVENT_MODE = 128;
/** v7: the USP's silencer started going on or off (WeaponReport.silencer is the new state, silencerTicks the lock-out). */
export const WEAPON_EVENT_SILENCER = 256;
/** v7: a weapon command gave a weapon (weapon-rules.ts IN_GIVE_*): it replaced that slot's weapon and was drawn. */
export const WEAPON_EVENT_GIVEN = 512;
/**
 * v10: that weapon command restored a gun the player had before the restart (weapon-rules.ts IN_GIVE_RESTORE): it is in
 * hand without a draw (no WEAPON_EVENT_SWITCHED or PICKED_UP), the silencer / burst mode already as the report says.
 */
export const WEAPON_EVENT_RESTORED = 1024;
/**
 * The USP's silencer attach / detach time (s): CS:S v_pist_usp.mdl `add_silencer` / `detach_silencer`, 115 frames at
 * 37 fps (CWeaponUSP::SecondaryAttack locks both attacks for SequenceDuration()). The core locks 308 ticks at 100 tick.
 */
export const USP_SILENCER_TIME = 114 / 37;
/** When the CS:S sequences' sound events fire (s into the sequence): Weapon_USP.AttachSilencer / DetachSilencer. */
export const USP_SILENCER_SOUND_AT = { attach: 0.3333 * (114 / 37), detach: 0.2544 * (114 / 37) } as const;

/** The player's weapons after the last step (valid every tick). */
export interface WeaponReport {
  /** WEAPON_EVENT_* of the last step (0 unless it returned EVENT_WEAPON). */
  flags: number;
  /** Weapon ids (WEAPON_IDS): active, primary slot, secondary slot (0 = none). */
  active: number;
  primary: number;
  secondary: number;
  knife: boolean;
  /** Rounds in the active gun's clip and its size (0 for the knife). */
  clip: number;
  clipSize: number;
  /** Ticks until the reload (or the next shotgun shell) completes; 0 when not reloading. */
  reloadTicks: number;
  /** Glock / FAMAS burst mode. */
  burst: boolean;
  /** Weapon items in the world appeared, went or moved since the last floorWeapons() call (physics v5 cores). */
  floorChanged: boolean;
  /** v7: the active USP's silencer is on (it flips when the attach / detach starts, like CS:S m_bSilencerOn). */
  silencer: boolean;
  /** v7: ticks until the silencer attach / detach finishes (attacks are locked until then); 0 otherwise. */
  silencerTicks: number;
}

/** The player's weapons (null on wasm builds before weapons). */
export function weaponReport(core: Core): WeaponReport | null {
  const x = (core as unknown as { x: { weapon_report?: () => number; memory: WebAssembly.Memory; scratch_f32_ptr(): number } }).x;
  if (!x.weapon_report) return null;
  const len = x.weapon_report();
  if (len < 9) return null;
  const s = coreF32(x, x.scratch_f32_ptr(), len);
  return { flags: s[0], active: s[1], primary: s[2], secondary: s[3], knife: s[4] !== 0, clip: s[5], clipSize: s[6], reloadTicks: s[7], burst: s[8] !== 0, floorChanged: len > 9 && s[9] !== 0, silencer: len > 10 && s[10] !== 0, silencerTicks: len > 11 ? s[11] : 0 };
}

/** floorWeapons() item flags (research/WEAPONS.md "Floor weapons"): in the world now, and what happened since the last call. */
export const FLOOR_PRESENT = 1;
export const FLOOR_PICKED_UP = 2;
export const FLOOR_SPAWNED = 4;
export const FLOOR_DROPPED = 8;
export const FLOOR_REMOVED = 16;
export const FLOOR_MOVED = 32;
/** Floats per floorWeapons() item: entity, weapon id (WEAPON_IDS index), FLOOR_* flags, x, y, z, pitch, yaw, roll. */
export const FLOOR_STRIDE = 9;

const floorViews = new WeakMap<Core, Float32Array>();

/**
 * Every weapon_* item of the map (entity order, present or not; the count is fixed per map) as FLOOR_STRIDE floats each,
 * with the FLOOR_* events since the previous call; the position is where the item rests. A view into the core's scratch
 * memory, valid until the next core call; no allocation per call once the view exists (viewmodel/guns/world.ts
 * FloorGuns.update). Empty on cores without floor items.
 */
export function floorWeapons(core: Core): Float32Array {
  const x = (core as unknown as { x: { floor_weapons?: () => number; memory: WebAssembly.Memory; scratch_f32_ptr(): number } }).x;
  const len = x.floor_weapons ? x.floor_weapons() : 0;
  if (len === 0) return EMPTY_F32;
  const ptr = x.scratch_f32_ptr();
  if (core.engine === "native") return coreF32(x, ptr, len);
  let v = floorViews.get(core);
  if (!v || v.buffer !== x.memory.buffer || v.byteOffset !== ptr || v.length !== len) floorViews.set(core, (v = new Float32Array(x.memory.buffer, ptr, len)));
  return v;
}
const EMPTY_F32 = new Float32Array(0);
