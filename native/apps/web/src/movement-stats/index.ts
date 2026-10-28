import { EVENT_JUMPED, EVENT_TELEPORTED, type PlayerState } from "../core";
import { EVENT_RESPAWNED, type RunTimer, type TickCmd } from "../timer";
import { prefs } from "../ui/settings";
import { registerChatCommand } from "../chat-commands";
import { postLocalLine } from "../net/hud";
import { announce } from "../audio";
import { actions, button, group, toggle } from "../ui/controls";
import { FirstJumpTracker, LjTracker, OffsetTracker, fjtText, ljColor, ljColumns, ljText, type LjReport, type OffsetReport } from "./stats";
import { h } from "../ui/dom";
import { forgetJump, openLastJump, rememberJump, type JumpResult } from "./share";

/** The chat line as nodes: the distance bold in its tier colour, the rest as plain text. */
function ljChatNodes(r: LjReport): (string | Node)[] {
  const dist = h("b", null, r.distance.toFixed(2));
  dist.style.color = ljColor(r);
  return [`${r.kind} `, dist, ...ljColumns(r).map(([n, l]) => ` | ${n} ${l}`)];
}

export interface MovementReading { offset: OffsetReport | null; fjt: number | null; lj: LjReport | null }
export class LiveMovementStats {
  private offsets = new OffsetTracker();
  private first = new FirstJumpTracker();
  private jumps = new LjTracker();
  private pre: PlayerState | null = null;
  private enabled = false;
  private shown: MovementReading = { offset: null, fjt: null, lj: null };
  private reading: MovementReading = { offset: null, fjt: null, lj: null };
  constructor(private show: (v: MovementReading) => void) {}
  reset(state: PlayerState | null): void {
    this.offsets.reset(); this.first.reset(); this.jumps.reset(); this.pre = state;
    this.reading = { offset: null, fjt: null, lj: null }; this.show(this.reading);
    this.shown = { ...this.reading };
  }
  feed(cmd: TickCmd, state: PlayerState, events: number, timer: RunTimer, context: Omit<JumpResult, "report" | "at">, noclip = false): void {
    const pre = this.pre; this.pre = state;
    if (!pre || noclip) { this.reset(state); return; }
    const p = prefs.get(), broken = !!(events & (EVENT_TELEPORTED | EVENT_RESPAWNED));
    const offsetsOn = p.hud.layout.strafeOffsets.on;
    const offset = offsetsOn ? this.offsets.feed(cmd, state, events, context.style) : null;
    if (!offsetsOn) { this.offsets.reset(); this.reading.offset = null; }
    if (broken || state.grounded) this.reading.offset = null;
    if (offset) this.reading.offset = offset;
    const fjt = this.first.feed({ jumped: !!(events & EVENT_JUMPED), jumps: timer.jumps, ticks: timer.ticks(), running: timer.status === "running", inStart: timer.inStart, broken });
    if (broken || timer.jumps === 0) this.reading.fjt = null;
    if (fjt !== undefined) {
      this.reading.fjt = fjt;
      if (p.hud.movement.fjtChat) postLocalLine(fjtText(fjt, timer.tickInterval));
    }
    if (this.enabled !== p.hud.movement.lj) { this.jumps.reset(); this.reading.lj = null; this.enabled = p.hud.movement.lj; }
    if (this.enabled) {
      const r = this.jumps.feed(pre, state, cmd, events, timer.tickInterval, context.style);
      if (r) {
        // A fail shows on the HUD only: the chat, the share card and the voice are for jumps that landed.
        this.reading.lj = r;
        if (!r.failed) {
          rememberJump({ ...context, report: r, at: Date.now() });
          if (p.hud.movement.ljChat) postLocalLine(ljText(r), ljChatNodes(r));
          if (r.kind === "LJ" && r.distance >= p.audio.announcer.ljThreshold) announce("lj");
        }
      }
    }
    if (broken) this.reading.lj = null;
    // Reports are immutable once published. Compare their identity without walking the retained flight path each tick.
    const r = this.reading, s = this.shown;
    if (r.lj !== s.lj || r.fjt !== s.fjt || r.offset?.ticks !== s.offset?.ticks || r.offset?.overlap !== s.offset?.overlap || r.offset?.gap !== s.offset?.gap) {
      this.shown = { ...r }; this.show(r);
    }
  }
}

