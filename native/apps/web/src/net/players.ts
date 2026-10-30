// Other players in the room: one solid PlayerModel (player/model.ts interface only, so a different model behind the
// same interface drops in) plus a name tag each, animated from the interpolated snapshot stream (net/interp.ts).
//
// Weapons (protocol.ts EXT_WEAPONS): the gun they hold is in the bunny's hand like your own third person and replays
// (PlayerModel.setGun); their shots play positionally (their gun's fire sound, Settings -> Audio -> Other players) with
// a tracer along their view to where it meets the world here (the gun impacts' pooled tracers: nothing allocated per
// shot). Players hidden with !hide take their guns and shots with them; Hide UI (F1) leaves them (world, not UI).
//
// Joining never stalls the room (0.0.22 hotfix): a new player's bunny geometry is built in a worker as soon as they
// join (player/bunny/prebuild.ts), and their model compiles its shaders (compileAsync) before it's added to the scene.
// Until then they're simply not drawn yet (a few frames).

import * as THREE from "three";
import { emitWeaponEvent } from "../viewmodel/events";
import { WEAPON_IDS } from "../core";
import { gunForWeapon, GunPresenter } from "../viewmodel/guns/presenter";
import type { GunImpacts } from "../viewmodel/guns/impacts";
import { gunSound } from "../viewmodel/guns/sounds";
import { PlayerModel } from "../player/model";
import { compileModel, prebuildBunny } from "../player/bunny/prebuild";
import { hasAnimRig, loadAnimRig } from "../player/studio/loader";
import { DEFAULT_COSMETICS } from "../progression";
import { cleanLoadout, DEFAULT_LOADOUT } from "../loadout";
import { NameTag, TagSight, type SightTrace } from "../player/tag";
import { uiHidden } from "../ui/hide-ui";
import { formatTime } from "../timer";
import { styleDef } from "../styles";
import { blankState, RemoteTrack, type InterpState } from "./interp";
import { SpatialMover } from "../audio";
import { prefs } from "../ui/settings";
import { styleAt, TIMER_FINISHED, TIMER_RUNNING, TIMER_START, type NetMeta, type NetSample, type RosterPlayer } from "./protocol";

/** Distinct accents per slot (readable on bright and dark maps). */
const PALETTE = ["#ff7a59", "#4fa8ff", "#5ee08a", "#ffd84d", "#c477ff", "#ff5d9e", "#3fd0c9", "#ffa94d", "#9aa3ff", "#b6f06a"];
export const slotColor = (slot: number) => PALETTE[slot % PALETTE.length];

export interface RemotePlayer {
  slot: number;
  info: RosterPlayer;
  track: RemoteTrack;
  state: InterpState;
  has: boolean;
  meta: NetMeta | null;
  /** performance.now() when meta arrived (running timers extrapolate from it). */
  metaAt: number;
  model: PlayerModel | null;
  tag: NameTag | null;
  /** Seconds since the tag text was last set (redrawn at most 10x a second, like ghost tags). */
  tagAge: number;
  /** Tag occlusion (line of sight from the camera) + distance fade. */
  sight: TagSight;
  /** Positional jump / landing / footstep sounds (audio/index.ts SpatialMover), created when first heard. */
  sound: SpatialMover | null;
  /** Their look's geometry, built off the main thread (prebuild.ts); resolves when it's cached. */
  prep: Promise<void>;
  /** The model is being made (prep, then its shaders compile); it's drawn once `model` is set. */
  making: boolean;
  /** Their pose wasn't updated last frame (behind the camera, see frame()): snapped when they're posed again. */
  unposed?: boolean;
}

const tmp = new THREE.Vector3();
const camPos = new THREE.Vector3();
const camDir = new THREE.Vector3();
/** Closer than this (units) a player is always posed, wherever they are. */
const POSE_NEAR = 150;
/** A model's radius for the behind-the-camera test (units: the bunny, a hat, a gun held out). */
const POSE_RADIUS = 90;
/** Extra angle past the edge of the view before a player counts as behind (radians, ~10 degrees). */
const POSE_MARGIN = 0.18;
const D2R = Math.PI / 180;
/** Tracer length when nothing is hit (the rifles' range, research/WEAPONS.md). */
const SHOT_RANGE = 8192;

/** Current run time of a remote player from their latest meta (display only; never trusted for records). */
export function remoteTime(p: Pick<RemotePlayer, "meta" | "metaAt">, now: number): { status: number; seconds: number } | null {
  const m = p.meta;
  if (!m) return null;
  if (m.timer === TIMER_RUNNING) return { status: m.timer, seconds: m.timerTicks / 100 + Math.max(0, (now - p.metaAt) / 1000) };
  if (m.timer === TIMER_FINISHED) return { status: m.timer, seconds: m.timerTicks / 100 };
  return { status: m.timer, seconds: 0 };
}

