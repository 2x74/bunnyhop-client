// Gun viewmodel animation: what the gun, its parts and the left hand do over time, as a small pose record the viewmodel
// (guns/viewmodel.ts) turns into bones. Original motions, timed like CS:S and sized to the simulation's times (a reload
// plays over exactly the reload time the core reports).
//
// Layers:
//   base     one clip at a time: idle, draw, holster, reload, shells (shotgun start / insert / end), inspect, pump
//            (the M3's rack after a shot); a clip that interrupts another crossfades from where it was (0.12 s)
//   overlay  shot: the slide / bolt cycle and the trigger squeeze; dry fire: the trigger click and a tiny twitch
//   recoil   damped springs on the gun's pitch / push back / roll / yaw, kicked by every shot (the Glock's burst is
//            three kicks): underdamped, so the muzzle snaps up, settles and dips a touch past rest before it comes
//            back; a slower, softer fifth spring sinks the gun a little after the kick (the hands soaking it up)
//   follow   the clips' gun pose (o, a) runs through a spring sized to the gun's weight: every stop (the end of a draw,
//            the turn into a reload, the slap, an inspect's hold) carries through a little and settles instead of
//            stopping dead. Snapped on seeks, draws and gun changes (stills and audits see the clip's own pose).
// Reduced motion (prefers-reduced-motion): kicks, flourishes and draw swings are scaled down; nothing is skipped.
// Idle sway, breathing and the movement response (bhop speed, strafes, jumps, landings) are guns/motion.ts, applied to
// the whole viewmodel like the knife's feel; this file is the gun's own pose only.
//
// Pose space: `o` (forward, left, up; units) and `a` (pitch, yaw, roll; degrees) move the gun in view space about its
// pivot (the right hand's grip), on top of the gun's framing. The left hand either holds its support grip (leftW 0) or
// goes to a named target on the gun (GunDef places, leftW 1), plus a view-space offset for trips off screen.

import { bump, E, hop, track } from "../inspects/kit";
import { silencerClip, silencerCues } from "./silencer";
import type { GunDef } from "./types";

export type V3 = [number, number, number];

/** Left-hand finger presets (flat curls are blended toward these): see guns/viewmodel.ts PRESETS. */
/** "sil": the grip solved onto the silencer (guns/hold.ts solveSilencerHand). */
export type CurlPreset = "support" | "open" | "mag" | "pinch" | "shell" | "flat" | "sil";

export interface GunPose {
  o: V3;
  a: V3;
  /** Slide / bolt travel back (units), the pump's travel back (units). */
  slide: number;
  pump: number;
  /** A bolt action's turn up about the bore (deg; GunDef.bolt: the Beanpole, on the Pump bone). */
  bolt: number;
  /** 0..1 trigger squeeze (index curl), 0..1 index off the trigger (along the frame). */
  trigger: number;
  indexOff: number;
  /** Magazine: units out of the gun along GunDef.mag.out; 1 = rides in the left hand; a falling offset; hidden. */
  mag: number;
  magHand: number;
  magDrop: V3;
  /** The dropped magazine's tumble (deg about gun-local y at its pivot). */
  magSpin: number;
  magHide: boolean;
  /** The left hand's shell (Aux): shown, and 0..1 pushed from the fingers into the gun. */
  aux: number;
  auxIn: number;
  /** Right hand: 0 = on the grip, 1 = on the bolt knob (GunDef.places.bolt, riding the bolt; fingers pinch). */
  rightW: number;
  /** Left hand: 0 = support grip, 1 = `leftT`; extra view-space offset; finger preset and its weight. */
  leftW: number;
  leftT: string;
  leftOff: V3;
  leftCurl: CurlPreset;
  leftCurlW: number;
  /** Right thumb flick (fire mode toggle) 0..1. */
  thumb: number;
  /** Cottontail's tail wobble (scale), the Seed Drill's pod lid. */
  tail: number;
  /**
   * The silencer (guns/silencer.ts): shown (0 / 1); its travel out along the bore from its seat (units) and turn about
   * the bore (deg); while it's carried, its tilt about its seat (pitch + nose up, yaw + nose left; deg) and offset
   * (gun-local units).
   */
  sil: number;
  silX: number;
  silSpin: number;
  silPitch: number;
  silYaw: number;
  silOff: V3;
  /** The left hand on the can ("sil" target): its roll about the bore (deg), lifted off it radially (units). */
  handRoll: number;
  handLift: number;
  /** Left fingers opened toward the open preset, on top of the preset (re-grips). */
  leftOpen: number;
}

export function newPose(): GunPose {
  return { o: [0, 0, 0], a: [0, 0, 0], slide: 0, pump: 0, bolt: 0, magSpin: 0, trigger: 0, indexOff: 0, mag: 0, magHand: 0, magDrop: [0, 0, 0], magHide: false, aux: 0, auxIn: 0, rightW: 0, leftW: 0, leftT: "", leftOff: [0, 0, 0], leftCurl: "support", leftCurlW: 0, thumb: 0, tail: 0, sil: 0, silX: 0, silSpin: 0, silPitch: 0, silYaw: 0, silOff: [0, 0, 0], handRoll: 0, handLift: 0, leftOpen: 0 };
}

function resetPose(p: GunPose): void {
  p.o[0] = p.o[1] = p.o[2] = 0;
  p.a[0] = p.a[1] = p.a[2] = 0;
  p.slide = p.pump = p.bolt = p.magSpin = p.trigger = p.indexOff = p.mag = p.magHand = 0;
  p.magDrop[0] = p.magDrop[1] = p.magDrop[2] = 0;
  p.magHide = false;
  p.aux = p.auxIn = 0;
  p.rightW = 0;
  p.leftW = 0;
  p.leftT = "";
  p.leftOff[0] = p.leftOff[1] = p.leftOff[2] = 0;
  p.leftCurl = "support";
  p.leftCurlW = 0;
  p.thumb = 0;
  p.tail = 0;
  p.sil = p.silX = p.silSpin = p.silPitch = p.silYaw = 0;
  p.silOff[0] = p.silOff[1] = p.silOff[2] = 0;
  p.handRoll = p.handLift = p.leftOpen = 0;
}

/** Numeric blend a -> b by w into out (strings / flags from b when w > 0.5). */
function blendPose(a: GunPose, b: GunPose, w: number, out: GunPose): void {
  const l = (x: number, y: number) => x + (y - x) * w;
  for (let k = 0; k < 3; k++) {
    out.o[k] = l(a.o[k], b.o[k]);
    out.a[k] = l(a.a[k], b.a[k]);
    out.magDrop[k] = l(a.magDrop[k], b.magDrop[k]);
  }
  out.slide = l(a.slide, b.slide);
  out.pump = l(a.pump, b.pump);
  out.bolt = l(a.bolt, b.bolt);
  out.magSpin = l(a.magSpin, b.magSpin);
  out.trigger = l(a.trigger, b.trigger);
  out.indexOff = l(a.indexOff, b.indexOff);
  out.mag = l(a.mag, b.mag);
  out.magHand = w > 0.5 ? b.magHand : a.magHand;
  out.magHide = w > 0.5 ? b.magHide : a.magHide;
  out.aux = w > 0.5 ? b.aux : a.aux;
  out.auxIn = l(a.auxIn, b.auxIn);
  out.rightW = l(a.rightW, b.rightW);
  out.thumb = l(a.thumb, b.thumb);
  out.tail = l(a.tail, b.tail);
  // The can: shown from b once it's mostly there; its travel / turn / tilt blend (a turn never wraps: both ends of
  // the clip sit at a whole turn of 0).
  out.sil = w > 0.5 ? b.sil : a.sil;
  out.silX = l(a.silX, b.silX);
  out.silSpin = l(a.silSpin, b.silSpin);
  out.silPitch = l(a.silPitch, b.silPitch);
  out.silYaw = l(a.silYaw, b.silYaw);
  for (let k = 0; k < 3; k++) out.silOff[k] = l(a.silOff[k], b.silOff[k]);
  out.handRoll = b.handRoll;
  out.handLift = b.handLift;
  out.leftOpen = b.leftOpen;
  // The left hand's target can't be blended by name: the viewmodel blends its final matrix (GunAnimator.leftFade).
  out.leftW = b.leftW;
  out.leftT = b.leftT;
  for (let k = 0; k < 3; k++) out.leftOff[k] = b.leftOff[k];
  out.leftCurl = b.leftCurl;
  out.leftCurlW = b.leftCurlW;
}

