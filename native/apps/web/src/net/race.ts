// !race on the client (research/RACE.md; the rules and the result are the room's: apps/api/src/rooms/race.ts). This
// is the racer's side of it, driven by net/mp.ts:
//
//   - picking: !race alone (or Esc → Server → Race a player) opens numbered menus: player, track (maps with bonuses),
//     style (main track); a typed !race <player> [style] [main|bonus] is resolved here. Either way the room gets
//     "/race #slot style track".
//   - a challenge to you: a menu (1 Accept / 2 Decline) until it expires.
//   - countdown: you're switched to the race's style and put on the track's start; movement is held (the view still
//     turns) with the map-change banner and its countdown beeps. At GO (the room's `live` message, sent at the server's
//     GO time) you're put on the start again and let go. Never on the local clock: its offset from the room's can be off
//     by the first ping, and a start before GO would make the run not count (arrival - run time >= GO).
//   - countdown: big numerals at crosshair height stamp in (3, 2, 1), GO in gold blows outward (#mp-count).
//   - live: a line at the top: opponent, the race clock (to tenths: it redraws at 5 Hz), their live timer (snapshot
//     meta), their finish once in.
//   - over: both times stacked, the winner's on top, and one line under them ("You won"); the loser's lands a beat later.
//   - runs: while live, finished runs on the race's map / style / track are submitted with ?race=<id> (net/presence.ts
//     raceTag): the room ties them to the race. Their verification decides it.

import { clear, h } from "../ui/dom";
import { formatTime } from "../timer";
import { STYLE_DEFS, styleLabel, type StyleId } from "../styles";
import { trackName } from "../zones";
import { styleByName } from "../chat-commands";
import { sfx } from "../audio";
import { landIn, stamp } from "../notify";
import { setRaceTag } from "./presence";
import { TIMER_FINISHED, TIMER_RUNNING, TIMER_START, type RaceSide, type RaceView } from "./protocol";
import type { Banner, NumberMenu } from "./hud";

/** What the race needs from the room controller (net/mp.ts). */
/** !race off (localStorage): challenges stay off across maps and rooms until !race on. */
const RACE_OFF_KEY = "bunnyhop:race-off";

export interface RaceHost {
  menu: NumberMenu;
  banner: Banner;
  /** Other players who could race (not spectating), by slot. */
  others(): { slot: number; name: string }[];
  /** A slot's live timer from its snapshot meta: TIMER_* status and seconds, or null. */
  remoteTimer(slot: number): { status: number; seconds: number } | null;
  /** Server time -> local Date.now() time. */
  toLocal(serverTime: number): number;
  /** Sends a chat line to the room as typed. */
  send(text: string): void;
  reply(text: string): void;
  selectedStyle(): StyleId;
  setStyle(id: StyleId): Promise<void>;
  bonusTracks(): number[];
  restart(track: number): void;
  spectating(): boolean;
  stopSpectating(): void;
  /** The room's map-change banner is up (it has the banner then). */
  changing(): boolean;
}

/** How long the result stays on the race line. */
const RESULT_MS = 8000;

const desc = (r: Pick<RaceView, "map" | "style" | "track">) => (r.track ? trackName(r.track) : styleLabel(r.style));

export class RaceUi {
  /** The race you're in (null: none). */
  race: RaceView | null = null;
  readonly el = h("div#mp-race", { hidden: true, role: "status" });
  /** 3, 2, 1, GO at crosshair height. */
  private count = h("div#mp-count", { hidden: true, "aria-hidden": "true" });
  private countShown = "";
  private resultFor = "";
  private wentFor = "";
  private preparedFor = "";
  private lastBeep = -1;
  private resultUntil = 0;

  constructor(
    parent: HTMLElement,
    private o: RaceHost,
  ) {
    parent.append(this.el, this.count);
    setRaceTag((run) => {
      const r = this.race;
      return r && r.state === "live" && run.map === r.map && run.style === r.style && run.track === r.track ? r.id : null;
    });
  }

  /** On every welcome: a player who turned challenges off keeps them off in every room (the room only knows this connection). */
  connected(): void {
    if (localStorage.getItem(RACE_OFF_KEY) === "1") this.o.send("/race off");
  }

  /** Movement is held during the countdown (net/mp.ts filterInput). */
  get frozen(): boolean {
    const r = this.race;
    return !!r && r.state === "countdown" && this.preparedFor === r.id;
  }

  // -------------------------------------------------------------------------------------------
  // The room's messages

