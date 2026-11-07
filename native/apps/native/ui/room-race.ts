import type { RoomRaceView } from "../../web/src/net/protocol";
import type { RunBoard } from "../../web/src/net/presence";
import { isStyleId } from "../../web/src/styles";

const uint = (n: unknown, max: number): boolean => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= max;
const time = (n: unknown): boolean => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** Bound the additive socket view before forwarding it to the native game. */
export function validRoomRace(r: RoomRaceView | null): boolean {
  return (
    r === null ||
    (!!r &&
      typeof r.id === "string" &&
      /^[a-z0-9]{10}$/.test(r.id) &&
      ["joining", "countdown", "live", "settling", "over"].includes(r.state) &&
      typeof r.map === "string" &&
      /^[a-zA-Z0-9_.-]{1,128}$/.test(r.map) &&
      isStyleId(r.style) &&
      uint(r.track, 64) &&
      time(r.joinUntil) &&
      [r.goAt, r.endsAt].every((n) => n === null || time(n)) &&
      Array.isArray(r.racers) &&
      r.racers.length <= 64 &&
      Number.isInteger(r.you) &&
      r.you >= -1 &&
      r.you < r.racers.length &&
      (r.outcome === undefined || ["finish", "timeout", "cancelled"].includes(r.outcome)) &&
      r.racers.every(
        (p) =>
          !!p &&
          typeof p.name === "string" &&
          p.name.length <= 128 &&
          (p.slot === null || uint(p.slot, 255)) &&
          (p.place === null || (uint(p.place, 64) && p.place > 0)) &&
          (p.dnf === null || ["forfeit", "left", "timeout"].includes(p.dnf)) &&
          typeof p.checking === "boolean" &&
          (p.finish === null || (!!p.finish && time(p.finish.time) && time(p.finish.real))),
      ))
  );
}

export function roomRaceTag(race: RoomRaceView | null, run: RunBoard): string | null {
  const me = race && race.you >= 0 ? race.racers[race.you] : null;
  return race?.state === "live" &&
    me &&
    me.place === null &&
    !me.dnf &&
    !me.finish &&
    run.map === race.map &&
    run.style === race.style &&
    run.track === race.track
    ? race.id
    : null;
}