export class RemotePlayers {
  readonly players = new Map<number, RemotePlayer>();
  /** !hide: other players invisible (client-side only). */
  hidden = false;
  /** Slot drawn in first person by the spectator camera (its model is hidden). */
  inEye: number | null = null;

  constructor(
    private scene: THREE.Scene,
    private you: () => number,
    /** World line of sight (core traceRay): tags hide behind walls unless Settings -> Ghost -> Names through walls. */
    private trace: SightTrace | null = null,
    /** The live game's gun impacts (viewmodel/guns/presenter.ts): their shots' tracers. */
    private impacts: GunImpacts | null = null,
    /** Compiles a new player's shaders before they're drawn (null: they compile on their first frame). */
    private renderer: THREE.WebGLRenderer | null = null,
  ) {}

  /** The camera of the last frame (new models compile for it). */
  private camera: THREE.Camera | null = null;

  upsert(info: RosterPlayer): RemotePlayer {
    let p = this.players.get(info.slot);
    if (p && p.info.id !== info.id) {
      this.remove(info.slot);
      p = undefined;
    }
    if (!p) {
      p = { slot: info.slot, info, track: new RemoteTrack(), state: blankState(), has: false, meta: null, metaAt: 0, model: null, tag: null, tagAge: 1, sight: new TagSight(2000, 3000), sound: null, prep: info.slot === this.you() ? Promise.resolve() : this.prebuild(info), making: false };
      this.players.set(info.slot, p);
    } else {
      p.info = info;
      // A roster refresh (e.g. they rejoined after changing their loadout): the new look's geometry is built off the
      // main thread first, then applied (from the roster as it is by then).
      const q = p;
      q.prep = this.prebuild(info).then(() => {
        if (this.players.get(q.slot) !== q || !q.model) return;
        q.model.setPlayerGlow(q.info.playerGlow ?? null);
        q.model.setLoadout(cleanLoadout(q.info.loadout) ?? { ...DEFAULT_LOADOUT });
      });
    }
    return p;
  }

  remove(slot: number): void {
    const p = this.players.get(slot);
    if (!p) return;
    p.model?.root.removeFromParent();
    p.model?.dispose();
    p.tag?.dispose();
    p.sound?.dispose();
    this.players.delete(slot);
  }

  clear(): void {
    for (const slot of [...this.players.keys()]) this.remove(slot);
  }

  /** `weapon`: the weapon in hand as of the newest sample (EXT_WEAPONS), when the room sent it with the block. */
  feed(slot: number, meta: NetMeta | null, samples: NetSample[], now: number, weapon?: number, silenced = false): void {
    const p = this.players.get(slot);
    if (!p) return;
    if (meta) {
      p.meta = meta;
      p.metaAt = now;
    }
    p.track.push(samples, now);
    if (weapon !== undefined && samples.length) p.track.pushWeapon(weapon, samples[samples.length - 1].tick, silenced);
  }

  /** The weapon in hand of a slot right now (the welcome's list). */
  setWeapon(slot: number, weapon: number): void {
    this.players.get(slot)?.track.setWeapon(weapon);
  }

  setMeta(slot: number, meta: NetMeta, now: number): void {
    const p = this.players.get(slot);
    if (p) {
      p.meta = meta;
      p.metaAt = now;
    }
  }

  private prebuild(info: RosterPlayer): Promise<void> {
    // The CS:S animations every bunny shares (fetched and parsed once): loaded now rather than by the first model's
    // first update, inside a frame.
    if (hasAnimRig()) loadAnimRig().catch(() => {});
    return prebuildBunny(info.outfit ?? DEFAULT_COSMETICS.outfit!, cleanLoadout(info.loadout) ?? { ...DEFAULT_LOADOUT });
  }

  /** True once the model is in the scene; otherwise starts making it (prebuilt geometry, compiled shaders). */
  private ensureModel(p: RemotePlayer): boolean {
    if (p.model) return true;
    if (p.making) return false;
    p.making = true;
    void p.prep
      .then(() => this.makeModel(p))
      .catch((e) => console.warn("player model failed", e));
    return false;
  }

