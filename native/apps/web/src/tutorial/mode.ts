// Tutorial mode on bhop_lol_tutorial (main.ts starts it on that map). The lesson is wherever you are: four rooms joined
// by exit portals, so hopping through the course and the lesson flow can never disagree.
//
// What the player sees, in order of importance:
//  - the map: each lesson's title painted on the floor, the strafe line, speed gates and an EXIT sign that light up
//    (marks.ts); the demo ghost runs once the first time you enter a lesson (demo.ts)
//  - one quiet line at the bottom: the lesson's one instruction for a few seconds (and again if you stand about), and
//    a short nudge only when something's going wrong (coach.ts)
//  - the strafe guide: two arcs around the crosshair (guide.ts), in the strafing lessons
// Goals come from sim state (goals.ts). Lessons 1-3 are practice (never submitted: session.lessonPractice); the final
// course is the map's bonus 1, a normal timed and submitted run with its own board (board.ts, on the finish). Arriving
// on the course through lesson 3's exit restarts you onto its start pad (flow.ts needsFinalRestart).

import { appLocation } from "../platform/navigation";
import type * as THREE from "three";
import type { Core, PlayerState, RestartPoint } from "../core";
import type { Input, UserCmd } from "../input";
import type { RunSession } from "../session";
import { h } from "../ui/dom";
import { keyLabel, prefs } from "../ui/settings";
import { sfx } from "../audio";
import { firstMapOfTheDay } from "../ui/first-map";
import { lessonAt, LESSON_IDS, loadTutorialData, type LessonGeometry, type LessonId, type TutorialData } from "./data";
import { Coach } from "./coach";
import { DemoGhost } from "./demo";
import { recordFinalFinish, saveTutorialProgress, tutorialProgress } from "./flag";
import { FinaleBoard } from "./board";
import { FINAL_TRACK, lessonIsPractice, needsFinalRestart } from "./flow";
import { touching } from "../zones";
import { LessonGoals, StrafeMeter } from "./goals";
import { StrafeGuide, type GuideMode } from "./guide";
import { EXIT_OPEN, LESSONS, NUDGES } from "./lessons";
import { TutorialMarks } from "./marks";
import "./tutorial.css";
import { celebrate, celebrating, PRIORITY, whisper, type CelebrationSpec } from "../notify";

export interface TutorialHost {
  session: RunSession;
  core: Core;
  input: Input;
  scene: THREE.Scene;
  bsp: Uint8Array;
  wasmBytes: Uint8Array;
  /** main.ts restart(track, at). */
  restart: (track?: number, at?: RestartPoint | null) => void;
}

const FINAL = LESSON_IDS.indexOf("final");
const GOLD_FACTOR = 1.4;
/** How long a lesson's instruction shows on entering it (ms); after that, only when standing about or stuck. */
const INSTRUCTION_MS = 9000;
/** No progress on the goal for this long (ms) while playing: the instruction comes back for a few seconds. */
const STALL_MS = 6000;
/** Standing about this long (ticks) brings the instruction and key hints back. */
const IDLE_TICKS = 300;
const GUIDE_PREF = "bunnyhop:tutorial-guide";
/**
 * The final course's finish is one moment, in beats: the title line alone (the end card waits), then the graduation
 * celebration in its place (the prompt steps aside, so the bunny over the card covers nothing), then the end card and
 * the prompt's next-step line. How long the title holds the screen alone (ms).
 */
const TITLE_MS = 2600;

export async function startTutorialMode(host: TutorialHost): Promise<TutorialMode | null> {
  let data: TutorialData;
  try {
    data = await loadTutorialData();
  } catch (e) {
    console.warn("tutorial:", e);
    host.session.hud.toast("Tutorial data missing: playing the map without lessons", 5000);
    return null;
  }
  if (data.bspSha256 !== host.session.mapSha256) console.warn("tutorial: lesson data is for another build of the map");
  return new TutorialMode(host, data);
}

const bind = (action: keyof ReturnType<typeof prefs.get>["binds"], fallback: string) => keyLabel(prefs.get().binds[action]?.[0] ?? fallback);
/** Copy with {jump} / {forward} / {left} / {right} replaced by the bound keys. */
const withKeys = (s: string) => s.replace(/\{(\w+)\}/g, (_, k: string) => ({ jump: bind("jump", "Space"), forward: bind("forward", "KeyW"), left: bind("left", "KeyA"), right: bind("right", "KeyD") })[k] ?? k);
const kbd = (k: string) => h("kbd", null, k);

