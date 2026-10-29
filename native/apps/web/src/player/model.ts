import type { PlayerGlow } from "./glow-config";
import { getPlayerGlow, onPlayerGlow } from "./cosmetics";
// PlayerModel: the one player-model contract used everywhere a player is drawn (replay viewer, live third person,
// race ghosts, the menu background, other players in multiplayer).
//
//   const m = new PlayerModel({ style: "solid" });     // or "ghost" (+ color); { model: "runner" } to force one
//   scene.add(m.root);
//   every frame: m.setState(pose); m.update(dt);
//   after teleports / seeks: m.snap();
//
// Poses are in Source conventions (Z-up position in units, yaw/pitch in degrees, pitch + = looking down); the model
// converts to three.js space itself. `root.position` is the feet in three.js space after update().
//
// Implementations (Settings -> Graphics -> Player model; ghosts can pick their own):
//   - the bunnyhop.lol bunny (player/bunny/): our own character on the CS:S player skeleton, animated by the CS:S
//     animations (cs_player_shared + the SDK animstate, identical to the CS:S models) when the hosted content is
//     available, procedurally until then. Colourway from the "outfit" cosmetic. The default, and the fallback.
//   - the classic runner (player/runner.ts): the original procedural low-poly runner.
//   - CS:S player models (player/studio/): the real models from the hosted CS:S content (opt-in); the bunny shows while
//     one loads or when there is no hosted content.
// The facade swaps implementations live (setting changes, content arriving) without callers noticing.

import * as THREE from "three";
import { playerUniforms, type PlayerUniforms } from "./materials";
import { RunnerModel } from "./runner";
import { BunnyModel } from "./bunny/model";
import { getLoadout, getOutfit, onLoadout, onOutfit } from "./cosmetics";
import type { CosmeticLoadout } from "../loadout";
import { followLoadout, knifeOf } from "../viewmodel/equip";
import { equippedKnife, onKnife } from "../viewmodel/knives/equipped";
import type { KnifeDef } from "../viewmodel/knives/types";
import { CsPlayerModel } from "./studio/csmodel";
import { CT_SKINS, hasAnimRig, hasSkin, loadAnimRig, loadCsAsset, readyAnimRig, readyAsset, T_SKINS } from "./studio/loader";
import { onPlayerContent } from "../content/player";
import { prefs, type PlayerModelChoice } from "../ui/settings";

export type PlayerStyle = "ghost" | "solid";

export interface PlayerPose {
  /** Explicit visual clock for deterministic replay/export and local shadow animation. */
  visualTime?: number;
  /** Feet origin, Source units (x, y, z; z up). */
  position: ArrayLike<number>;
  /** Units/s. Derived from position changes when omitted. */
  velocity?: ArrayLike<number>;
  /** View angles, degrees (Source: yaw CCW from +X, pitch + = down). */
  yaw: number;
  pitch: number;
  /** FL_DUCKING. */
  crouched: boolean;
  /** FL_ONGROUND (callers sampling slower than the tick rate should OR in any ground tick since the last frame). */
  grounded: boolean;
  /** Command inputs (i16 domain, e.g. ±450). Optional; used for strafe lean. */
  forwardmove?: number;
  sidemove?: number;
  /**
   * A jump happened since the last setState (PLAYERANIMEVENT_JUMP). Optional: when omitted the model detects jumps
   * from the vertical velocity. Network clients that receive jump events should pass them.
   */
  jumped?: boolean;
  /**
   * Cosmetic carrot swing since the last setState: 1 = slash (primary), 2 = stab (secondary). Models with the CS:S
   * animations play the knife attack layer (Idle/Walk/Run/Crouch_Shoot_KNIFE, like CCSPlayerAnimState's fire layer).
   */
  attack?: number;
  /**
   * Inspect signal since the last setState (viewmodel/inspects/combo.ts SIG_START = 1: the base inspect started,
   * SIG_NEXT = 2: the next trick of the chain took over). The bunny and CS:S models play it as a gesture layer
   * (viewmodel/inspects/third.ts); attacks and snaps cancel it.
   */
  inspect?: number;
  /** The inspect key is held (hold-to-loop tricks keep looping while true). */
  inspectHeld?: boolean;
  /**
   * A shot from the gun in hand since the last setState (PlayerModel.setGun; the bunny kicks, flashes at the muzzle and
   * throws a case: player/bunny/gun-hold.ts). Knife swings stay `attack`.
   */
  gunShot?: boolean;
  /**
   * The gun in hand started a reload since the last setState, `seconds` long (the core's reload time, or the gun's own
   * for other players), or with `shell` one shell of a tube gun went in (`seconds` until the next one could).
   */
  gunReload?: { seconds: number; shell?: boolean; empty?: boolean } | null;
}

