// Mouse delta pipeline between the pointer-lock events and the view angles (input.ts): the spike filter, the post-lock
// discard and the input stats behind the diagnostics overlay (input-debug.ts). DOM-free and allocation-free per event;
// unit-tested in apps/api/test/mouse-filter.test.ts.
//
// WHAT IT IS FOR. Chromium on Windows (Chrome, Edge, Opera; with or without raw input) keeps the hidden cursor of a
// pointer lock inside the window by warping it back to the centre once it comes within ~15% of an edge, and is meant to
// ignore the mouse move that warp causes (RenderWidgetHostViewAura's move-to-center; crbug 411634 /
// codereview.chromium.org/1005213003 fixed one way of missing it). Now and then it doesn't, and the warp is reported as
// motion: one report of about a third of the window on top of the real motion. In game that is a sudden flick of tens
// of degrees the player never made (Krunker ships a "Mouse Flick Fix" for the same thing; html5gamedevs threads 34516 /
// 34523 describe the same "snap back" in Babylon.js games). Prod diagnostics (7,047 runs, 2026-10-06..08, v0.0.12):
// the largest dropped report is 0.36-0.42 of the viewport's width for every player whose feedback carried the viewport,
// and 0.25-0.45 of the screen's for 100 Chromium/Windows players; nothing like it on Firefox. The first event after a
// lock can also carry the cursor's travel while unlocked, or a window change (fullscreen) can re-centre it.
//
// HOW A SPIKE IS TOLD FROM A FLICK. Chromium and Firefox deliver pointermove once per frame (rAF-aligned), each event
// the SUM of the mouse reports since the last one, with the reports themselves in getCoalescedEvents(). A real flick,
// however fast, ramps: no hand takes one report (1 ms at 1000 Hz) to several times the speed of the reports around
// it. A spike is exactly that: one report (or two or three side by side) far above the reports around it. So a run of
// 1..SPIKE_RUN adjacent reports is dropped when all of these hold:
//   - each moves at least SPIKE_MIN counts on one axis;
//   - the smallest of them is more than RATIO times the largest of the WINDOW accepted reports before the run and the
//     WINDOW reports after it (at least SPIKE_FLOOR),
//   - plus what a hand could add from standing still within one report (½·SPIKE_ACCEL·dt², SPIKE_ACCEL generous enough
//     for a 200 m/s² flick at 6400 DPI), so slow-polling mice can't trip it.
// RATIO is SPIKE_RATIO (10) in general, and RECENTRE_RATIO (4) when the run is the size of a re-centre warp: it moves at
// least RECENTRE_FRAC of the view's width (x) or height (y), and no report in it more than RECENTRE_MAX of it plus the
// motion around it (bigger is a high-DPI hand, thousands of counts a report). Neighbours are scaled up for a report
// whose timestamp shows it waited for missed polls (it rightly holds more motion).
// Runs, not just lone reports: v0.0.6 judged each report against its neighbours, so a jump reported twice side by side
// (Chromium does that: replays show leaked snaps of twice the dropped size) shielded itself, and with slow or coalesced
// reports (OS-accelerated locks deliver ~150-350 a second) the 10x test let ~0.4-window jumps through during fast
// strafes. Only the run is subtracted; the rest of the event's motion passes. An event whose reports can't be read
// (Safari before 18.2, single-report events, or reports that don't add up to the event) is judged as one report
// spanning the time since the last event (capped at 50 ms) by the same two rules. A drop that the very next report
// contradicts (same way, REFUND_RATIO times as much: a hand speeding up) is given back with it, one report late.
// After the lock is (re)gained or the window comes back (input.ts rearm), the first motion event and big ones within
// POST_LOCK_MS are discarded (150 ms, as kathirmeyyappan/world#31 settled on for the same Chrome jumps).
//
// CALIBRATION (0.0.13). Real motion: every tick of 5,410 prod replays (all players with input diagnostics, the fastest
// turners and highest-DPI players included; up to 2,710 counts in one 10 ms tick) re-sampled as 125 Hz .. 8 kHz reports
// at 60 .. 360 fps with jitter and missed polls, in a 1280x720 window: 0-15 reports dropped per setting out of 1.1
// billion counts (v0.0.6: 0-2), every one at a re-sampling artefact (a frame hitch the 10 ms ticks show as a 10 ms
// stop, or a game angle set). Injected warps of 0.36-0.42 of the window into that motion: lone ones caught 99.8-100%
// with coalesced reports (v0.0.6: 97.5-100%), doubled ones 99.8-100% (v0.0.6: 0%), single-report events ~90%
// (v0.0.6: 70%; the rest come from a hand at rest, and a warp needs the cursor to travel a third of the window first).
//
// The filter runs before commands are built: the sim, replays and the server verifier only ever see the view angles
// the player was shown, so physics and determinism are untouched. Dropped reports are whole mouse counts, so the view
// stays on the count grid the anticheat checks (apps/api/src/input-analysis.ts gridFit).