  /** A `race` message (or the welcome's race). */
  onState(r: RaceView | null): void {
    const prev = this.race;
    if (!r) {
      this.race = null;
      this.o.menu.hide("race-prompt");
      this.render();
      return;
    }
    if (r.state === "over") {
      // A challenge that never started (declined, expired, withdrawn): its chat line says it all.
      this.race = r.goAt !== null ? r : null;
      this.o.menu.hide("race-prompt");
      this.resultUntil = Date.now() + RESULT_MS;
      const won = r.winner === r.you;
      if (r.goAt !== null && r.winner) sfx(won ? "finish_pb" : "chat");
      if (prev?.state === "countdown" && !this.o.changing()) this.o.banner.set(null);
      this.render();
      return;
    }
    this.race = r;
    if (r.state === "challenge") {
      if (r.you === "b" && prev?.id !== r.id) {
        sfx("vote_open");
        this.prompt();
      }
    } else this.o.menu.hide("race-prompt");
    if (r.state === "countdown") void this.prepare(r);
    if (r.state === "live" && this.wentFor !== r.id) {
      // GO. (A reconnect mid-race only gets the race back: a race started long ago isn't restarted.)
      if (prev?.id === r.id && prev.state === "countdown") this.go(r);
      else this.wentFor = r.id;
    }
    this.render();
  }

  /** 1 Accept / 2 Decline, refreshed with the time left. */
  private prompt(): void {
    const r = this.race;
    if (!r || r.state !== "challenge" || r.you !== "b") return this.o.menu.hide("race-prompt");
    const left = Math.max(0, Math.ceil((this.o.toLocal(r.expiresAt ?? 0) - Date.now()) / 1000));
    const spec = {
      title: `Race challenge from ${r.a.name}`,
      items: [
        { label: "Accept", detail: `${r.map} · ${desc(r)}` },
        { label: "Decline", detail: "" },
      ],
      footer: `${left} s`,
      exit: "Hide",
      onPick: (i: number) => {
        this.o.menu.hide("race-prompt");
        this.o.send(i === 0 ? "/accept" : "/decline");
      },
    };
    if (this.o.menu.id.current === "race-prompt") this.o.menu.update("race-prompt", spec);
    else this.o.menu.show("race-prompt", spec);
  }

  /** Countdown: the race's style, on the track's start; GO on the room's clock. */
  private async prepare(r: RaceView): Promise<void> {
    if (this.preparedFor === r.id) return;
    this.preparedFor = r.id;
    this.lastBeep = -1;
    if (this.o.spectating()) this.o.stopSpectating();
    if (r.track === 0 && this.o.selectedStyle() !== r.style) await this.o.setStyle(r.style);
    if (this.race?.id !== r.id) return;
    this.o.restart(r.track);
    this.o.reply(`Race vs ${this.opponent(r).name}: ${r.map} · ${desc(r)}. !forfeit to give up.`);
  }

  /** GO: back on the start, moving. */
  private go(r: RaceView): void {
    if (this.wentFor === r.id) return;
    this.wentFor = r.id;
    if (this.o.spectating()) this.o.stopSpectating();
    this.o.restart(r.track);
    sfx("countdown_go");
    if (!this.o.changing()) this.o.banner.set(null);
    this.showCount("GO");
    this.render();
  }

  private opponent(r: RaceView): RaceSide {
    return r.you === "a" ? r.b : r.a;
  }

  // -------------------------------------------------------------------------------------------
  // Picking (!race, Esc → Server → Race a player)