/** `model` values: a Settings choice, a CS:S team (uses the Settings skin for it), or a specific skin ("ct_gign"). */
export type PlayerModelKind = PlayerModelChoice | "ct" | "t" | (typeof CT_SKINS)[number] | (typeof T_SKINS)[number];

export interface PlayerModelOptions {
  playerGlow?: PlayerGlow | null;
  /** Explicit supporter customization preview only. */
  previewGlow?: boolean;
  style?: PlayerStyle;
  /** Accent (solid) / tint (ghost) colour. */
  color?: THREE.ColorRepresentation;
  /**
   * Ghost: the fresnel rim glow's colour (a ghost cosmetic's second colour, progression.ts CosmeticDef.color2, e.g. the
   * Geode ghost's amethyst). Absent / null = the tint.
   */
  rim?: THREE.ColorRepresentation | null;
  /** Ghost: screen-door dithered transparency instead of blending (fully depth-correct, noisier). */
  dither?: boolean;
  /** Force a model instead of the Settings choice (e.g. a multiplayer player's team / skin). */
  model?: PlayerModelKind;
  /** Bunny colourway ("outfit-*" cosmetic id); default: the one you equipped (player/cosmetics.ts). */
  outfit?: string;
  /**
   * Blade in the bunny's hand (viewmodel/knives/ registry entry; null = the carrot). Default (undefined): the one you
   * equipped (viewmodel/knives/equipped.ts), like `outfit`; other players / replays should pass theirs.
   */
  knife?: KnifeDef | null;
  /**
   * Cosmetic loadout (loadout.ts: knife, finish, gloves). Default (undefined): the one you equipped
   * (player/cosmetics.ts), like `outfit`; other players (room roster) and replays (cosmetic trailer) pass theirs. When
   * set and `knife` isn't, the knife comes from it too.
   */
  loadout?: CosmeticLoadout | null;
}

/** What every implementation provides; the facade forwards to it. */
export interface PlayerModelImpl {
  readonly root: THREE.Object3D;
  readonly uniforms: PlayerUniforms;
  setStyle(style: PlayerStyle, color?: THREE.ColorRepresentation, dither?: boolean): void;
  readonly currentStyle: PlayerStyle;
  setOpacity(a: number): void;
  setNearFade(near: number, far: number): void;
  setRenderOrder(order: number): void;
  setState(pose: PlayerPose): void;
  snap(): void;
  update(dt: number): void;
  dispose(): void;
}

/** Live players always use the bunny and its loadout; explicit model overrides are for the developer viewer. */
export function resolveSkin(o: PlayerModelOptions): string {
  const m = prefs.get().models;
  let choice: string = o.model ?? "bunny";
  if (choice === "css") choice = m.team;
  if (choice === "ct") choice = m.ct;
  else if (choice === "t") choice = m.t;
  return choice;
}