/** Smallest single report that can be a spike (counts, either axis). */
export const SPIKE_MIN = 150;
/** A spike is more than this many times the largest neighbouring report... */
export const SPIKE_RATIO = 10;
/** ...with neighbours counted as at least this many counts... */
export const SPIKE_FLOOR = 4;
/** ...plus ½·SPIKE_ACCEL·dt²: the fastest a hand can speed up, counts per ms² (≈ 200 m/s² at 6400 DPI). */
export const SPIKE_ACCEL = 50;
/** A run moving at least this share of the view's width (x) or height (y) is a re-centre-sized jump... */
export const RECENTRE_FRAC = 0.3;
/** ...when none of its reports moves more than this share (plus the motion around it): a warp never spans more. */
export const RECENTRE_MAX = 0.6;
/** A re-centre-sized run is dropped at this many times its neighbours (plus the same ½·SPIKE_ACCEL·dt²). */
export const RECENTRE_RATIO = 4;
/** Adjacent reports judged together: a jump split over or repeated in up to this many reports. */
export const SPIKE_RUN = 3;
/**
 * A drop is given back when the very next report moves the same way at least this many times as much: a hand speeding
 * up (a fast flick at a slow polling rate), not a warp (a repeated warp is about the same size). Stops one wrong drop
 * from cascading (a dropped report is nobody's neighbour) and returns its motion one report late instead of never.
 */
export const REFUND_RATIO = 1.5;
/** After the lock is (re)acquired: the first motion event is discarded, and large ones are for this long (ms). */
export const POST_LOCK_MS = 150;
/** Neighbouring reports looked at on each side. */
const WINDOW = 3;

/** What the browser gives per mouse report: PointerEvent / MouseEvent fields. */
export interface MotionSample {
  readonly movementX: number;
  readonly movementY: number;
  readonly timeStamp: number;
}

/** Per-event flags in the stats ring. */
export const EV_OK = 0;
export const EV_SPIKE = 1;
export const EV_DISCARD = 2;

/**
 * Is a report of `m` counts, next to reports of at most `neighbour` counts, `dtMs` after the last one, a spike?
 * `recentre`: it is re-centre-sized (RECENTRE_FRAC of the view on an axis), which takes RECENTRE_RATIO, not SPIKE_RATIO.
 */
export function isSpike(m: number, neighbour: number, dtMs: number, recentre = false): boolean {
  if (m < SPIKE_MIN) return false;
  return m > (recentre ? RECENTRE_RATIO : SPIKE_RATIO) * Math.max(neighbour, SPIKE_FLOOR) + 0.5 * SPIKE_ACCEL * dtMs * dtMs;
}

const mag = (x: number, y: number) => Math.max(Math.abs(x), Math.abs(y));
const smag = (s: MotionSample) => mag(s.movementX || 0, s.movementY || 0);
/** Longest average gap between a moving mouse's reports (ms): 125 Hz is 8 ms. Longer means it was resting. */
const MAX_REPORT_GAP_MS = 20;