/** prefers-reduced-motion (through globalThis: the API's tests typecheck this without the DOM lib). */
const reducedMotion = (): boolean => {
  const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
  return typeof mm === "function" && mm("(prefers-reduced-motion: reduce)").matches;
};

/** A sound cue inside a clip (guns/sounds.ts plays it): a GunSounds key, "draw", "dry" or "mode". */
/** silTwist / silSeat / silCrack / silOff: the silencer going on (a thread scrape per twist, the seat) and off. */
/**
 * caseMetal / caseShell: a spent brass case / shotgun hull landing at your feet (guns/fx.ts: about 0.3 to 0.5 s after
 * it's thrown, by a shot, the M3's pump or the Beanpole's bolt).
 */
export type Cue = "magOut" | "magIn" | "slide" | "pump" | "shell" | "draw" | "dry" | "mode" | "silTwist" | "silSeat" | "silCrack" | "silOff" | "caseMetal" | "caseShell";

export type BaseClip = "idle" | "draw" | "holster" | "reload" | "shellStart" | "shellInsert" | "shellEnd" | "inspect" | "pump" | "silencer";

interface Playing {
  clip: BaseClip;
  t: number;
  dur: number;
  /** Reload: the clip was empty (the slide is released / the bolt pulled at the end). */
  empty: boolean;
  /** Silencer: screwing it on (else off). */
  on?: boolean;
}


/** Per gun class choreography (times in fractions of the clip's duration unless noted). */
export class GunAnimator {
  readonly pose = newPose();
  private base: Playing = { clip: "idle", t: 0, dur: 1, empty: false };
  private from = newPose();
  private cur = newPose();
  private fade = 0;
  private fadeT = 0;
  /** The left hand's crossfade (0..1 remaining weight of its previous final matrix), read by the viewmodel. */
  leftFade = 0;
  private leftFadeDur = 0.15;
  // Overlays (seconds since; Infinity = not playing).
  private shotT = Infinity;
  private dryT = Infinity;
  private modeT = Infinity;
  // Recoil spring state: pitch, back, roll, yaw, sink (value, velocity).
  private rx = new Float64Array(5);
  private rv = new Float64Array(5);
  /** The roll kick alternates side (with some randomness), so a string of shots rocks rather than drifts. */
  private rollSide = 1;
  // Follow-through spring on the clips' gun pose (o, a): value, velocity; snapped (no history) when `followSnap`.
  private fx = new Float64Array(6);
  private fv = new Float64Array(6);
  private followSnap = true;
  /** Rounds left after the last event (the slide locks back on the last one of a pistol). */
  empty = false;
  /**
   * The silencer is on (the core's WeaponReport.silencer: it flips as the attach / detach starts, like CS:S
   * m_bSilencerOn). Shown on the gun whenever no clip says otherwise; guns without one ignore it.
   */
  silenced = false;
  private motion = 1;
  /** Shells: the current insert's index (alternates the hand's path a little). */
  private shellN = 0;
  /** Sound cues as clips pass them (guns/sounds.ts). */
  onCue: ((cue: Cue, gain: number) => void) | null = null;
  private cues: [number, Cue, number][] = [];
  private cueI = 0;

  constructor(public def: GunDef) {
    this.motion = reducedMotion() ? 0.45 : 1;
  }

  get clip(): BaseClip {
    return this.base.clip;
  }

  get clipTime(): number {
    return this.base.t;
  }

  get clipDuration(): number {
    return this.base.dur;
  }

  /** Seconds since the last shot (Infinity: none yet). */
  get sinceShot(): number {
    return this.shotT;
  }

  /** Busy with something a shot shouldn't cut visually short (draw, reload). */
  get busy(): boolean {
    const c = this.base.clip;
    return c === "draw" || c === "reload" || c === "shellStart" || c === "shellInsert" || c === "shellEnd" || c === "silencer";
  }

  setGun(def: GunDef): void {
    this.def = def;
    this.rx.fill(0);
    this.rv.fill(0);
    this.followSnap = true;
    this.shotT = this.dryT = this.modeT = Infinity;
    this.empty = false;
    this.silenced = false;
    this.play("idle", 1, true);
  }

  /** Starts a base clip (crossfades from the current pose unless `snap`). */
  play(clip: BaseClip, dur: number, snap = false, empty = false, on = false): void {
    if (!snap) {
      blendPose(this.cur, this.cur, 1, this.from);
      this.from.leftW = this.cur.leftW;
      this.fade = clip === "inspect" || clip === "idle" ? 0.22 : 0.12;
      this.fadeT = 0;
      this.leftFade = 1;
      this.leftFadeDur = this.fade + 0.05;
    } else {
      this.fade = 0;
      this.leftFade = 0;
    }
    if (clip === "shellInsert") this.shellN++;
    this.base = { clip, t: 0, dur: Math.max(0.05, dur), empty, on };
    this.cues = cuesFor(this.def, clip, this.base.dur, empty, on);
    this.cueI = 0;
  }

  draw(): void {
    this.play("draw", this.drawDur(), true);
    this.rx.fill(0);
    this.rv.fill(0);
    this.followSnap = true;
  }

  private drawDur(): number {
    return Math.min(this.def.timing.draw, 1.0) * 0.85;
  }

  holster(): void {
    this.play("holster", 0.22);
  }

  /** A shot: recoil kick, slide / bolt, trigger; the M3 queues its pump. */
  fire(): void {
    const r = this.def.recoil;
    const m = this.motion;
    const w = Math.sqrt(r.settle);
    // Impulses sized so each spring's first peak is about 0.77 of the configured kick (as before the polish), at the
    // springs' own damping (RECOIL_DAMP): the peak comes as quickly, the settle now carries past rest and back.
    this.rv[0] += r.kick * w * 1.47 * m;
    this.rv[1] += r.back * w * 1.57 * m;
    this.rollSide = -this.rollSide;
    this.rv[2] += this.rollSide * (0.55 + 0.45 * Math.random()) * r.roll * w * 1.42 * m;
    this.rv[3] += (Math.random() * 2 - 1) * r.roll * 0.5 * w * 1.42 * m;
    // The sink: a fraction of the push back, slower (the arms absorbing the shot after the muzzle has risen).
    this.rv[4] -= r.back * 0.3 * w * SINK_K * 2.6 * m;
    this.shotT = 0;
    // A shot cancels an inspect (CS:GO style) and a shotgun reload (the core interrupts it).
    const c = this.base.clip;
    // (A shot out of the silencer clip: impossible in the sim, which locks attacks through it; a replay / lag only.)
    if (c === "inspect" || c === "shellStart" || c === "shellInsert" || c === "shellEnd" || c === "holster" || c === "silencer") this.play("idle", 1);
    if (c === "draw") {
      // Firing out of a draw (not possible in the sim before it's ready, but replays / lag): finish it quickly.
      this.base.t = Math.max(this.base.t, this.base.dur * 0.85);
    }
    const pump = this.def.timing.pump;
    if (pump) this.pumpIn = pump.at;
  }
  private pumpIn = Infinity;

