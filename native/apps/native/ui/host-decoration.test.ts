import { expect, test } from "bun:test";
import {
  hostFlag,
  hostMarks,
  hostNameLook,
  hostScoreboard,
  readMarks,
  ScoreboardFeed,
  type HostScoreboard,
} from "./host-decoration";
import { NAME_COLORS } from "../../web/src/creators";
import { NAME_FONTS } from "../../web/src/supporter-looks";
import type { RoomView } from "./room-service";

test("a supporter's name and marks come out in the web's order", () => {
  const marks = readMarks({
    nameColor: NAME_COLORS[1].id,
    nameEffect: "shimmer",
    nameColor2: NAME_COLORS[3].id,
    staff: "moderator",
    supporter: true,
    booster: true,
    verified: true,
    giftsSent: 120,
    gifterColors: ["#112233", "nope"],
  });
  // "shimmer" is the old name for paint (creators.ts nameEffectOf).
  expect(hostNameLook(marks)).toEqual({
    color: NAME_COLORS[1].hex,
    color2: NAME_COLORS[3].hex,
    effect: "paint",
    font: null,
  });
  // The shield first, then two more (creators.ts equippedNameBadges): staff wear three marks in all.
  expect(hostMarks(marks).map((mark) => mark.id)).toEqual(["staff", "verified", "booster"]);
  const gifter = hostMarks(readMarks({ giftsSent: 120, gifterColors: ["#112233"], nameBadges: ["gifter"] }));
  expect(gifter).toEqual([{ id: "gifter-prism", name: "Prism Gifter", colors: ["#112233"], animated: false }]);
  // Anything malformed is no mark at all.
  expect(hostMarks(readMarks({ staff: "god", creator: "myspace", verified: "yes" }))).toEqual([]);
});

test("a supporter's name font reaches the host; an unknown or missing one is the default font", () => {
  for (const font of NAME_FONTS) expect(hostNameLook(readMarks({ nameFont: font.id })).font).toBe(font.id);
  for (const nameFont of ["comic", "GROTESK", "", 7, {}, null, undefined])
    expect(hostNameLook(readMarks({ nameFont })).font).toBeNull();
});

test("the Tab board is the room screen's rows; a running time ticking alone isn't sent again", () => {
  const view = {
    id: "eu-1",
    map: "bhop_arcane",
    you: 1,
    room: { name: "EU 1", maxPlayers: 16, private: false },
    players: [
      {
        slot: 1,
        name: "Profile Hopper",
        style: "autohop",
        country: "US",
        supporter: true,
        nameColor: NAME_COLORS[0].id,
        nameFont: "script",
      },
      { slot: 2, name: "oiwa", style: "autohop", spec: 1 },
    ],
    metas: { "1": { timer: 2, timerTicks: 1234, style: 0, ping: 30 } },
    metaAt: { "1": 1000 },
  } as unknown as RoomView;
  const board = hostScoreboard(view, { now: 2000, server: 2000, ping: 25, at: 1_700_000_000_000 });
  expect(board.head?.room).toBe("EU 1");
  const you = board.rows.find((row) => row.slot === 1)!;
  const spectator = board.rows.find((row) => row.slot === 2)!;
  expect(you).toMatchObject({
    slot: 1,
    you: true,
    country: "us",
    statusKind: "running",
    ping: 25,
    look: { color: NAME_COLORS[0].hex, color2: null, effect: null, font: "script" },
    marks: [{ id: "supporter", name: "Supporter" }],
  });
  expect(you.running).toEqual({ seconds: 13.34, at: 1_700_000_000_000 });
  expect(spectator).toMatchObject({ statusKind: "spec", status: "SPEC → Profile Hopper", running: null });
  expect(spectator.look.font).toBeNull();
  expect(hostScoreboard({ ...view, id: "" } as RoomView, { now: 0, server: 0, ping: null, at: 0 })).toEqual({
    type: "scoreboard",
    head: null,
    rows: [],
  });

  const posted: HostScoreboard[] = [];
  const feed = new ScoreboardFeed((next) => posted.push(next));
  feed.update(board);
  feed.update(hostScoreboard(view, { now: 2500, server: 2500, ping: 25, at: 1_700_000_000_500 }));
  expect(posted.length).toBe(1);
  feed.update(hostScoreboard({ ...view, metas: {} } as RoomView, { now: 2500, server: 2500, ping: 25, at: 0 }));
  expect(posted.length).toBe(2);
});

test("pride flags reach the host as their own codes; unknown codes are no flag", () => {
  expect(hostFlag("PRIDE-TRANS")).toBe("PRIDE-TRANS");
  expect(hostFlag("PRIDE-RAINBOW")).toBe("PRIDE-RAINBOW");
  // Retired on the website (countries.ts PRIDE_FLAGS keeps Rainbow and Transgender).
  expect(hostFlag("PRIDE-PROGRESS")).toBeNull();
  expect(hostFlag("US")).toBe("us");
  for (const code of ["PRIDE-XX", "pride-trans", "PRIDE-", "USA", "", null, 7]) expect(hostFlag(code)).toBeNull();
});

test("the peak mark after a name is the hardest tier held, and a pick of any peak wears it", () => {
  const ids = (marks: Record<string, unknown>) => hostMarks(readMarks(marks)).map((mark) => mark.id);
  // An account merge can bring two: only the highest shows.
  expect(ids({ special: ["peak-8", "peak-10"] })).toEqual(["peak-10"]);
  expect(hostMarks(readMarks({ special: ["peak-9"] }))).toEqual([{ id: "peak-9", name: "Cleared a T9 map" }]);
  expect(ids({ special: ["peak-9"], nameBadges: ["peak-8"] })).toEqual(["peak-9"]);
  expect(ids({ special: ["peak-11"] })).toEqual([]);
});