export class PlayerModel {
  /** Add to the scene. Positioned at the feet by update(). */
  readonly root = new THREE.Group();
  readonly uniforms: PlayerUniforms = playerUniforms();
  private impl: PlayerModelImpl;
  private o: PlayerModelOptions;
  private opacity: number | null = null;
  private nearFade: [number, number] | null = null;
  private renderOrder: number | null = null;
  /** The gun in hand (bunny only; viewmodel/guns), null = the knife. */
  private gun: string | null = null;
  private gunSilencer = false;
  /** setHeldHidden: an empty hand. */
  private heldHidden = false;
  private pose: PlayerPose | null = null;
  private wanted = "";
  private pendingSkin: string | null = null;
  private updated = false;
  private disposed = false;
  private unsub: (() => void)[] = [];

  constructor(o: PlayerModelOptions = {}) {
    this.o = { ...o };
    followLoadout(); // your equipped loadout's knife -> knives/equipped.ts (once)
    this.root.name = "player-model";
    this.impl = this.bunny();
    this.root.add(this.impl.root);
    this.choose();
    this.syncRim();
    this.unsub.push(prefs.watch(() => { this.choose(); this.syncGlow(); }));
    this.unsub.push(onPlayerGlow(() => this.syncGlow()));
    this.syncGlow();
    this.unsub.push(
      onPlayerContent(() => {
        this.choose();
        this.loadAnims();
      }),
    );
    this.unsub.push(
      onOutfit((id) => {
        if (!this.o.outfit && this.impl instanceof BunnyModel) this.impl.setOutfit(id);
      }),
    );
    this.unsub.push(
      onLoadout((l) => {
        if (this.o.loadout === undefined && this.impl instanceof BunnyModel) this.impl.setLoadout(l);
      }),
    );
    this.unsub.push(
      onKnife((k) => {
        if (this.o.knife === undefined && this.o.loadout === undefined && this.impl instanceof BunnyModel) this.impl.setKnife(k);
      }),
    );
  }

  /** The implementation in use: "bunny", "runner" or a CS:S skin such as "ct_urban". */
  get kind(): string {
    return this.impl instanceof CsPlayerModel ? this.impl.kind : this.impl instanceof BunnyModel ? "bunny" : "runner";
  }

  /** The bunny implementation (debugging / perf), or null. */
  get bunnyModel(): BunnyModel | null {
    return this.impl instanceof BunnyModel ? this.impl : null;
  }

  private bunny(): BunnyModel {
    return new BunnyModel({ ...this.o, playerGlow: this.o.playerGlow === undefined ? getPlayerGlow() : this.o.playerGlow, outfit: this.o.outfit ?? getOutfit(), knife: this.knifeChoice(), loadout: this.o.loadout === undefined ? getLoadout() : this.o.loadout }, this.uniforms, readyAnimRig());
  }

  get playerGlow(): PlayerGlow | null { return this.o.playerGlow === undefined ? getPlayerGlow() : this.o.playerGlow; }
  setPlayerGlow(value: PlayerGlow | null | undefined): void { this.o.playerGlow = value; this.syncGlow(); }
  private syncGlow(): void { if (this.impl instanceof BunnyModel) this.impl.setPlayerGlow(this.o.playerGlow === undefined ? getPlayerGlow() : this.o.playerGlow, this.o.previewGlow || prefs.get().showPlayerGlow, !prefs.get().graphics.potato); }

  /** The knife the bunny holds: explicit `knife`, else the explicit loadout's, else the one you equipped. */
  private knifeChoice(): KnifeDef | null {
    return this.o.knife !== undefined ? this.o.knife : this.o.loadout !== undefined ? knifeOf(this.o.loadout) : equippedKnife();
  }

  /** Knife + finish + gloves (bunny). undefined = follow your equipped loadout. CS:S models keep w_knife. */
  setLoadout(l: CosmeticLoadout | null | undefined): void {
    this.o.loadout = l;
    if (!(this.impl instanceof BunnyModel)) return;
    this.impl.setLoadout(l === undefined ? getLoadout() : l);
    this.impl.setKnife(this.knifeChoice());
  }

