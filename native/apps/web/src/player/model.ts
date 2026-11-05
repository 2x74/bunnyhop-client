import type { PlayerGlow } from "./glow-config";
import { getPlayerGlow, onPlayerGlow } from "./cosmetics";
// PlayerModel: the one player-model contract used everywhere a player is drawn (replay viewer, live third person,
// race ghosts, the menu background, other players in multiplayer).
//
//   const m = new PlayerModel({ style: "solid" });     // or "ghost" (+ color)
//   scene.add(m.root);
//   every frame: m.setState(pose); m.update(dt);
//   after teleports / seeks: m.snap();
//
// Poses are in Source conventions (Z-up position in units, yaw/pitch in degrees, pitch + = looking down); the model
// converts to three.js space itself. `root.position` is the feet in three.js space after update().
//
// The one implementation is the bunnyhop.lol bunny (player/bunny/): our own character on the CS:S player skeleton,
// animated by the CS:S animations (cs_player_shared.mdl + the SDK animstate) when the hosted content is available,
// procedurally until then (it switches live when the animations arrive). Colourway from the "outfit" cosmetic. The
// CS:S player models and the classic runner were removed in v0.0.38 (owner: bunny player models only); old prefs that
// chose them load as the bunny (ui/settings.ts migrateModels).

import * as THREE from "three";
import { playerUniforms, type PlayerUniforms } from "./materials";
import { BunnyModel } from "./bunny/model";
import { getHeldLoadout, getOutfit, onHeldLoadout, onOutfit } from "./cosmetics";
import type { CosmeticLoadout } from "../loadout";
import { followLoadout, knifeOf } from "../viewmodel/equip";
import { equippedKnife, onKnife } from "../viewmodel/knives/equipped";
import type { KnifeDef } from "../viewmodel/knives/types";
import { hasAnimRig, loadAnimRig, readyAnimRig } from "./studio/loader";
import { onPlayerContent } from "../content/player";
import { prefs } from "../ui/settings";
import type { PlayerPose } from "./pose";

export type PlayerStyle = "ghost" | "solid";

export type { PlayerPose } from "./pose";

/** `model` values: only the bunny since v0.0.38 (kept so callers that name it still compile). */
export type PlayerModelKind = "bunny";

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
  /** Always the bunny (the option is kept for callers that name it). */
  model?: PlayerModelKind;
  /**
   * 0..1 seed for the bunny's idle variation (weight shift phase, ear twitch schedule). Default: from the outfit, style
   * and colour, so the same model looks the same in every replay and export, and a ghost doesn't idle in step with you.
   */
  seed?: number;
  /**
   * The bunny's leg layer (player/bunny/legs.ts: planting, steps, jump phases, landings). Default on; off for a
   * turntable that spins the model by its yaw (the Loadout's bunny), where planted steps would fight the spin.
   */
  legs?: boolean;
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

export class PlayerModel {
  /** Add to the scene. Positioned at the feet by update(). */
  readonly root = new THREE.Group();
  readonly uniforms: PlayerUniforms = playerUniforms();
  private impl: BunnyModel;
  private o: PlayerModelOptions;
  private opacity: number | null = null;
  private nearFade: [number, number] | null = null;
  private renderOrder: number | null = null;
  /** The gun in hand (bunny only; viewmodel/guns), null = the knife. */
  private gun: string | null = null;
  private gunSilencer = false;
  /** setHeldHidden: an empty hand. */
  private heldHidden = false;
  private updated = false;
  private disposed = false;
  private unsub: (() => void)[] = [];

  constructor(o: PlayerModelOptions = {}) {
    this.o = { ...o };
    followLoadout(); // your equipped loadout's knife -> knives/equipped.ts (once)
    this.root.name = "player-model";
    this.impl = this.bunny();
    this.root.add(this.impl.root);
    this.syncRim();
    this.unsub.push(prefs.watch(() => this.syncGlow()));
    this.unsub.push(onPlayerGlow(() => this.syncGlow()));
    this.syncGlow();
    this.unsub.push(onPlayerContent(() => this.loadAnims()));
    this.unsub.push(
      onOutfit((id) => {
        if (!this.o.outfit) this.impl.setOutfit(id);
      }),
    );
    this.unsub.push(
      onHeldLoadout((l) => {
        if (this.o.loadout === undefined) this.impl.setLoadout(l);
      }),
    );
    this.unsub.push(
      onKnife((k) => {
        if (this.o.knife === undefined && this.o.loadout === undefined) this.impl.setKnife(k);
      }),
    );
  }

  /** The implementation in use (always "bunny" since v0.0.38). */
  get kind(): string {
    return "bunny";
  }

  /** The bunny (debugging / perf). Never null since v0.0.38 (kept nullable for callers). */
  get bunnyModel(): BunnyModel | null {
    return this.impl;
  }

  private bunny(): BunnyModel {
    return new BunnyModel({ ...this.o, playerGlow: this.o.playerGlow === undefined ? getPlayerGlow() : this.o.playerGlow, outfit: this.o.outfit ?? getOutfit(), knife: this.knifeChoice(), loadout: this.o.loadout === undefined ? getHeldLoadout() : this.o.loadout }, this.uniforms, readyAnimRig());
  }

  get playerGlow(): PlayerGlow | null { return this.o.playerGlow === undefined ? getPlayerGlow() : this.o.playerGlow; }
  setPlayerGlow(value: PlayerGlow | null | undefined): void { this.o.playerGlow = value; this.syncGlow(); }
  private syncGlow(): void { this.impl.setPlayerGlow(this.o.playerGlow === undefined ? getPlayerGlow() : this.o.playerGlow, this.o.previewGlow || prefs.get().showPlayerGlow, !prefs.get().graphics.potato); }

