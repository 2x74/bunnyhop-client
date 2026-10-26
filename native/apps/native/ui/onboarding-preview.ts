// Native presentation transport for the web intro's scalar acting timeline. No Three/WebGL is loaded by the menu.
import {requestPreview,cancelPreview,nativePreviewAvailable,type OnboardingPose} from "./loadout-preview";
import {getOutfit,getLoadout} from "../../web/src/player/cosmetics";
import {packLoadout} from "../../web/src/loadout";
import type {PlayerPose} from "../../web/src/player/model";
import {sfx} from "./audio";
import "./onboarding-preview.css";
type BunnyActing=OnboardingPose["acting"];
const GRAV = 800;
/** A hop's height (feet, units): the game's is 57; this keeps the ears and the tag in frame. 0.65 s in the air. */
const HOP_H = 42;
/** Phases of a hop (s): the anticipation crouch before the first, the ground contact between bhops, the last landing. */
const PREP = 0.13;
const CONTACT = 0.075;
const SETTLE = 0.2;
/** Horizontal speed while bhopping (u/s, for the animation: the feet run along it, the ears stream back). */
const BHOP_SPEED = 290;
/** How far the view sweeps each way per strafe (degrees). */
const STRAFE_YAW = 22;
/** Facing: three quarters to the camera, turned toward the question on the right (Source yaw, degrees). */
const BASE_YAW = -58;
const TAG_Z = 78;
/** Where the head is (feet up, units), for looking at things. */
const HEAD_Z = 66;
const D2R = Math.PI / 180;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const damp = (cur: number, to: number, rate: number, dt: number) => cur + (to - cur) * (1 - Math.exp(-rate * dt));
const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);

export interface BunnyStage {
  el: HTMLCanvasElement;
  /** Your name over its head (marks: your staff / verified / supporter marks, as other players see them). */
  setName(name: string, marks?: unknown): void;
  /** The tag's dot follows your colourway. */
  setColor(css: string): void;
  /** A keystroke in the name: a small nod. */
  typed(): void;
  /** The name has a problem (true) or not: a held, puzzled head tilt. */
  puzzled(on: boolean): void;
  /** The name step: bhop on the spot, strafing (true), or stop after this hop (false). */
  strafe(on: boolean): void;
  /** The name was accepted: ears up, a jump out of the top of the frame, and back in a moment later (a drop). */
  fly(): void;
  /** A colourway was picked: a show-off (which one depends on the swatch). */
  show(id: string): void;
  /** The sensitivity changed: a 360 on a hop, quicker for a lower cm per turn. */
  spin(cm: number): void;
  /** A turn toward the side the next question comes from (1 = forward / right, -1 = back), and a look at it. */
  pivot(dir: 1 | -1): void;
  /** Crouch, then jump at the camera; resolves at the apex (onApex) and when it's off screen. */
  launch(onApex?: () => void): Promise<void>;
  dispose(): void;
}

type Fidget = "trick" | "hops" | "curious" | "lookback" | "shake";
/** Where it looks when the pointer rests: you (the camera), the question (to the right), or somewhere (yaw, pitch). */
type Attend = "you" | "question" | "pointer" | { yaw: number; pitch: number };