export function movementRows(): HTMLElement[] {
  const p = () => prefs.get();
  return [
    group("Strafe timing",
      toggle("Strafe offsets", () => p().hud.layout.strafeOffsets.on, v => prefs.update(p => p.hud.layout.strafeOffsets.on = v), { desc: "A/D timing against mouse reversals, in ticks. Negative = key early, positive = key late; aim for -1 or 0. Normal, HSW and scroll styles. Edit layout moves it.", keywords: "offset offsets strafe early late key timing" }),
      toggle("First jump tick HUD", () => p().hud.layout.firstJump.on, v => prefs.update(p => p.hud.layout.firstJump.on = v), { desc: "First takeoff relative to the timer's start. A takeoff inside the start zone is 0. Edit layout moves it.", keywords: "fjt first jump tick start timing" }),
      toggle("First jump tick chat", () => p().hud.movement.fjtChat, v => prefs.update(p => p.hud.movement.fjtChat = v), { keywords: "fjt first jump tick chat" }),
    ),
    group("Longjump stats",
      toggle("Enable longjump stats", () => p().hud.movement.lj, v => prefs.update(p => { p.hud.movement.lj = v; if (v) p.hud.layout.longJump.on = true; }), { desc: "Clean, same-height jumps: distance, pre and max speed, strafes and sync. LJ after a ground run-up, BH after a recent hop; a jump that drops below its takeoff height shows as a fail. Distance is origin displacement + 32 units. Local stats only.", keywords: "lj longjump long jump jumpstats bhop distance" }),
      toggle("Longjump HUD", () => p().hud.layout.longJump.on, v => prefs.update(p => p.hud.layout.longJump.on = v), { desc: "Last clean jump. Edit layout moves and resizes it.", keywords: "lj longjump stats hud" }),
      toggle("Longjump chat", () => p().hud.movement.ljChat, v => prefs.update(p => p.hud.movement.ljChat = v), { keywords: "lj longjump chat stats" }),
      actions("Jump result", [button("Last jump", openLastJump)], { desc: "Your last jump as an image to copy or save, with its strafes. !ljlast opens it in game. Voice feedback is in Audio → Advanced → Announcer.", keywords: "lj longjump share discord image png announcer hera" }),
    ),
  ];
}

export function registerMovementStats(): void {
  forgetJump();
  for (const [name, aliases, get, set, help] of [
    ["offsets", ["offset"], () => prefs.get().hud.layout.strafeOffsets.on, (v: boolean) => prefs.update(p => p.hud.layout.strafeOffsets.on = v), "strafe offsets"],
    ["fjt", ["jumptick", "jt"], () => prefs.get().hud.layout.firstJump.on, (v: boolean) => prefs.update(p => { p.hud.layout.firstJump.on = v; p.hud.movement.fjtChat = v; }), "first jump tick"],
    ["lj", ["ljstats", "longjump"], () => prefs.get().hud.movement.lj, (v: boolean) => prefs.update(p => { p.hud.movement.lj = v; if (v) p.hud.layout.longJump.on = true; }), "longjump stats"],
  ] as const) registerChatCommand({ name, aliases: [...aliases], help, group: "more", where: "both", args: "[on|off]", run: (ctx, arg) => {
    const value = arg.toLowerCase();
    if (value && value !== "on" && value !== "off") return void ctx.reply(`Usage: !${name} [on|off]`);
    const on = value ? value === "on" : !get(); set(on); ctx.reply(`${help} ${on ? "on" : "off"}. Settings → HUD.`);
  } });
  registerChatCommand({ name: "ljlast", help: "view or share your last jump", group: "more", where: "both", key: "lastLj", run: openLastJump });
}
