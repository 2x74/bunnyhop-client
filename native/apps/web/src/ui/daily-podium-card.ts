// The Daily Challenge podium as one 1200x630 picture for the close-of-day Discord post: the page's scene
// (daily/podium-scene.ts), from the same camera with room added under the podium for the names and times, and the
// card's words drawn over it in the look of the flat top-three card (apps/api src/og/cards.ts dailyCard).
//
// Nothing here talks to a server. The daily page draws it when it is opened with `?podium=card` (ui/daily-podium.ts)
// and leaves it in the document as a hidden <canvas id="dyp-card"> whose data attributes say what it shows
// (data-day, data-places = the three player ids in order, data-ready="1"): the render host's job reads the canvas as
// a JPEG and checks those against the podium it was asked for (design: the lane's report, "The Discord image").
//
// The bunnies wear what they wear in the game, except staff-only items (podium-data.ts shareLook): those are for
// their holders' eyes in the game and are left off a picture that leaves it.

import { lookOfRun } from "./daily-podium";
import type { PodiumShown } from "./daily-podium";
import type { Painter } from "./daily-podium-paint";
import { mapImages } from "./thumbs";
import { dressPodium, shareLook, type PodiumStanding } from "../daily/podium-data";
import { CAMERA, STEP_X } from "../daily/podium-scene";
import { formatTime } from "../timer";

export const CARD_W = 1200;
export const CARD_H = 630;
/** Heights (units at the podium) the picture's bottom and top edges show: the page's frame plus a band under the podium. */
const LO = -36, HI = CAMERA.target + CAMERA.half;
const C = { text: "#eef1f6", dim: "#a3abba", gold: "#ffd45e" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `text` cut with an ellipsis to fit `max` pixels in the context's font. */
function fit(g: CanvasRenderingContext2D, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

/** Where a place's column is on the card (pixels): under its step, as the camera sees it. */
export function columnX(place: 1 | 2 | 3): number {
  return CARD_W / 2 + (STEP_X[place] * CARD_H) / (HI - LO);
}

/** The words over the picture. Exported for the tests of what the card says. */
export function cardLines(s: Pick<PodiumShown, "label" | "map" | "players" | "standings">): { title: string; map: string; date: string; players: string | null; places: { place: 1 | 2 | 3; name: string; time: string }[] } {
  return {
    title: "Daily Challenge",
    map: s.map.name,
    date: s.label,
    players: s.players === null || s.players === undefined ? null : `${s.players.toLocaleString("en-US")} ${s.players === 1 ? "player" : "players"}`,
    places: s.standings.map((x: PodiumStanding) => ({ place: x.place, name: x.player.name, time: formatTime(x.time) })),
  };
}

/**
 * Draws the day's card and leaves it in the document (see the top of the file). Resolves with the canvas, or null when
 * the scene couldn't be drawn (the caller keeps the flat card).
 */
export async function drawPodiumCard(painter: Painter, s: PodiumShown): Promise<HTMLCanvasElement | null> {
  const { PodiumScene } = await import("../daily/podium-scene");
  const font = getComputedStyle(document.documentElement).getPropertyValue("--font-ui").trim() || "sans-serif";
  await Promise.all([document.fonts?.load(`800 54px ${font}`), document.fonts?.load(`650 30px ${font}`)]).catch(() => {});
  const scene = new PodiumScene({ font });
  try {
    scene.warm = (root) => painter.warm(root, scene.scene, scene.camera);
    scene.setAspect(CARD_W / CARD_H, LO, HI);
    const reg = mapImages(s.map.name);
    scene.setBackdrop(reg?.hero ?? reg?.thumbnail ?? s.map.thumbnailUrl ?? null);
    const found = await Promise.all(s.standings.map((x) => lookOfRun(x.runId)));
    const { want, kept: standings } = dressPodium(s.standings, found);
    scene.set(want.map((w) => w && { id: w.id, look: shareLook(w.look) }));
    // Every bunny in, then a moment of the idle so the stance and the winner's arm are where they rest.
    for (let i = 0; i < 100 && !scene.settled; i++) await sleep(100);
    if (!scene.settled) return null;
    await sleep(400); // the backdrop's picture
    for (let i = 0; i < 60; i++) scene.advance(1 / 30);
    const shot = painter.snapshot(scene.scene, scene.camera, CARD_W, CARD_H);
    if (!shot) return null;

    const g = shot.getContext("2d")!;
    const words = cardLines({ ...s, standings });
    // The heading's corner and the names' band, a little darker so the words read on any map.
    const top = g.createLinearGradient(0, 0, 0, 190);
    top.addColorStop(0, "rgba(8, 9, 13, 0.62)");
    top.addColorStop(1, "rgba(8, 9, 13, 0)");
    g.fillStyle = top;
    g.fillRect(0, 0, CARD_W, 190);
    g.textBaseline = "alphabetic";
    g.textAlign = "left";
    g.fillStyle = C.text;
    g.font = `800 54px ${font}`;
    g.fillText(words.title, 56, 86);
    g.font = `700 28px ${font}`;
    const map = fit(g, words.map, 420);
    g.fillText(map, 58, 132);
    const mw = g.measureText(map).width;
    g.fillStyle = C.dim;
    g.font = `500 26px ${font}`;
    g.fillText(words.date, 58 + mw + 18, 132);
    g.textAlign = "right";
    g.fillStyle = C.text;
    g.font = `750 28px ${font}`;
    g.fillText("bunnyhop", CARD_W - 56 - g.measureText(".lol").width, 78);
    g.fillStyle = "#ffb43a";
    g.fillText(".lol", CARD_W - 56, 78);
    if (words.players) {
      g.fillStyle = C.dim;
      g.font = `500 24px ${font}`;
      g.fillText(words.players, CARD_W - 56, 116);
    }
    g.textAlign = "center";
    for (const p of words.places) {
      const x = columnX(p.place);
      g.fillStyle = C.text;
      g.font = `700 30px ${font}`;
      g.fillText(fit(g, p.name, 300), x, 560);
      g.fillStyle = p.place === 1 ? C.gold : C.text;
      g.font = `750 28px ${font}`;
      g.fillText(p.time, x, 600);
    }

    document.getElementById("dyp-card")?.remove();
    shot.id = "dyp-card";
    shot.hidden = true;
    shot.dataset.day = s.day;
    shot.dataset.places = standings.map((x) => x.player.id).join(",");
    shot.dataset.ready = "1";
    document.body.append(shot);
    return shot;
  } finally {
    scene.dispose();
  }
}