export class TutorialMode {
  private current = -1;
  private goals = new Map<LessonId, LessonGoals>();
  private meter: StrafeMeter;
  private coach: Coach;
  private guide: StrafeGuide;
  private guidePref: GuideMode;
  private guideShown = false;
  private marks: TutorialMarks;
  private prompt: HTMLElement;
  private pTitle: HTMLElement;
  private pLine: HTMLElement;
  private pHint: HTMLElement;
  private painted = { title: "", line: "", cls: "", hint: "" };
  private showUntil = 0;
  private hintUntil = 0;
  private step: string | null = null;
  private progress = { value: 0, at: 0 };
  /** The final course is finished: the gold line; the title beat's end (0 once over); the celebration it then plays. */
  private finale: { line: string; titleUntil: number; cel: CelebrationSpec | null } | null = null;
  private started = false;
  private board = new FinaleBoard();
  private demo: DemoGhost | null = null;
  private demoLoading = false;
  private autoPlayed = new Set<LessonId>();
  private aux: Core | null = null;
  private pos: readonly number[] = [0, 0, 0];
  private vel: readonly number[] = [0, 0, 0];
  private grounded = true;
  private legit: boolean;

  constructor(
    private host: TutorialHost,
    private data: TutorialData,
  ) {
    this.legit = !host.session.settings.autohop;
    this.meter = new StrafeMeter(this.legit ? 5 : 2);
    this.coach = new Coach(this.legit);
    this.guide = new StrafeGuide();
    this.guide.el.id = "tut-guide";
    this.guidePref = localStorage.getItem(GUIDE_PREF) === "details" ? "details" : "on";
    this.marks = new TutorialMarks(
      data,
      data.lessons.map((l) => LESSONS[l.id].title),
      { left: bind("left", "KeyA"), right: bind("right", "KeyD") },
    );
    host.scene.add(this.marks.root);
    this.pTitle = h("div.tp-title");
    this.pLine = h("div.tp-line");
    this.pHint = h("div.tp-hint");
    this.prompt = h("div#tut-prompt", { role: "status", "aria-live": "polite" }, this.pTitle, this.pLine, this.pHint);
    document.getElementById("hud")!.append(this.prompt, this.guide.el);
    document.body.classList.add("tutorial-mode");
    document.addEventListener("pointerlockchange", this.onLock);
    // A verified final-course run moves you on the board: draw it again with your new row.
    host.session.onSubmission = (st) => {
      if (st.status === "verified" && this.finale) void this.showBoard();
    };
    // Start where the URL says (?lesson=<id>), else wherever the map put us (lesson 1's spawn).
    const want = appLocation().searchParams.get("lesson");
    const i = LESSON_IDS.indexOf(want as LessonId);
    if (i > 0) this.goTo(i);
    else this.enter(Math.max(0, lessonAt(data, host.core.state().position)));
  }

  /** Play starts (the first pointer lock, after "Click to start"): the instruction gets its full time from here. */
  private onLock = (): void => {
    if (this.started || !document.pointerLockElement) return;
    this.started = true;
    this.showUntil = this.hintUntil = performance.now() + INSTRUCTION_MS;
  };

  private get lesson(): LessonGeometry {
    return this.data.lessons[this.current];
  }

  private goalsFor(l: LessonGeometry): LessonGoals {
    let g = this.goals.get(l.id);
    if (!g) {
      const gold = l.demoSeconds ? Math.ceil(l.demoSeconds * GOLD_FACTOR) : 20;
      g = new LessonGoals(l, { goldSeconds: gold });
      this.goals.set(l.id, g);
    }
    return g;
  }

  /** The instruction for the step being worked on. */
  private instruction(): string {
    const copy = LESSONS[this.lesson.id];
    const steps = (this.legit && copy.legit) || copy.steps;
    const g = this.goalsFor(this.lesson);
    const k = g.current ? g.goals.indexOf(g.current) : 0;
    return withKeys(steps[Math.min(k, steps.length - 1)]);
  }

  // ------------------------------------------------------------------------------------------- flow

