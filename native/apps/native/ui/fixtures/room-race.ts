import type { RoomRaceView } from "../../../web/src/net/protocol";

export function roomRace(state: RoomRaceView["state"] = "joining"): RoomRaceView {
  return {
    id: "roomrace01",
    state,
    map: "bhop_eazy",
    style: "autohop",
    track: 0,
    joinUntil: 20000,
    goAt: 23000,
    endsAt: 623000,
    you: 0,
    racers: ["Alice", "Bob"].map((name, slot) => ({
      name,
      slot,
      place: null,
      dnf: null,
      finish: null,
      checking: false,
    })),
  };
}