  dryFire(): void {
    this.dryT = 0;
    this.rv[0] += 0.6 * Math.sqrt(this.def.recoil.settle) * this.motion;
  }

  modeToggle(): void {
    this.modeT = 0;
  }

  /**
   * The silencer goes on (true) or off over `dur` seconds (the core's lock-out); `at` > 0 starts that far in (a restart
   * or a replay seek into the lock-out: no crossfade, and the sounds before it are skipped). The state flips now.
   */
  silencer(on: boolean, dur: number, at = 0): void {
    this.silenced = on;
    if (!this.def.silencer) return;
    this.pumpIn = Infinity;
    this.play("silencer", dur, at > 0, false, on);
    if (at > 0) {
      this.base.t = Math.min(at, this.base.dur);
      while (this.cueI < this.cues.length && this.cues[this.cueI][0] <= this.base.t) this.cueI++;
    }
  }

  /** Magazine reload over `dur` seconds (`empty`: the slide was locked back / the bolt needs pulling). */
  reload(dur: number, empty: boolean): void {
    this.pumpIn = Infinity;
    this.play("reload", dur, false, empty);
  }

  /** Shotgun reload: the start (gun turns, hand to the port), one shell, the end (M3: pump). */
  shellStart(dur?: number): void {
    this.pumpIn = Infinity;
    this.shellN = 0;
    this.play("shellStart", dur ?? this.def.timing.shells?.start ?? 0.5);
  }

  shellInsert(dur?: number): void {
    if (this.base.clip !== "shellStart" && this.base.clip !== "shellInsert") this.play("shellStart", 0.25, false);
    this.play("shellInsert", dur ?? this.def.timing.shells?.each ?? 0.5, this.base.clip === "shellInsert");
  }

  shellEnd(dur?: number): void {
    this.play("shellEnd", dur ?? this.def.timing.shells?.end ?? 0.6);
  }

  inspect(): void {
    if (this.base.clip !== "idle") return;
    this.play("inspect", INSPECT_DUR[this.def.id] ?? 2.4);
  }

  /** Dev / screenshots: holds `clip` at time t (s) frozen (`on`: the silencer clip screws it on). */
  seek(clip: BaseClip | "fire", t: number, dur?: number, empty = false, on = false): void {
    this.rx.fill(0);
    this.rv.fill(0);
    this.followSnap = true;
    this.shotT = this.dryT = this.modeT = Infinity;
    this.pumpIn = Infinity;
    this.fade = 0;
    this.leftFade = 0;
    if (clip === "fire") {
      this.base = { clip: "idle", t: 0, dur: 1, empty: false };
      // Replay the spring analytically by stepping.
      this.fire();
      this.pumpIn = Infinity;
      this.base = { clip: "idle", t: 0, dur: 1, empty: false };
      for (let s = 0; s < t; s += 1 / 240) this.stepSpring(1 / 240);
      this.shotT = t;
      return;
    }
    this.base = { clip, t, dur: dur ?? (clip === "draw" ? this.drawDur() : clip === "inspect" ? (INSPECT_DUR[this.def.id] ?? 2.4) : clip === "reload" ? (this.def.timing.reload ?? 2) : clip === "silencer" ? SILENCER_DUR : 0.5), empty, on };
    if (clip === "silencer") this.silenced = on;
  }

  private stepSpring(h: number): void {
    const k0 = this.def.recoil.settle;
    for (let i = 0; i < 5; i++) {
      const k = i === 4 ? k0 * SINK_K * SINK_K : k0;
      const c = 2 * Math.sqrt(k) * RECOIL_DAMP[i];
      this.rv[i] += (-k * this.rx[i] - c * this.rv[i]) * h;
      this.rx[i] += this.rv[i] * h;
    }
  }

  /**
   * The follow-through: the clip's gun pose (o, a in `p`) tracked by a spring of the gun's weight (FOLLOW), written
   * back into `p`. Snapped (no lag) right after a seek / draw / gun change.
   */
  private follow(p: GunPose, dt: number): void {
    const x = this.fx, v = this.fv;
    if (this.followSnap) {
      for (let i = 0; i < 3; i++) (x[i] = p.o[i]), (x[i + 3] = p.a[i]);
      v.fill(0);
      this.followSnap = false;
      return;
    }
    const k = FOLLOW[this.def.cls], c = 2 * Math.sqrt(k) * FOLLOW_DAMP;
    const steps = Math.ceil(dt / (1 / 240));
    const h = steps ? dt / steps : 0;
    for (let s = 0; s < steps; s++)
      for (let i = 0; i < 6; i++) {
        const target = i < 3 ? p.o[i] : p.a[i - 3];
        v[i] += (-k * (x[i] - target) - c * v[i]) * h;
        x[i] += v[i] * h;
      }
    for (let i = 0; i < 3; i++) (p.o[i] = x[i]), (p.a[i] = x[i + 3]);
  }

  /** Advances by dt and writes `pose`. */
  update(dt: number): void {
    // Recoil spring, sub-stepped (stable at any frame rate).
    const steps = Math.ceil(dt / (1 / 240));
    const h = steps ? dt / steps : 0;
    for (let s = 0; s < steps; s++) this.stepSpring(h);
    this.shotT += dt;
    this.dryT += dt;
    this.modeT += dt;
    if (this.pumpIn !== Infinity) {
      this.pumpIn -= dt;
      if (this.pumpIn <= 0) {
        this.pumpIn = Infinity;
        if (!this.busy) this.play("pump", this.def.timing.pump!.dur, this.base.clip === "idle");
      }
    }
    const b = this.base;
    b.t += dt;
    while (this.cueI < this.cues.length && b.t >= this.cues[this.cueI][0]) {
      const c = this.cues[this.cueI++];
      this.onCue?.(c[1], c[2]);
    }
    if (b.clip !== "idle" && b.t >= b.dur) {
      const next: BaseClip = b.clip === "shellStart" || b.clip === "shellInsert" ? b.clip : "idle";
      if (next === "idle") this.play("idle", 1, b.clip === "draw" || b.clip === "pump" || b.clip === "reload" || b.clip === "shellEnd" || b.clip === "silencer");
      else b.t = b.dur; // hold the last frame until the next shell / the end
    }
    resetPose(this.cur);
    if (this.silenced && this.def.silencer) this.cur.sil = 1;
    this.sampleBase(this.cur, this.base);
    this.overlays(this.cur);
    const p = this.pose;
    if (this.fade > 0 && this.fadeT < this.fade) {
      this.fadeT += dt;
      const f = Math.min(1, this.fadeT / this.fade);
      blendPose(this.from, this.cur, f * f * (3 - 2 * f), p);
    } else {
      blendPose(this.cur, this.cur, 1, p);
    }
    if (this.leftFade > 0) this.leftFade = Math.max(0, this.leftFade - dt / this.leftFadeDur);
    this.follow(p, dt);
    // Recoil on top (pitch up = negative pitch in Source angles; back = -forward; the sink is down).
    p.a[0] -= this.rx[0];
    p.o[0] -= this.rx[1];
    p.a[2] += this.rx[2];
    p.a[1] += this.rx[3];
    p.o[2] += this.rx[4];
  }