  /** The knife the bunny holds: explicit `knife`, else the explicit loadout's, else the one you equipped. */
  private knifeChoice(): KnifeDef | null {
    return this.o.knife !== undefined ? this.o.knife : this.o.loadout !== undefined ? knifeOf(this.o.loadout) : equippedKnife();
  }

  /** Knife + finish + gloves. undefined = follow your equipped loadout. */
  setLoadout(l: CosmeticLoadout | null | undefined): void {
    this.o.loadout = l;
    this.impl.setLoadout(l === undefined ? getHeldLoadout() : l);
    this.impl.setKnife(this.knifeChoice());
  }

  /** Bunny colourway ("outfit-*" id); undefined = follow the one you equipped. */
  setOutfit(id: string | undefined): void {
    this.o.outfit = id;
    this.impl.setOutfit(id ?? getOutfit());
  }

  /**
   * Nothing in the bunny's hand: the knife collapses and a gun isn't shown (the replay viewer's held-weapon toggle).
   * setGun keeps tracking the gun meanwhile, so it comes back when this is turned off.
   */
  setHeldHidden(on: boolean): void {
    if (on === this.heldHidden) return;
    this.heldHidden = on;
    this.impl.setKnifeHidden(on);
    this.impl.setGun(on ? null : this.gun);
  }

  /** The blade in hand (null = the carrot, undefined = follow your equipped knife). */
  setKnife(k: KnifeDef | null | undefined): void {
    this.o.knife = k;
    this.impl.setKnife(this.knifeChoice());
  }

  /**
   * A map-given gun in the bunny's right hand (a core weapon id: "glock", "m3"...; viewmodel/guns), null = back to the
   * knife.
   */
  setGun(id: string | null): void {
    this.gun = id;
    if (!this.heldHidden) this.impl.setGun(id);
  }

  /**
   * The bunny's gun shows its silencer (the USP's, physics v7: WeaponReport.silencer / the room's silenced flag) or not.
   * Kept across setGun calls: a gun without a silencer ignores it.
   */
  setGunSilencer(on: boolean): void {
    this.gunSilencer = on;
    this.impl.setGunSilencer(on);
  }

  /** The ground under the bunny's feet (Source z at x, y; null = none near) for planting on slopes; null: flat. */
  setGroundProbe(p: ((x: number, y: number, z: number) => number | null) | null): void {
    this.impl.setGroundProbe(p);
  }

  /** The bunny's gun muzzle in three.js world space as of the last update (false: no gun drawn, or another model). */
  gunMuzzle(out: THREE.Vector3): boolean {
    return this.root.visible && this.impl.gunMuzzle(out);
  }

  /** Bunny: switch to the CS:S animations once they're loaded (fetched once this model is animated). */
  private loadAnims(): void {
    if (this.impl.animSource === "cs" || !this.updated || this.disposed) return;
    const ready = readyAnimRig();
    if (ready) {
      this.impl.setAnimations(ready);
      return;
    }
    if (!hasAnimRig()) return;
    loadAnimRig().then(
      (d) => {
        if (!this.disposed) this.impl.setAnimations(d);
      },
      (e) => console.warn("player model: CS:S animations unavailable, the bunny keeps its procedural animation", e),
    );
  }

  private place(): void {
    // Implementations position their own root in world space; the facade's root carries the position instead.
    this.root.position.copy(this.impl.root.position);
    this.impl.root.position.set(0, 0, 0);
  }

  /** `rim`: the ghost's rim glow colour (PlayerModelOptions.rim); a new `color` without one resets it to the tint. */
  setStyle(style: PlayerStyle, color?: THREE.ColorRepresentation, dither?: boolean, rim?: THREE.ColorRepresentation | null): void {
    this.o.style = style;
    if (color !== undefined) {
      this.o.color = color;
      this.o.rim = rim ?? null;
    } else if (rim !== undefined) this.o.rim = rim;
    if (dither !== undefined) this.o.dither = dither;
    this.impl.setStyle(style, color, dither);
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
    this.impl.setState(pose);
  }

  snap(): void {
    this.impl.snap();
  }

  /**
   * Seek-safe restart: snaps, then animates through the poses of the `seconds` before the new moment (`poseAgo(u)` = the
   * pose u seconds earlier, null to stop early, e.g. at a teleport) at 60 Hz, so the bank, legs, ears and the CS:S anim
   * state arrive where continuous playback would have them instead of easing in from rest. Call before this frame's
   * setState / update. Deterministic for the same poses.
   */
  preroll(poseAgo: (secondsAgo: number) => PlayerPose | null, seconds = 0.6): void {
    this.impl.snap();
    const step = 1 / 60;
    let first = true;
    for (let u = seconds; u > step * 0.5; u -= step) {
      const p = poseAgo(u);
      if (!p) continue;
      this.impl.setState(p);
      if (!first) this.impl.update(step);
      else (this.impl.snap(), this.impl.update(0), (first = false));
    }
    this.place();
  }

  /** Tick presentation: `a` (0-1) of the way between the last two updates (BunnyModel.present; viewer/player.ts TickStepper). */
  present(a: number, hold = false): void {
    this.impl.root.position.copy(this.root.position);
    this.impl.present(a, hold);
    this.place();
  }

  update(dt: number): void {
    if (!this.updated) {
      this.updated = true;
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
