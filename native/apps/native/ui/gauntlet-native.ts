// Gauntlet mode in the native client: the web's gauntlet/mode.ts (GauntletMode, resolveGauntlet) with the host in place
// of the page. The web opens the game with ?gauntlet=<attemptId> and reloads for every map; here the menu keeps the
// attempt and tells the host:
//   menu → host  {type:"gauntlet", id, map, progress}   lock Normal + main track, no practice, the HUD's gauntlet line
//                {type:"gauntlet", id:null}              the attempt is over here (the map plays on by itself)
//                {type:"selectMap", id, style:"autohop", track:0} / {type:"restart"}   the attempt's map
//                {type:"hudToast", key:"gauntlet", ...}  the split line, over the game
//   host → menu  state.gauntlet {id, map}                the lock as the host applied it
// Everything else is the web's: the attempt from the API, the minute ping (the server expires an attempt after 10
// minutes without one), the first finish on the map as the candidate (state.ts SplitGate, submitted with ?gauntlet= by
// the run service), the split line, the next map after NEXT_MAP_MS (Enter or a click goes at once), the result screen
// after the last one. DOM-free apart from the Enter/click listener (gauntlet-native.test.ts).

import { ApiError, type GauntletAttempt, type GauntletAttemptState, type GauntletDetail, type GauntletSplitResult } from "../../web/src/api";
import {
  endedText,
  forgetAttempt,
  GAUNTLET_STYLE,
  NEXT_MAP_MS,
  offlineResume,
  PING_MS,
  progressOf,
  rememberAttempt,
  resumeTarget,
  RETRY_MS,
  savedAttempt,
  SplitGate,
  splitLine,
  splitOutcome,
  type GauntletProgress,
  type SplitOutcome,
} from "../../web/src/gauntlet/state";
import type { GauntletHudProgress, MenuMessage } from "./bridge";
import type { RunServiceStatus } from "./run-service";

export interface GauntletApi {
  gauntletAttempt(id: string): Promise<GauntletAttempt>;
  pingGauntlet(id: string): Promise<{ id: string; state: GauntletAttemptState; step: number; expiresAt: number | null }>;
  gauntlet(slug: string): Promise<Pick<GauntletDetail, "me">>;
}

export interface GauntletHost {
  api: GauntletApi;
  send: (message: MenuMessage) => void;
  /** The host's loaded map and whether a load is going. */
  map: () => string | null;
  loading: () => boolean;
  /** A line in the menu (the web's toast). */
  notice: (text: string) => void;
  /** An attempt's result screen (ui/gauntlets.ts gauntletResult). */
  result: (slug: string, attempt: string) => void;
  /** The split line on the finish card, or null to clear it. */
  line: (text: string | null, ok: boolean) => void;
  /** The confirmed account id, null when signed out, undefined when it can't be confirmed now (offline / stale). */
  account?: () => Promise<string | null | undefined>;
  /** Enter / a click: go to the next map at once. Returns the way to stop listening. */
  listenGo?: (go: () => void) => () => void;
  setTimeout?: (fn: () => void, ms: number) => number;
  clearTimeout?: (id: number) => void;
  now?: () => number;
}

/** What a finished run's status says for a tagged run (gauntlet/state.ts submissionOutcome, for the run service). */
export function statusOutcome(status: RunServiceStatus, maps: number): SplitOutcome | null {
  if (status.gauntlet) return splitOutcome(status.gauntlet, maps);
  // The run service sends it again (holdGauntlet): still the candidate, no later finish here takes its place.
  if (status.held) return { kind: "held" };
  if (status.status === "rejected") return { kind: "refused", reason: status.message ? `the run was refused (${status.message})` : "the run was refused" };
  // Given up (no connection for the grace period, the account changed, the build isn't allowed): go again here.
  if (status.status === "kept" || status.status === "error") return { kind: "refused", reason: "the run didn't upload" };
  if (status.status === "verified" || status.status === "pending") return splitOutcome(undefined as GauntletSplitResult | undefined, maps);
  return null;
}

export const hudProgress = (p: GauntletProgress): GauntletHudProgress => ({ idx: p.idx, maps: p.maps, before: p.before, pbSplit: p.pbSplit });

