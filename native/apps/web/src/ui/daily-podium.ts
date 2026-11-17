// The Daily Challenge page's podium (ui/daily.ts mounts it where the map's picture was): the shown day's top three as
// their own bunnies on a three-step podium, the day's map soft behind them, and under each bunny the player's name in
// their own name style with their marks (opens the profile; the hover card as everywhere), the place's medal with the
// time, and a small play button that watches the run.
//
//   data     Who stands where comes from the page's own reads and nowhere else (daily/podium-data.ts podiumPlaces):
//            today's top three from GET /daily, an earlier day's podium from GET /daily/days (or its board). What each
//            bunny wears is GET /runs/<id>?look=1, one request a place, kept a minute. A run the server no longer
//            shows this viewer (404: hidden or invalidated since the board was read) empties its place.
//   drawing  daily/podium-scene.ts, painted by ui/daily-podium-paint.ts: on the game's pages with the game's own
//            renderer, so no WebGL context is made for it. About 30 frames a second while it is on screen and the tab
//            is visible; nothing while it isn't.
//   updates  While the day runs the page asks GET /daily again every 30 s (the shared read, daily/state.ts); a changed
//            top three changes only the captions and the bunnies that differ (PodiumScene.set), never the scene.
//   still    Potato graphics and reduced motion get one frame per change instead of the idle motion.
//   off      No WebGL, or WebGL in software: the map's picture stays as it was, with the captions under it.
//   closing  The scene outlives the element by PARK_MS, so going to a profile and back (or another day) costs a
//            frame; after that, or as soon as a map starts loading, everything it made is disposed.
//
// With `?podium=card` in the address the page also draws the day's Discord image (ui/daily-podium-card.ts): how the
// render host makes it.

import "./daily-podium.css";
import { api, ApiError, type ApiPlayer, type DailyMapInfo, type DailyView } from "../api";
import { dailyMarkSvg } from "../creators";
import { dressPodium, lookReader, METAL_OF, podiumPlaces, sameStandings, type Place, type PodiumStanding, type PodiumWant } from "../daily/podium-data";
import type { PodiumScene } from "../daily/podium-scene";
import { dailyNow } from "../daily/state";
import { formatTime } from "../timer";
import { openReplayViewer } from "../viewer/request";
import { makePainter, paintStats, type Painter } from "./daily-podium-paint";
import { h } from "./dom";
import { hoverCardFor } from "./hover-card";
import { icon } from "./icons";
import { nameAttrs, nameMarks } from "./marks";
import { onMenuMapStart } from "./menu-work";
import { navigate } from "./nav";
import { withReplayViews } from "./replay-views";
import { prefs } from "./settings";
import { mapArt, mapImages } from "./thumbs";

type DailyOn = Extract<DailyView, { enabled: true }>;

/** How long the scene is kept after its element left the page. */
export const PARK_MS = 15_000;
const FRAME_MS = 1000 / 30;
const REFRESH_MS = 30_000;
/** The two waits, where the harness can shorten them (dev only: window.__dailyPodium.timing). */
const timing = { parkMs: PARK_MS, refreshMs: REFRESH_MS };
const LOOK_TTL_MS = 60_000;
/** The picture waits this long for its bunnies before it shows without the late ones. */
const FIRST_FRAME_MS = 2500;
/** Read when the page loads (the daily screen rewrites the address): the render host's flag for the Discord image. */
const CARD_MODE = typeof location !== "undefined" && new URLSearchParams(location.search).get("podium") === "card";

/** Counters for the page's measurements and the harness (dev and tests read them through window.__dailyPodium). */
export const podiumStats = { views: 0, scenes: 0, scenesDisposed: 0, frames: 0, cpuMs: 0, lookReads: 0, firstFrameMs: 0 };

// ---------------------------------------------------------------------------------------------
// What a bunny wears: one read per run, shared by every view for a minute

