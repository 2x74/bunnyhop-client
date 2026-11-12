// The profile's Compare tab (someone else's profile): you against them, from GET /players/:id/compare/:other. A score
// line (who is faster on how many of the maps you've both finished), then the maps themselves: the ones they lead
// closest first (what you could take next), the ones you lead closest first (what they could take back), and the maps
// only one of you has finished. Every row plays its map; Watch on a map you've both finished opens the two runs head to
// head (viewer/h2h.ts: your run on the left, theirs on the right), and on a one-sided row that player's run.

import { api, type CompareBoard, type PlayerCompare } from "../api";
import { styleLabel } from "../styles";
import { formatTime } from "../timer";
import { openHeadToHead, openReplayViewer } from "../viewer/request";
import { h } from "./dom";

type View = "both" | "them" | "you";

const secs = (ms: number) => formatTime(ms / 1000);
/** Your time against theirs: "−0.532" (you're faster) or "+1.204". */
const gapText = (ms: number) => `${ms < 0 ? "−" : "+"}${(Math.abs(ms) / 1000).toFixed(3)}`;
const boardTags = (b: CompareBoard) => [b.track ? `Bonus ${b.track}` : null, styleLabel(b.style)].filter(Boolean).join(", ");
const place = (rank: number, players: number) => (rank === 1 ? h("span.place.wr-word", { title: "World record" }, "WR") : h(`span.place${rank <= 10 ? ".top10" : ""}`, null, `#${rank}`, h("small.dim", null, `/${players}`)));

/** Your time minus theirs on a board you've both finished (ms; negative: you're faster). */
const gap = (b: CompareBoard) => b.a!.ms - b.b!.ms;

/**
 * The boards sorted into the tab's lists (side a is you). Shared boards closest first on each side: the next map you
 * could take, and the next one they could take back. Maps only they have: easiest and busiest first.
 */
export function splitCompare(boards: readonly CompareBoard[]) {
  const both = boards.filter((b) => b.a && b.b);
  return {
    both,
    theirs: both.filter((b) => gap(b) > 0).sort((x, y) => gap(x) - gap(y)),
    yours: both.filter((b) => gap(b) < 0).sort((x, y) => gap(y) - gap(x)),
    level: both.filter((b) => gap(b) === 0),
    onlyThem: boards.filter((b) => !b.a && b.b).sort((x, y) => x.tier - y.tier || y.players - x.players),
    onlyYou: boards.filter((b) => b.a && !b.b).sort((x, y) => y.tier - x.tier || x.a!.rank - y.a!.rank),
  };
}