  /** Bunny colourway ("outfit-*" id); undefined = follow the one you equipped. */
  setOutfit(id: string | undefined): void {
    this.o.outfit = id;
    if (this.impl instanceof BunnyModel) this.impl.setOutfit(id ?? getOutfit());
  }

  /**
   * Nothing in the bunny's hand: the knife collapses and a gun isn't shown (the replay viewer's held-weapon toggle).
   * setGun keeps tracking the gun meanwhile, so it comes back when this is turned off.
   */
  setHeldHidden(on: boolean): void {
    if (on === this.heldHidden) return;
    this.heldHidden = on;
    if (!(this.impl instanceof BunnyModel)) return;
    this.impl.setKnifeHidden(on);
    this.impl.setGun(on ? null : this.gun);
  }

  /** The blade in hand (bunny; null = the carrot, undefined = follow your equipped knife). CS:S models keep w_knife. */
  setKnife(k: KnifeDef | null | undefined): void {
    this.o.knife = k;
    if (this.impl instanceof BunnyModel) this.impl.setKnife(this.knifeChoice());
  }

  /**
   * A map-given gun in the bunny's right hand (a core weapon id: "glock", "m3"...; viewmodel/guns), null = back to the
   * knife. The bunny only: the runner and CS:S models keep their knife.
   */
  setGun(id: string | null): void {
    this.gun = id;
    if (this.impl instanceof BunnyModel && !this.heldHidden) this.impl.setGun(id);
  }

  /**
   * The bunny's gun shows its silencer (the USP's, physics v7: WeaponReport.silencer / the room's silenced flag) or not.
   * Kept across setGun calls: a gun without a silencer ignores it.
   */
  setGunSilencer(on: boolean): void {
    this.gunSilencer = on;
    if (this.impl instanceof BunnyModel) this.impl.setGunSilencer(on);
  }

  /** The bunny's gun muzzle in three.js world space as of the last update (false: no gun drawn, or another model). */
  gunMuzzle(out: THREE.Vector3): boolean {
    return this.impl instanceof BunnyModel && this.root.visible && this.impl.gunMuzzle(out);
  }

  /** Bunny: switch to the CS:S animations once they're loaded (fetched once this model is animated). */
  private loadAnims(): void {
    if (!(this.impl instanceof BunnyModel) || this.impl.animSource === "cs" || !this.updated || this.disposed) return;
    const ready = readyAnimRig();
    if (ready) {
      this.impl.setAnimations(ready);
      return;
    }
    if (!hasAnimRig()) return;
    loadAnimRig().then(
      (d) => {
        if (!this.disposed && this.impl instanceof BunnyModel) this.impl.setAnimations(d);
      },
      (e) => console.warn("player model: CS:S animations unavailable, the bunny keeps its procedural animation", e),
    );
  }

  /** The CS:S implementation (debugging / perf), or null when the runner is shown. */
  get cs(): CsPlayerModel | null {
    return this.impl instanceof CsPlayerModel ? this.impl : null;
  }

  /** Picks (and if needed loads) the implementation for the current Settings / content. */
  private choose(): void {
    if (this.disposed) return;
    const skin = resolveSkin(this.o);
    if (skin === this.wanted) return;
    this.wanted = skin;
    this.pendingSkin = null;
    if (skin === "runner") {
      if (!(this.impl instanceof RunnerModel)) this.swap(new RunnerModel(this.o, this.uniforms));
      return;
    }
    if (skin === "bunny" || !hasSkin(skin)) {
      // A CS:S skin without hosted content: the bunny stands in; re-evaluate when content arrives.
      if (skin !== "bunny") this.wanted = "";
      if (!(this.impl instanceof BunnyModel)) this.swap(this.bunny());
      this.loadAnims();
      return;
    }
    const ready = readyAsset(skin);
    if (ready) {
      this.swap(new CsPlayerModel(ready, this.o, this.uniforms));
      return;
    }
    // Not loaded yet: fetch it once this model is actually animated (update()), so a hidden model (live third
    // person while off, a disabled ghost) doesn't download anything.
    this.pendingSkin = skin;
    if (this.updated) this.load();
  }