  private overlays(p: GunPose): void {
    const r = this.def.recoil;
    // Slide / bolt: snaps back at the shot, dwells at the rear a moment, runs home accelerating and bounces once off
    // its stop (locked back on an empty pistol).
    if (r.slide > 0 && this.shotT < r.slideTime * 1.6) p.slide = Math.max(p.slide, r.slide * slideCycle(this.shotT / r.slideTime));
    if (this.empty && this.def.cls === "pistol" && this.base.clip !== "reload") p.slide = Math.max(p.slide, r.slide);
    // Trigger: a quick squeeze with each shot / dry fire.
    const sq = (t: number) => (t < 0.03 ? t / 0.03 : t < 0.12 ? 1 - (t - 0.03) / 0.09 : 0);
    p.trigger = Math.max(p.trigger, sq(this.shotT), sq(this.dryT));
    if (this.dryT < 0.5) {
      // Dry fire: a twitch on the click, then the gun tips toward you a moment (nothing came out).
      p.a[0] -= bump(this.dryT, 0, 0.2) * 0.5 * this.motion;
      p.a[2] += bump(this.dryT, 0.08, 0.5) * 4 * this.motion;
      p.o[2] += bump(this.dryT, 0.08, 0.5) * 0.25;
    }
    // Secondary motion on every shot: the Cottontail's tail, the Jackrabbit's ears, the Seed Drill's pod lid jiggle.
    const id = this.def.id;
    if (this.shotT < 0.7 && (id === "usp" || id === "fiveseven" || id === "p90")) p.tail += Math.sin(this.shotT * 30) * Math.exp(-this.shotT * 7) * (id === "p90" ? 0.35 : 0.6) * this.motion;
    if (this.modeT < 0.35) p.thumb = Math.max(p.thumb, hop(this.modeT, 0, 0.35, 1));
  }

  // -------------------------------------------------------------------------------------------
  // Base clips

  private sampleBase(p: GunPose, b: Playing): void {
    const u = b.dur > 0 ? Math.min(1, b.t / b.dur) : 1;
    const m = this.motion;
    switch (b.clip) {
      case "idle":
        return;
      case "draw":
        return this.drawClip(p, u, m);
      case "holster": {
        const k = HOLSTER(u);
        p.o[2] -= 7 * k;
        p.o[1] -= 1.5 * k;
        p.a[0] += 30 * k * m;
        p.a[2] += 15 * k * m;
        p.leftW = 0;
        p.leftOff[2] = -8 * k;
        return;
      }
      case "reload":
        return this.def.cls === "smg" ? this.reloadPod(p, u, b.dur, b.empty, m) : this.reloadMag(p, u, b.dur, b.empty, m);
      case "shellStart":
        return this.shellStartClip(p, u, m);
      case "shellInsert":
        return this.shellInsertClip(p, u, m);
      case "shellEnd":
        return this.shellEndClip(p, u, b.dur, m);
      case "pump":
        return this.def.bolt ? this.boltClip(p, b.t, b.dur, m) : this.pumpClip(p, b.t, b.dur, m);
      case "inspect":
        return this.inspectClip(p, b.t, m);
      case "silencer":
        return silencerClip(this.def, p, b.t, b.dur, b.on ?? true, m);
    }
  }

  private drawClip(p: GunPose, u: number, m: number): void {
    const cls = this.def.cls;
    // Up from below the screen, turning in, with a little overshoot.
    const k = 1 - CV[0](u);
    p.o[2] -= 9 * k;
    p.o[0] -= 2.5 * k;
    p.o[1] -= 1.5 * k;
    p.a[0] += 38 * k * m;
    p.a[1] -= 8 * k * m;
    p.a[2] += 28 * k * m;
    // The heft: as it arrives the weight settles into the hands (a dip, the muzzle nodding), heavier guns more.
    const heft = bump(u, 0.58, 0.95) * (cls === "pistol" ? 0.7 : cls === "smg" ? 1 : 1.35);
    p.o[2] -= 0.7 * heft;
    p.a[0] += 2.6 * heft * m;
    // The support hand joins from below.
    const lk = 1 - CV[1](u);
    p.leftOff[2] = -9 * lk;
    p.leftOff[0] = -2 * lk;
    p.leftCurl = "open";
    p.leftCurlW = lk;
    if (this.def.id === "fiveseven") {
      // The heavy pistol racks its slide as it comes up: the left hand pinches the slide's rear and pulls.
      const g = CV[2](u);
      p.leftW = g;
      p.leftT = "rack";
      p.leftCurl = "pinch";
      p.leftCurlW = Math.max(lk, g);
      p.slide = this.def.recoil.slide * CV[3](u);
      p.leftOff[0] -= 1.3 * CV[3](u);
    } else if (cls === "shotgun") {
      // Comes up and racks once (pump / bolt).
      if (this.def.id === "m3") p.pump = 2.4 * CV[4](u);
      else {
        const g = CV[5](u);
        p.leftW = g;
        p.leftT = "rack";
        p.leftCurl = "pinch";
        p.leftCurlW = Math.max(lk, g);
        const pull = CV[6](u);
        p.slide = this.def.recoil.slide * pull;
        p.leftOff[0] -= this.def.recoil.slide * pull;
      }
      p.a[0] += bump(u, 0.7, 1) * 2 * m;
    } else if (cls === "smg") {
      // The left hand slaps the pod home as it arrives.
      p.a[2] -= bump(u, 0.62, 0.95) * 3 * m;
    }
  }

