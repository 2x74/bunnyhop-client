import { expect, test } from "bun:test";
import { cleanLoadout, loadoutFor, packLoadout, unpackLoadout } from "../../web/src/loadout";
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

// Packs with the v0.0.42 fields, as the website's own pack tests spell them (apps/api/test heads, hop-effects and
// backs tests) or as the website packed them at the synced commit (cape and robe options, the mask worn).
const WEBSITE_PACKS: [Record<string, unknown>, string][] = [
  [{ back: "back-cape" }, "2;knife-carrot;fin-garden;glove-knit;;;;;;;;;;back-cape"],
  [
    {
      hop: "hop-ring",
      trail: "trail-sky",
      back: "back-balloon",
      hat: "hat-ponytail",
      hairColor: "#2fa59a",
      hairLength: 150,
    },
    "2;knife-carrot;fin-garden;glove-knit;;hat-ponytail;;;2fa59a;150;;;hop-ring:sky;back-balloon",
  ],
  [
    {
      hop: "hop-ring",
      trail: "trail-sky",
      back: "back-balloon",
      hat: "hat-ponytail",
      hairColor: "#2fa59a",
      hairLength: 150,
      hairHighlight: "#ffaa33",
    },
    "2;knife-carrot;fin-garden;glove-knit;;hat-ponytail;;;2fa59a;150;;;hop-ring:sky;back-balloon;;-z",
  ],
  [
    { camo: "camo-woodland", hop: "hop-ring", trail: "trail-rose" },
    "2;knife-carrot;fin-garden;glove-knit;;;;;;;;camo-woodland;hop-ring:rose",
  ],
  [{ hat: "hat-kitsune-mask" }, "2;knife-carrot;fin-garden;glove-knit;;hat-kitsune-mask"],
  [
    { back: "back-cape", capeLength: 180, capeColor: "#c8202c", capeLining: "#ffffff" },
    "2;knife-carrot;fin-garden;glove-knit;;;;;;;;;;back-cape;dgN8b___",
  ],
  [
    {
      back: "back-robe",
      robePattern: 3,
      robeTied: true,
      robeColor: "#223344",
      robePrint: "#ddeeff",
      hat: "hat-kitsune-mask",
      maskOn: true,
    },
    "2;knife-carrot;fin-garden;glove-knit;;hat-kitsune-mask;;;;;;;;back-robe;cb8dhTX_;f",
  ],
  // v0.0.43: the Daily Challenge's finish and camos, the Daily Medal with and without its look, the living hilts. A
  // charm never enters the pack (it rides in its own roster fields and the replay's continuation trailer).
  [{ finish: "fin-sunray", camo: "camo-first-light" }, "2;knife-carrot;fin-sunray;glove-knit;;;;;;;;camo-first-light"],
  [
    { camo: "camo-midnight-sun", back: "back-medal", medal: 13 },
    "2;knife-carrot;fin-garden;glove-knit;;;;;;;;camo-midnight-sun;;back-medal;d",
  ],
  [{ back: "back-medal" }, "2;knife-carrot;fin-garden;glove-knit;;;;;;;;;;back-medal"],
  [
    { hilt: "hilt-watcher", charm: "charm-bun", charmSwing: 60, charmPommel: true },
    "2;knife-carrot;fin-garden;glove-knit;;;;;;;hilt-watcher",
  ],
  [
    { knife: "knife-karrotbit", hilt: "hilt-frostrune", charm: "charm-toadstool", charmLength: 200, charmSize: 140 },
    "2;knife-karrotbit;fin-garden;glove-knit;;;;;;;hilt-frostrune",
  ],
];

test("players wearing the new items reach the game byte for byte", () => {
  for (const [choice, pack] of WEBSITE_PACKS) {
    const worn = loadoutFor(choice);
    expect(packLoadout(worn)).toBe(pack);
    // The server sends the cleaned loadout object; the menu packs it again, to the same bytes.
    expect(rosterPack(worn), pack).toBe(pack);
    expect(rosterPack(unpackLoadout(pack)), pack).toBe(pack);
    const join = withLoadoutPacks({ t: "join", player: { slot: 4, loadout: worn } } as unknown as ServerMsg);
    expect((join as unknown as { player: { pack?: string } }).player.pack).toBe(pack);
  }
});

test("the fullest loadout still fits the game's 200-byte pack", () => {
  const fullest = loadoutFor(
    {
      knife: "knife-karrotbit",
      finish: "fin-dewweb",
      glove: "glove-garden-tulip",
      hilt: "hilt-oak",
      camo: "camo-carrot-patch",
      hat: "hat-ponytail",
      body: "body-b",
      hairColor: "#f29bbf",
      hairLength: 260,
      hairHighlight: "#ffaa33",
      hop: "hop-crystals",
      trail: "trail-rose",
      back: "back-cape",
      capeLength: 260,
      capeColor: "#c8202c",
      capeLining: "#112233",
    },
    3,
  );
  const pack = rosterPack(fullest)!;
  expect(pack).toBe(
    "2;knife-karrotbit;fin-dewweb;glove-garden-tulip;3;hat-ponytail;body-b;;f29bbf;260;hilt-oak;camo-carrot-patch;" +
      "hop-crystals:rose;back-cape;ewN8b48d;-z",
  );
  expect(new TextEncoder().encode(pack).length).toBeLessThanOrEqual(200);
});

test("unknown or broken new fields from a newer server never break the pack", () => {
  const plain = rosterPack({ knife: "knife-carrot", finish: "fin-garden", glove: "glove-knit" });
  expect(rosterPack({ knife: "knife-carrot", finish: "fin-garden", glove: "glove-knit", back: "back-nope" })).toBe(
    plain,
  );
  expect(
    rosterPack({ knife: "knife-carrot", finish: "fin-garden", glove: "glove-knit", hop: 7, capeColor: "red" }),
  ).toBe(plain);
  expect(rosterPack({ knife: "knife-carrot", finish: "fin-garden", glove: "glove-knit", future: "x" })).toBe(plain);
});
