// The Daily Challenge in the native client (web daily/mode.ts, without its page URL): the day's map played from the
// Daily entry in the day's style, marked `?daily=<day>` on its runs, the HUD line while on the day's map, and the day's
// place under a verified run. The server decides what counts (apps/api src/daily.ts markDailyRun): the day's map in the
// day's style, main track, so a native run counts whether or not it came from the entry.
import type { DailyView, Submission } from "../../web/src/api";
import {
  currentDaily,
  dailyNow,
  dailyStyle,
  forgetDaily,
  guestResultLine,
  hudLine,
  resultLine,
  setDailySession,
  wrongStyleLine,
} from "../../web/src/daily/state";

/** The day's map and style, and the server's clock offset (it decides the day). */
interface Today {
  day: string;
  map: string;
  style: string;
  endsAt: number;
  skew: number;
}

export interface NativeDailyHost {
  /** The HUD line in the gauntlet line's place (null: none). */
  line(text: string | null): void;
  daily?: () => Promise<DailyView>;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface DailyRunLine {
  text: string;
  /** Counted for the day (green, as the web's `ok`); false: a guest's or another style's line (quiet). */
  good: boolean;
}

export class NativeDaily {
  private today: Today | null = null;
  private map: string | null = null;
  private style = "";
  private inRoom = false;
  private shown: string | null = null;
  private timer: unknown = null;
  private asked = 0;

  constructor(private readonly host: NativeDailyHost) {}

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }

  /** Play the day's map from the Daily entry: its runs carry `?daily=<day>`. Returns the style to start it in. */
  play(day: string, map: string, style?: string, endsAt = Number.MAX_SAFE_INTEGER): string {
    const s = dailyStyle(style);
    setDailySession({ day, map, style: s, endsAt });
    return s;
  }

  /** The day a finished run is submitted for (POST /runs?daily=), or null. */
  entry(run: { map: string; style: string; track: number }): string | null {
    return currentDaily(run);
  }

  /** The host's map, style and room: the HUD line follows them. */
  update(map: string | null, style: string, inRoom: boolean): void {
    const mapChanged = map !== this.map;
    this.map = map;
    this.style = style;
    this.inRoom = inRoom;
    if (mapChanged) {
      this.today = null;
      // Another map ends a Daily entry's session (web: the page's ?daily= goes with the page).
      if (map === null) setDailySession(null);
      if (map) this.ask(map);
    }
    this.paint();
  }

  private ask(map: string): void {
    const asked = ++this.asked;
    void (this.host.daily?.() ?? dailyNow()).then(
      (v) => {
        if (asked !== this.asked || this.map !== map) return;
        const t = v.enabled && v.today.map.name === map ? v.today : null;
        this.today = t
          ? {
              day: t.day,
              map,
              style: dailyStyle(t.style),
              endsAt: t.endsAt,
              skew: v.enabled ? v.now - this.now() : 0,
            }
          : null;
        this.paint();
      },
      () => {},
    );
  }

  /** Repainted every 2 s while on the day's map, to count down and follow a style change in the start zone. */
  private paint(): void {
    const text =
      this.today && !this.inRoom
        ? hudLine(this.today.endsAt, this.now() + this.today.skew, this.today.style, this.style)
        : null;
    if (text !== this.shown) {
      this.shown = text;
      this.host.line(text);
    }
    const ticking = text !== null;
    if (ticking && this.timer === null)
      this.timer = (this.host.setInterval ?? ((fn, ms) => setInterval(fn, ms)))(() => this.paint(), 2_000);
    else if (!ticking && this.timer !== null) {
      (this.host.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>)))(this.timer);
      this.timer = null;
    }
  }

  /** The line under a verified run's result (web daily/mode.ts onSubmission), or null. */
  result(st: Submission, run: { map: string; style: string; track: number } | null): DailyRunLine | null {
    if (st.status !== "verified") return null;
    const g = st.daily;
    // A guest's run is kept and not on the board: one line says where it would be (the account offer is the website's).
    if (g?.guest && g.rank !== undefined) {
      forgetDaily();
      return { text: guestResultLine({ rank: g.rank, of: g.of }, false), good: false };
    }
    const line = resultLine(g);
    if (line) {
      forgetDaily();
      return { text: line, good: true };
    }
    // The day's map, main track, the day still going, another style: why this one isn't on the day's board.
    const day = this.today;
    if (g || !day || !run || run.map !== day.map || run.style === day.style || run.track !== 0) return null;
    if (this.now() + day.skew >= day.endsAt) return null;
    return { text: wrongStyleLine(day.style, run.style), good: false };
  }
}
