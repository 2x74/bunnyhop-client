import type { ScoreHead, ScoreRow } from "../../web/src/net/scoreboard";
import { roomStyleAt } from "./room-styles";
import { staffBadgeOf } from "../../web/src/creators";
import { formatTime } from "../../web/src/timer";
import type { RoomView } from "./room-service";
import { roomTimeLeft } from "../../web/src/net/daily-room";
import { scoreOrder } from "../../web/src/net/score-order";
const PALETTE = [
  "#ff7a59",
  "#4fa8ff",
  "#5ee08a",
  "#ffd84d",
  "#c477ff",
  "#ff5d9e",
  "#3fd0c9",
  "#ffa94d",
  "#9aa3ff",
  "#b6f06a",
];
/** A player's run time while it runs (seconds at `now`), else null. */
export function runningSeconds(view: RoomView, slot: number, now: number): number | null {
  const meta = view.metas[String(slot)];
  if (meta?.timer !== 2) return null;
  const readAt = view.metaAt?.[String(slot)] ?? now;
  return meta.timerTicks / 100 + Math.max(0, (now - readAt) / 1000);
}
/** The room's practice tag (roster `practice`, rooms from web 0.0.36), newer than the vendored roster type. */
function isPractising(player: object): boolean {
  return "practice" in player && player.practice === true;
}
/** Display only. Server metadata remains untrusted for records and score writes. */
export function roomScoreboard(
  view: RoomView,
  now: number,
  serverNow: number,
  selfPing?: number | null,
): { head: ScoreHead; rows: ScoreRow[] } {
  const rows: ScoreRow[] = view.players.map((p) => {
    const m = view.metas[String(p.slot)],
      style = roomStyleAt(m?.style ?? -1) ?? p.style;
    const bests: Partial<Record<string, number>> = p.pb ?? {};
    const role = p.role !== undefined ? p.role : p.admin ? "admin" : null;
    let status = "—",
      statusKind: ScoreRow["statusKind"] = "idle";
    if (p.spec != null) {
      status = `SPEC → ${view.players.find((other) => other.slot === p.spec)?.name ?? "?"}`;
      statusKind = "spec";
    } else if (isPractising(p)) {
      // A practice attempt is never a run, so its time isn't shown (web net/players.ts).
      status = "practice";
    } else if (m) {
      const seconds =
        m.timerTicks / 100 + (m.timer === 2 ? Math.max(0, (now - (view.metaAt?.[String(p.slot)] ?? now)) / 1000) : 0);
      if (m.timer === 2 || m.timer === 3) {
        status = formatTime(seconds);
        statusKind = m.timer === 2 ? "running" : "finished";
      } else if (m.timer === 1) status = "start zone";
    }
    return {
      slot: p.slot,
      you: p.slot === view.you,
      name: p.name,
      color: PALETTE[p.slot % PALETTE.length],
      rank: p.rank ?? null,
      role,
      verified: p.verified,
      creator: p.creator,
      special: p.special,
      booster: p.booster,
      supporter: p.supporter,
      nameColor: p.nameColor,
      nameEffect: p.nameEffect,
      nameColor2: p.nameColor2,
      nameFont: p.nameFont,
      nameBadges: p.nameBadges,
      giftsSent: p.giftsSent,
      gifterColors: p.gifterColors,
      gifterAnimated: p.gifterAnimated,
      staff: p.staff !== undefined ? p.staff : staffBadgeOf(role),
      style,
      status,
      statusKind,
      pb: bests[style] ?? null,
      ping: p.slot === view.you ? (selfPing === undefined ? (m?.ping ?? null) : selfPing) : (m?.ping ?? null),
      host: !!view.room?.private && p.slot === view.room.host,
      country: p.country ?? null,
    };
  });
  // Equal PBs: who set theirs first, as on the boards (web net/mp.ts, net/score-order.ts).
  const pbAt = new Map(
    view.players.map((p) => [p.slot, (p as { pbAt?: Partial<Record<string, number>> }).pbAt ?? {}] as const),
  );
  rows.sort((a, b) =>
    scoreOrder(
      { pb: a.pb, pbAt: pbAt.get(a.slot)?.[a.style] ?? null, name: a.name },
      { pb: b.pb, pbAt: pbAt.get(b.slot)?.[b.style] ?? null, name: b.name },
    ),
  );
  // The Daily room counts down to the end of the day ("5h 12m left"), then to its map change (web net/daily-room.ts).
  let timeLeft = "";
  if (view.change) timeLeft = `changing to ${view.change.map}`;
  else if (view.mapInfo) timeLeft = roomTimeLeft(serverNow, view.mapInfo.endsAt, view.mapInfo.daily ?? view.room?.daily);
  return {
    rows,
    head: {
      room: view.room?.name ?? view.id ?? "Room",
      map: view.map,
      tier: view.mapInfo?.tier ?? null,
      timeLeft,
      players: view.players.length,
      max: view.room?.maxPlayers ?? 0,
      nextMap: view.change?.map ?? view.nextMap ?? (view.mapInfo?.daily ?? view.room?.daily)?.nextMap ?? null,
      spectating: view.players.find((p) => p.slot === view.you)?.spec != null,
    },
  };
}
