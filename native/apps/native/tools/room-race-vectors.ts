// Regenerate the native lifecycle expectations from the pinned web controller.
import { RoomRaceClient } from "../../web/src/net/room-race";
import type { RoomRaceView } from "../../web/src/net/protocol";
import { roomRace } from "../ui/fixtures/room-race";
const base = roomRace("countdown");
base.joinUntil = 7000;
base.goAt = 10000;
base.endsAt = 610000;
const state = (phase: RoomRaceView["state"], patch: Partial<RoomRaceView> = {}): RoomRaceView => ({
  ...structuredClone(base),
  state: phase,
  ...patch,
});
const finished = state("over", { outcome: "finish" });
finished.racers[0].place = 1;
finished.racers[0].finish = { real: 12, time: 11 };
const forfeit = state("countdown");
forfeit.racers[0].dnf = "forfeit";
const cases = [
  {
    name: "countdown, duplicate GO, final finish",
    views: [
      state("joining"),
      state("countdown"),
      state("countdown"),
      state("live"),
      state("live"),
      finished,
      finished,
      null,
    ],
  },
  {
    name: "observer",
    views: [state("countdown", { you: -1 }), state("live", { you: -1 }), state("over", { you: -1 })],
  },
  { name: "live reconnect", views: [state("live"), state("live")] },
  { name: "forfeit before GO", views: [state("countdown"), forfeit, { ...forfeit, state: "live" as const }] },
  { name: "cancel before GO", views: [state("countdown"), state("over", { outcome: "cancelled" })] },
  { name: "bonus", views: [state("countdown", { track: 2 }), state("live", { track: 2 })] },
];
const vectors = [];
for (const example of cases) {
  let restarts = 0,
    go = 0,
    finish = 0,
    over = 0;
  const client = new RoomRaceClient({
    selectedStyle: () => "autohop",
    setStyle: async () => {},
    restart: () => {
      restarts++;
    },
    spectating: () => false,
    stopSpectating() {},
    toLocal: (time) => time,
    reply() {},
    event: (event) => {
      if (event.kind === "go") go++;
      if (event.kind === "finish") finish++;
      if (event.kind === "over") over++;
    },
  });
  const steps = [];
  for (const view of example.views) {
    const before = { restarts, go, finish, over };
    client.onState(view);
    await Promise.resolve();
    await Promise.resolve();
    steps.push({
      view,
      restart: restarts > before.restarts,
      go: go > before.go,
      finish: finish > before.finish,
      over: over > before.over,
      frozen: client.frozen,
    });
  }
  vectors.push({ name: example.name, steps });
}
await Bun.write(new URL("../src/room_race_vectors.json", import.meta.url), JSON.stringify(vectors, null, 2) + "\n");
