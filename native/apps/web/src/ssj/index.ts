// Jump stats in the game (the !ssj of bhop servers): the live tracker session.ts feeds every tick, the chat line, the
// !ssj command and its panel, and the settings rows the panel shares with Settings → HUD → Jump stats.
// The formulas are in stats.ts (DOM-free, tested); the HUD element in view.ts; sources in research/SSJ.md.
//
//   session.ts   ssj.feed(cmd, state, events, { inStart, time }) after every tick, ssj.reset(state) on restarts
//   chat         one local system line per reported jump (net/hud.ts postLocalLine: the line a command's ctx.reply
//                writes), solo and rooms, when "Chat" is on
//   !ssj         chat-commands.ts registry: opens the panel (pauses the game like the HUD editor, resumes on close)

import { EVENT_JUMPED, EVENT_TELEPORTED, type PlayerState } from "../core";
import { registerChatCommand } from "../chat-commands";
import { takeFreeCursor } from "../free-cursor";
import { postLocalLine } from "../net/hud";
import { resumePlay } from "../play-lock";
import type { TickCmd } from "../timer";
import { check, color, group, range, segmented, toggle } from "../ui/controls";
import { h } from "../ui/dom";
import { prefs, type Prefs } from "../ui/settings";
import "../ui/settings.css";
import { DEFAULT_JHUD, JHUD_BANDS, JhudTracker, type JhudBand, type JhudReport } from "./jhud";
import { SSJ_FIELDS, SsjTracker, ssjItems, ssjText, type SsjField, type SsjMode, type SsjReport, type SsjState, StartPreTracker } from "./stats";
import { ssjNodes } from "./view";
import { dismissOutside } from "../ui/dismiss";

const P = () => prefs.get().hud.ssj;
const up = (fn: (p: Prefs) => void) => prefs.update(fn);

/** The live run's tracker. The state after each tick is the next tick's "before". */
export class LiveSsj {
  private tracker = new SsjTracker(P().mode);
  private pre: SsjState | null = null;
  private startPre = new StartPreTracker();
  private jhud = new JhudTracker();

  constructor(private report: (r: SsjReport) => void, private reportStartPre: (speed: number | null) => void = () => {}, private reportJhud: (r: JhudReport | null) => void = () => {}) {
    prefs.watch((p) => this.tracker.setMode(p.hud.ssj.mode));
  }

  /** Restart / checkpoint teleport: the count starts over from `state` (the state the next tick starts from). */
  reset(state: PlayerState | null): void {
    this.tracker.reset();
    this.startPre.reset();
    this.reportStartPre(null);
    this.jhud.reset();
    this.reportJhud(null);
    this.pre = state;
  }

  /**
   * One simulated tick: `cmd` exactly as stepped, `state` after it. `inStart` / `time`: the timer before the tick (in a
   * start zone; run time if running). `noclip`: practice noclip (not sampled).
   */
  feed(cmd: TickCmd, state: PlayerState, events: number, o: { inStart: boolean; time: number | null; noclip?: boolean }): void {
    const pre = this.pre;
    this.pre = state;
    if (!pre) return;
    const startPre = this.startPre.tick(pre, { jumped: (events & EVENT_JUMPED) !== 0, teleported: (events & EVENT_TELEPORTED) !== 0, ...o });
    if (startPre !== undefined) this.reportStartPre(startPre);
    const r = this.tracker.tick(pre, cmd, { jumped: (events & EVENT_JUMPED) !== 0, teleported: (events & EVENT_TELEPORTED) !== 0, ...o });
    if (r) this.report(r);
    const j = this.jhud.tick(pre, cmd, { jumped: (events & EVENT_JUMPED) !== 0, ...o });
    if (j) this.reportJhud(j);
  }
}