/** Ring buffers + counters for the diagnostics overlay and feedback reports. Fixed-size typed arrays: no garbage. */
export class InputStats {
  static readonly EVENTS = 2048;
  static readonly FRAMES = 240;
  /** Per motion event: time, accepted magnitude, magnitude before filtering (the dropped report's for spikes), flag. */
  readonly evT = new Float64Array(InputStats.EVENTS);
  readonly evMag = new Float32Array(InputStats.EVENTS);
  readonly evRaw = new Float32Array(InputStats.EVENTS);
  readonly evFlag = new Uint8Array(InputStats.EVENTS);
  /**
   * Mouse reports in each event, and the time they cover: from the previous event's last report to this event's last
   * (ms; 0 = reports unknown, the first after a reset, or a pause). pollHz divides one by the other.
   */
  readonly evN = new Uint16Array(InputStats.EVENTS);
  readonly evSpan = new Float32Array(InputStats.EVENTS);
  /** Last report time of the previous event that had readable reports (0: none since the reset). */
  private lastReportT = 0;
  evHead = 0;
  /** Per frame: time, duration, and how old the newest motion event was when the frame ran (-1: none this frame). */
  readonly frT = new Float64Array(InputStats.FRAMES);
  readonly frDur = new Float32Array(InputStats.FRAMES);
  readonly frAge = new Float32Array(InputStats.FRAMES);
  frHead = 0;
  /** Motion events, and mouse reports in them (coalesced events; = events where the browser has none). */
  events = 0;
  samples = 0;
  spikes = 0;
  discards = 0;
  /** Events whose coalesced reports didn't add up to the event (the event's own total was used). */
  mismatches = 0;
  /** Largest accepted event and largest dropped report (counts). */
  maxDelta = 0;
  maxSpike = 0;
  framesOver25 = 0;
  framesOver50 = 0;
  maxFrame = 0;
  /** Long main-thread tasks (PerformanceObserver "longtask"; Chromium). */
  longTasks = 0;
  maxLongTask = 0;
  /** Newest motion event time (performance clock; 0 = none yet). */
  lastMotionT = 0;
  private lastFrameT = 0;
  private motionSinceFrame = false;

  /** `lastReportT`: the event's last coalesced report's time (0 when the browser gave no readable reports). */
  event(t: number, accepted: number, raw: number, flag: number, samples: number, lastReportT = 0): void {
    const i = this.evHead;
    this.evT[i] = t;
    this.evMag[i] = accepted;
    this.evRaw[i] = raw;
    this.evFlag[i] = flag;
    this.evN[i] = Math.min(65535, samples);
    // A report gap over MAX_REPORT_GAP_MS is the mouse resting, not its polling rate.
    const span = lastReportT > 0 && this.lastReportT > 0 ? lastReportT - this.lastReportT : 0;
    this.evSpan[i] = span > 0 && span / samples <= MAX_REPORT_GAP_MS ? span : 0;
    if (lastReportT > 0) this.lastReportT = lastReportT;
    this.evHead = (i + 1) % InputStats.EVENTS;
    this.events++;
    this.samples += samples;
    if (accepted > this.maxDelta) this.maxDelta = accepted;
    this.lastMotionT = t;
    this.motionSinceFrame = true;
  }

  spike(m: number): void {
    this.spikes++;
    if (m > this.maxSpike) this.maxSpike = m;
  }

  /**
   * Once per rendered frame: `now` is the rAF time, `wall` performance.now() (for the input age). Stutters are counted
   * only while `playing` (pointer-locked): map loads and menus aren't what a player reports.
   */
  frame(now: number, wall: number, playing = true): void {
    const dur = this.lastFrameT ? now - this.lastFrameT : 0;
    this.lastFrameT = now;
    const i = this.frHead;
    this.frT[i] = now;
    this.frDur[i] = dur;
    this.frAge[i] = this.motionSinceFrame ? Math.max(0, wall - this.lastMotionT) : -1;
    this.motionSinceFrame = false;
    this.frHead = (i + 1) % InputStats.FRAMES;
    if (!playing) return;
    if (dur > 25) this.framesOver25++;
    if (dur > 50) this.framesOver50++;
    if (dur > this.maxFrame) this.maxFrame = dur;
  }