export class NativeGauntlet {
  private attempt: GauntletAttempt | null = null;
  private idx = 0;
  private mapName = "";
  private progress: GauntletProgress | null = null;
  private gate: SplitGate | null = null;
  private offline = false;
  /** The map has been on screen in this attempt (after that, the host showing another map ends gauntlet mode). */
  private arrived = false;
  /** The run service generation the candidate was tagged in, and its time. */
  private awaiting: { generation: number; time: number | null } | null = null;
  private pingTimer = 0;
  private goTimer = 0;
  private unlisten: (() => void) | null = null;
  /** Bumped by every start / leave / end: answers for an older attempt (or a lookup that was left) are dropped. */
  private epoch = 0;
  /**
   * The account the attempt belongs to: confirmed when it started, or later by the server answering for the attempt
   * under the signed-in account (it only shows you your own). undefined: not known yet. Another account lets it go.
   */
  private owner: string | null | undefined;
  /** Bumped by every onAccount (and start / leave / end): only the latest account's server answer may bind or end. */
  private accountCheck = 0;

  constructor(private h: GauntletHost) {}

  private get set() { return this.h.setTimeout ?? ((fn: () => void, ms: number) => window.setTimeout(fn, ms)); }
  private get clear() { return this.h.clearTimeout ?? ((id: number) => window.clearTimeout(id)); }
  private get now() { return this.h.now ?? Date.now; }

  /** The attempt being played, if any. */
  get id(): string | null { return this.attempt?.id ?? null; }
  get map(): string | null { return this.attempt ? this.mapName : null; }
  get modeLock(): string | null { return this.attempt ? "Gauntlets are Normal style on the main track." : null; }

  /**
   * Opens attempt `id` (the web's ?gauntlet=<id>, with ?map= when the link had one): plays its current map, or shows
   * its result when it's done, or says why it can't be played (web resolveGauntlet).
   */
  async start(id: string, urlMap: string | null = null): Promise<void> {
    this.leave();
    const epoch = ++this.epoch;
    const owner = this.h.account ? await this.h.account().catch(() => undefined) : undefined;
    if (epoch !== this.epoch) return;
    let a: GauntletAttempt;
    try {
      a = await this.h.api.gauntletAttempt(id);
    } catch (e) {
      if (epoch !== this.epoch) return;
      const gone = e instanceof ApiError && (e.status === 404 || e.status === 401);
      const saved = gone ? null : savedAttempt(id);
      const play = saved ? offlineResume(saved, id, urlMap ?? saved.a.next?.map ?? null, this.now()) : null;
      if (saved && play) {
        this.owner = owner;
        return this.begin(saved.a, play.map, play.idx, true);
      }
      if (gone) forgetAttempt(id);
      this.h.notice(gone ? endedText("unknown") : "Couldn't reach the gauntlet. Try again in a moment.");
      return;
    }
    if (epoch !== this.epoch) return;
    // The native client has no page address to be on the wrong map: the attempt's next map is the one to play.
    const r = resumeTarget(a, a.next?.map ?? urlMap);
    if (r.kind === "result") return this.h.result(a.gauntlet.slug, a.id);
    if (r.kind === "ended") {
      forgetAttempt(id);
      this.h.notice(endedText(r.state));
      return;
    }
    if (r.kind === "play") {
      this.owner = owner;
      return this.begin(a, r.map, r.idx, false);
    }
  }

  /**
   * The signed-in account changed (or was refreshed), with its confirmed id (null: signed out). An attempt of another
   * account is let go here. One whose owner isn't known yet (started offline) is asked of the server under this
   * account: its answer names the owner, never a guess; "not yours" ends it, no answer leaves it unknown.
   */
  onAccount(id: string | null): void {
    const a = this.attempt;
    const check = ++this.accountCheck;
    if (!a) return;
    if (this.owner !== undefined) {
      if (id !== this.owner) this.leave();
      return;
    }
    if (id === null) return this.leave();
    const epoch = this.epoch;
    // Only the answer to the latest account check counts: an earlier account's late reply neither binds nor ends.
    const current = () => epoch === this.epoch && check === this.accountCheck && this.attempt === a;
    this.h.api.gauntletAttempt(a.id).then(
      (server) => { if (current() && server.id === a.id) this.owner = id; },
      (e) => { if (current() && e instanceof ApiError && (e.status === 404 || e.status === 401)) this.end(endedText("unknown")); },
    );
  }