/** The chat line for a report, if Chat is on: "Jump 6 · 1013 u/s (+87) · Gain 87.5% · Sync 92% · 5 strafes". */
export function ssjChat(r: SsjReport): void {
  const p = P();
  if (!p.chat) return;
  postLocalLine(ssjText(r, p.fields), ssjNodes(ssjItems(r, p.fields), false));
}

// ---------------------------------------------------------------------------------------------
// Settings rows (Settings → HUD → Jump stats, and the !ssj panel)

const FIELD_LABELS: Record<SsjField, [string, string]> = {
  speed: ["Speed", "Horizontal speed at take-off."],
  diff: ["Difference", "Speed gained since jump 1 (6th jump), jump 6k + 1 (every 6th) or the last jump (every jump)."],
  gain: ["Gain", "How much of the possible air acceleration you got, tick by tick, as SSJ plugins count it."],
  sync: ["Sync", "Air ticks where your strafe added speed."],
  strafes: ["Strafes", "W / A / S / D presses in the air."],
  eff: ["Efficiency", "Gain, times how straight your path was."],
  height: ["Height", "Height difference to the same jump as Difference."],
  time: ["Time", "Run time at the jump."],
};

const MODES: [SsjMode, string][] = [
  ["sixth", "6th jump"],
  ["every", "Every jump"],
  ["everySixth", "Every 6th"],
];

/** The Jump stats rows: chat, HUD element, which jumps, which fields. */
export function ssjRows(): HTMLElement[] {
  return [
    toggle("Chat", () => P().chat, (v) => up((p) => (p.hud.ssj.chat = v)), {
      hint: "!ssj",
      desc: "A line in chat for each jump picked below.",
      keywords: "ssj jump stats speed sixth jump gain sync strafes efficiency chat",
    }),
    toggle("HUD", () => prefs.get().hud.layout.jumpStats.on, (v) => up((p) => (p.hud.layout.jumpStats.on = v)), {
      desc: "The same numbers on the HUD. Edit layout moves it.",
      keywords: "ssj jump stats hud element show hide",
    }),
    segmented<SsjMode>("Jumps", () => P().mode, (v) => up((p) => (p.hud.ssj.mode = v)), MODES, {
      desc: "The jump count starts over after standing still or a jump in a start zone. 6th jump and Every 6th add up the jumps since the last report.",
      keywords: "ssj mode sixth every repeat usage",
    }),
    h(
      "div.check-grid",
      null,
      ...SSJ_FIELDS.map((f) =>
        check(FIELD_LABELS[f][0], () => P().fields[f], (v) => up((p) => (p.hud.ssj.fields[f] = v)), { desc: FIELD_LABELS[f][1], keywords: `ssj jump stats ${f}` }),
      ),
    ),
  ];
}

// ---------------------------------------------------------------------------------------------
// JHUD settings rows (Settings → HUD → JHUD, and the !jhud panel)

const J = () => prefs.get().hud.jhud;
const BAND_LABELS: Record<JhudBand, string> = { reallyBad: "Under 60%", bad: "60-70%", meh: "70-80%", good: "80-90%", reallyGood: "90% and up" };

