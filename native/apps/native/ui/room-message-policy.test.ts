import { describe, expect, test } from "bun:test";
import { leaveRoomBefore } from "./room-message-policy";

describe("room session while opening replay or spectating", () => {
  for (const visibility of ["private", "public"] as const) {
    test(`${visibility} room keeps its session while a replay is opened and closed`, () => {
      let roomId: string | null = `${visibility}-room`;
      const send = (message: Parameters<typeof leaveRoomBefore>[0]) => {
        if (roomId && leaveRoomBefore(message)) roomId = null;
      };
      send({ type: "replay", action: "play", id: "run" });
      send({ type: "replayData", action: "play", name: "run", map: "bhop_test", replayBase64: "AA==" });
      send({ type: "replayControl", action: "stop" });
      expect(roomId).toBe(`${visibility}-room`);
    });
  }

  test("!spec's room command does not detach the room session", () => {
    const specMessage = { type: "roomCommand", command: "spec", target: "player" } as unknown as Parameters<
      typeof leaveRoomBefore
    >[0];
    expect(leaveRoomBefore(specMessage)).toBe(false);
  });

  test("starting a tutorial that replaces the map still detaches the room", () => {
    expect(leaveRoomBefore({ type: "tutorial", action: "start", lesson: "jump" })).toBe(true);
    expect(leaveRoomBefore({ type: "tutorial", action: "stop" })).toBe(false);
  });
});