  /** !race [player] [style] [main|bonus] / !race cancel. */
  command(arg: string): void {
    const a = arg.trim();
    if (!a) return this.pickPlayer();
    if (a.toLowerCase() === "cancel") return this.o.send("/race cancel");
    if (a.toLowerCase() === "off" || a.toLowerCase() === "on") {
      if (a.toLowerCase() === "off") localStorage.setItem(RACE_OFF_KEY, "1");
      else localStorage.removeItem(RACE_OFF_KEY);
      return this.o.send(`/race ${a.toLowerCase()}`);
    }
    const others = this.o.others();
    const low = a.toLowerCase();
    // The longest name the line starts with (names have spaces), else a unique prefix of the first word, else #slot.
    let who = others.filter((p) => low === p.name.toLowerCase() || low.startsWith(`${p.name.toLowerCase()} `)).sort((x, y) => y.name.length - x.name.length)[0];
    let rest = who ? a.slice(who.name.length) : "";
    if (!who) {
      const [first, ...more] = a.split(/\s+/);
      const slot = /^#(\d+)$/.exec(first);
      const m = slot ? others.filter((p) => p.slot === Number(slot[1])) : others.filter((p) => p.name.toLowerCase().startsWith(first.toLowerCase()));
      if (m.length !== 1) return this.o.reply(m.length ? `"${first}" matches ${m.length} players. Type more of the name, or !race for the menu.` : `No player "${first}" to race.`);
      who = m[0];
      rest = more.join(" ");
    }
    let style = this.o.selectedStyle();
    let track = 0;
    for (const w of rest.split(/\s+/).filter(Boolean)) {
      const l = w.toLowerCase();
      const b = /^(?:b|bonus)(\d{0,2})$/.exec(l);
      if (l === "main" || l === "m") track = 0;
      else if (b) track = b[1] ? Number(b[1]) : 1;
      else {
        const id = styleByName(w);
        if (!id) return this.o.reply(`No style "${w}". !style lists them.`);
        style = id;
      }
    }
    if (track && !this.o.bonusTracks().includes(track)) return this.o.reply(this.o.bonusTracks().length ? `This map has no ${trackName(track)}.` : "This map has no bonus.");
    this.send(who.slot, style, track);
  }

  private send(slot: number, style: StyleId, track: number): void {
    this.o.send(`/race #${slot} ${style} ${track}`);
  }

  /** Menu 1: who. */
  pickPlayer(page = 0): void {
    if (this.race && this.race.state !== "over") return this.o.reply(this.race.state === "challenge" && this.race.you === "a" ? "You have a challenge out (!race cancel to withdraw)." : "You're in a race (!forfeit to give up).");
    const all = this.o.others();
    if (!all.length) return this.o.reply("Nobody here to race.");
    const per = 7;
    const pages = Math.ceil(all.length / per);
    const list = all.slice(page * per, page * per + per);
    const items = list.map((p) => ({ label: p.name, detail: "" }));
    if (pages > 1) items.push({ label: "More…", detail: `${page + 1}/${pages}` });
    this.o.menu.show("race", {
      title: "Race a player",
      items,
      onPick: (i) => (i >= list.length ? this.pickPlayer((page + 1) % pages) : this.pickTrack(list[i])),
    });
  }

  /** Menu 2: the track (maps with a bonus). */
  private pickTrack(p: { slot: number; name: string }): void {
    const bonus = this.o.bonusTracks().slice(0, 8);
    if (!bonus.length) return this.pickStyle(p);
    const tracks = [0, ...bonus];
    this.o.menu.show("race", {
      title: `Race ${p.name}: track`,
      items: tracks.map((t) => ({ label: trackName(t), detail: t ? "Normal" : "" })),
      onPick: (i) => (tracks[i] ? (this.o.menu.hide("race"), this.send(p.slot, "autohop", tracks[i])) : this.pickStyle(p)),
    });
  }

  /** Menu 3: the style (main track). */
  private pickStyle(p: { slot: number; name: string }): void {
    const cur = this.o.selectedStyle();
    this.o.menu.show("race", {
      title: `Race ${p.name}: style`,
      items: STYLE_DEFS.map((d) => ({ label: d.name, detail: d.id === cur ? "yours" : "", selected: d.id === cur })),
      onPick: (i) => {
        this.o.menu.hide("race");
        this.send(p.slot, STYLE_DEFS[i].id, 0);
      },
    });
  }

  // -------------------------------------------------------------------------------------------
  // HUD (net/mp.ts refreshUi, 5 Hz)

  refresh(): void {
    const r = this.race;
    if (r?.state === "challenge" && r.you === "b" && this.o.menu.id.current === "race-prompt") this.prompt();
    if (r?.state === "countdown" && r.goAt !== null && !this.o.changing()) {
      const s = Math.max(0, Math.ceil((this.o.toLocal(r.goAt) - Date.now()) / 1000));
      if (s !== this.lastBeep && s <= 3 && s > 0) sfx("countdown_tick");
      this.lastBeep = s;
      if (s > 0) {
        this.o.banner.set(`Race vs ${this.opponent(r).name}`, `${r.map}, ${desc(r)}`, "change");
        this.showCount(String(s));
      }
    } else if (r?.state !== "live" && this.countShown && this.countShown !== "GO") this.showCount(null);
    if (r?.state === "over" && Date.now() > this.resultUntil) this.race = null;
    this.render();
  }