  longTask(ms: number): void {
    this.longTasks++;
    if (ms > this.maxLongTask) this.maxLongTask = ms;
  }

  /**
   * Over the second before `now`: motion events, mouse reports in them (the polling rate while the mouse moves, where
   * the browser exposes reports) and frames. The event ring covers the last EVENTS events, so a rate above that per
   * second is scaled from the span it does cover.
   */
  rates(now: number): { eventHz: number; reportHz: number; frameHz: number; pollHz: number } {
    let ev = 0;
    let rep = 0;
    let oldest = now;
    for (let i = 0; i < InputStats.EVENTS; i++) {
      const t = this.evT[i];
      if (t > now - 1000) {
        ev++;
        rep += this.evN[i];
        if (t < oldest) oldest = t;
      }
    }
    const span = ev === InputStats.EVENTS ? Math.max(1, now - oldest) : 1000;
    let fr = 0;
    for (let i = 0; i < InputStats.FRAMES; i++) if (this.frT[i] > now - 1000) fr++;
    return { eventHz: Math.round((ev * 1000) / span), reportHz: Math.round((rep * 1000) / span), frameHz: fr, pollHz: this.pollHz(now) };
  }

  /**
   * Polling rate (Hz) while the mouse moved over the last `windowMs` (2 s): reports over the time they cover (0: under
   * 50 ms of readable reports). Not a per-event median: with pointerrawupdate nearly every event has one report, and
   * the few pairs share a timestamp rounded to Chromium's 100 µs, which read as 10,000 Hz.
   */
  pollHz(now: number, windowMs = 2000): number {
    let reports = 0;
    let ms = 0;
    for (let i = 0; i < InputStats.EVENTS; i++) {
      if (this.evT[i] > now - windowMs && this.evSpan[i] > 0) {
        reports += this.evN[i];
        ms += this.evSpan[i];
      }
    }
    return ms >= 50 ? Math.round((reports * 1000) / ms) : 0;
  }

  /** Percentile `p` (0..1) of a ring's positive values (allocates: for the overlay / reports, not per event). */
  static pct(a: Float32Array, p: number): number {
    const v = Array.from(a).filter((x) => x > 0).sort((x, y) => x - y);
    return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * p))] : 0;
  }

  reset(): void {
    for (const a of [this.evT, this.evMag, this.evRaw, this.evFlag, this.evN, this.evSpan, this.frT, this.frDur, this.frAge]) a.fill(0);
    this.evHead = this.frHead = 0;
    this.events = this.samples = this.spikes = this.discards = this.mismatches = 0;
    this.maxDelta = this.maxSpike = 0;
    this.framesOver25 = this.framesOver50 = this.maxFrame = this.longTasks = this.maxLongTask = 0;
    this.lastMotionT = this.lastFrameT = this.lastReportT = 0;
    this.motionSinceFrame = false;
  }
}

/** Common mouse polling rates (Hz): a run's rate is recorded as one of them. */
export const POLL_RATES = [125, 250, 500, 1000, 2000, 4000, 8000] as const;

/**
 * A run's polling rate (selfcheck.ts RunWatch; the boards' stats card): every half second of mouse movement is measured
 * (InputStats.pollHz over 500 ms) and counted under the common rate it's within 15 % of. Slow movement only ever reads
 * low (the mouse sends nothing when it has nothing to send), so the run's rate is the highest one that at least 3
 * windows and a tenth of all of them landed on. 0: not enough movement to tell.
 */
export class RunPollRate {
  private readonly bins = new Uint32Array(POLL_RATES.length);
  private total = 0;
  private last = -Infinity;

  reset(): void {
    this.bins.fill(0);
    this.total = 0;
    this.last = -Infinity;
  }