  /** Teleports to lesson i's start (the final course: its own start pad, a timed bonus run). */
  goTo(i: number): void {
    if (i < 0 || i >= this.data.lessons.length) return;
    const l = this.data.lessons[i];
    if (l.id === "final") this.host.restart(1);
    else this.host.restart(0, { position: [...l.start.position] as [number, number, number], yaw: l.start.yaw });
    this.meter.reset();
    this.coach.reset();
    if (i !== this.current) this.enter(i);
    else {
      this.demo?.restart();
      this.showUntil = performance.now() + 4000;
    }
  }

  private enter(i: number): void {
    this.current = i;
    this.endFinale();
    const l = this.lesson;
    const copy = LESSONS[l.id];
    const g = this.goalsFor(l);
    this.guideShown = copy.guide;
    this.meter.reset();
    this.coach.reset();
    this.step = g.current?.id ?? null;
    const now = performance.now();
    this.showUntil = now + INSTRUCTION_MS;
    this.hintUntil = now + INSTRUCTION_MS;
    this.marks.setExit(i, g.done);
    // Lessons 1-3 are untimed practice: no run timer (it would sit at 00:00.000). The final course shows it.
    document.body.classList.toggle("tutorial-practice", i !== FINAL);
    this.stopDemo();
    // Show, don't tell: the first time in a lesson, the demo ghost runs it once (X hides it, or brings it back).
    if (!tutorialProgress().lessons[l.id] && !this.autoPlayed.has(l.id) && l.id !== "final") {
      this.autoPlayed.add(l.id);
      void this.startDemo(false);
    }
  }

  private complete(): void {
    const id = this.lesson.id;
    saveTutorialProgress((p) => (p.lessons[id] ??= Date.now()));
    sfx("achievement", 0.6);
    this.marks.setExit(this.current, true);
  }

  /**
   * A finish in the final course, on whichever track (bonus 1; or the main track, the whole tutorial, which ends in the
   * same zone): the course and the tutorial are done. Only a bonus 1 time counts for the best and the gold.
   */
  private finishFinal(track: number, seconds: number): void {
    const g = this.goalsFor(this.lesson);
    const timed = track === FINAL_TRACK;
    if (timed) g.finish(seconds);
    const gold = g.goals.find((x) => x.id === "gold")!;
    let first = false;
    saveTutorialProgress((p) => (first = recordFinalFinish(p, { track, seconds, gold: timed && gold.done, at: Date.now() })));
    // The first finish is a graduation: after the title beat the bunny cheers on a celebration card (its sound with
    // it; the badge is said there, not on the line). Later finishes: a chime.
    const cel: CelebrationSpec | null = first
      ? { kicker: "Tutorial complete", title: "You can bhop", detail: `Graduate badge earned${gold.done ? " · gold time, too" : ""}`, mood: "cheer", confetti: 80, sound: "achievement", priority: PRIORITY.level, key: "tutorial-graduate" }
      : null;
    this.finale = { line: gold.done ? "Gold time, too." : `Gold is under ${gold.target} s.`, titleUntil: performance.now() + TITLE_MS, cel };
    // The end card waits out the title beat (tutorial.css), then drops in.
    document.body.classList.add("tutorial-title");
    // The final course's board on the end-of-run card (bonus 1 finishes; the card goes with the next attempt).
    if (timed && this.board.available) {
      this.host.session.hud.setCardExtra(this.board.el);
      void this.showBoard();
    }
    if (!first) sfx("achievement", 0.8);
  }