export function profileCompare(me: { id: string }, them: { id: string; name: string }, play: (map: string, style?: string) => void): HTMLElement {
  const body = h("div.pf-cmp-body", { "aria-busy": "true" });
  const el = h("section.pf-cmp", null, body);
  const load = () =>
    api.playerCompare(me.id, them.id).then(draw, () =>
      body.replaceChildren(h("p.pf-empty", null, "Couldn't load the comparison. ", h("button.link-btn", { type: "button", onclick: load }, "Try again"))),
    ).finally(() => body.removeAttribute("aria-busy"));

  const mapCell = (b: CompareBoard) =>
    h("span.pf-run-map", null, h("button.link-btn", { type: "button", onclick: () => play(b.map, b.style), title: `Play ${b.map} (tier ${b.tier})` }, b.map), h("small", null, boardTags(b)));
  const watch = (b: CompareBoard) =>
    b.a && b.b
      ? h("button.link-btn", { type: "button", onclick: () => openHeadToHead(b.a!.runId, b.b!.runId), title: `Watch your run and ${them.name}'s side by side` }, "Watch")
      : h("button.link-btn", { type: "button", onclick: () => openReplayViewer({ runId: (b.a ?? b.b)!.runId }), title: "Watch this run" }, "Watch");
  const row = (b: CompareBoard, cells: (Node | string | null)[]) =>
    h(`div.pf-cmp-row.t${b.tier}`, null, mapCell(b), ...cells, h("span.pf-cmp-acts", null, watch(b), h("button.link-btn", { type: "button", onclick: () => play(b.map, b.style), title: `Play ${b.map}` }, "Play ›")));

  function draw(res: PlayerCompare): void {
    const { both, theirs, yours, level, onlyThem, onlyYou } = splitCompare(res.boards);

    const bothRows = (list: CompareBoard[]) =>
      list.map((b) => row(b, [h("span.pf-cmp-t", null, secs(b.a!.ms)), h("span.pf-cmp-t", null, secs(b.b!.ms)), h(`span.pf-cmp-gap${gap(b) < 0 ? ".ahead" : gap(b) > 0 ? ".behind" : ""}`, null, gapText(gap(b)))]));
    const group = (title: string, list: CompareBoard[]) => (list.length ? [h("h4.pf-cmp-h", null, title, h("small", null, String(list.length))), ...bothRows(list)] : []);
    const head = (...cols: string[]) => h("div.pf-cmp-row.pf-cmp-head", { "aria-hidden": "true" }, h("span", null, "Map"), ...cols.map((c) => h("span.pf-cmp-t", null, c)), h("span"));

    const views: Record<View, () => Node[]> = {
      both: () =>
        both.length
          ? [head("You", them.name, "Gap"), ...group(`${them.name} is ahead`, theirs), ...group("You're ahead", yours), ...group("Level", level)]
          : [h("p.pf-empty", null, `You and ${them.name} haven't finished any of the same maps yet.`)],
      them: () =>
        onlyThem.length
          ? [head(them.name, "Place"), ...onlyThem.map((b) => row(b, [h("span.pf-cmp-t", null, secs(b.b!.ms)), h("span.pf-cmp-t", null, place(b.b!.rank, b.players))]))]
          : [h("p.pf-empty", null, `You've finished every map ${them.name} has.`)],
      you: () =>
        onlyYou.length
          ? [head("You", "Place"), ...onlyYou.map((b) => row(b, [h("span.pf-cmp-t", null, secs(b.a!.ms)), h("span.pf-cmp-t", null, place(b.a!.rank, b.players))]))]
          : [h("p.pf-empty", null, `${them.name} has finished every map you have.`)],
    };
    let view: View = both.length ? "both" : onlyThem.length ? "them" : "you";
    const list = h("div.pf-cmp-list");
    const seg = h("div.pf-seg", { role: "group", "aria-label": "Which maps" });
    const tabs: [View, string, number][] = [
      ["both", "Both", both.length],
      ["them", `Only ${them.name}`, onlyThem.length],
      ["you", "Only you", onlyYou.length],
    ];
    const show = (v: View) => {
      view = v;
      seg.replaceChildren(...tabs.map(([id, label, n]) => h(`button${id === view ? ".on" : ""}`, { type: "button", "aria-pressed": String(id === view), onclick: () => show(id) }, label, h("small", null, ` ${n}`))));
      list.dataset.view = v;
      list.replaceChildren(...views[v]());
      list.scrollTop = 0;
    };

    // The score: who is faster on how many shared maps, and a bar split the same way.
    const score = both.length
      ? h(
          "div.pf-cmp-score",
          null,
          h(`b.pf-cmp-n${yours.length > theirs.length ? ".lead" : ""}`, null, String(yours.length)),
          h("span.pf-cmp-who", null, "You"),
          h("span.pf-cmp-bar", { "aria-hidden": "true" }, h("i.you", { style: `flex:${yours.length}` }), h("i.level", { style: `flex:${level.length}` }), h("i.them", { style: `flex:${theirs.length}` })),
          h("span.pf-cmp-who", null, them.name),
          h(`b.pf-cmp-n${theirs.length > yours.length ? ".lead" : ""}`, null, String(theirs.length)),
        )
      : null;
    const note = both.length ? h("p.pf-cmp-note", null, `Faster on the ${both.length.toLocaleString("en-US")} ${both.length === 1 ? "map" : "maps"} you've both finished.`) : null;
    const parts: (Node | null)[] = [score, note, seg, list];
    body.replaceChildren(...parts.filter((x): x is Node => !!x));
    show(view);
  }

  void load();
  return el;
}
