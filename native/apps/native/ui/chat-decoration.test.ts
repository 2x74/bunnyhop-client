import { test, expect } from "bun:test";
import { nativeChatDecoration } from "./chat-decoration";
import { NAME_COLORS } from "../../web/src/creators";
test("native decorations map trusted structured marks without coercing objects", () => {
  const color = NAME_COLORS[0];
  expect(
    nativeChatDecoration({
      nameColor: color.id,
      rank: { name: "Legend", color: "#ff00ff" },
      role: "admin",
      verified: true,
      country: "us",
    }),
  ).toEqual({
    nativeNameColor: color.hex,
    nativeName: { color: color.hex, color2: null, effect: null, font: null },
    nativeMarks: [
      { id: "staff", name: "Admin", kind: "admin" },
      { id: "verified", name: "Verified" },
    ],
    nativeBadge: "Admin · Verified",
    nativeRank: "Legend",
    nativeRankColor: "#ff00ff",
    nativeCountry: "US",
  });
});
test("unknown colors/countries/objects never become host rendering values", () => {
  expect(
    nativeChatDecoration({ nameColor: "url(evil)", rank: { name: {} }, staff: {}, country: "USA", verified: "yes" }),
  ).toEqual({ nativeMarks: [] });
  expect(nativeChatDecoration({ rank: { name: "a\nb" } }).nativeRank).toBe("ab");
});

test("creator badges use the shared platform catalog", () => {
  expect(nativeChatDecoration({ creator: "youtube" }).nativeBadge).toBe("YouTube creator");
  expect(nativeChatDecoration({ creator: "youtube" }).nativeMarks).toEqual([
    { id: "creator", name: "YouTube creator", kind: "youtube", colors: ["#ff3d3d"] },
  ]);
  expect(nativeChatDecoration({ creator: "unknown" })).toEqual({ nativeMarks: [] });
});

test("a supporter with no equipped badges shows no marks, as on the website", () => {
  const decoration = nativeChatDecoration({ supporter: true, nameColor: "lime", nameEffect: "glow", nameBadges: [] });
  expect(decoration.nativeMarks).toEqual([]);
  expect(decoration.nativeBadge).toBe("Supporter");
});

test("chat lines carry a pride flag as its code and drop unknown ones", () => {
  expect(nativeChatDecoration({ country: "PRIDE-RAINBOW" }).nativeCountry).toBe("PRIDE-RAINBOW");
  // The website keeps Rainbow and Transgender only (countries.ts PRIDE_FLAGS).
  expect(nativeChatDecoration({ country: "PRIDE-NONBINARY" }).nativeCountry).toBeUndefined();
  expect(nativeChatDecoration({ country: "PRIDE-XX" }).nativeCountry).toBeUndefined();
  expect(nativeChatDecoration({ country: "de" }).nativeCountry).toBe("DE");
});

test("a chat name in a supporter font carries the font, with or without a colour", () => {
  expect(nativeChatDecoration({ supporter: true, nameFont: "pixel" }).nativeName).toEqual({
    color: null,
    color2: null,
    effect: null,
    font: "pixel",
  });
  expect(nativeChatDecoration({ nameFont: "papyrus" }).nativeName).toBeUndefined();
});