  /**
   * Pistols, magazine guns: a small dip the other way (anticipation), the turn toward the left hand, the release
   * (a flick: the old magazine slides out, falls and tumbles), the hand down off screen and back with a new one in an
   * arc, a careful start into the well and a shove home (the slap jolts the gun up; the follow-through settles it),
   * an empty gun's slide release (the right thumb, the slide slams home on the sound's hit), and the turn back with a
   * touch of overshoot. Times are fractions of the reload; the sound cues (cuesFor) sit on the same beats.
   */
  private reloadMag(p: GunPose, u: number, dur: number, empty: boolean, m: number): void {
    const s = dur;
    const tilt = RL.tilt(u);
    // Lift the gun into view, turn its magazine well toward the left hand. A long gun (rifle, sniper) only cants a
    // little and stays put: its stock is behind the grip, a pistol's turn would swing it into the camera.
    const long = this.def.cls === "rifle" || this.def.cls === "sniper";
    p.a[2] += (long ? 16 : 34) * tilt * m;
    p.a[1] += (long ? -3 : 10) * tilt * m;
    p.a[0] += (long ? 3 : 8) * tilt * m;
    p.o[0] += (long ? 0.8 : 0.5) * tilt;
    p.o[1] += (long ? 0.5 : 2.2) * tilt;
    p.o[2] += (long ? 0.6 : 2.2) * tilt;
    p.indexOff = Math.max(0, Math.min(1, tilt));
    // The release flick: a quick roll back toward the drop as the magazine lets go.
    p.a[2] -= bump(u, 0.11, 0.24) * (long ? 2.5 : 5) * m;
    // Old magazine: released at 0.12 (the magOut cue), slides out under gravity, falls and tumbles (gone by 0.42).
    const out = this.def.mag ? 3.6 : 0;
    if (u < 0.5) {
      const rel = Math.max(0, (u - 0.12) * s);
      p.mag = out * Math.min(1, E.in2(rel / 0.14));
      const fall = Math.max(0, rel - 0.1);
      p.magDrop[2] = -0.5 * 260 * fall * fall;
      p.magDrop[1] = -2.2 * fall;
      p.magSpin = -150 * fall * fall * m;
      p.magHide = u > 0.42;
    } else {
      // New magazine: in the hand from 0.5, lined up under the well by 0.6, eased in to its lips by 0.665, shoved home
      // by 0.7 (the magIn cue).
      p.magHand = 1;
      p.mag = out * RL.magIn(u);
      p.magHide = u < 0.5;
    }
    // Left hand: leaves the grip, down out of view, back with the magazine along an arc, pushes it in, slaps, returns.
    const away = RL.away(u);
    p.leftW = away;
    p.leftT = "mag";
    const pocket = RL.pocket(u);
    // The way back comes in from the side and a little behind (an arc, not a straight line up).
    const arc = u > 0.46 ? Math.sin(Math.PI * Math.min(1, pocket)) : 0;
    p.leftOff[2] = -12 * pocket;
    p.leftOff[1] = 2.5 * pocket + 1.6 * arc;
    p.leftOff[0] = -2 * pocket - 0.8 * arc;
    p.leftCurl = u < 0.48 ? "open" : "mag";
    p.leftCurlW = Math.min(away, u < 0.48 ? pocket : 1);
    // The slap: a sharp jolt of the gun up as it seats, the hand pushing through.
    const slap = RL.slap(u);
    p.a[0] -= slap * 4.5 * m;
    p.o[2] += slap * 0.55;
    p.leftOff[2] += slap * 0.35;
    // Ready: the gun is presented back (out a touch, the muzzle up, a small roll), the follow-through settles it.
    const ready = bump(u, 0.88, 1.0);
    p.o[0] += 0.35 * ready;
    p.a[0] -= 1.4 * ready * m;
    p.a[2] -= 2 * ready * m;
    if (empty) {
      // Slide release: the right thumb flicks at the slide cue (0.8); the slide slams home on the sound's hit, about
      // 0.1 s later, and the gun bucks with it.
      const hit = 0.8 + SLIDE_HIT / s;
      p.slide = this.def.recoil.slide * (u < hit - 0.03 / s ? 1 : 1 - E.in2((u - (hit - 0.03 / s)) / (0.03 / s)));
      p.thumb = hop(u, 0.77, hit + 0.04 / s, 1);
      p.a[0] -= bump(u, hit, hit + 0.12) * 2.5 * m;
      p.o[0] += bump(u, hit, hit + 0.1) * 0.25;
    }
  }

  /** The Seed Drill: the pea-pod magazine lifts off the top, a new pod is laid on, slapped down, the bolt pulled. */
  private reloadPod(p: GunPose, u: number, dur: number, empty: boolean, m: number): void {
    const tilt = RL.podTilt(u);
    p.a[2] += 22 * tilt * m;
    p.a[0] -= 10 * tilt * m;
    p.a[1] += 6 * tilt * m;
    // Pushed out and kept low: the left hand works on top of the gun, and a raised gun brought that forearm up across
    // the middle of the screen.
    p.o[0] += 2.5 * tilt;
    p.o[1] += 0.8 * tilt;
    p.o[2] -= 0.6 * tilt;
    p.indexOff = Math.max(0, Math.min(1, tilt));
    const away = CV[7](u);
    p.leftW = away;
    p.leftT = "mag";
    p.leftCurl = "mag";
    p.leftCurlW = away;
    if (u < 0.5) {
      // Grab the old pod (0.16-0.22), lift it off and away (gone by 0.42).
      const lift = CV[8](u);
      p.mag = 2.5 * lift;
      p.magHand = 1;
      const pocket = CV[9](u);
      p.leftOff[2] = -11 * pocket;
      p.leftOff[1] = 3 * pocket;
      p.magHide = u > 0.42;
    } else {
      // The new pod rides the hand until it's seated (0.7), then stays on the gun.
      p.magHand = u < 0.7 ? 1 : 0;
      const pocket = 1 - CV[10](u);
      p.leftOff[2] = -11 * pocket;
      p.leftOff[1] = 3 * pocket;
      p.mag = 2.5 * (1 - CV[11](u));
      p.magHide = u < 0.5;
      p.a[0] -= bump(u, 0.69, 0.82) * 3 * m;
    }
    // Ready beat at the end, as for the magazine guns.
    const ready = bump(u, 0.9, 1.0);
    p.o[0] += 0.35 * ready;
    p.a[0] -= 1.2 * ready * m;
    // Charging handle (always on the Seed Drill: its bolt is cocked after a fresh pod).
    const pull = CV[12](u);
    if (u > 0.7) {
      p.leftT = "rack";
      p.leftCurl = "pinch";
      p.slide = this.def.recoil.slide > 0 ? 1.4 * pull : 0;
      p.leftOff[0] = -1.4 * pull;
    }
    void empty;
  }

  /** Shotguns: the gun lifts and turns its loading port toward you, the hand goes under the receiver. */
  private portPose(p: GunPose, k: number, m: number): void {
    p.a[2] += 30 * k * m;
    p.a[0] -= 9 * k * m;
    p.a[1] += 4 * k * m;
    p.o[2] += 1.6 * k;
    p.o[1] += 1.6 * k;
    p.o[0] -= 0.6 * k;
    p.indexOff = k;
  }

  private shellStartClip(p: GunPose, u: number, m: number): void {
    const k = E.io(u);
    this.portPose(p, k, m);
    p.leftW = k;
    p.leftT = "port";
    p.leftCurl = "open";
    p.leftCurlW = k;
    p.leftOff[2] = -3 * hop(u, 0, 1, 1);
  }

  private shellInsertClip(p: GunPose, u: number, m: number): void {
    this.portPose(p, 1, m);
    p.leftW = 1;
    p.leftT = "port";
    // Down for a shell (0-0.35), back to the port (0.35-0.62), thumb it in (0.62-0.85), relax.
    const down = CV[13](u);
    const side = this.shellN % 2 ? 0.6 : -0.4;
    p.leftOff[2] = -9 * down;
    p.leftOff[1] = (2 + side) * down;
    p.leftOff[0] = -1.5 * down;
    p.aux = u > 0.2 && u < 0.86 ? 1 : 0;
    p.auxIn = CV[14](u);
    p.leftCurl = "shell";
    p.leftCurlW = 1;
    // The push: the hand moves along the port a little, the gun nods.
    p.leftOff[0] += 0.9 * CV[15](u);
    p.a[0] -= bump(u, 0.78, 1) * 1.5 * m;
  }

  private shellEndClip(p: GunPose, u: number, dur: number, m: number): void {
    const k = 1 - CV[16](u);
    this.portPose(p, k, m);
    p.leftW = k;
    p.leftT = "port";
    p.leftCurl = "open";
    p.leftCurlW = k;
    if (this.def.id === "m3") {
      // Back to the pump and rack it.
      p.pump = 2.4 * CV[17](u);
      p.a[0] -= bump(u, 0.7, 1) * 2 * m;
    } else {
      // The auto shotgun: a smack on the bolt release.
      p.slide = this.def.recoil.slide * CV[18](u) * (u > 0.45 ? 1 : 0);
      p.a[2] -= bump(u, 0.58, 0.9) * 2.5 * m;
    }
    void dur;
  }

  /** The M3's pump after a shot (seconds): the fore-end back and forward, the gun dips and rolls into it. */
  private pumpClip(p: GunPose, t: number, dur: number, m: number): void {
    const u = t / dur;
    p.pump = 2.4 * CV[19](u);
    const k = hop(u, 0, 1, 1);
    p.a[0] += 3 * k * m;
    p.a[2] += 5 * k * m;
    p.o[2] -= 0.4 * k;
  }