  /** Every frame of the run: measures a window once half a second has passed. */
  sample(now: number, pollHz: (now: number, windowMs: number) => number): void {
    if (now - this.last < 500) return;
    this.last = now;
    const hz = pollHz(now, 500);
    if (!hz) return;
    const k = POLL_RATES.findIndex((r) => Math.abs(hz - r) <= r * 0.15);
    if (k < 0) return;
    this.bins[k]!++;
    this.total++;
  }

  hz(): number {
    for (let k = POLL_RATES.length - 1; k >= 0; k--) if (this.bins[k]! >= 3 && this.bins[k]! >= this.total * 0.1) return POLL_RATES[k]!;
    return 0;
  }
}

/** Turns pointer-lock motion events into accepted deltas: feed every event to `push`, read `outX` / `outY`. */
export class MouseFilter {
  /** Settings → Mouse & view → Spike filter. Off: every delta passes, the post-lock discard included. */
  enabled = true;
  /** Accepted delta of the last `push` (counts). */
  outX = 0;
  outY = 0;
  /**
   * The last `push` judged its coalesced reports one by one: `repN` of them, report i's accepted motion in `repX[i]` /
   * `repY[i]` (0 for a dropped one; a refund lands on the report that earned it). They add up to outX / outY. False:
   * the accepted motion is the one aggregate (a single report, unreadable reports, a discard). Timestamped input
   * (input.ts) keeps each report's own time this way instead of moving the whole event to its dispatch time.
   */
  perReport = false;
  repN = 0;
  repX = new Float64Array(64);
  repY = new Float64Array(64);
  readonly stats = new InputStats();
  /** Magnitudes of the last WINDOW accepted reports (ring; tailHead is the oldest). */
  private tail = new Float64Array(WINDOW);
  private tailHead = 0;
  /** Time of the newest report seen (-1: none since the lock). */
  private lastT = -1;
  private lockedAt = -1e9;
  private discardNext = false;
  /** The view (CSS px = movement units: window.innerWidth / innerHeight) for the re-centre rule; 0 = unknown, rule off. */
  private viewW = 0;
  private viewH = 0;
  /** Magnitudes of the current event's reports (grown as needed, reused: no garbage per event). */
  private mags = new Float64Array(64);
  /** The last drop while nothing has been accepted since: its motion, largest report and report count (0: none). */
  private dropX = 0;
  private dropY = 0;
  private dropMag = 0;
  private dropN = 0;

  /** The view's size (input.ts: on start and resize). */
  setView(w: number, h: number): void {
    this.viewW = w > 0 ? w : 0;
    this.viewH = h > 0 ? h : 0;
  }

  /** Does a motion of (`x`, `y`) counts span a re-centre warp (RECENTRE_FRAC of the view on either axis)? */
  private recentreSized(x: number, y: number): boolean {
    return (this.viewW > 0 && Math.abs(x) >= RECENTRE_FRAC * this.viewW) || (this.viewH > 0 && Math.abs(y) >= RECENTRE_FRAC * this.viewH);
  }

  /**
   * Is a report of (`x`, `y`) no bigger than `jumps` re-centre warps (RECENTRE_MAX of the view each) plus `slack` counts
   * of real motion? Bigger is a high-DPI hand (thousands of counts a report), judged by the general rule only.
   */
  private warpBounded(x: number, y: number, slack: number, jumps = 1): boolean {
    return Math.abs(x) <= jumps * RECENTRE_MAX * this.viewW + slack && Math.abs(y) <= jumps * RECENTRE_MAX * this.viewH + slack;
  }

  /** Lock acquired, or the window changed while locked: discard the next motion event, and large ones for POST_LOCK_MS. */
  rearm(now: number): void {
    this.lockedAt = now;
    this.discardNext = true;
    this.lastT = -1;
    this.tail.fill(0);
    this.dropMag = 0;
  }

  private accept(m: number): void {
    this.pushTail(m);
    this.dropMag = 0;
  }

