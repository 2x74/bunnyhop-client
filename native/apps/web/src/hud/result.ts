// The end of a run (design audit ingame.md P1, P2, P9; feedback.md P2): the HUD timer becomes the result.
//
// No card: the time is set straight over the world in HUD type, at upper centre. On finish it flies there from the HUD
// timer (one FLIP transform: the eye follows the number it watched all run), its digits roll and lock left to right
// with three rising ticks, then the delta slides out from under it. Three tiers:
//   - a slower run: quiet. Muted red delta, no stamp, plain finish sting (session.ts).
//   - a PB: "New PB" stamps beside the delta; the corner PB readout is struck through and replaced (hud.ts pbLedger).
//   - faster than the world record we know of (session.ts fetches it once per map / style / track): the time turns gold
//     at once and breathes slowly while the server checks it. Verified as the record, it slams (stamp, one sheen,
//     confetti from the time itself, the WR sting) and the word becomes "World record". No separate banner in game.
// Under it: one quiet submission line, the reward reel (hud/reel.ts) and, after two seconds, "R to go again".
// While it's up its bottom edge is published as --endcard-bottom (it grows as lines arrive: the submission, a mode's
// line, the reel), and in-game whispers (notify.css: "♪ track", "Flashlight on") sit under it instead of on it.
// Everything is one-shot WAAPI on transform / opacity after the run; reduced motion lands it all at once (sounds stay).

import { h } from "../ui/dom";
import { formatTime } from "../timer";
import { duckMusic, sfx } from "../audio";
import { countUp, landIn, ring, stamp } from "../notify";
import { burst } from "../notify/confetti";
import { spring, SPRINGS } from "../notify/spring";
import { noteVerifiedRun } from "../ui/share";
import { celebrateRun, openCustomise, runRewards } from "../ui/unlocks";
import { hideUiHint, hideUiKey, uiHidden } from "../ui/hide-ui";
import { formatDelta, splitLead } from "./time-face";
import { hasRewards, playReel } from "./reel";
import { playedText } from "../map-time";
import type { Submission } from "../api";
import type { RunResult, SubmissionView } from "../hud";

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const potato = () => document.body.classList.contains("potato");

export interface ShowOptions {
  /** Where the HUD timer's digits were (the time flies from there); null: it just lands. */
  from: DOMRect | null;
  /** World record we know of for this board (seconds), or null. */
  wr: number | null;
  /** The restart key's label ("R"). */
  restartKey: string;
}

export class ResultCard {
  readonly el = h("div#hud-endcard", { role: "status", "aria-live": "polite", hidden: true });
  private sub = h("div.endcard-sub");
  private reel = h("div.endcard-reel", { hidden: true });
  private extra = h("div.endcard-extra", { hidden: true });
  private time: HTMLElement | null = null;
  private word: HTMLElement | null = null;
  private note: HTMLElement | null = null;
  private hint: HTMLElement | null = null;
  private result: RunResult | null = null;
  private provisional = false;
  private timers: number[] = [];
  private raf = 0;
  private stopReel: (() => void) | null = null;
  private progressSince: number | null = null;
  private lastVerified = "";
  private lastReward = "";
  /** Follows the card's height while it's up (publishBottom). */
  private sizes = typeof ResizeObserver === "function" ? new ResizeObserver(() => this.publishBottom()) : null;
  /** Called when a verified world record lands (the HUD keeps the new record time). */
  onRecord: ((time: number) => void) | null = null;

  get shown(): boolean {
    return !this.el.hidden;
  }

