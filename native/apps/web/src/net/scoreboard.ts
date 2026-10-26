// Shared DOM scoreboard: usable by web gameplay and the native room menu.
import "./net.css";
import {clear,h} from "../ui/dom";
import {formatTime} from "../timer";
import {styleLabel} from "../styles";
import type {StaffRole} from "../progression";
import type {RankTag} from "./protocol";
import type {PlayerMarks} from "../creators";
import {countryFlag} from "../ui/country-flag";
import {nameAttrs,nameMarks} from "../ui/marks";
export interface ScoreRow extends PlayerMarks {
  slot: number;
  you: boolean;
  name: string;
  color: string;
  rank: RankTag | null;
  role: StaffRole | null;
  style: string;
  /** "0:12.345", "start", "—", "SPEC → name" */
  status: string;
  statusKind: "running" | "finished" | "idle" | "spec";
  pb: number | null;
  ping: number | null;
  /** A private lobby's host (net/lobby.ts). */
  host?: boolean;
  /** Profile flag (countries.ts code), before the name as on the boards. */
  country?: string | null;
}

export interface ScoreHead {
  room: string;
  map: string;
  tier: number | null;
  timeLeft: string;
  players: number;
  max: number;
  nextMap: string | null;
  /** You're spectating: the footer has the spectator's keys. */
  spectating?: boolean;
}

/** Tab scoreboard. */
export class Scoreboard {
  readonly el = h("div#mp-scoreboard", { hidden: true, role: "dialog", "aria-label": "Scoreboard" });

  constructor(parent: HTMLElement) {
    parent.append(this.el);
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  show(on: boolean): void {
    this.el.hidden = !on;
  }

  render(head: ScoreHead, rows: ScoreRow[]): void {
    const playing = rows.filter((r) => r.statusKind !== "spec");
    const spec = rows.filter((r) => r.statusKind === "spec");
    const row = (r: ScoreRow, i: number) =>
      h(
        `tr${r.you ? ".you" : ""}`,
        null,
        h("td.sb-pos", null, String(i + 1)),
        h(
          "td.sb-name",
          null,
          h("i.sb-dot", { style: `background:${r.color}` }),
          r.rank ? h("span.chat-tag", { style: `--rc:${r.rank.color}` }, r.rank.name) : null,
          countryFlag(r.country),
          h("span.sb-pname", nameAttrs(r), r.name),
          nameMarks(r),
          r.host ? h("span.sb-host", { title: "Lobby host" }, "host") : null,
        ),
        h("td.sb-style", null, styleLabel(r.style)),
        h(`td.sb-time.${r.statusKind}`, null, r.status),
        h("td.sb-pb", null, r.pb === null ? "—" : formatTime(r.pb)),
        h("td.sb-ping", null, r.ping === null ? "—" : String(r.ping)),
      );
    clear(this.el,
      h(
        "div.sb-head",
        null,
        h("div.sb-room", null, h("b", null, head.room), h("span.dim", null, ` · ${head.players}/${head.max} players`)),
        h(
          "div.sb-map",
          null,
          h("b", null, head.map),
          head.tier ? h(`span.badge.tier.t${head.tier}`, null, `T${head.tier}`) : null,
          h("span.dim", null, ` · ${head.timeLeft}`),
          head.nextMap ? h("span.dim", null, ` · next: ${head.nextMap}`) : null,
        ),
      ),
      h(
        "table.sb-table",
        null,
        h("thead", null, h("tr", null, h("th", null, "#"), h("th", null, "Player"), h("th", null, "Style"), h("th", null, "Time"), h("th", null, "PB"), h("th", null, "Ping"))),
        h("tbody", null, ...playing.map(row)),
      ),
      spec.length ? h("div.sb-spec", null, h("span.dim", null, "Spectating: "), spec.map((r) => `${r.name}${r.status.replace(/^SPEC/, "")}`).join(", ")) : null,
      h("div.sb-hint.dim", null, head.spectating ? "Mouse 1 and 2 switch players. Space changes the camera. R respawns you." : "Y to chat, N to spectate. Type rtv, nominate or timeleft. Esc has the server menu."),
    );
  }
}