/** The look of a run's player ("gone": the server doesn't show this run to this viewer). Never rejects. */
export const lookOfRun = lookReader(
  (runId) => (podiumStats.lookReads++, api.runPlayer(runId, true)),
  (e) => e instanceof ApiError && e.status === 404,
  LOOK_TTL_MS,
);

// ---------------------------------------------------------------------------------------------
// The scene and its painter: one at a time, handed from a closed view to the next one

interface Stage {
  scene: PodiumScene;
  painter: Painter;
  owner: PodiumView | null;
  park: number;
}
let stage: Stage | null = null;
let stageLoading: Promise<Stage | null> | null = null;

function releaseStage(): void {
  const s = stage;
  if (!s) return;
  stage = null;
  clearTimeout(s.park);
  s.owner?.lost();
  s.scene.dispose();
  s.painter.dispose();
  podiumStats.scenesDisposed++;
}

function acquire(view: PodiumView): Promise<Stage | null> {
  if (stage && !stage.painter.alive()) releaseStage();
  if (stage) {
    clearTimeout(stage.park);
    if (stage.owner && stage.owner !== view) stage.owner.lost();
    stage.owner = view;
    return Promise.resolve(stage);
  }
  stageLoading ??= (async () => {
    const painter = makePainter();
    if (!painter) return null;
    try {
      const { PodiumScene } = await import("../daily/podium-scene");
      const font = getComputedStyle(document.documentElement).getPropertyValue("--font-ui").trim() || "sans-serif";
      await document.fonts?.load(`850 32px ${font}`).catch(() => {});
      const scene = new PodiumScene({ font });
      scene.warm = (root) => painter.warm(root, scene.scene, scene.camera);
      podiumStats.scenes++;
      stage = { scene, painter, owner: null, park: 0 };
      return stage;
    } catch (e) {
      console.warn("daily podium:", e);
      painter.dispose();
      return null;
    }
  })().finally(() => (stageLoading = null));
  return stageLoading.then((s) => {
    if (s && s === stage) {
      clearTimeout(s.park);
      if (s.owner && s.owner !== view) s.owner.lost();
      s.owner = view;
    }
    return s === stage ? s : null;
  });
}

function park(view: PodiumView): void {
  const s = stage;
  if (!s || s.owner !== view) return;
  s.owner = null;
  clearTimeout(s.park);
  s.park = window.setTimeout(releaseStage, timing.parkMs);
}

// A map is loading, or the game has the pointer: nothing of the menus' is kept.
onMenuMapStart(releaseStage);
if (typeof document !== "undefined")
  document.addEventListener("pointerlockchange", () => {
    if (document.pointerLockElement) releaseStage();
  });

// ---------------------------------------------------------------------------------------------
// The element

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const potato = () => {
  try {
    return !!prefs.get().graphics.potato;
  } catch {
    return false;
  }
};

interface Shown {
  day: string;
  label: string;
  map: DailyMapInfo;
  /** The day is still running (its top three can change). */
  open: boolean;
  players: number | null;
  standings: PodiumStanding[];
}

class PodiumView {
  readonly el: HTMLElement;
  private frame: HTMLElement;
  private caps: HTMLElement;
  private shown: Shown | null = null;
  private stage: Stage | null = null;
  private still = reduced() || potato();
  private seen = false;
  private closed = false;
  private visible = true;
  private raf = 0;
  private last = 0;
  private seq = 0;
  private openedAt = performance.now();
  private revealed = false;
  private revealTimer = 0;
  private ticker = 0;
  private sinceRefresh = 0;
  private ro: ResizeObserver | null = null;
  private io: IntersectionObserver | null = null;
  private carded = false;