  show(r: RunResult, o: ShowOptions): void {
    this.cancel();
    this.result = r;
    this.lastVerified = "";
    const final = formatTime(r.time);
    const [lead, rest] = splitLead(final);
    const restNode = document.createTextNode(rest);
    this.provisional = r.newPB && o.wr !== null && r.time < o.wr;
    const delta = r.previousPB === null ? null : r.time - r.previousPB;
    const time = (this.time = h("div.ec-time", null, h("span.t-lead", null, lead), h("span.t-rest", null, restNode)));
    this.word = r.newPB ? h("b.ec-word", null, r.previousPB === null ? "First PB" : "New PB") : null;
    const deltaEl = delta === null ? null : h("span.ec-d", null, formatDelta(delta));
    const deltaRow = this.word || deltaEl ? h(`div.ec-delta${r.newPB ? ".ahead" : ".behind"}`, null, this.word, deltaEl) : null;
    this.note = this.provisional ? h("div.ec-note", null, "Faster than the world record. Checking it…") : null;
    // The map's attempts and time played on this device follow the run's own numbers.
    const onMap = r.onMap;
    const stats = h(
      "div.ec-stats",
      null,
      h("span", null, h("b", null, String(r.jumps)), " jumps"),
      h("span", null, h("b", null, String(r.strafes)), " strafes"),
      h("span", null, h("b", null, `${r.sync.toFixed(1)}%`), " sync"),
      onMap?.attempts ? h("span", null, h("b", null, String(onMap.attempts)), onMap.attempts === 1 ? " attempt" : " attempts") : null,
      onMap && onMap.seconds >= 60 ? h("span", null, h("b", null, playedText(onMap.seconds)), " played") : null,
    );
    this.el.className = this.provisional ? "wr-prov" : r.newPB ? "pb" : "slow";
    this.sub.className = "endcard-sub";
    this.sub.replaceChildren();
    this.reel.hidden = true;
    this.reel.replaceChildren();
    // The time (and its PB / WR word) floats over the world; the rest sits in one quiet card under it.
    const card = h("div.ec-card", null, stats, this.sub, this.reel, this.extra);
    this.hint = h("div.ec-hint", null, `${o.restartKey} to go again`);
    const parts: (HTMLElement | null)[] = [r.track ? h("div.ec-track", null, r.track) : null, time, deltaRow, this.note, card, this.hint];
    this.el.replaceChildren(...parts.filter((e): e is HTMLElement => !!e));
    this.el.hidden = false;
    this.sizes?.observe(this.el);
    this.publishBottom();
    if (reduced()) {
      sfx("count_tick", 1, 1.12);
      return;
    }
    // 0 ms: the time flies up from the HUD timer (FLIP: the same number, so the eye follows it) with a flash.
    const to = time.getBoundingClientRect();
    if (o.from && to.height > 0) {
      const dx = o.from.left + o.from.width / 2 - (to.left + to.width / 2);
      const dy = o.from.top + o.from.height / 2 - (to.top + to.height / 2);
      const s = Math.max(0.2, o.from.height / to.height);
      time.animate({ transform: [`translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${s.toFixed(3)})`, "none"] }, { ...spring(SPRINGS.pop), fill: "backwards" });
    } else landIn(time, "translateY(-10px) scale(0.96)");
    if (!potato()) {
      const flash = h("span.ec-flash", { "aria-hidden": "true" }, final);
      time.append(flash);
      flash.animate({ opacity: [1, 1, 0], offset: [0, 0.27, 1] }, { duration: 300, easing: "ease-out" }).finished.then(() => flash.remove(), () => flash.remove());
    }
    // 0–280 ms: the digits roll, then lock left to right (minutes, seconds, milliseconds), a tick each, rising.
    this.roll(restNode, rest);
    // ~320 ms: the delta slides out from under the time; a PB stamps its word.
    if (deltaRow) landIn(deltaRow, "translateY(-6px)", 320);
    if (this.word) stamp(this.word, 430);
    if (this.note) landIn(this.note, "translateY(-4px)", 520);
    card.animate({ opacity: [0, 1], transform: ["translateY(6px)", "none"] }, { duration: 260, delay: 380, easing: "ease-out", fill: "backwards" });
  }

  /** The digits of `rest` spin, then lock in three groups ("1:31" / ".42" / "0"-ish: up to each separator). */
  private roll(node: Text, rest: string): void {
    const locks = [rest.indexOf(":") + 1, rest.indexOf(".") + 1, rest.length].filter((v, i, a) => v > 0 && a.indexOf(v) === i);
    const at = [110, 195, 280];
    const t0 = performance.now();
    let locked = 0;
    let shown = "";
    const spin = (keep: number) => rest.slice(0, keep) + rest.slice(keep).replace(/\d/g, () => String((Math.random() * 10) | 0));
    const frame = () => {
      const t = performance.now() - t0;
      while (locked < locks.length && t >= at[locked]) {
        sfx("count_tick", 1, 1 + locked * 0.12);
        locked++;
      }
      const keep = locked ? locks[locked - 1] : 0;
      if (keep >= rest.length) {
        node.data = rest;
        this.raf = 0;
        return;
      }
      const s = spin(keep);
      if (s !== shown) node.data = shown = s;
      this.raf = requestAnimationFrame(frame);
    };
    node.data = spin(0);
    this.raf = requestAnimationFrame(frame);
  }