  private begin(a: GauntletAttempt, map: string, idx: number, offline: boolean): void {
    // A countdown to this (or another) map is over once a map begins: it must not begin one again.
    this.clear(this.goTimer);
    this.goTimer = 0;
    this.unlisten?.();
    this.unlisten = null;
    this.attempt = a;
    this.mapName = map;
    this.idx = idx;
    this.offline = offline;
    this.arrived = false;
    this.awaiting = null;
    this.gate = new SplitGate(a.id, map);
    this.progress = progressOf(a, idx, null);
    if (!offline) this.save();
    this.h.line(null, false);
    this.lock();
    // The same map already loaded: a fresh attempt on it (R), not a reload.
    if (this.h.map() === map && !this.h.loading()) {
      this.arrived = true;
      this.h.send({ type: "restart" });
    } else this.h.send({ type: "selectMap", id: map, style: GAUNTLET_STYLE, track: 0 });
    this.schedulePing(offline ? RETRY_MS : PING_MS);
    void this.loadPB();
  }

  private lock(): void {
    if (!this.attempt || !this.progress) return;
    this.h.send({ type: "gauntlet", id: this.attempt.id, map: this.mapName, progress: hudProgress(this.progress) });
  }

  private save(): void {
    if (this.attempt) rememberAttempt(this.attempt.gauntlet.slug, this.attempt.id, { a: this.attempt, at: this.now() });
  }

  /** Your gauntlet PB's split on this map, for the HUD's delta. */
  private async loadPB(): Promise<void> {
    const a = this.attempt, epoch = this.epoch;
    if (!a) return;
    try {
      const d = await this.h.api.gauntlet(a.gauntlet.slug);
      if (epoch !== this.epoch || this.attempt !== a) return;
      this.progress = progressOf(a, this.idx, d.me);
      this.lock();
    } catch {
      /* no delta without it */
    }
  }

  private schedulePing(ms: number): void {
    this.clear(this.pingTimer);
    this.pingTimer = this.set(() => void this.ping(), ms);
  }

  private async ping(): Promise<void> {
    const a = this.attempt, epoch = this.epoch;
    if (!a) return;
    try {
      const r = await this.h.api.pingGauntlet(a.id);
      if (epoch !== this.epoch) return;
      this.schedulePing(PING_MS);
      // During the next-map countdown the server is already ahead of this map: the countdown moves on, not the ping.
      if (this.goTimer) return;
      // The server moved on (a reply was lost): the attempt as the server has it.
      if ((r.state === "open" && r.step > this.idx) || r.state === "finished_pending" || r.state === "complete") {
        const now = await this.h.api.gauntletAttempt(a.id);
        if (epoch !== this.epoch || this.goTimer) return;
        const target = resumeTarget(now, now.next?.map ?? null);
        if (target.kind === "result") return this.finishAttempt(now);
        if (target.kind === "play" && target.idx > this.idx) return this.begin(now, target.map, target.idx, false);
      }
      if (r.state !== "open" && r.state !== "finished_pending" && r.state !== "complete") return this.end(endedText(r.state));
      this.save();
      if (this.offline) {
        this.offline = false;
        void this.loadPB();
      }
    } catch (e) {
      if (epoch !== this.epoch) return;
      if (e instanceof ApiError && e.status === 404) return this.end(endedText("unknown"));
      this.schedulePing(e instanceof ApiError ? PING_MS : RETRY_MS);
    }
  }

  /**
   * The run service asks, once per finished run, what it is submitted for (gauntlet/state.ts setGauntletTag): the
   * attempt id for the candidate (this map, Normal, main track, the first finish here), else null.
   */
  tag(run: { map: string; style: string; track: number }, generation: number, time: number | null = null): string | null {
    if (!this.attempt || !this.gate) return null;
    const id = this.gate.tag(run);
    if (id) this.awaiting = { generation, time };
    return id;
  }

  /** The run service may send generation's upload again: it's still this attempt's candidate on the map being played. */
  holds(attempt: string, generation: number): boolean {
    return !!this.attempt && this.attempt.id === attempt && this.awaiting?.generation === generation && (this.gate?.state === "sent" || this.gate?.state === "held");
  }