  constructor(
    private today: string,
    private day: string,
    art: HTMLElement | null,
  ) {
    podiumStats.views++;
    this.frame = h("div.dyp-frame", null, art);
    this.caps = h("ol.dyp-caps", { "aria-label": "The day's top three" });
    this.el = h("figure.dyp", { "data-day": day, "data-state": "wait" }, this.frame, this.caps);
    this.renderCaps([]);
    // One slow ticker: notices the element leaving the page (a still view has no frame loop to do it) and asks for
    // the day's standings again while it runs.
    this.ticker = window.setInterval(() => this.tick1s(), 1000);
    document.addEventListener("visibilitychange", this.wake);
  }

  // --- data

  /** The day's standings as the page has them now. */
  show(s: Shown): void {
    if (this.closed) return;
    const first = !this.shown;
    const same = !!this.shown && sameStandings(this.shown.standings, s.standings);
    this.shown = s;
    if (first) {
      if (s.day !== this.today) {
        // An earlier day: its own map under the scene, and its date and map said on the picture.
        this.frame.querySelector(".dy-art")?.replaceWith(mapArt(s.map.name, s.map.thumbnailUrl, { className: "dy-art", eager: true }));
        this.frame.append(h("span.dyp-day", null, `${s.label}, ${s.map.name}`));
      }
      void this.start();
    }
    if (!same || first) this.renderCaps(s.standings);
    void this.dress();
  }

  /** Reads the looks and tells the scene who stands where. A run that is gone for this viewer leaves its place empty. */
  private async dress(): Promise<void> {
    const s = this.shown;
    if (!s) return;
    const seq = ++this.seq;
    const found = await Promise.all(s.standings.map((x) => lookOfRun(x.runId)));
    if (this.closed || seq !== this.seq || this.shown !== s) return;
    const { want, kept } = dressPodium(s.standings, found);
    if (kept.length !== s.standings.length) this.renderCaps(kept);
    this.wanted = want;
    this.stage?.scene.set(want);
    this.redraw();
  }
  private wanted: (PodiumWant | null)[] | null = null;

  private tick1s(): void {
    if (!this.el.isConnected) {
      if (this.seen || performance.now() - this.openedAt > 5000) this.close();
      return;
    }
    this.seen = true;
    if (!this.raf && !this.still) this.wake();
    const s = this.shown;
    if (!s || !s.open || s.day !== this.today || document.hidden) return;
    this.sinceRefresh += 1000;
    if (this.sinceRefresh < timing.refreshMs) return;
    this.sinceRefresh = 0;
    void dailyNow(Math.max(0, timing.refreshMs - 5000)).then(
      (v) => {
        if (this.closed || !v.enabled || v.today.day !== s.day) return;
        this.show({ ...s, open: !v.today.closed && v.today.endsAt > v.now, players: v.today.players, standings: podiumPlaces(v.today.top) });
      },
      () => {},
    );
  }

  // --- captions

  private renderCaps(standings: readonly PodiumStanding[]): void {
    const at = (place: Place) => standings.find((x) => x.place === place) ?? null;
    // Left to right as they stand: 2nd, 1st, 3rd.
    this.caps.replaceChildren(...([2, 1, 3] as const).map((place) => caption(place, at(place), this.shown)));
    this.el.dataset.count = String(standings.length);
  }

  // --- drawing

