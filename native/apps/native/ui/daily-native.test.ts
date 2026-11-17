import { expect, test } from "bun:test";
import type { DailyView, Submission } from "../../web/src/api";
import { setDailySession } from "../../web/src/daily/state";
import { NativeDaily } from "./daily-native";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const today = (style = "autohop"): DailyView =>
  ({
    enabled: true,
    now: NOW,
    today: { day: "2026-11-17", map: { name: "bhop_tasku" }, style, endsAt: NOW + 5 * HOUR + 12 * 60_000 },
  }) as unknown as DailyView;

function fixture(view: DailyView = today()) {
  const lines: (string | null)[] = [];
  const daily = new NativeDaily({
    line: (text) => lines.push(text),
    daily: async () => view,
    now: () => NOW,
    setInterval: () => 1,
    clearInterval: () => {},
  });
  return { daily, lines };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const verified = (daily?: Submission["daily"]) => ({ status: "verified", id: "r1", daily }) as Submission;

test("the HUD line counts down on the day's map, names another style, and goes in a room or on another map", async () => {
  const f = fixture();
  f.daily.update("bhop_tasku", "autohop", false);
  await settle();
  expect(f.lines.at(-1)).toBe("Daily Challenge, 5h 12m left");
  f.daily.update("bhop_tasku", "wonly", false);
  expect(f.lines.at(-1)).toBe("Daily Challenge is Normal today, W-Only runs don't count");
  f.daily.update("bhop_tasku", "autohop", true);
  expect(f.lines.at(-1)).toBeNull();
  f.daily.update("bhop_eazy", "autohop", false);
  await settle();
  expect(f.lines.at(-1)).toBeNull();
});

test("runs from the Daily entry carry the day; other runs and other styles don't", () => {
  const f = fixture();
  expect(f.daily.play("2026-11-17", "bhop_tasku", undefined)).toBe("autohop");
  expect(f.daily.entry({ map: "bhop_tasku", style: "autohop", track: 0 })).toBe("2026-11-17");
  expect(f.daily.entry({ map: "bhop_tasku", style: "legit", track: 0 })).toBeNull();
  expect(f.daily.entry({ map: "bhop_tasku", style: "autohop", track: 1 })).toBeNull();
  expect(f.daily.entry({ map: "bhop_eazy", style: "autohop", track: 0 })).toBeNull();
  expect(f.daily.play("2026-11-17", "bhop_tasku", "legit")).toBe("legit");
  setDailySession(null);
});

test("the result line: the day's place, a kept best, a guest's place, and why another style didn't count", async () => {
  const f = fixture(today("legit"));
  f.daily.update("bhop_tasku", "autohop", false);
  await settle();
  const run = { map: "bhop_tasku", style: "legit", track: 0 };
  expect(f.daily.result(verified({ day: "2026-11-17", rank: 14, of: 58 }), run)).toEqual({
    text: "Daily Challenge: 14th of 58",
    good: true,
  });
  expect(f.daily.result(verified({ day: "2026-11-17", rank: 3, of: 58, best: false, time: 61.5 }), run)?.text).toBe(
    "Daily Challenge: your best today stays 01:01.500, 3rd of 58",
  );
  expect(f.daily.result(verified({ day: "2026-11-17", rank: 14, of: 58, guest: true }), run)).toEqual({
    text: "Daily Challenge: that would be 14th of 58 today. The board shows accounts.",
    good: false,
  });
  expect(f.daily.result(verified(), { ...run, style: "autohop" })).toEqual({
    text: "Daily Challenge: today is EZ Scroll, so this Normal run doesn't count",
    good: false,
  });
  expect(f.daily.result(verified(), run)).toBeNull();
  expect(f.daily.result({ status: "rejected" } as Submission, run)).toBeNull();
});