  /** A run service status: the tagged run's answer decides the split. */
  onRunStatus(status: RunServiceStatus, finishSeconds: number | null): void {
    const w = this.awaiting;
    if (!w || !this.attempt || status.generation !== w.generation) return;
    const outcome = statusOutcome(status, this.attempt.maps.length);
    if (!outcome) return;
    // Held: the same run's answer is still to come.
    if (outcome.kind === "held") {
      if (this.gate?.state !== "held") this.show(outcome, status.time ?? w.time ?? finishSeconds ?? 0);
      return;
    }
    this.awaiting = null;
    this.show(outcome, status.time ?? w.time ?? finishSeconds ?? 0);
  }

  private show(outcome: SplitOutcome, time: number): void {
    const a = this.attempt!;
    const next = outcome.kind === "split" && !outcome.last ? (a.maps.find((m) => m.idx === outcome.idx + 1)?.map ?? null) : null;
    const line = splitLine(outcome, time, a.maps.length, next);
    this.h.line(line, outcome.kind === "split");
    this.h.send({ type: "hudToast", key: "gauntlet", text: line, ms: outcome.kind === "split" ? NEXT_MAP_MS + 1000 : 5000, ...(outcome.kind === "split" ? { tone: "good" as const } : {}) });
    this.gate!.answer(outcome);
    if (outcome.kind === "ended") return this.end(null);
    if (outcome.kind !== "split") return;
    // This map is done: no more splits here (the server would refuse them), on to the next one.
    a.splits = [...a.splits.filter((s) => s.idx !== outcome.idx), { idx: outcome.idx, map: a.maps[outcome.idx]?.map ?? "", runId: "", ticks: 0, time, arrivedAt: this.now(), verified: false }];
    a.step = outcome.idx + 1;
    a.next = next ? { idx: outcome.idx + 1, map: next } : null;
    if (outcome.last) a.state = "finished_pending";
    this.save();
    this.progress = { ...this.progress!, before: this.progress!.before + time };
    this.lock();
    this.goTo(() => (outcome.last ? this.finishAttempt(a) : this.begin(a, next!, outcome.idx + 1, false)));
  }

  /** The next step after NEXT_MAP_MS, or at once on Enter or a click. */
  private goTo(step: () => void): void {
    const epoch = this.epoch;
    const go = () => {
      this.unlisten?.();
      this.unlisten = null;
      this.clear(this.goTimer);
      this.goTimer = 0;
      if (epoch === this.epoch) step();
    };
    this.unlisten = this.h.listenGo?.(go) ?? null;
    this.goTimer = this.set(go, NEXT_MAP_MS);
  }

  /** Every split is in: gauntlet mode ends, the map is let go, and the result screen shows (web: gauntletPath). */
  private finishAttempt(a: GauntletAttempt): void {
    this.stop();
    this.attempt = null;
    this.h.send({ type: "gauntlet", id: null });
    this.h.send({ type: "leaveMap" });
    this.h.result(a.gauntlet.slug, a.id);
  }

  /** Host state: once the attempt's map has been on screen, another map (or none) means the player left the attempt. */
  onHostState(): void {
    if (!this.attempt || this.goTimer) return;
    const map = this.h.map(), loading = this.h.loading();
    if (map === this.mapName && !loading) this.arrived = true;
    else if (this.arrived && !loading && map !== this.mapName) this.leave();
  }

  /**
   * The player went elsewhere (another map, the main menu, a room): the attempt stays open on the server (Resume on its
   * page within the grace period), this client stops pinging and the lock comes off.
   */
  leave(): void {
    // Always first: a start() still waiting for the attempt (or a ping's follow-up) must find its epoch gone.
    this.stop();
    if (!this.attempt) return;
    this.attempt = null;
    this.owner = undefined;
    this.h.line(null, false);
    this.h.send({ type: "gauntlet", id: null });
  }

  /** The attempt is over (expired, abandoned, failed): the map plays on by itself. `text`: a line saying so. */
  end(text: string | null): void {
    const a = this.attempt;
    this.stop();
    if (!a) return;
    this.attempt = null;
    this.owner = undefined;
    forgetAttempt(a.id);
    this.h.send({ type: "gauntlet", id: null });
    if (text) this.h.notice(text);
  }

  private stop(): void {
    this.epoch++;
    this.accountCheck++;
    this.clear(this.pingTimer);
    this.clear(this.goTimer);
    this.pingTimer = this.goTimer = 0;
    this.unlisten?.();
    this.unlisten = null;
    this.awaiting = null;
  }
}