  /**
   * A bolt action after a shot (GunDef.bolt: the Beanpole; seconds, sized to BOLT_DUR and stretched to `dur`): the
   * firing hand leaves the grip for the knob on the right (the support hand keeps the gun up), turns the handle up,
   * throws the bolt back (the case flies out), runs it home, turns it down and goes back to the grip; the gun rolls a
   * little toward it, each stroke tugging it (back with the pull, forward with the push). The bolt cue (cuesFor) lands
   * on the lift, its closing click on the turn down. (A support hand on a left-side knob, tried first, put its sleeve
   * in front of the lens: the knob sits right under the eye. The right hand comes from below the gun, off screen.)
   */
  private boltClip(p: GunPose, t: number, dur: number, m: number): void {
    const u = (t / dur) * BOLT_DUR;
    const g = BOLT.hand(u);
    p.rightW = g;
    p.indexOff = Math.max(p.indexOff, g);
    p.bolt = BOLT_TURN * BOLT.turn(u);
    p.pump = BOLT_TRAVEL * BOLT.travel(u);
    const k = BOLT.lean(u);
    p.a[2] += 9 * k * m;
    p.a[0] += 2.5 * k * m;
    p.o[2] -= 0.4 * k;
    p.o[0] -= (bump(u, 0.24, 0.42) - bump(u, 0.4, 0.56)) * 0.45;
    p.a[0] -= (bump(u, 0.24, 0.4) * 1.2 + bump(u, 0.49, 0.65) * 1.6) * m;
    p.a[2] += bump(u, 0.18, 0.3) * 2 * m;
  }

  // -------------------------------------------------------------------------------------------
  // Inspects (one per gun; short and tasteful). t in seconds.

  private inspectClip(p: GunPose, t: number, m: number): void {
    const id = this.def.id;
    const ins = INSPECTS[id];
    if (ins) ins(p, t, m);
  }
}

/** Sound cues of a clip: [seconds, cue, gain]. */
function cuesFor(def: GunDef | null, clip: BaseClip, dur: number, empty: boolean, on = false): [number, Cue, number][] {
  if (!def) return [];
  const id = def.id;
  const at = (f: number) => f * dur;
  switch (clip) {
    case "draw": {
      const c: [number, Cue, number][] = [[0, "draw", 1]];
      if (id === "fiveseven") c.push([at(0.6), "slide", 0.8]);
      else if (id === "m3") c.push([at(0.5), "pump", 0.9]);
      else if (id === "xm1014") c.push([at(0.7), "slide", 0.8]);
      else if (id === "p90") c.push([at(0.7), "magIn", 0.45]);
      return c;
    }
    case "reload":
      if (def.cls === "smg") return [[at(0.22), "magOut", 1], [at(0.68), "magIn", 1], [at(0.8), "slide", 0.9]];
      return [[at(0.12), "magOut", 1], [at(0.7), "magIn", 1], ...(empty ? [[at(0.8), "slide", 1] as [number, Cue, number]] : [])];
    case "shellInsert":
      return [[at(0.75), "shell", 1]];
    case "shellEnd":
      return id === "m3" ? [[at(0.38), "pump", 1]] : [[at(0.55), "slide", 0.9]];
    case "pump":
      // A bolt action: the cue on the lift (the clip's own time, stretched like the clip).
      return def.bolt ? [[(BOLT_LIFT * dur) / BOLT_DUR, "pump", 1]] : [[0, "pump", 1]];
    case "silencer":
      return def.silencer ? silencerCues(dur, on) : [];
    case "inspect":
      return (
        ({
          glock: [[1.9, "mode", 0.35]],
          usp: [[1.2, "dry", 0.3]],
          fiveseven: [[0.45, "slide", 0.45], [0.95, "slide", 0.45]],
          m3: [[1.88, "pump", 0.55]],
          xm1014: [[1.1, "mode", 0.3], [1.4, "mode", 0.3]],
          p90: [[1.05, "mode", 0.3], [1.3, "mode", 0.3], [1.55, "mode", 0.3]],
          ak47: [[1.05, "mode", 0.35], [1.35, "mode", 0.35]],
          awp: [[1.95, "pump", 0.55]],
        }) as Record<string, [number, Cue, number][]>
      )[id] ?? [];
    default:
      return [];
  }
}

/** The silencer clip's default length (s): CS:S add_silencer / detach_silencer (the core's lock-out is its tick count). */
const SILENCER_DUR = 114 / 37;

/**
 * The clips' and inspects' curves (keys in fractions of a clip or in seconds), built once at load: nothing is
 * allocated per frame (CV[n] is the n-th curve the code uses; identical key lists share one).
 */