  private load(): void {
    const skin = this.pendingSkin;
    if (!skin) return;
    this.pendingSkin = null;
    loadCsAsset(skin).then(
      (asset) => {
        if (this.disposed || this.wanted !== skin) return;
        this.swap(new CsPlayerModel(asset, this.o, this.uniforms));
      },
      (e) => console.warn(`player model: ${skin} unavailable, using the bunny`, e),
    );
  }

  private swap(next: PlayerModelImpl): void {
    const prev = this.impl;
    this.impl = next;
    this.syncGlow();
    prev.dispose();
    this.root.add(next.root);
    this.syncRim();
    if (this.opacity !== null) next.setOpacity(this.opacity);
    if (this.nearFade) next.setNearFade(...this.nearFade);
    if (this.renderOrder !== null) next.setRenderOrder(this.renderOrder);
    if (this.gun && next instanceof BunnyModel && !this.heldHidden) next.setGun(this.gun);
    if (this.heldHidden && next instanceof BunnyModel) next.setKnifeHidden(true);
    if (next instanceof BunnyModel) next.setGunSilencer(this.gunSilencer);
    if (this.pose) {
      next.setState(this.pose);
      next.snap();
      next.update(0);
      this.place();
    }
  }

  private place(): void {
    // Implementations position their own root in world space; the facade's root carries the position instead.
    this.root.position.copy(this.impl.root.position);
    this.impl.root.position.set(0, 0, 0);
  }

  /** `rim`: the ghost's rim glow colour (PlayerModelOptions.rim); a new `color` without one resets it to the tint. */
  setStyle(style: PlayerStyle, color?: THREE.ColorRepresentation, dither?: boolean, rim?: THREE.ColorRepresentation | null): void {
    const ghostChoiceChanged = (style === "ghost") !== (this.o.style === "ghost");
    this.o.style = style;
    if (color !== undefined) {
      this.o.color = color;
      this.o.rim = rim ?? null;
    } else if (rim !== undefined) this.o.rim = rim;
    if (dither !== undefined) this.o.dither = dither;
    this.impl.setStyle(style, color, dither);
    if (ghostChoiceChanged) {
      this.wanted = "";
      this.choose();
    }
    this.syncRim();
  }

  /** The ghost rim follows the tint (uGhost, set by the implementations) unless a rim colour is given. */
  private syncRim(): void {
    const u = this.uniforms;
    if (this.o.rim != null) u.uGhostRim.value.set(this.o.rim);
    else u.uGhostRim.value.copy(u.uGhost.value);
  }

  get currentStyle(): PlayerStyle {
    return this.impl.currentStyle;
  }

  setOpacity(a: number): void {
    this.opacity = a;
    this.impl.setOpacity(a);
  }

  setNearFade(near: number, far: number): void {
    this.nearFade = [near, far];
    this.impl.setNearFade(near, far);
  }

  setRenderOrder(order: number): void {
    this.renderOrder = order;
    this.impl.setRenderOrder(order);
  }

  setState(pose: PlayerPose): void {
    this.pose = pose;
    this.impl.setState(pose);
  }

  snap(): void {
    this.impl.snap();
  }

  update(dt: number): void {
    if (!this.updated) {
      this.updated = true;
      this.load();
      this.loadAnims();
    }
    this.impl.update(dt);
    this.place();
  }

  dispose(): void {
    this.disposed = true;
    for (const u of this.unsub) u();
    this.unsub = [];
    this.impl.dispose();
    this.root.removeFromParent();
  }
}