export function jhudRows(): HTMLElement[] {
  return [
    toggle("JHUD", () => prefs.get().hud.layout.jhud.on, (v) => up((p) => (p.hud.layout.jhud.on = v)), {
      hint: "!jhud",
      desc: "Speed and gain of every jump, near the crosshair, coloured by how it went. Edit layout moves it.",
      keywords: "jhud jump hud gain speed sync center screen",
    }),
    h(
      "div.check-grid",
      null,
      check("Sync", () => J().sync, (v) => up((p) => (p.hud.jhud.sync = v)), { desc: "Air ticks where your strafe added speed, after the gain.", keywords: "jhud sync" }),
      check("JSS", () => J().jss, (v) => up((p) => (p.hud.jhud.jss = v)), { desc: "How fast you turned against the turn that gains the most at your speed. 100% is ideal.", keywords: "jhud jss strafe speed turn" }),
      check("Strafe analyzer", () => J().analyzer, (v) => up((p) => (p.hud.jhud.analyzer = v)), { desc: "An arrow by the gain: down when you turned too fast, up when too slow.", keywords: "jhud analyzer arrow fast slow" }),
    ),
    range("Speed colours until jump", () => J().speedColors, (v) => up((p) => (p.hud.jhud.speedColors = v)), { min: 1, max: 16, step: 1, desc: "Up to this jump the colour says if your speed is on pace; after it, how good the gain was. The plugins use 6, or 16 for Extra Jumps.", keywords: "jhud extra jumps speed colours colors" }),
    range("Stop after jump", () => J().cutoff, (v) => up((p) => (p.hud.jhud.cutoff = v)), { min: 0, max: 30, step: 1, desc: "Hides it after this jump, for when you only care about the start. 0 never hides it.", keywords: "jhud cutoff limit" }),
    ...JHUD_BANDS.map((b) => color(BAND_LABELS[b], () => J().colors[b], (v) => up((p) => (p.hud.jhud.colors[b] = v)), { swatches: Object.values(DEFAULT_JHUD.colors), keywords: "jhud colour color gain" })),
  ];
}

// ---------------------------------------------------------------------------------------------
// !ssj and !jhud panels

let open: HTMLDialogElement | null = null;

/** The Jump stats panel over the game. */
export const openSsjPanel = (): void => openPanel("Jump stats", ssjRows());

/** The JHUD panel over the game: the plugin's !jhud menu. */
export const openJhudPanel = (): void => openPanel("JHUD", jhudRows());

/** A settings panel over the game. Play pauses while it's open and resumes when it closes (the HUD editor's way). */
function openPanel(title: string, rows: HTMLElement[]): void {
  if (open) return;
  // From the chat (!ssj) the cursor is already free: play pauses under the panel all the same.
  const relock = !!document.pointerLockElement || takeFreeCursor();
  if (document.pointerLockElement) document.exitPointerLock();
  document.body.classList.add("ssj-open");
  const d = h("dialog.acct-dialog.ssj-dialog", { "aria-label": title }) as HTMLDialogElement;
  let viaClick = false;
  d.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape" && !e.defaultPrevented) (e.preventDefault(), d.close());
  });
  dismissOutside(d, () => ((viaClick = true), d.close()));
  d.addEventListener("close", () => {
    d.remove();
    open = null;
    document.body.classList.remove("ssj-open");
    // A click can take the pointer back (Esc can't: the pause menu shows, as after any Esc).
    if (relock && viaClick) void resumePlay();
  });
  const done = h("button.btn.btn-sm.primary", { type: "button", onclick: () => ((viaClick = true), d.close()) }, "Done");
  d.append(
    h("header.acct-head", null, h("h2", null, title), h("button.acct-close", { type: "button", "aria-label": "Close", onclick: () => ((viaClick = true), d.close()) }, "×")),
    h("div.acct-body.quick-set", null, group(null, ...rows), h("div.acct-actions", null, done)),
  );
  document.body.append(d);
  open = d;
  d.showModal();
  done.focus({ preventScroll: true });
}

registerChatCommand({
  name: "jhud",
  args: "[on|off]",
  help: "jump hud",
  about: "speed and gain of every jump near the crosshair, coloured by how it went. !jhud opens its settings; !jhud on or off just switches it.",
  group: "more",
  where: "both",
  run: (ctx, arg) => {
    const v = arg.toLowerCase();
    if (!v) return openJhudPanel();
    if (v !== "on" && v !== "off") return void ctx.reply("Usage: !jhud [on|off]");
    up((p) => (p.hud.layout.jhud.on = v === "on"));
    ctx.reply(`JHUD ${v}. !jhud for its settings; Edit layout moves it.`);
  },
});
registerChatCommand({ name: "ssj", help: "jump stats", about: "speed, gain and sync on your 6th jump, as a chat line (opens its settings).", group: "more", where: "both", run: () => openSsjPanel() });