  /** The model, once its geometry is cached (prep): built, its shaders compiled, then into the scene. */
  private async makeModel(p: RemotePlayer): Promise<void> {
    if (this.players.get(p.slot) !== p) return;
    const color = slotColor(p.slot);
    // Their bunny colourway and loadout (knife, finish with their seed, gloves) from the roster (defaults for older
    // servers), accented with their slot colour. The geometry is cached by now (prep), so this is cheap.
    const model = new PlayerModel({ style: "solid", playerGlow: p.info.playerGlow ?? null, color, outfit: p.info.outfit ?? DEFAULT_COSMETICS.outfit!, loadout: cleanLoadout(p.info.loadout) ?? { ...DEFAULT_LOADOUT } });
    if (this.renderer && this.camera) await compileModel(this.renderer, model.root, this.camera, this.scene);
    if (this.players.get(p.slot) !== p) return model.dispose();
    p.model = model;
    this.scene.add(model.root);
    p.tag = new NameTag(color);
    this.scene.add(p.tag.sprite);
  }

  /**
   * Per rendered frame: interpolate, animate, place tags. `poseBehind`: also pose players behind the camera (the
   * composer looks' sun shadows can fall into view from them). Otherwise a player behind the camera, outside the view
   * in yaw with a margin, keeps their last pose and is hidden until they're in front again: nothing of them can be
   * on screen, in a water reflection (it mirrors the view vertically) or in the refraction pass. The bone setup was
   * most of a full room's main-thread time. Their sounds go on as usual.
   */
  frame(camera: THREE.Camera, dt: number, now: number, poseBehind = true): void {
    this.camera = camera;
    camera.getWorldPosition(camPos);
    // The view's half-angle in yaw (a perspective camera; anything else poses everyone).
    const persp = camera instanceof THREE.PerspectiveCamera ? camera : null;
    const halfYaw = persp ? Math.atan(Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2) * persp.aspect) : Math.PI;
    camera.getWorldDirection(camDir);
    const fwdLen = Math.hypot(camDir.x, camDir.z);
    const me = this.you();
    const pr = prefs.get();
    const hear = pr.audio.others;
    for (const p of this.players.values()) {
      if (p.slot === me) continue;
      p.has = p.track.sample(now, p.state);
      const visible = p.has && p.info.spec === null && !this.hidden && p.state.age < 5000;
      if (!visible) {
        p.sound?.moves.reset();
        if (p.model) p.model.root.visible = false;
        if (p.tag) p.tag.sprite.visible = false;
        p.sight.reset();
        continue;
      }
      if (!this.ensureModel(p)) {
        p.sound?.moves.reset();
        p.sight.reset();
        continue;
      }
      const m = p.model!;
      const s = p.state;
      const gunAttackNow = s.attack !== 0 && s.attackWeapon >= 2;
      if (!poseBehind && persp && fwdLen > 0.2 && this.inEye !== p.slot && !gunAttackNow && !s.snapped) {
        // three (x, y, z) = Source (x, z, -y); the angle in yaw between the view and the player.
        const dx = s.pos[0] - camPos.x, dz = -s.pos[1] - camPos.z;
        const dist = Math.hypot(dx, dz);
        if (dist > POSE_NEAR) {
          const cos = (dx * camDir.x + dz * camDir.z) / (dist * fwdLen);
          const off = Math.acos(Math.max(-1, Math.min(1, cos)));
          if (off > halfYaw + Math.atan2(POSE_RADIUS, dist) + POSE_MARGIN) {
            m.root.visible = false;
            p.unposed = true;
            if (hear) (p.sound ??= new SpatialMover()).update(dt, s.pos, s.vel, s.grounded, s.crouched, s.jumped, s.snapped);
            else p.sound?.moves.reset();
            p.tag!.place(tmp.set(s.pos[0], s.pos[2] + 76, -s.pos[1]), camPos, 0);
            continue;
          }
        }
      }
      if (s.snapped || p.unposed) m.snap();
      p.unposed = false;
      // The gun in their hand (the bunny; other models keep the knife, as for your own third person).
      m.setGun(s.weapon >= 2 ? (WEAPON_IDS[s.weapon] ?? null) : null);
      m.setGunSilencer(s.weapon >= 2 && s.silenced); // the USP's silencer (0.0.12, protocol.ts EXT_SILENCED)
      // An attack with a gun is a shot (no knife swing); with the knife (or an older client: unknown) a swing.
      const gunAttack = s.attack !== 0 && s.attackWeapon >= 2;
      const swing = gunAttack ? 0 : s.attack;
      // Their gun in third person (player/bunny/gun-hold.ts): the kick and flash per shot, the reload gesture (its length
      // from the gun's own timing: the sender's core isn't ours), a shell per tube-gun event.
      const held = s.weapon >= 2 ? gunForWeapon(s.weapon) : undefined;
      const gunReload = s.reload && held ? (held.timing.shells ? { seconds: held.timing.shells.each, shell: true } : { seconds: held.timing.reload ?? 2 }) : null;
      m.setState({ position: s.pos, velocity: s.vel, yaw: s.yaw, pitch: s.pitch, crouched: s.crouched, grounded: s.grounded, jumped: s.jumped, attack: swing, inspect: s.inspect, inspectHeld: s.inspectHeld, gunShot: gunAttack && s.attack === 1, gunReload });
      if (swing) emitWeaponEvent({ type: swing === 2 ? "stab" : "slash", source: "remote", slot: p.slot, position: [s.pos[0], s.pos[1], s.pos[2]] });
      if (gunAttack && s.attack === 1) this.shot(s, hear, m);
      // Drew a gun (a switch or a pickup): its draw sound at them.
      if (s.weaponChanged && s.weapon >= 2 && hear && !s.snapped) gunSound(gunForWeapon(s.weapon) ?? null, "draw", { at: s.pos, gain: 0.7 });
      if (s.inspect) emitWeaponEvent({ type: "inspect", source: "remote", slot: p.slot, position: [s.pos[0], s.pos[1], s.pos[2]], trick: s.inspect === 1 ? 0 : undefined });
      m.update(dt);
      const eye = this.inEye === p.slot;
      // Spectating in-eye: the listener sits at their eye, so their sounds play centred, like your own.
      if (hear) (p.sound ??= new SpatialMover()).update(dt, s.pos, s.vel, s.grounded, s.crouched, s.jumped, s.snapped);
      else p.sound?.moves.reset();
      m.root.visible = !eye;
      // Tag above the head: name + current time (or the style when not running).
      const tag = p.tag!;
      tmp.set(s.pos[0], s.pos[2] + (s.crouched ? 58 : 76), -s.pos[1]);
      const dist = tmp.distanceTo(camPos);
      if (s.snapped) p.sight.reset();
      // Only players you can see (no names through walls by default), fading out far away (TagSight) and right next
      // to the camera (they'd fill the screen).
      const seen = p.sight.update(dt, camPos, tmp, this.trace, pr.tags.throughWalls);
      const fade = eye || dist < 90 || !pr.tags.players || uiHidden() ? 0 : Math.min(1, (dist - 90) / 90) * seen;
      // The tag's text is a canvas texture: redrawn and uploaded at most 10x a second (its running time changes every
      // frame), and not at all while it's invisible.
      p.tagAge += dt;
      if (fade > 0 && p.tagAge >= 0.1) {
        p.tagAge = 0;
        const rt = remoteTime(p, now);
        const style = styleAt(p.meta?.style ?? -1) ?? p.info.style;
        const styleTag = style !== "autohop" ? `${styleDef(style)?.short ?? style} · ` : "";
        const time = !rt ? "" : rt.status === TIMER_RUNNING || rt.status === TIMER_FINISHED ? styleTag + formatTime(rt.seconds) : rt.status === TIMER_START ? `${styleTag}start` : styleTag.replace(/ · $/, "");
        // Staff shield / Verified / Creator / Booster marks: from the room's roster, never from the client.
        tag.set(p.info.name, time, null, false, p.info);
      }
      tag.place(tmp, camPos, fade);
    }
  }

  /** A remote shot: their gun's sound at them and a tracer from about their muzzle along their view. */
  private shot(s: InterpState, hear: boolean, m?: PlayerModel): void {
    if (hear) GunPresenter.remoteShot(s.attackWeapon, s.pos, s.attackSilenced);
    if (!this.impacts) return;
    const cp = Math.cos(s.pitch * D2R);
    const fwd = [cp * Math.cos(s.yaw * D2R), cp * Math.sin(s.yaw * D2R), -Math.sin(s.pitch * D2R)];
    const eye = [s.pos[0], s.pos[1], s.pos[2] + (s.crouched ? 46 : 64)];
    const far = [0, 1, 2].map((k) => eye[k] + fwd[k] * SHOT_RANGE);
    const f = this.trace ? this.trace(eye, far) : 1;
    const end = [0, 1, 2].map((k) => eye[k] + fwd[k] * SHOT_RANGE * f);
    // The tracer leaves from their gun's muzzle (the bunny's posed gun as of the last frame), else about where it would be.
    const rl = Math.hypot(fwd[0], fwd[1]) || 1;
    const right = [fwd[1] / rl, -fwd[0] / rl, 0];
    const hand = s.crouched ? 30 : 46;
    const from = m?.gunMuzzle(tmp) ? [tmp.x, -tmp.z, tmp.y] : [s.pos[0] + (fwd[0] / rl) * 26 + right[0] * 7, s.pos[1] + (fwd[1] / rl) * 26 + right[1] * 7, s.pos[2] + hand];
    this.impacts.hit(end, [0, 0, 0], "concrete", { from });
  }

  /** Interpolated state of a slot this frame (spectating). */
  stateOf(slot: number): InterpState | null {
    const p = this.players.get(slot);
    return p?.has ? p.state : null;
  }

  dispose(): void {
    this.clear();
  }
}