export function bunnyStage(host:HTMLElement,o:{potato?:boolean}={}):BunnyStage|null {
  if(!nativePreviewAvailable())return null;
  const canvas=document.createElement("canvas");canvas.className="native-intro-canvas";canvas.setAttribute("aria-label","Your bunny reacts to the intro");canvas.setAttribute("role","img");
  const tag=document.createElement("span");tag.className="native-intro-tag";const shadow=document.createElement("span");shadow.className="native-intro-shadow";shadow.setAttribute("aria-hidden","true");host.append(shadow,canvas,tag);const potato=!!o.potato;
  let request=0,lastSent=-1,received=0,inspectCount=0,spinDegrees=0;
  const render=()=>{
    if(disposed||request||document.hidden||!canvas.isConnected||t-lastSent<1/30)return;lastSent=t;
    const stage:OnboardingPose={position:Array.from(pose.position),velocity:Array.from(pose.velocity??[0,0,0]),yaw:pose.yaw,pitch:pose.pitch,crouched:pose.crouched,grounded:pose.grounded,jumped:!!pose.jumped,acting:{...act},squash:sq,spin:spinDegrees,clock:t};
    request=requestPreview({loadout:packLoadout(getLoadout()),outfit:getOutfit(),ghost:"ghost-gold",playerGlow:null,view:"onboarding",yaw:0,pitch:0,inspect:inspectCount,held:false,width:Math.max(384,Math.min(768,Math.round(host.clientWidth*Math.min(devicePixelRatio||1,1.25)))),height:Math.max(240,Math.min(600,Math.round(host.clientHeight*Math.min(devicePixelRatio||1,1.25)))),stage},png=>{
      request=0;if(disposed||!png)return;const frame=++received,image=new Image();image.onload=()=>{if(disposed||frame!==received)return;canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;canvas.getContext("2d")?.drawImage(image,0,0);};image.src=png;
    });
  };
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let raf = 0;
  let t = 0;
  let last = performance.now();
  let disposed = false;

  // ---- timeline: callbacks on the stage's clock (cleared by launch)
  let timers: { at: number; fn: () => void }[] = [];
  const after = (s: number, fn: () => void) => void timers.push({ at: t + s, fn });

  // ---- body: height and its fall, take-offs and landings
  let z = still ? 0 : 150; // the entrance drops it in from above the frame
  let vz = 0;
  let jumpedNow = false;
  let entered = still;
  /**
   * Where it is in a hop (see the header). "stand": on the ground, not hopping; "air": in the air (a hop, the
   * entrance's drop, the fly out); prep / contact / settle: crouching on the ground before, between and after hops.
   */
  type Phase = "stand" | "prep" | "air" | "contact" | "settle";
  let phase: Phase = still ? "stand" : "air";
  let phaseT = 0;
  const setPhase = (p: Phase) => ((phase = p), (phaseT = 0));
  /** Hops still to go after the current one (strafe() keeps it topped up), and how they go. */
  let hopsLeft = 0;
  /** This run of hops air-strafes (bhop): the side of the current hop (+1: turning to its left). */
  let strafing = false;
  let strafeSide = 1;
  /** The name step: bhop until strafe(false). */
  let strafeOn = false;
  let strafeAt = 0;
  /** A boing at this gain on the next take-off (show-offs), and something to do as it leaves the ground. */
  let nextBoing = 0;
  let onTakeoff: (() => void) | null = null;
  /** The current hop: when it left the ground and its airtime, for the strafe sweep through it. */
  let hopT0 = 0, hopAir = 1;
  let strafeYaw = 0, strafeLean = 0, yawFrom = 0, yawTo = 0;
  /** The name accepted: flying up out of the frame, then away a moment until it drops back in. */
  let flying = false, away = false;
  /** Squash (-) / stretch (+) of the body, a spring, and its velocity. */
  let sq = 0, sqV = 0;
  /** Crouching (the CS:S crouch pose) until this time (the launch). */
  let crouchUntil = -1;

  /** Leaves the ground: a hop of HOP_H at the game's gravity. */
  const takeoff = () => {
    vz = Math.sqrt(2 * GRAV * HOP_H);
    hopT0 = t;
    hopAir = (2 * vz) / GRAV;
    z = 0.01;
    jumpedNow = true;
    setPhase("air");
    sqV += 1.6;
    if (strafing) {
      // This hop's sweep: from where the view is to the other side (the last hop of a run back to the front).
      strafeSide = -strafeSide;
      yawFrom = strafeYaw;
      yawTo = hopsLeft > 0 || strafeOn ? strafeSide * STRAFE_YAW : 0;
    }
    if (nextBoing) sfx("bunny_boing", nextBoing);
    else sfx("jump", strafing ? 0.12 : 0.2);
    nextBoing = 0;
    const f = onTakeoff;
    onTakeoff = null;
    f?.();
  };
  /**
   * `n` hops from here (more if already hopping): from standing, the anticipation crouch first. `bhop`: air-strafing.
   * `then`: as the first of them leaves the ground.
   */
  const hop = (n: number, o: { bhop?: boolean; boing?: number; then?: () => void } = {}) => {
    if (still || !entered || flying || away || launchT >= 0) return;
    strafing = !!o.bhop;
    nextBoing = o.boing ?? 0;
    onTakeoff = o.then ?? null;
    if (phase === "stand" || phase === "settle") {
      hopsLeft = n - 1;
      setPhase("prep");
      sqV -= 0.8;
    } else hopsLeft = Math.max(hopsLeft, n);
  };
  /** Touches down: the next bhop after a short contact, else the landing crouch. Squash by how hard, a soft thud. */
  const touchdown = (speed: number) => {
    z = 0;
    vz = 0;
    if (hopsLeft > 0 || (strafeOn && strafing)) {
      if (!strafeOn) hopsLeft--;
      setPhase("contact");
      sqV -= clamp(speed / 200, 0.6, 1.6);
      sfx("land_soft", 0.1);
      earKick = 0.35;
      return;
    }
    strafing = false;
    setPhase("settle");
    sqV -= clamp(speed / 170, 0.8, 3.4);
    sfx("land_soft", clamp(speed / 900, 0.12, 0.45));
    earKick = Math.min(1, speed / 400);
  };

  // ---- facing and spins
  let turnYaw = 0, turnV = 0;
  let spin: { t0: number; dur: number; turn: number } | null = null;


  // ---- looking: the target (relative to the facing, degrees: yaw + = its left, pitch + = down) and where it looks
  let lookYaw = 0, lookPitch = 0;
  let pointer: { x: number; y: number; at: number } | null = null;
  let attend: Attend = "you";
  let attendUntil = 0;
  const look = (a: Attend, secs: number) => ((attend = a), (attendUntil = t + secs));
  const onPointer = (e: PointerEvent) => (pointer = { x: e.clientX, y: e.clientY, at: t });
  if (!potato) window.addEventListener("pointermove", onPointer, { passive: true });

  // ---- acting (BunnyModel.setActing): breathing, looks, tilts, ears
  const act: BunnyActing = { chestPitch: 0, chestYaw: 0, chestRoll: 0, headPitch: 0, headYaw: 0, headRoll: 0, earL: 0, earR: 0 };
  /** Nod (keystrokes), a spring; head-shake time left; held tilt (puzzled) and its ear pose; ear perk until. */
  let nod = 0, nodV = 0;
  let shakeT = 0;
  let tilt = 0, tiltTo = 0;
  let puzzledOn = false;
  let perkTo = 0, perkUntil = 0, perk = 0;
  let earsBack = 0;
  let earKick = 0;
  let lean = 0, leanTo = 0;

  // ---- inspect / fidgets
  let inspectNow = false;
  /** Busy (a reaction or fidget playing) until this time: no fidget starts before it. */
  let busyUntil = 1.6;
  let nextFidget = rand(3.5, 5.5);
  let lastFidget: Fidget | null = null;
  let nextGlance = 0;

  // ---- launch
  let launchT = -1;
  let apexCb: (() => void) | null = null;
  let doneCb: (() => void) | null = null;

  const pose: PlayerPose = { position: [0, 0, 0], velocity: [0, 0, 0], yaw: BASE_YAW, pitch: 4, crouched: false, grounded: true };

  /** The facing now (Source yaw, degrees). */
  const facing = () => BASE_YAW + turnYaw + strafeYaw;

  const toward=(point:number[])=>{const dx=point[0],dy=-point[2],dz=point[1]-(z+HEAD_Z);return {yaw:wrap180(Math.atan2(dy,dx)/D2R-facing()),pitch:-Math.atan2(dz,Math.hypot(dx,dy))/D2R};};
  const normalize=(v:number[])=>{const l=Math.hypot(...v)||1;return v.map(x=>x/l);};
  const cross3=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const target = (): {yaw:number;pitch:number} => {
    const rect=canvas.getBoundingClientRect(),aspect=Math.max(1,rect.width)/Math.max(1,rect.height),zoom=Math.max(1,.8/aspect),camera=[79*zoom,122*zoom,295*zoom];
    if(attend === "pointer" && pointer){
      const nx=(pointer.x-rect.left)/Math.max(1,rect.width)*2-1,ny=1-(pointer.y-rect.top)/Math.max(1,rect.height)*2;
      const forward=normalize([-camera[0],68-camera[1],-camera[2]]),right=normalize(cross3(forward,[0,1,0])),up=cross3(right,forward),tan=Math.tan(14*D2R);
      const ray=normalize(forward.map((x,i)=>x+right[i]*nx*tan*aspect+up[i]*ny*tan)),horizontal=normalize([camera[0],0,camera[2]]),dist=Math.hypot(camera[0],camera[2])*.45;
      const s=(dist-horizontal.reduce((n,x,i)=>n+x*camera[i],0))/(horizontal.reduce((n,x,i)=>n+x*ray[i],0)||-1e-6);
      return toward(camera.map((x,i)=>x+ray[i]*Math.max(0,s)));
    }
    if(attend === "question")return {yaw:34,pitch:4};
    if(typeof attend === "object")return attend;
    return toward(camera);
  };
  /** A fidget, now. */
  const fidget = (f: Fidget) => {
    lastFidget = f;
    if (f === "trick") {
      // The carrot trick (the knife's third-person inspect), looking down at it.
      inspectNow = true;
      look({ yaw: -26, pitch: 24 }, 2.2);
      busyUntil = t + 3;
    } else if (f === "hops") {
      const n = 2 + (Math.random() < 0.5 ? 1 : 0);
      strafeSide = Math.random() < 0.5 ? 1 : -1;
      hop(n, { bhop: true });
      busyUntil = t + n * 0.75 + 0.9;
    } else if (f === "curious") {
      look("you", 1.8);
      tiltTo = Math.random() < 0.5 ? 13 : -13;
      perkTo = 0.7;
      perkUntil = t + 1.5;
      after(1.5, () => !puzzledOn && (tiltTo = 0));
      busyUntil = t + 2.2;
    } else if (f === "lookback") {
      look({ yaw: Math.random() < 0.5 ? 68 : -78, pitch: rand(-4, 10) }, rand(1.3, 2));
      busyUntil = t + 2.4;
    } else {
      shakeT = 0.55;
      look("you", 1.4);
      busyUntil = t + 1.4;
    }
  };
  const pickFidget = (): Fidget => {
    const all: Fidget[] = potato ? ["hops", "curious", "lookback"] : ["trick", "hops", "curious", "lookback", "shake", "trick", "hops"];
    const pool = all.filter((f) => f !== lastFidget);
    return pool[Math.floor(Math.random() * pool.length)];
  };

  const step = (dt: number) => {
    t += dt;
    for (let i = timers.length - 1; i >= 0; i--) if (timers[i].at <= t) timers.splice(i, 1)[0].fn();

    // -- body: the hop phases, the fall, landings
    let x = 0, y = 0;
    phaseT += dt;
    if (launchT >= 0) {
      launchT += dt;
      const c = 0.3, f = 0.46;
      if (launchT < c) {
        // (caught mid-hop: down first)
        if (z > 0) {
          vz -= GRAV * dt;
          z = Math.max(0, z + vz * dt);
        } else if (phase === "air") setPhase("settle");
        crouchUntil = t + 0.05;
        if (z <= 0) sq = damp(sq, -0.12, 14, dt);
      } else {
        const k = Math.min(1, (launchT - c) / f);
        if (phase !== "air") {
          setPhase("air");
          jumpedNow = true;
          sqV += 4;
          sfx("bunny_boing", 0.7);
        }
        // At the camera (three +x / +z = Source +x / -y), up in an arc.
        const e = k * k * (3 - 2 * k) * 0.35 + k * 0.65;
        x = e * 64;
        y = -e * 236;
        z = 70 * k + 40 * k * k;
        vz = 300;
        if (k >= 0.45 && apexCb) (apexCb(), (apexCb = null));
        if (k >= 1 && doneCb) (doneCb(), (doneCb = null));
      }
    } else if (phase === "air") {
      if (!away && (entered || t > 0.4)) {
        vz -= GRAV * dt;
        z += vz * dt;
        if (flying && z > 200) {
          // Out of the top of the frame: away a moment, then it drops back in (the entrance again).
          flying = false;
          away = true;
          vz = 0;
          after(0.3, () => ((away = false), (entered = false), (z = 170)));
        }
        if (z <= 0) {
          touchdown(-vz);
          if (!entered) {
            // The entrance: landed. A look at you, ears up: hello.
            entered = true;
            look("you", 1.6);
            perkTo = 0.8;
            perkUntil = t + 1.1;
            busyUntil = t + 2.2;
            strafeAt = t + 0.8;
          }
        }
      }
    } else if (phase === "prep") {
      if (phaseT >= PREP) takeoff();
    } else if (phase === "contact") {
      if (phaseT >= CONTACT) takeoff();
    } else if (phase === "settle") {
      if (phaseT >= SETTLE) setPhase("stand");
    }
    const grounded = phase !== "air";

    // -- bhopping on the name step: the first hop once it has landed and looked at you
    if (strafeOn && entered && !flying && !away && launchT < 0 && (phase === "stand" || phase === "settle") && t >= strafeAt) {
      strafeSide = 1;
      hop(1, { bhop: true });
    }
    // -- strafing: the view sweeps one way through the hop (eased: the mouse slows as the strafe switches at the
    // landing), the body leaning into the turn; the next hop the other way. On the ground between hops it holds.
    const hopK = clamp((t - hopT0) / hopAir, 0, 1);
    if (strafing && phase === "air") {
      strafeYaw = yawFrom + (yawTo - yawFrom) * (1 - Math.cos(Math.PI * hopK)) * 0.5;
      // Lean into the turn (to its left when the yaw grows: chest roll -), most at the middle of the sweep.
      strafeLean = -clamp((yawTo - yawFrom) / (2 * STRAFE_YAW), -1, 1) * Math.sin(Math.PI * hopK);
    } else if (!strafing) {
      strafeYaw = damp(strafeYaw, 0, 5, dt);
      strafeLean = damp(strafeLean, 0, 8, dt);
    } else strafeLean = damp(strafeLean, 0, 14, dt);

    // -- turn: the pivot's spring, and spins
    turnV += (-turnYaw * 60 - turnV * 12) * dt;
    turnYaw += turnV * dt;
    let spinA = 0;
    if (spin) {
      const k = (t - spin.t0) / spin.dur;
      if (k >= 1) spin = null;
      else spinA = easeInOut(Math.max(0, k)) * spin.turn;
    }
    spinDegrees = spinA;

    // -- squash / stretch: a spring toward a stretch by the vertical speed in the air
    // (gathering itself before a jump, it squats a little: the anticipation, and between bhops the landing)
    const sqTo = launchT >= 0.3 || flying ? 0.13 : phase === "prep" || phase === "contact" ? -0.06 : grounded ? 0 : clamp(vz / 4000, -0.03, 0.04);
    for (let left = dt; left > 1e-6; left -= 1 / 120) {
      const h = Math.min(1 / 120, left);
      sqV += (-(sq - sqTo) * 420 - sqV * 16) * h;
      sq += sqV * h;
    }
    if (still) sq = 0;
    sq = clamp(sq, -0.14, launchT >= 0 || flying ? 0.16 : 0.07);

    // -- where it looks
    if (attendUntil < t) {
      if (pointer && t - pointer.at < 2.5) attend = "pointer";
      else if (t >= nextGlance) {
        // The pointer rests: glance about (mostly at you).
        const r = Math.random();
        attend = r < 0.5 ? "you" : r < 0.75 ? "question" : { yaw: rand(-50, 50), pitch: rand(-8, 12) };
        nextGlance = t + rand(1.4, 3.6);
      }
    }
    const want = target();
    let lim = still ? 0.5 : 1;
    if (strafeOn) lim *= 0.6; // strafing: it mostly looks where it turns
    const wy = clamp(want.yaw, -72, 72) * lim, wp = clamp(want.pitch, -28, 30) * lim;
    const lookRate = still ? 2.5 : attend === "pointer" ? 7 : 5;
    lookYaw = damp(lookYaw, wy, lookRate, dt);
    lookPitch = damp(lookPitch, wp, lookRate, dt);

    // -- acting
    if (!still) {
      nodV += (-nod * 380 - nodV * 22) * dt;
      nod += nodV * dt;
    }
    tilt = damp(tilt, tiltTo, still ? 3 : 8, dt);
    perk = damp(perk, t < perkUntil ? perkTo : 0, 9, dt);
    earsBack = damp(earsBack, launchT >= 0 ? 1 : 0, 12, dt);
    lean = damp(lean, leanTo, 6, dt);
    const breath = potato ? 0 : Math.sin(t * ((2 * Math.PI) / 3.4));
    const sway = potato ? 0 : Math.sin(t * ((2 * Math.PI) / 7.3));
    let shake = 0;
    if (shakeT > 0) {
      shakeT = Math.max(0, shakeT - dt);
      shake = Math.sin(shakeT * 46) * 16 * Math.min(1, shakeT / 0.25);
    }
    act.chestPitch = breath * 1.3 + lookPitch * 0.25 + lean + (launchT >= 0 ? 10 : 0);
    act.chestYaw = lookYaw * 0.3;
    act.chestRoll = sway * 1.6 - tilt * 0.2 + strafeLean * 8;
    act.headPitch = -breath * 0.7 + lookPitch * 0.75 + nod;
    act.headYaw = lookYaw * 0.7 + shake * 0.35;
    act.headRoll = tilt + sway * 1.2 + shake - strafeLean * 3;
    const puzzledEars = puzzledOn ? 1 : 0;
    act.earL = clamp(perk + puzzledEars * 0.55 - earsBack - earKick * 0.3, -1, 1);
    act.earR = clamp(perk - puzzledEars * 0.5 - earsBack - earKick * 0.3, -1, 1);
    earKick = damp(earKick, 0, 6, dt);
    // -- idle: fidgets
    if (!still && entered && !strafeOn && launchT < 0 && phase === "stand" && t >= busyUntil && t >= nextFidget) {
      fidget(pickFidget());
      nextFidget = busyUntil + rand(3, 7.5);
    }

    // -- the pose
    const yaw = facing();
    const r = yaw * D2R;
    // Bhopping, it runs along the view in the air (on the spot: the stage doesn't move): the CS:S anim state turns the
    // feet that way and the ears stream back. On the ground it's still, so the feet never slide.
    const airStrafe = strafing && phase === "air" && launchT < 0;
    const fwd = airStrafe ? BHOP_SPEED : 0;
    const pos = pose.position as number[];
    pos[0] = x, pos[1] = y, pos[2] = Math.max(0, z);
    const vel = pose.velocity as number[];
    vel[0] = Math.cos(r) * fwd, vel[1] = Math.sin(r) * fwd, vel[2] = grounded ? 0 : vz;
    pose.yaw = yaw;
    // The CS:S crouch on the ground around a hop: the anticipation, the landing between bhops (a few frames of its
    // crossfade: the knees give), the landing after.
    pose.crouched = t < crouchUntil || phase === "prep" || phase === "contact" || (phase === "settle" && phaseT < SETTLE * 0.6);
    pose.grounded = grounded && launchT < 0.3;
    pose.jumped = jumpedNow;
    if(inspectNow)inspectCount++;
    pose.sidemove = airStrafe ? (yawTo > yawFrom ? -450 : 450) : 0;
    jumpedNow = false;
    inspectNow = false;
    const rect=canvas.getBoundingClientRect(),aspect=Math.max(1,rect.width)/Math.max(1,rect.height),zoom=Math.max(1,.8/aspect),cam=[79*zoom,122*zoom,295*zoom],f=normalize([-cam[0],68-cam[1],-cam[2]]),screenRight=normalize(cross3(f,[0,1,0])),u=cross3(screenRight,f),tan=Math.tan(14*D2R);
    const project=(point:number[])=>{const v=point.map((x,i)=>x-cam[i]),depth=v.reduce((n,x,i)=>n+x*f[i],0);return [50*(1+v.reduce((n,x,i)=>n+x*screenRight[i],0)/depth/tan/aspect),50*(1-v.reduce((n,x,i)=>n+x*u[i],0)/depth/tan)];};
    const label=project([x,Math.max(0,z)+TAG_Z*(1+sq),-y]);tag.style.left=label[0]+"%";tag.style.top=label[1]+"%";tag.style.opacity=String(tag.textContent&&launchT<0?clamp((80-z)/20,0,1):0);
    const floor=project([x,0,-y]);shadow.style.left=floor[0]+"%";shadow.style.top=floor[1]+"%";shadow.style.transform=`translate(-50%,-50%) scale(${1-Math.min(.6,z/110)})`;shadow.style.opacity=String(launchT>=0?Math.max(0,.4-launchT):.4*(1-Math.min(1,z/160)));

  };
  const frame=(now:number)=>{if(disposed)return;raf=requestAnimationFrame(frame);if(document.hidden){last=now;return;}const dt=Math.min(.05,(now-last)/1000);last=now;step(dt);render();};
  raf=requestAnimationFrame(frame);
  const startSpin=(turn:number,dur:number)=>{spin={t0:t,dur,turn};};
  const ready=()=>!still&&entered&&!flying&&!away&&launchT<0;
  return {
    el:canvas,
    setName(name) {tag.textContent=name;},
    setColor(css) {tag.style.color=css;},
    typed() {
      if (!ready()) return;
      nodV += 34;
      sqV -= 0.35;
      busyUntil = Math.max(busyUntil, t + 1.2);
    },
    puzzled(on) {
      if (on === puzzledOn) return;
      puzzledOn = on;
      tiltTo = on ? 16 : 0;
      if (on) look("you", 1.5);
      busyUntil = Math.max(busyUntil, t + 1.5);
    },
    strafe(on) {
      strafeOn = on && !still;
      if (strafeOn) strafeAt = Math.max(strafeAt, t + 0.3);
    },
    fly() {
      puzzledOn = false;
      tiltTo = 0;
      perkTo = 1;
      perkUntil = t + 1.4;
      look("you", 1.6);
      if (!ready()) return;
      strafeOn = false;
      strafing = false;
      hopsLeft = 0;
      onTakeoff = null;
      // Straight up and out of the frame, stretched, the ears trailing on their springs.
      flying = true;
      vz = 760;
      z = Math.max(z, 0.01);
      setPhase("air");
      jumpedNow = true;
      sqV += 2.4;
      sfx("bunny_boing", 0.7);
      busyUntil = t + 3;
    },
    show(id) {
      if (!ready()) return;
      // The same swatch always does the same show-off.
      let hsh = 0;
      for (let i = 0; i < id.length; i++) hsh = (hsh * 31 + id.charCodeAt(i)) >>> 0;
      const v = hsh % 3;
      perkTo = 0.6;
      perkUntil = t + 1;
      look("you", 1.8);
      if (v === 0 || potato) {
        // A twirl on a hop.
        hop(1, { boing: 0.7, then: () => startSpin(Math.random() < 0.5 ? 360 : -360, 0.5) });
      } else if (v === 1) {
        // A hop, then the carrot trick at you once it's down.
        hop(1, { boing: 0.7, then: () => after(hopAir + SETTLE * 0.5, () => (inspectNow = true)) });
      } else {
        // Two bhops, strafing.
        strafeSide = -1;
        hop(2, { bhop: true, boing: 0.7 });
      }
      busyUntil = t + 2.6;
    },
    spin(cm) {
      if (!ready() || spin) return;
      const dur = clamp(0.16 + cm * 0.006, 0.26, 0.5);
      hop(1, { then: () => startSpin(360, dur) });
      look("you", 1.4);
      busyUntil = t + 1.6;
    },
    pivot(dir) {
      if (still) return look("question", 1.2);
      turnV += dir * 260;
      look(dir > 0 ? "question" : "you", 1.3);
      earKick = 0.6;
      busyUntil = Math.max(busyUntil, t + 1.4);
    },
    launch(onApex) {
      apexCb = onApex ?? null;
      timers = [];
      hopsLeft = 0;
      strafeOn = strafing = false;
      onTakeoff = null;
      look("you", 9);
      if (still) {
        onApex?.();
        return Promise.resolve();
      }
      launchT = 0;
      sqV -= 1.4;
      return new Promise<void>((res) => (doneCb = res));
    },
    dispose(){if(disposed)return;disposed=true;cancelAnimationFrame(raf);cancelPreview(request);window.removeEventListener("pointermove",onPointer);doneCb?.();doneCb=null;tag.remove();shadow.remove();canvas.remove();}
  };
}