  /** The title beat is over: the end card comes in and the graduation celebrates (once). */
  private endTitle(): void {
    const f = this.finale;
    if (!f?.titleUntil) return;
    f.titleUntil = 0;
    document.body.classList.remove("tutorial-title");
    const card = document.getElementById("hud-endcard");
    if (card && !card.hidden && !matchMedia("(prefers-reduced-motion: reduce)").matches)
      card.animate({ opacity: [0, 1], transform: ["translateY(-10px)", "none"] }, { duration: 320, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    if (f.cel) celebrate(f.cel);
    f.cel = null;
  }

  /** Leaving the finish (a restart, another lesson): a pending graduation still celebrates. */
  private endFinale(): void {
    this.endTitle();
    this.finale = null;
  }

  private showBoard(): Promise<void> {
    const gold = this.goalsFor(this.data.lessons[FINAL]).goals.find((x) => x.id === "gold")!.target;
    return this.board.show(tutorialProgress().best ?? null, gold);
  }

  // ------------------------------------------------------------------------------------------- tick / frame

  tick(cmd: UserCmd, pre: PlayerState, post: PlayerState, events: number): void {
    const info = { cmd: { forward: cmd.forwardmove, side: cmd.sidemove, yaw: cmd.yaw, pitch: cmd.pitch, buttons: cmd.buttons }, pre, post, events };
    // A restart (R, a menu, the debug hook) moves the player without a teleport event: start the meters afresh.
    if (Math.hypot(pre.position[0] - this.pos[0], pre.position[1] - this.pos[1], pre.position[2] - this.pos[2]) > 96) {
      this.meter.reset();
      this.coach.reset();
    }
    const at = lessonAt(this.data, post.position);
    if (at >= 0 && at !== this.current) {
      // Through lesson 3's exit into the final course: onto its start pad, a fresh bonus 1 attempt (flow.ts).
      const onPad = touching(post.position, post.crouched, this.host.session.timer.zones, "start", FINAL_TRACK) !== null;
      if (needsFinalRestart(this.data.lessons[at].id, this.current >= 0 ? this.lesson.id : null, onPad)) {
        this.goTo(at);
        this.pos = this.host.core.state().position;
        return;
      }
      this.enter(at);
    }
    // Lessons 1-3 are practice: never submitted or saved as PBs (the final course is a normal run). Its own flag, not
    // third person's; a reset clears it.
    if (lessonIsPractice(this.lesson.id)) this.host.session.lessonPractice = true;
    const breaks = this.meter.breaks;
    this.meter.update(info);
    const g = this.goalsFor(this.lesson);
    const was = g.done;
    const gate = g.update(info, this.meter);
    if (gate >= 0) {
      this.marks.lightGate(this.current, gate);
      sfx("split", 0.8);
    }
    const step = g.current?.id ?? null;
    const now = performance.now();
    const v = g.current?.value ?? 0;
    if (v !== this.progress.value) this.progress = { value: v, at: now };
    else if (g.current && this.lesson.id !== "final" && now - this.progress.at > STALL_MS) {
      // Stuck (say, strafing left when the step is the right): say it again.
      this.showUntil = now + 4000;
      this.progress.at = now;
    }
    if (step !== this.step) {
      // Lesson 2's second half: a fresh instruction.
      if (step) (this.showUntil = now + 5000), sfx("split", 0.6);
      this.step = step;
    }
    this.coach.update(this.lesson.id, info, this.meter, breaks, g.done);
    if (!was && g.done && this.lesson.id !== "final") this.complete();
    const t = this.host.session.timer;
    if (this.lesson.id === "final" && t.status === "finished" && !this.finale) this.finishFinal(t.track, t.time());
    else if (t.status !== "finished" && this.finale) this.endFinale();
    this.grounded = post.grounded;
    this.pos = post.position;
    this.vel = post.velocity;
  }

  frame(camera: THREE.Camera, dt: number): void {
    const now = performance.now();
    if (this.finale?.titleUntil && now >= this.finale.titleUntil) this.endTitle();
    const showGuide = this.guideShown && !this.finale;
    this.guide.mode = showGuide ? this.guidePref : "off";
    if (showGuide) this.guide.update(this.meter, now);
    this.marks.landing(this.lesson, this.pos, this.vel, this.grounded, LESSONS[this.lesson.id].landing);
    this.marks.frame(dt);
    if (this.demo) {
      this.demo.frame(dt, camera.position);
      if (this.demo.ended) this.stopDemo();
    }
    this.paintPrompt(now);
  }

  // ------------------------------------------------------------------------------------------- input

  /** Bound actions (input.onAction): R restarts the lesson. Returns true if handled. */
  onAction(a: string): boolean {
    if (a === "restart") {
      this.goTo(this.current);
      return true;
    }
    return false;
  }

  /** Unbound keys (input.onKey). Returns true if handled. */
  onKey(code: string): boolean {
    switch (code) {
      case "KeyN":
        this.goTo(this.current + 1);
        return true;
      case "Backspace":
        this.goTo(this.current - 1);
        return true;
      case "Enter":
      case "NumpadEnter":
        if (this.finale) {
          location.href = `/?map=${firstMapOfTheDay()}`;
          return true;
        }
        if (this.goalsFor(this.lesson).done) this.goTo(this.current + 1);
        return true;
      case "KeyX":
        if (this.demo) this.stopDemo();
        else void this.startDemo(true);
        return true;
      case "KeyG":
        // Shows the guide where it's hidden; else cycles arcs -> arcs with numbers -> off.
        if (!this.guideShown) this.guideShown = true;
        else if (this.guidePref === "on") this.guidePref = "details";
        else (this.guidePref = "on"), (this.guideShown = false);
        localStorage.setItem(GUIDE_PREF, this.guidePref);
        whisper(!this.guideShown ? "Strafe guide off" : this.guidePref === "details" ? "Strafe guide with numbers" : "Strafe guide on", { key: "strafe-guide" });
        return true;
    }
    return false;
  }

  // ------------------------------------------------------------------------------------------- demo

  private async startDemo(loop: boolean): Promise<void> {
    if (this.demoLoading) return;
    const l = this.lesson;
    const src = this.legit && l.demoLegit ? l.demoLegit : l.demo;
    if (!src) return;
    this.demoLoading = true;
    try {
      if (!this.aux) {
        this.aux = await (await import("../core")).Core.create(this.host.wasmBytes as Uint8Array<ArrayBuffer>);
        this.aux.loadMapPhysics(this.host.bsp);
      }
      const d = await DemoGhost.create({ wasmBytes: this.host.wasmBytes, bsp: this.host.bsp, scene: this.host.scene, demo: src, aux: this.aux, loop });
      if (this.lesson !== l || this.demo) return d.dispose();
      this.demo = d;
    } catch (e) {
      console.warn("tutorial demo:", e);
    } finally {
      this.demoLoading = false;
    }
  }

  private stopDemo(): void {
    this.demo?.dispose();
    this.demo = null;
  }

  // ------------------------------------------------------------------------------------------- the prompt line

  private paintPrompt(now: number): void {
    const done = this.goalsFor(this.lesson).done;
    const idle = this.coach.idleTicks > IDLE_TICKS;
    // The lesson's title is on the banner in the map; the big line is only for the finish.
    let title = "";
    let line = "";
    let cls = "";
    let hint: (string | HTMLElement)[] = [];
    const quiet = celebrating();
    if (quiet) {
      // A celebration is up in the same spot (the graduation, a level-up): the line steps aside, the bunny covers nothing.
    } else if (this.finale?.titleUntil) {
      title = "You can bhop.";
      line = this.finale.line;
    } else if (this.finale) {
      line = this.finale.line;
      hint = [kbd("Enter"), ` play ${firstMapOfTheDay()} · `, kbd(bind("restart", "KeyR")), " go again"];
    } else if (this.coach.nudge) {
      line = withKeys(NUDGES[this.coach.nudge]);
      cls = "nudge";
    } else if (done && this.lesson.id !== "final") {
      line = EXIT_OPEN;
      hint = [kbd("Enter"), " next lesson"];
    } else if (now < this.showUntil || idle) {
      line = this.instruction();
    }
    if (!quiet && !this.finale && !done && (now < this.hintUntil || idle)) {
      hint = [kbd("X"), this.demo ? " hide the ghost" : " show me"];
      if (this.current < this.data.lessons.length - 1) hint.push(" · ", kbd("N"), " skip");
    }
    const hintKey = hint.map((x) => (typeof x === "string" ? x : x.textContent)).join("");
    const p = this.painted;
    if (title !== p.title) {
      if (title) this.pTitle.textContent = title;
      this.pTitle.classList.toggle("on", !!title);
      p.title = title;
    }
    if (line !== p.line || cls !== p.cls) {
      if (line) this.pLine.textContent = line;
      this.pLine.className = `tp-line ${cls}${line ? " on" : ""}`;
      p.line = line;
      p.cls = cls;
    }
    if (hintKey !== p.hint) {
      if (hint.length) this.pHint.replaceChildren(...hint);
      this.pHint.classList.toggle("on", hint.length > 0);
      p.hint = hintKey;
    }
  }

  dispose(): void {
    this.stopDemo();
    this.board.dispose();
    this.host.session.onSubmission = null;
    this.marks.dispose();
    this.prompt.remove();
    this.guide.el.remove();
    document.removeEventListener("pointerlockchange", this.onLock);
    document.body.classList.remove("tutorial-mode", "tutorial-practice", "tutorial-title");
  }
}