  private dropped(x: number, y: number, m: number, reports: number): void {
    this.dropX = x;
    this.dropY = y;
    this.dropMag = m;
    this.dropN = reports;
  }

  /** Gives the last drop back (see REFUND_RATIO) if a report of (`x`, `y`) says it was a hand speeding up (report `at`). */
  private refund(x: number, y: number, m: number, at = -1): void {
    if (!this.dropMag || m < REFUND_RATIO * this.dropMag) return;
    const ax = Math.abs(this.dropX) >= Math.abs(this.dropY);
    const d = ax ? this.dropX : this.dropY;
    const v = ax ? x : y;
    if (!(d * v > 0)) return;
    this.outX += this.dropX;
    this.outY += this.dropY;
    if (at >= 0) {
      this.repX[at] += this.dropX;
      this.repY[at] += this.dropY;
    }
    this.stats.spikes = Math.max(0, this.stats.spikes - this.dropN);
    this.accept(this.dropMag);
  }

  private pushTail(m: number): void {
    this.tail[this.tailHead] = m;
    this.tailHead = (this.tailHead + 1) % WINDOW;
  }

  /** The j-th newest accepted report before this event (j = 1: the newest). */
  private before(j: number): number {
    return this.tail[(this.tailHead + WINDOW - j) % WINDOW];
  }

