import { expect, test } from "bun:test";
import { cleanLoadout, packLoadout } from "../../web/src/loadout";
import { rosterPack, withLoadoutPacks } from "./room-loadout";
import type { ServerMsg } from "../../web/src/net/protocol";

const loadout = { knife: "knife-carrot", finish: "fin-garden", glove: "glove-knit", crown: 2 };

test("roster loadouts reach the game as the website packs them", () => {
  expect(rosterPack(loadout)).toBe(packLoadout(cleanLoadout(loadout)!));
  expect(rosterPack("not a loadout")).toBeNull();
  const welcome = withLoadoutPacks({
    t: "welcome",
    players: [
      { slot: 1, name: "a", loadout },
      { slot: 2, name: "b" },
    ],
  } as unknown as ServerMsg) as unknown as { players: { pack?: string }[] };
  expect(welcome.players[0].pack).toBe(rosterPack(loadout)!);
  expect(welcome.players[1].pack).toBeUndefined();
  const join = withLoadoutPacks({ t: "join", player: { slot: 3, loadout } } as unknown as ServerMsg) as unknown as {
    player: { pack?: string };
  };
  expect(join.player.pack).toBe(rosterPack(loadout)!);
  const patch = withLoadoutPacks({ t: "player", slot: 3, patch: { loadout } } as unknown as ServerMsg) as unknown as {
    patch: { pack?: string };
  };
  expect(patch.patch.pack).toBe(rosterPack(loadout)!);
  const chat = { t: "chat", text: "hi" } as unknown as ServerMsg;
  expect(withLoadoutPacks(chat)).toBe(chat);
});