const CV: ((t: number) => number)[] = [
  /* 0 */ track([[0, 0], [0.62, 1, E.out], [0.8, 1.04, E.io], [1, 1, E.io]]),
  /* 1 */ track([[0, 0], [0.3, 0], [0.75, 1, E.out]]),
  /* 2 */ track([[0.35, 0], [0.48, 1, E.out], [0.72, 1], [0.84, 0, E.io]]),
  /* 3 */ track([[0.5, 0], [0.6, 1, E.out], [0.66, 1], [0.7, 0, E.in2]]),
  /* 4 */ track([[0.52, 0], [0.64, 1, E.out], [0.72, 1], [0.97, 0, E.io]]),
  /* 5 */ track([[0.5, 0], [0.6, 1, E.out], [0.82, 1], [0.92, 0, E.io]]),
  /* 6 */ track([[0.62, 0], [0.7, 1, E.out], [0.74, 1], [0.78, 0, E.in2]]),
  /* 7 */ track([[0.06, 0], [0.16, 1, E.io], [0.88, 1], [0.98, 0, E.io]]),
  /* 8 */ track([[0.2, 0], [0.3, 1, E.in2]]),
  /* 9 */ track([[0.28, 0], [0.42, 1, E.in2]]),
  /* 10 */ track([[0.46, 0], [0.6, 1, E.out]]),
  /* 11 */ track([[0.6, 0], [0.7, 1, E.in2]]),
  /* 12 */ track([[0.74, 0], [0.8, 1, E.out], [0.83, 1], [0.86, 0, E.in2]]),
  /* 13 */ track([[0, 0], [0.18, 1, E.in2], [0.3, 1], [0.55, 0, E.out]]),
  /* 14 */ track([[0.55, 0], [0.82, 1, E.io]]),
  /* 15 */ track([[0.58, 0], [0.8, 1, E.io], [1, 0, E.io]]),
  /* 16 */ track([[0, 0], [0.55, 1, E.io]]),
  /* 17 */ track([[0.42, 0], [0.55, 1, E.out], [0.62, 1], [0.95, 0, E.io]]),
  /* 18 */ track([[0.55, 1], [0.6, 0, E.in2]]),
  /* 19 */ track([[0, 0], [0.25, 1, E.out], [0.45, 1], [0.84, 0, E.io]]),
  /* 20 */ track([[0, 0], [0.45, -62, E.io], [1.1, -55], [1.45, 18, E.io], [1.85, 14], [2.15, 0, E.io]]),
  /* 21 */ track([[0, 0], [0.45, 18, E.io], [1.1, 16], [1.45, 6, E.io], [2.15, 0, E.io]]),
  /* 22 */ track([[0, 0], [0.45, -8, E.io], [1.45, -14, E.io], [2.15, 0, E.io]]),
  /* 23 */ track([[0, 0], [0.45, 1, E.io], [1.85, 1], [2.15, 0, E.io]]),
  /* 24 */ track([[0, 0], [0.5, -48, E.io], [1.7, -44], [2.1, 0, E.io]]),
  /* 25 */ track([[0, 0], [0.5, 20, E.io], [1.7, 18], [2.1, 0, E.io]]),
  /* 26 */ track([[0, 0], [0.5, -6, E.io], [2.1, 0, E.io]]),
  /* 27 */ track([[0, 0], [0.5, 1, E.io], [1.8, 1], [2.2, 0, E.io]]),
  /* 28 */ track([[0.05, 0], [0.4, 1, E.io], [0.75, 1], [1.05, 2, E.io], [1.25, 2], [1.55, 1, E.io], [2.05, 1], [2.4, 0, E.io]]),
  /* 29 */ track([[0.05, 0], [0.35, 1, E.io], [1.0, 1], [1.25, 0, E.io]]),
  /* 30 */ track([[0.4, 0], [0.6, 1, E.io], [0.85, 1], [1.0, 0, E.io]]),
  /* 31 */ track([[0, 0], [0.35, -18, E.io], [1.1, -18], [1.6, -58, E.io], [2.1, -52], [2.5, 0, E.io]]),
  /* 32 */ track([[0, 0], [0.35, 8, E.io], [1.6, 18, E.io], [2.5, 0, E.io]]),
  /* 33 */ track([[0, 0], [0.35, -10, E.io], [1.6, -6, E.io], [2.5, 0, E.io]]),
  /* 34 */ track([[0, 0], [0.35, 1, E.io], [2.2, 1], [2.55, 0, E.io]]),
  /* 35 */ track([[0, 0], [0.5, 1, E.io], [2.2, 1], [2.75, 0, E.io]]),
  /* 36 */ track([[0, 0], [0.5, -35, E.io], [1.3, -30], [1.75, 12, E.io], [2.2, 8], [2.75, 0, E.io]]),
  /* 37 */ track([[1.85, 0], [2.0, 1, E.out], [2.1, 1], [2.3, 0, E.io]]),
  /* 38 */ track([[0, 0], [0.5, 1, E.io], [2.1, 1], [2.6, 0, E.io]]),
  /* 39 */ track([[0, 0], [0.5, -26, E.io], [1.6, -22], [2.6, 0, E.io]]),
  /* 40 */ track([[0, 0], [0.5, 1, E.io], [2.2, 1], [2.7, 0, E.io]]),
  /* 41 */ track([[0.55, 0], [0.85, 1, E.io], [1.95, 1], [2.25, 0, E.io]]),
  /* 42 */ track([[0, 0], [0.5, -30, E.io], [1.7, -26], [2.6, 0, E.io]]),
  /* 43 */ track([[0.55, 0], [0.85, 1, E.io], [1.7, 1], [2.05, 0, E.io]]),
  /* 44 */ track([[0, 0], [0.5, 1, E.io], [2.25, 1], [2.8, 0, E.io]]),
  /* 45 */ track([[0, 0], [0.5, -32, E.io], [1.4, -28], [1.8, 10, E.io], [2.25, 6], [2.8, 0, E.io]]),
];

/** The holster: a small lift (anticipation), then down and away accelerating. */
const HOLSTER = track([[0, 0], [0.22, -0.07, E.io], [1, 1, E.in2]]);

/** Recoil springs' damping ratio: pitch, back, roll, yaw, sink (< 1: each overshoots its rest a little). */
const RECOIL_DAMP = [0.5, 0.62, 0.55, 0.6, 0.8];
/** The sink spring's frequency relative to the recoil's (slower: it follows the kick). */
const SINK_K = 0.55;

/** Follow-through spring stiffness per gun class (heavier = slower, carries further) and its damping ratio. */
const FOLLOW: Record<GunDef["cls"], number> = { pistol: 520, smg: 380, shotgun: 300, rifle: 320, sniper: 250 };
const FOLLOW_DAMP = 0.62;

/**
 * The slide / bolt over one cycle (u = time / slideTime): snaps back (0 .. 0.22), dwells (.. 0.32), runs home
 * accelerating (.. 0.82), bounces off its stop (.. 1.15).
 */
function slideCycle(u: number): number {
  if (u <= 0) return 0;
  if (u < 0.22) return E.out(u / 0.22);
  if (u < 0.32) return 1;
  if (u < 0.82) return 1 - E.in2((u - 0.32) / 0.5);
  if (u < 1.15) return 0.07 * Math.sin((Math.PI * (u - 0.82)) / 0.33);
  return 0;
}

/** The empty reload's slide hit: the slide cue's sound peaks about this long after it starts (gun_slide). */
const SLIDE_HIT = 0.1;

/** The magazine reload's curves (fractions of the reload), built once. */
const RL = {
  // A small dip the other way first, the turn, held, back with a touch of overshoot.
  tilt: track([[0, 0], [0.05, -0.12, E.io], [0.17, 1, E.out2], [0.8, 1], [0.93, -0.07, E.io], [1, 0, E.io]]),
  podTilt: track([[0, 0], [0.04, -0.1, E.io], [0.13, 1, E.out2], [0.84, 1], [0.95, -0.06, E.io], [1, 0, E.io]]),
  magIn: track([[0.5, 0.9], [0.6, 0.9], [0.665, 0.5, E.io], [0.7, 0, E.in2]]),
  away: track([[0.1, 0], [0.18, 1, E.io], [0.86, 1], [0.97, 0, E.io]]),
  pocket: track([[0.16, 0], [0.32, 1, E.in2], [0.46, 1], [0.6, 0, E.out]]),
  // Sharp rise as the magazine seats (0.7), slower fall.
  slap: track([[0.7, 0], [0.718, 1, E.out], [0.86, 0, E.io]]),
};

/** The Beanpole's bolt throw (seconds at its natural length BOLT_DUR; GunAnimator.boltClip stretches it). */
const BOLT_DUR = 0.95;
const BOLT_LIFT = 0.18;
const BOLT_TURN = 62;
const BOLT_TRAVEL = 2.3;
const BOLT = {
  hand: track([[0, 0], [0.16, 1, E.io], [0.58, 1], [0.8, 0, E.io]]),
  turn: track([[0.18, 0], [0.24, 1, E.out], [0.5, 1], [0.56, 0, E.in2]]),
  travel: track([[0.24, 0], [0.31, 1, E.out], [0.4, 1], [0.5, 0, E.in2]]),
  lean: track([[0, 0], [0.2, 1, E.io], [0.58, 1], [0.9, 0, E.io]]),
};

/** The Beanpole inspect's chamber check (seconds). */
const AWP_INSPECT = {
  hand: track([[1.55, 0], [1.78, 1, E.io], [2.42, 1], [2.68, 0, E.io]]),
  turn: track([[1.8, 0], [1.88, 1, E.out], [2.36, 1], [2.44, 0, E.in2]]),
  travel: track([[1.9, 0], [2.05, 1, E.out], [2.15, 1], [2.35, 0, E.io]]),
};

/** Inspect lengths (s). */
const INSPECT_DUR: Partial<Record<GunDef["id"], number>> = { glock: 2.3, usp: 2.6, fiveseven: 2.6, m3: 2.8, xm1014: 2.6, p90: 2.7, ak47: 2.6, awp: 2.8 };

type InspectFn = (p: GunPose, t: number, m: number) => void;

