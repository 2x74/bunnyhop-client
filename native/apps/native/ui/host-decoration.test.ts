import { expect, test } from "bun:test";
import {
  hostMarks,
  hostNameLook,
  hostScoreboard,
  readMarks,
  ScoreboardFeed,
  type HostScoreboard,
} from "./host-decoration";
import { NAME_COLORS } from "../../web/src/creators";
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
  expect(hostNameLook(marks)).toEqual({ color: NAME_COLORS[1].hex, color2: NAME_COLORS[3].hex, effect: "paint" });
  // The shield first, then two more (creators.ts equippedNameBadges): staff wear three marks in all.
  expect(hostMarks(marks).map((mark) => mark.id)).toEqual(["staff", "verified", "booster"]);
  const gifter = hostMarks(readMarks({ giftsSent: 120, gifterColors: ["#112233"], nameBadges: ["gifter"] }));
  expect(gifter).toEqual([{ id: "gifter-prism", name: "Prism Gifter", colors: ["#112233"], animated: false }]);
  // Anything malformed is no mark at all.
  expect(hostMarks(readMarks({ staff: "god", creator: "myspace", verified: "yes" }))).toEqual([]);
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
    look: { color: NAME_COLORS[0].hex, color2: null, effect: null },
    marks: [{ id: "supporter", name: "Supporter" }],
  });
  expect(you.running).toEqual({ seconds: 13.34, at: 1_700_000_000_000 });
  expect(spectator).toMatchObject({ statusKind: "spec", status: "SPEC → Profile Hopper", running: null });
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