  /**
   * One dispatched motion event: its total (`dx`, `dy`), its time, and its coalesced reports when the browser has them
   * (`null` otherwise). Sets `outX` / `outY`.
   */
  push(dx: number, dy: number, t: number, reports: ArrayLike<MotionSample> | null): void {
    this.outX = dx;
    this.outY = dy;
    this.perReport = false;
    this.repN = 0;
    if (!(dx || dy)) return;
    const m = mag(dx, dy);
    const n = reports ? reports.length : 0;
    const st = this.stats;
    const span = n > 1 ? reports![n - 1].timeStamp - reports![0].timeStamp : 0;
    const lastReport = n ? reports![n - 1].timeStamp : 0;
    if (!this.enabled) {
      this.discardNext = false;
      st.event(t, m, m, EV_OK, Math.max(1, n), lastReport);
      return;
    }
    if (this.discardNext || (m >= SPIKE_MIN && t - this.lockedAt < POST_LOCK_MS)) {
      this.discardNext = false;
      this.outX = this.outY = 0;
      this.lastT = t;
      st.discards++;
      st.event(t, 0, m, EV_DISCARD, Math.max(1, n), lastReport);
      return;
    }
    if (n < 2 || !this.addsUp(dx, dy, reports!)) {
      // One report spanning the time since the last one (capped: a mouse at rest sends nothing).
      const dt = this.lastT >= 0 ? Math.min(50, Math.max(0.125, t - this.lastT)) : 50;
      this.lastT = t;
      this.outX = this.outY = 0;
      this.refund(dx, dy, m);
      const nb = Math.max(this.before(1), this.before(2), this.before(3));
      // The event may hold two warps (a jump reported twice) but nothing in it is known apart.
      if (isSpike(m, nb, dt, this.recentreSized(dx, dy) && this.warpBounded(dx, dy, nb, 2))) {
        st.spike(m);
        this.dropped(dx, dy, m, 1);
        st.event(t, mag(this.outX, this.outY), m, EV_SPIKE, Math.max(1, n), lastReport);
        return;
      }
      this.outX += dx;
      this.outY += dy;
      this.accept(m);
      st.event(t, m, m, EV_OK, Math.max(1, n), lastReport);
      return;
    }
    const r = reports!;
    // Report spacing: the mouse's polling interval as delivered (a report never spans more, whatever the idle before).
    const dt = Math.min(8, Math.max(0.125, span / (n - 1)));
    if (this.mags.length < n) this.mags = new Float64Array(Math.max(n, this.mags.length * 2));
    const mags = this.mags;
    for (let i = 0; i < n; i++) mags[i] = smag(r[i]);
    if (this.repX.length < n) {
      this.repX = new Float64Array(Math.max(n, this.repX.length * 2));
      this.repY = new Float64Array(this.repX.length);
    }
    for (let i = 0; i < n; i++) {
      this.repX[i] = r[i].movementX || 0;
      this.repY[i] = r[i].movementY || 0;
    }
    // The event's total may differ from its reports' sum by a rounding count (addsUp): the newest report takes it, so
    // the per-report motion still adds up to outX / outY.
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sx += this.repX[i];
      sy += this.repY[i];
    }
    this.repX[n - 1] += dx - sx;
    this.repY[n - 1] += dy - sy;
    this.perReport = true;
    this.repN = n;
    let worst = 0;
    for (let i = 0; i < n; ) {
      this.refund(r[i].movementX || 0, r[i].movementY || 0, mags[i], i);
      const run = mags[i] >= SPIKE_MIN ? this.spikeRun(r, mags, i, n, dt) : 0;
      if (!run) {
        this.accept(mags[i]);
        i++;
        continue;
      }
      // Dropped reports never become anyone's neighbour (here or in the next event): a jump can't vouch for itself.
      let x = 0;
      let y = 0;
      let big = 0;
      for (let k = i; k < i + run; k++) {
        x += r[k].movementX || 0;
        y += r[k].movementY || 0;
        this.repX[k] = this.repY[k] = 0;
        st.spike(mags[k]);
        if (mags[k] > big) big = mags[k];
      }
      this.outX -= x;
      this.outY -= y;
      this.dropped(x, y, big, run);
      if (big > worst) worst = big;
      i += run;
    }
    this.lastT = r[n - 1].timeStamp;
    st.event(t, mag(this.outX, this.outY), worst || m, worst ? EV_SPIKE : EV_OK, n, lastReport);
  }

  /**
   * Length of the shortest run of reports starting at `i` (1..SPIKE_RUN, all at least SPIKE_MIN) that is a spike
   * against the WINDOW accepted reports before it and the WINDOW reports after it in this event; 0 if none.
   */
  private spikeRun(r: ArrayLike<MotionSample>, mags: Float64Array, i: number, n: number, dt: number): number {
    const before = Math.max(this.before(1), this.before(2), this.before(3));
    let inner = Infinity;
    let sx = 0;
    let sy = 0;
    let stretch = 1;
    let bounded = true;
    for (let len = 1; len <= SPIKE_RUN && i + len <= n; len++) {
      const j = i + len - 1;
      if (mags[j] < SPIKE_MIN) return 0;
      if (mags[j] < inner) inner = mags[j];
      sx += r[j].movementX || 0;
      sy += r[j].movementY || 0;
      bounded &&= this.warpBounded(r[j].movementX || 0, r[j].movementY || 0, before);
      // A report that waited longer than the usual spacing (missed polls, or Windows merging cursor moves under an
      // OS-accelerated lock) rightly holds that much more motion: its neighbours are scaled up to match (at most 4x).
      const prevT = j > 0 ? r[j - 1].timeStamp : this.lastT;
      if (prevT >= 0) stretch = Math.max(stretch, Math.min(4, (r[j].timeStamp - prevT) / dt));
      let nb = before;
      for (let k = j + 1; k <= j + WINDOW && k < n; k++) if (mags[k] > nb) nb = mags[k];
      if (isSpike(inner, nb * stretch, dt, bounded && this.recentreSized(sx, sy))) return len;
    }
    return 0;
  }

  /** Coalesced reports add up to their event (±1 count per axis: cooked deltas can round). Counts mismatches. */
  private addsUp(dx: number, dy: number, r: ArrayLike<MotionSample>): boolean {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < r.length; i++) {
      sx += r[i].movementX || 0;
      sy += r[i].movementY || 0;
    }
    if (Math.abs(sx - dx) <= 1 && Math.abs(sy - dy) <= 1) return true;
    this.stats.mismatches++;
    return false;
  }
}