/** The left hand lets go and drops a little (pistols turn one-handed). */
function freeLeft(p: GunPose, t: number, t0: number, t1: number, depth = 6): number {
  // In over 0.25 s, held, out over the last 0.3 s (computed directly: no curve built per frame).
  const k = t <= t0 || t >= t1 ? 0 : t < t0 + 0.25 ? E.io((t - t0) / 0.25) : t > t1 - 0.3 ? 1 - E.io((t - (t1 - 0.3)) / 0.3) : 1;
  p.leftOff[2] = -depth * k;
  p.leftOff[1] = 1.5 * k;
  p.leftCurl = "open";
  p.leftCurlW = k;
  return k;
}

const INSPECTS: Partial<Record<GunDef["id"], InspectFn>> = {
  // Thumper: turns to show its left flank and the three burst dots, then the top, and thumps twice as it settles.
  glock: (p, t, m) => {
    freeLeft(p, t, 0.05, 2.05);
    const roll = CV[20](t);
    const yaw = CV[21](t);
    p.a[2] += roll * m;
    p.a[1] += yaw * m;
    p.a[0] += CV[22](t) * m;
    p.o[1] += 2.2 * CV[23](t);
    p.o[2] += 1.0 * CV[23](t);
    // Three thumps (its burst, a rabbit's foot on the ground).
    p.o[2] -= (bump(t, 1.84, 1.96) + bump(t, 1.96, 2.08) + bump(t, 2.08, 2.22)) * 0.5 * m;
  },
  // Cottontail: shows its left side, the left hand comes up and flicks the tail, which wobbles.
  usp: (p, t, m) => {
    const roll = CV[24](t);
    p.a[2] += roll * m;
    p.a[1] += CV[25](t) * m;
    p.a[0] += CV[26](t) * m;
    p.o[1] += 2.4 * CV[27](t);
    p.o[2] += 0.8 * CV[27](t);
    const k = CV[28](t);
    // 0..1: hand off, 1..2: up at the tail.
    p.leftOff[2] = -6 * Math.min(1, k);
    p.leftCurl = "open";
    p.leftCurlW = Math.min(1, k);
    if (k > 1) {
      p.leftW = k - 1;
      p.leftT = "tail";
      p.leftCurl = "flat";
      p.leftCurlW = 1;
      p.leftOff[2] = -6 * (2 - k);
    }
    // The flick at ~1.2 s: the tail squashes and wobbles.
    p.tail = t > 1.2 ? Math.sin((t - 1.2) * 28) * Math.exp(-(t - 1.2) * 4.5) : 0;
  },
  // Jackrabbit: a press check (the left hand eases the slide back to peek at the chamber), then a slow turn to show
  // the ears.
  fiveseven: (p, t, m) => {
    const pc = CV[29](t);
    p.leftW = pc;
    p.leftT = "rack";
    p.leftCurl = "pinch";
    p.leftCurlW = pc;
    const s = CV[30](t);
    p.slide = 0.8 * s;
    p.leftOff[0] = -0.8 * s;
    p.a[2] += CV[31](t) * m;
    p.a[1] += CV[32](t) * m;
    p.a[0] += CV[33](t) * m;
    p.o[1] += 2 * CV[34](t);
    p.o[2] += 1.0 * CV[34](t);
    if (t > 1.15) freeLeft(p, t, 1.15, 2.55);
    // The ears: a double twitch while they're shown, a flop as it turns back.
    if (t > 1.65) p.tail += Math.sin((t - 1.65) * 38) * Math.exp(-(t - 1.65) * 6) * 0.8 + (t > 1.95 ? Math.sin((t - 1.95) * 38) * Math.exp(-(t - 1.95) * 6) * 0.6 : 0);
    if (t > 2.25) p.tail += Math.sin((t - 2.25) * 18) * Math.exp(-(t - 2.25) * 5) * 0.5;
  },
  // Broadfork: lifts and rolls to show its flank, the left hand half-racks the pump ("chk"), and back.
  m3: (p, t, m) => {
    const k = CV[35](t);
    p.a[2] += CV[36](t) * m;
    p.a[0] -= 10 * k * m;
    p.a[1] += 10 * k * m;
    p.o[1] += 2.5 * k;
    p.o[2] += 1.5 * k;
    p.o[0] -= 1 * k;
    p.pump = 1.3 * CV[37](t);
  },
  // Hedgerow: turns to show the receiver and its leaf vents, the support hand gives the handguard two pats. (No hand
  // on the bolt: reaching over the receiver brought the forearm right up to the camera.)
  xm1014: (p, t, m) => {
    const k = CV[38](t);
    p.a[2] += CV[39](t) * m;
    p.a[0] -= 6 * k * m;
    p.a[1] += 8 * k * m;
    p.o[1] += 1.5 * k;
    p.o[2] += 1.3 * k;
    const pat = bump(t, 1.0, 1.2) + bump(t, 1.3, 1.5);
    p.leftOff[2] = -0.6 * pat;
    p.leftCurl = "open";
    p.leftCurlW = 0.5 * pat;
    p.a[0] += pat * 0.6 * m;
  },
  // Seed Drill: tips toward you to show the pea pod on top, the left fingers drum on it three times.
  p90: (p, t, m) => {
    const k = CV[40](t);
    p.a[2] += 38 * k * m;
    p.a[0] -= 16 * k * m;
    p.a[1] += 12 * k * m;
    // Out and low, like the reload: the drumming hand's forearm stays short on screen.
    p.o[0] += 2.5 * k;
    p.o[1] += 1.2 * k;
    p.o[2] -= 0.4 * k;
    const g = CV[41](t);
    p.leftW = g;
    p.leftT = "mag";
    p.leftCurl = "flat";
    p.leftCurlW = g;
    p.leftOff[2] = 0.5 * (bump(t, 1.0, 1.2) + bump(t, 1.25, 1.45) + bump(t, 1.5, 1.7));
    p.tail = bump(t, 1.05, 1.25) + bump(t, 1.3, 1.5) + bump(t, 1.55, 1.75);
  },
  // Furrow: rolls to show its flank and the carrot magazine; the left hand gives the carrot two pats.
  ak47: (p, t, m) => {
    const k = CV[38](t);
    p.a[2] += CV[42](t) * m;
    p.a[0] -= 6 * k * m;
    p.a[1] += 10 * k * m;
    p.o[1] += 2 * k;
    p.o[2] += 1.3 * k;
    const g = CV[43](t);
    p.leftW = g;
    p.leftT = "mag";
    p.leftCurl = "flat";
    p.leftCurlW = g;
    p.leftOff[0] = -0.5 * (bump(t, 0.95, 1.15) + bump(t, 1.25, 1.45));
    p.a[0] += (bump(t, 1.02, 1.2) + bump(t, 1.32, 1.5)) * 0.8 * m;
  },
  // Beanpole: lifts and rolls to show the scope, then the bolt turns up, eases back halfway (a chamber check), runs home
// and turns down.
  awp: (p, t, m) => {
    const k = CV[44](t);
    p.a[2] += CV[45](t) * m;
    p.a[0] -= 8 * k * m;
    p.a[1] += 10 * k * m;
    p.o[1] += 2.5 * k;
    p.o[2] += 1.4 * k;
    p.o[0] -= 1 * k;
    // The chamber check: the firing hand on the knob turns the bolt up, eases it half back, home, down.
    const g = AWP_INSPECT.hand(t);
    p.rightW = g;
    p.indexOff = Math.max(p.indexOff, g);
    p.bolt = BOLT_TURN * AWP_INSPECT.turn(t);
    p.pump = 1.2 * AWP_INSPECT.travel(t);
  },
};