  private async start(): Promise<void> {
    const st = await acquire(this);
    if (this.closed) return void (st && park(this));
    if (!st) return this.setState("off");
    this.stage = st;
    const { scene, painter } = st;
    const s = this.shown!;
    scene.setBackdrop(backdropUrl(s.map));
    scene.onChange = () => this.redraw();
    if (this.wanted) scene.set(this.wanted);
    painter.canvas.className = "dyp-canvas";
    painter.canvas.setAttribute("aria-hidden", "true");
    this.frame.append(painter.canvas);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.frame);
    this.io = new IntersectionObserver((e) => {
      this.visible = e[e.length - 1]?.isIntersecting ?? true;
      this.wake();
    });
    this.io.observe(this.frame);
    this.resize();
    // The picture shows once its bunnies are in (or after a moment without the late ones): never an empty podium first.
    this.revealTimer = window.setTimeout(() => this.reveal(), FIRST_FRAME_MS);
    this.redraw();
    this.wake();
  }

  private resize(): void {
    const st = this.stage;
    if (!st) return;
    const r = this.frame.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, potato() ? 1 : 2);
    st.painter.size(r.width * dpr, r.height * dpr);
    st.scene.setAspect(r.width / r.height);
    this.redraw();
  }

  /** Something changed: a still view draws its one frame; a live one is drawing anyway. */
  private redraw(): void {
    const st = this.stage;
    if (!st || this.closed) return;
    if (st.scene.settled && this.wanted) this.reveal();
    if (!this.still || !this.revealed) return;
    // The pose a moment in: the idle settled, the winner's arm up.
    for (let i = 0; i < 30; i++) st.scene.advance(1 / 30);
    this.paint();
  }

  private reveal(): void {
    if (this.revealed || this.closed || !this.stage) return;
    this.revealed = true;
    clearTimeout(this.revealTimer);
    podiumStats.firstFrameMs = Math.round(performance.now() - this.openedAt);
    if (this.still) this.redraw();
    else this.wake();
  }

  private paint(): void {
    const st = this.stage;
    if (!st) return;
    if (!st.painter.alive()) return releaseStage();
    if (st.painter.draw(st.scene.scene, st.scene.camera)) {
      podiumStats.frames++;
      // (A frame read back from the game's renderer lands a moment later; the fade-in covers it.)
      if (this.el.dataset.state === "wait") window.setTimeout(() => !this.closed && this.stage && this.setState(this.still ? "still" : "live"), 60);
      if (CARD_MODE && !this.carded && st.scene.settled) void this.card();
    }
  }

  private wake = (): void => {
    if (this.raf || this.still || this.closed || !this.stage || !this.revealed || document.hidden || !this.visible) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  };

  private loop = (now: number): void => {
    this.raf = 0;
    if (this.closed || !this.stage) return;
    // Off the page: closed if it was ever on it; a view made a moment before its screen is attached just waits.
    if (!this.el.isConnected) return this.seen ? this.close() : void (this.raf = requestAnimationFrame(this.loop));
    this.seen = true;
    if (document.hidden || !this.visible) return;
    if (now - this.last >= FRAME_MS - 2) {
      const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      const t0 = performance.now();
      this.stage.scene.advance(dt);
      this.paint();
      podiumStats.cpuMs += performance.now() - t0;
    }
    if (this.stage) this.raf = requestAnimationFrame(this.loop);
  };

  private setState(state: "wait" | "live" | "still" | "off"): void {
    this.el.dataset.state = state;
  }

  /** The render host's picture of this day (ui/daily-podium-card.ts), once, when everything is in. */
  private async card(): Promise<void> {
    const st = this.stage, s = this.shown;
    if (!st || !s || this.carded) return;
    this.carded = true;
    try {
      const { drawPodiumCard } = await import("./daily-podium-card");
      await drawPodiumCard(st.painter, s);
    } catch (e) {
      console.warn("daily podium card:", e);
    }
  }

  /** The scene went away under this view (a map started, or another view took it): the map's picture shows again. */
  lost(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    clearTimeout(this.revealTimer);
    this.ro?.disconnect();
    this.io?.disconnect();
    this.stage?.painter.canvas.remove();
    if (this.stage) this.stage.scene.onChange = null;
    this.stage = null;
    if (!this.closed) this.setState("off");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ticker);
    document.removeEventListener("visibilitychange", this.wake);
    this.lost();
    park(this);
  }
}

/** The map picture behind the podium: the hero render (the map should be recognisable), else the card render. */
function backdropUrl(map: DailyMapInfo): string | null {
  const reg = mapImages(map.name);
  return reg?.hero ?? reg?.thumbnail ?? map.thumbnailUrl ?? null;
}