  /** Updates the submission line (queued -> verifying -> verified #3), the WR moment and the reward reel. */
  setSubmission(s: SubmissionView): void {
    let text = "";
    let cls = "";
    let progress: number | null = null;
    if (s.status !== "verifying") this.progressSince = null;
    switch (s.status) {
      case "local":
        text = "Saved on this device.";
        cls = "dim";
        break;
      case "submitting":
        text = "Submitting…";
        cls = "pending";
        break;
      case "queued":
        text = "Waiting for verification…";
        cls = "pending";
        break;
      case "verifying":
        text = "Verifying replay…";
        cls = "pending";
        // Long runs report how far the server's re-simulation is (GET /submissions/:id `progress`). The bar only shows
        // once there's something to show, so a run that verifies in a moment never flashes one.
        if ("progress" in s && s.progress !== undefined) {
          this.progressSince ??= performance.now();
          if (s.progress > 0 || performance.now() - this.progressSince > 1500) progress = s.progress;
        }
        if (progress !== null) text = `Verifying replay… ${Math.floor(progress * 100)}%`;
        break;
      case "verified":
        noteVerifiedRun(s.id); // Esc → Replays → Share this run
        if ("rank" in s && s.id !== this.lastVerified) {
          this.lastVerified = s.id;
          this.showVerified(s);
        }
        if ("xp" in s && s.xp !== undefined && s.id !== this.lastReward) {
          this.lastReward = s.id;
          const r = runRewards(s);
          // Achievements and unlocks: the cards at the bottom (ui/unlocks.ts). XP and the level: the reel, here.
          celebrateRun(r, openCustomise);
          const d = { xp: s.xp ?? 0, levelUp: r.levelUp };
          if (hasRewards(d)) {
            this.stopReel?.();
            this.stopReel = playReel(this.reel, d, 420);
          }
        }
        if (this.sub.querySelector(".ec-n, .ec-rank")) return; // the counted line (showVerified) stays
        text = "Verified";
        cls = "ok";
        break;
      case "rejected":
        if ("code" in s && s.code === "unranked_map") {
          text = "Unranked map. Saved on this device.";
          cls = "dim";
        } else if (s.id) {
          if (s.reason) console.info("run not accepted:", s.reason);
          text = "Not accepted: the replay didn't check out.";
          cls = "bad";
          this.el.classList.add("rejected");
        } else {
          // Practice runs: expected, not a failure.
          text = `Not submitted${s.reason ? `: ${s.reason}` : ""}.`;
          cls = "dim";
        }
        this.unprovisional();
        break;
      case "unsent":
        // Kept on this device (uploads.ts) and sent once more: after a moment for a lost connection, on the next visit
        // otherwise (the size limit may have been raised by then).
        if (!this.sub.classList.contains("bad")) sfx("ui_error");
        text = s.failure === "network" ? "Couldn't upload. Trying again soon." : "Couldn't upload. It goes up next time you play.";
        cls = "bad";
        this.unprovisional();
        break;
      case "error":
        if (!this.sub.classList.contains("bad")) sfx("ui_error");
        // With an id: uploaded, but the server couldn't verify it (our problem, not the run's). Without: upload failed.
        text = "id" in s && s.id ? "The server couldn't verify it. Your run is saved." : "Couldn't submit. Saved on this device.";
        cls = "bad";
        this.unprovisional();
        break;
    }
    if (s.status !== "verified") {
      this.reel.hidden = true;
      this.stopReel?.();
      this.stopReel = null;
    }
    // With the UI hidden the result can't be seen: a run that didn't make it says so in one quiet line (ui/hide-ui.ts).
    if (cls === "bad" && uiHidden() && this.sub.className !== `endcard-sub ${cls}`) {
      const key = hideUiKey();
      hideUiHint(`Your run wasn't submitted. ${key ? `Press ${key} to see why.` : "Show the UI to see why."}`);
    }
    this.sub.className = `endcard-sub ${cls}`;
    this.sub.textContent = text;
    if (progress !== null) {
      const bar = h("div.endcard-progress", { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.floor(progress * 100)) }, h("i"));
      (bar.firstChild as HTMLElement).style.transform = `scaleX(${progress.toFixed(3)})`;
      this.sub.append(bar);
    }
  }

  /** "Rank #3   +120 pts": the place stamps (a top-10 place rings once), the points count up. A WR slams the time. */
  private showVerified(s: Submission): void {
    const r = this.result;
    const wr = s.announcer === "wr" || (s.announcer == null && s.rank === 1 && !!r?.newPB);
    const rank = s.rank ? h(`b.ec-rank${s.rank <= 10 ? ".top" : ""}`, null, `#${s.rank}`) : null;
    const pts = s.points ? h("b.ec-n", null, "+0") : null;
    this.sub.className = "endcard-sub ok";
    this.sub.replaceChildren(...(rank ? ["Rank ", rank] : ["Verified"]), ...(pts ? [h("span.ec-gap"), pts, " pts"] : []));
    if (rank) {
      stamp(rank, 80);
      if (!wr && s.rank! <= 10) window.setTimeout(() => rank.isConnected && ring(rank, "var(--gain)"), 300);
    }
    if (pts) this.timers.push(window.setTimeout(() => countUp(pts, 0, Math.round(s.points!), 700, undefined, (v) => `+${v}`), 200));
    if (wr) this.slam(s);
    else this.unprovisional();
  }

  /** The verified world record: the time stamps, one sheen crosses it, confetti leaves from it, the WR sting. */
  private slam(s: Submission): void {
    const time = this.time;
    if (!time) return;
    this.provisional = false;
    this.el.className = "wr";
    this.note?.remove();
    this.note = null;
    if (this.word) this.word.textContent = "World record";
    else {
      this.word = h("b.ec-word", null, "World record");
      time.after(h("div.ec-delta.ahead", null, this.word));
    }
    sfx("finish_wr");
    duckMusic(0.25, 3);
    const t = this.result?.time ?? s.time;
    if (t !== undefined) this.onRecord?.(t);
    if (reduced()) return;
    stamp(time);
    stamp(this.word, 140);
    if (potato()) return;
    const sheen = h("span.ec-sheen", { "aria-hidden": "true" }, time.textContent ?? "");
    time.append(sheen);
    sheen.animate({ backgroundPosition: ["150% 0", "-50% 0"] }, { duration: 600, delay: 220, easing: "ease-in-out", fill: "backwards" }).finished.then(() => sheen.remove(), () => sheen.remove());
    // Confetti from the time's own position (not the screen edge), once it has landed.
    this.timers.push(
      window.setTimeout(() => {
        if (!time.isConnected) return;
        const b = time.getBoundingClientRect();
        burst({ x: b.left + b.width / 2, y: b.top + b.height * 0.5, count: 140, spread: 160, power: 0.8 });
      }, 120),
    );
  }

  /** Not the record after all (slower than a newer WR, rejected, failed): the gold goes. */
  private unprovisional(): void {
    if (!this.provisional) return;
    this.provisional = false;
    this.el.classList.replace("wr-prov", "pb");
    this.note?.remove();
    this.note = null;
  }

  /** The last line ("R to go again"): another text, or hidden (null). The next result has the usual one. */
  setHint(text: string | null): void {
    if (!this.hint) return;
    this.hint.hidden = text === null;
    if (text !== null) this.hint.textContent = text;
  }

  /** Extra content under the stats, set by a mode (the tutorial's final-course board); null: none. */
  setExtra(el: Node | null): void {
    this.extra.replaceChildren(...(el ? [el] : []));
    this.extra.hidden = !el;
  }

  private cancel(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.stopReel?.();
    this.stopReel = null;
  }

  hide(): void {
    this.cancel();
    this.setExtra(null);
    this.el.hidden = true;
    this.sizes?.unobserve(this.el);
    this.publishBottom();
    this.result = null;
    this.provisional = false;
  }

  /** The card's bottom edge (its layout box: the HUD layer is the viewport) for notify.css, or none while it's hidden. */
  private publishBottom(): void {
    const root = document.documentElement.style;
    if (this.el.hidden || !this.el.isConnected) root.removeProperty("--endcard-bottom");
    else root.setProperty("--endcard-bottom", `${this.el.offsetTop + this.el.offsetHeight}px`);
  }
}
