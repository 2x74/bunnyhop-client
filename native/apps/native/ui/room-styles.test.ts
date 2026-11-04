import { test, expect } from "bun:test";
import { WIRE_STYLES } from "../../web/src/net/protocol";
import { ROOM_WIRE_STYLES, roomStyleAt, roomStyleId, roomStyleLabel } from "./room-styles";

test("room wire styles follow the website's frozen order through Backwards", () => {
  // web 0.0.36 protocol.ts WIRE_STYLES.
  expect(ROOM_WIRE_STYLES).toEqual([
    "autohop",
    "legit",
    "wonly",
    "sideways",
    "hsw",
    "autostrafe",
    "scroll",
    "lowgrav",
    "segmented",
    "infinite",
    "backwards",
  ]);
  expect(ROOM_WIRE_STYLES.slice(0, WIRE_STYLES.length)).toEqual([...WIRE_STYLES]);
  expect(roomStyleAt(10)).toBe("backwards");
  expect(roomStyleAt(11)).toBeNull();
});

test("room styles read by name, unknown ones by id", () => {
  expect(roomStyleLabel("backwards")).toBe("Backwards");
  expect(roomStyleLabel("infinite")).toBe("Infinite");
  expect(roomStyleLabel("segmented")).toBe("Segmented");
  expect(roomStyleLabel("zigzag")).toBe("zigzag");
  expect(roomStyleId("backwards")).toBe(true);
  expect(roomStyleId("zigzag")).toBe(true);
  expect(roomStyleId("")).toBe(false);
  expect(roomStyleId("<b>")).toBe(false);
  expect(roomStyleId(3)).toBe(false);
});
