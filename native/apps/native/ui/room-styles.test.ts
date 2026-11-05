import { test, expect } from "bun:test";
import { ROOM_WIRE_STYLES, roomStyleAt, roomStyleId, roomStyleLabel } from "./room-styles";

test("room wire styles follow the website's frozen order through A/D-Only", () => {
  // web 0.0.37 protocol.ts WIRE_STYLES.
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
    "adonly",
  ]);
  expect(roomStyleAt(10)).toBe("backwards");
  expect(roomStyleAt(11)).toBe("adonly");
  expect(roomStyleAt(12)).toBeNull();
});

test("room styles read by name, unknown ones by id", () => {
  expect(roomStyleLabel("backwards")).toBe("Backwards");
  expect(roomStyleLabel("adonly")).toBe("A/D-Only");
  expect(roomStyleLabel("infinite")).toBe("Infinite");
  expect(roomStyleLabel("segmented")).toBe("Segmented");
  expect(roomStyleLabel("zigzag")).toBe("zigzag");
  expect(roomStyleId("backwards")).toBe(true);
  expect(roomStyleId("zigzag")).toBe(true);
  expect(roomStyleId("")).toBe(false);
  expect(roomStyleId("<b>")).toBe(false);
  expect(roomStyleId(3)).toBe(false);
});