const medal = (place: Place) => {
  const el = h("span.dyp-medal", { title: `${["", "1st", "2nd", "3rd"][place]} place`, role: "img", "aria-label": `${["", "1st", "2nd", "3rd"][place]} place` });
  // The daily mark's plain disc in the place's metal, with the place engraved (creators.ts dailyMarkSvg).
  el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${dailyMarkSvg(METAL_OF[place], place)}</svg>`;
  return el;
};

function caption(place: Place, s: PodiumStanding | null, shown: Shown | null): HTMLElement {
  // An empty step has no caption: no name, no placeholder.
  if (!s) return h("li.dyp-cap.empty", { "data-place": String(place), "aria-hidden": "true" });
  const p: ApiPlayer = s.player;
  const title = `#${place} · ${p.name} · Daily${shown ? `, ${shown.label}` : ""}`;
  const name = hoverCardFor(
    h(
      "a.dyp-name",
      {
        href: `/u/${encodeURIComponent(p.id)}`,
        onclick: (ev: Event) => {
          const e = ev as MouseEvent;
          if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          navigate({ screen: "profile", id: p.id });
        },
        ...nameAttrs(p),
      },
      p.name,
    ),
    p,
  );
  // Watch: the game's play triangle, one per place (ui/icons.ts; the label and the replay's view count are in its title).
  const watch = !s.watch ? null : withReplayViews(
    h("button.dyp-play", { type: "button", "data-part": "watch", title: `Watch ${p.name}'s run`, "aria-label": `Watch ${p.name}'s run`, onclick: () => openReplayViewer({ runId: s.runId, name: title }) }, icon("play")),
    s.runId,
  );
  // The name in the player's own name style with their marks, as a leaderboard row shows them (ui/marks.ts): marks that
  // don't fit beside the name are left off (daily-podium.css), the first ones stay.
  return h(
    "li.dyp-cap",
    { "data-place": String(place), "data-player": p.id },
    h("span.dyp-who", null, name, nameMarks(p)),
    h("span.dyp-run", null, medal(place), h("b.dyp-time", null, formatTime(s.time))),
    watch,
  );
}

/**
 * Puts the podium where the daily screen's map picture is (`side`: the screen's left column, already filled). `day`:
 * the day the screen shows. The picture itself stays inside the podium's frame: it is what shows until the scene is
 * drawn, and all that shows where the scene can't be.
 */
export function mountDailyPodium(side: HTMLElement, v: DailyOn, day: string): HTMLElement {
  const art = side.querySelector<HTMLElement>(".dy-art");
  const slot = art ? document.createComment("") : null;
  if (art && slot) art.replaceWith(slot);
  const view = new PodiumView(v.today.day, day, art);
  if (slot) slot.replaceWith(view.el);
  else side.prepend(view.el);
  const t = v.today;
  if (day === t.day) view.show({ day: t.day, label: t.label, map: t.map, open: !t.closed && t.endsAt > v.now, players: t.players, standings: podiumPlaces(t.top) });
  else
    void earlierDay(day).then(
      (s) => s && view.show(s),
      () => {},
    );
  return view.el;
}

/** An earlier day's podium: from the last two weeks' list (the page reads it anyway), else from that day's board. */
async function earlierDay(day: string): Promise<Shown | null> {
  const d = (await api.dailyDays().catch(() => null))?.days.find((x) => x.day === day);
  if (d) return { day, label: d.label, map: d.map, open: false, players: d.players, standings: podiumPlaces(d.podium) };
  const b = await api.dailyBoard(day);
  return { day, label: b.label, map: b.map, open: false, players: b.total, standings: podiumPlaces(b.podium ?? b.entries) };
}

export type { Shown as PodiumShown };

if (import.meta.env?.DEV && typeof window !== "undefined")
  Object.assign(window, { __dailyPodium: { stats: podiumStats, paint: paintStats, stage: () => stage, release: releaseStage, timing } });