  /** The countdown numeral: each one stamps in at crosshair height; GO is gold and blows outward. null hides it. */
  private showCount(text: string | null): void {
    if (text === this.countShown) return;
    this.countShown = text ?? "";
    const el = this.count;
    el.getAnimations().forEach((a) => a.cancel());
    if (!text) {
      el.hidden = true;
      return;
    }
    el.textContent = text;
    el.className = text === "GO" ? "go" : "";
    el.hidden = false;
    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (text === "GO") {
      const a = el.animate({ transform: ["scale(1.5)", "scale(1)", "scale(1.4)"], opacity: [0, 1, 0], offset: [0, 0.3, 1] }, { duration: calm ? 500 : 650, easing: "ease-out" });
      a.finished.then(() => this.countShown === "GO" && this.showCount(null), () => {});
    } else if (!calm) el.animate({ transform: ["scale(1.6)", "scale(0.96)", "none"], opacity: [0, 1, 1], offset: [0, 0.6, 1] }, { duration: 300, easing: "cubic-bezier(0.2, 0.9, 0.3, 1)" });
  }

  private render(): void {
    const r = this.race;
    document.getElementById("hud")?.classList.toggle("race-result", r?.state === "over");
    if (!r || r.state === "challenge" || r.state === "countdown") {
      this.el.hidden = true;
      return;
    }
    const opp = this.opponent(r);
    const me = r.you === "a" ? r.a : r.b;
    this.el.hidden = false;
    if (r.state === "over") return this.renderResult(r, me, opp);
    const fin = (f: RaceSide["finish"]) => (f ? `${formatTime(f.real)}${f.status === "verifying" ? " (checking)" : f.status === "rejected" ? " (rejected)" : ""}` : null);
    const go = r.goAt !== null ? this.o.toLocal(r.goAt) : Date.now();
    // Tenths: the line redraws at 5 Hz, so milliseconds visibly jumped.
    const clock = r.state === "settling" ? "checking" : formatTime(Math.max(0, (Date.now() - go) / 1000)).slice(0, -2);
    const mine = fin(me.finish);
    let theirs = fin(opp.finish) ?? (opp.out === "forfeit" ? "forfeited" : opp.out === "left" ? "left" : "");
    if (!theirs && opp.slot !== null) {
      const t = this.o.remoteTimer(opp.slot);
      theirs = !t ? "" : t.status === TIMER_RUNNING || t.status === TIMER_FINISHED ? formatTime(t.seconds).slice(0, -2) : t.status === TIMER_START ? "start zone" : "";
    }
    this.el.className = "";
    clear(
      this.el,
      h("span.rc-what", null, "Race vs ", h("b", null, opp.name)),
      h("b.rc-clock", null, clock),
      mine ? h("span.rc-side", null, h("span.dim", null, "you "), mine) : null,
      theirs ? h("span.rc-side", null, h("span.dim", null, `${opp.name} `), theirs) : null,
    );
  }

  /** Both times stacked, the winner's on top, one line under them. Lands once per race. */
  private renderResult(r: RaceView, me: RaceSide, opp: RaceSide): void {
    const won = r.winner === r.you;
    const verdict = won ? "You won" : r.winner ? `${opp.name} won` : r.outcome === "draw" ? "Draw" : r.outcome === "timeout" ? "Nobody finished" : "Race over";
    const time = (sd: RaceSide) => (sd.finish ? formatTime(sd.finish.real) : sd.out === "forfeit" ? "forfeited" : sd.out === "left" ? "left" : "no finish");
    const row = (sd: RaceSide, name: string, top: boolean) => h(`div.rc-row${top ? ".top" : ""}`, null, h("span.rc-name", null, name), h("b.rc-t", null, time(sd)));
    const meFirst = won || (!r.winner && (me.finish?.real ?? Infinity) <= (opp.finish?.real ?? Infinity));
    const a = meFirst ? row(me, "you", true) : row(opp, opp.name, true);
    const b = meFirst ? row(opp, opp.name, false) : row(me, "you", false);
    const v = h("div.rc-verdict", null, verdict);
    this.el.className = `result ${won ? "won" : "lost"}`;
    clear(this.el, a, b, v);
    if (this.resultFor === r.id) return;
    this.resultFor = r.id;
    landIn(a, "translateY(-8px)");
    landIn(b, "translateY(-8px)", 200);
    stamp(v, 360);
  }

  dispose(): void {
    setRaceTag(null);
  }
}
