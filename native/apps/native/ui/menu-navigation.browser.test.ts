import { test, expect } from "bun:test";
import { chromium, webkit, type Page } from "playwright";
import { readFile } from "node:fs/promises";
import { COSMETICS } from "../../web/src/progression";
import { fullProfileFixture as profile, profileRunFixture as run, nativeProfileFixture } from "./profile-fixture";
// NATIVE_UI_ENGINE=webkit runs the same checks on WebKit (closer to the macOS/Linux menu views; needs `playwright install webkit`).
const engine = process.env.NATIVE_UI_ENGINE === "webkit" ? webkit : chromium;
const menu = new URL("../../../target/native-menu/menu.html", import.meta.url).pathname;

// Reads only: every request is a fixture, and any non-GET fails the test.
async function open(width: number, height: number) {
  const html = await readFile(menu, "utf8"),
    browser = await engine.launch({ headless: true }),
    page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultTimeout(5000);
  const errors: string[] = [],
    writes: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const sent: unknown[] = [];
    Object.assign(window, {
      sent,
      webkit: { messageHandlers: { bunnyhop: { postMessage: (m: unknown) => sent.push(m) } } },
    });
    localStorage.setItem("bunnyhop:onboarded", "1");
  });
  await page.route("https://bunnyhop.lol/**", (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path === "/native-navigation-test") return route.fulfill({ contentType: "text/html", body: html });
    if (req.method() !== "GET") {
      writes.push(`${req.method()} ${path}`);
      return route.fulfill({ status: 409, body: "{}" });
    }
    const body =
      path === "/api/me"
        ? profile.player
        : path === "/api/players/profile-fixture"
          ? profile
          : path === "/api/players/other-player"
            ? nativeProfileFixture("other-player", "Other Hopper", false)
            : path.endsWith("/runs")
              ? { total: 1, runs: [run] }
              : path.endsWith("/points")
                ? { scope: "all", records: [{ ...run, counted: 122 }] }
                : path.endsWith("/stats")
                  ? {
                      totals: {
                        mapsCompleted: 6,
                        jumps: 123,
                        playtimeSeconds: 3600,
                        runTimeMs: 1234000,
                        verifiedRuns: 11,
                      },
                      styles: [],
                      maps: [{ map: "bhop_fixture", runs: 11 }],
                      activity: [],
                    }
                  : path === "/api/me/cosmetics"
                    ? { choice: profile.cosmetics, level: 12, unlocked: COSMETICS.map((c) => c.id) }
                    : null;
    return body
      ? route.fulfill({ contentType: "application/json", body: JSON.stringify(body) })
      : route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"offline_fixture"}' });
  });
  await page.goto("https://bunnyhop.lol/native-navigation-test");
  await page.waitForFunction(() => !!window.bunnyhopNativeMenu);
  return { browser, page, errors, writes };
}
const go = (page: Page, url: string) =>
  page.evaluate(
    (u) => window.dispatchEvent(new CustomEvent("bunnyhop:navigate", { detail: { url: `https://bunnyhop.lol${u}` } })),
    url,
  );
const screen = (page: Page) => page.evaluate(() => document.body.dataset.screen);
const player = (page: Page, name: string) => page.locator(".pc-name").filter({ hasText: name }).waitFor();

test("Back and Esc return to the screen a profile was opened from; a picked map's pause menu replaces the browser", async () => {
  const { browser, page, errors, writes } = await open(1280, 720);
  try {
    // Maps → profile → Esc: back on Maps (web menu.ts stack), then Home.
    await go(page, "/maps");
    expect(await screen(page)).toBe("maps");
    await go(page, "/u/other-player");
    await player(page, "Other Hopper");
    await page.keyboard.press("Escape");
    expect(await screen(page)).toBe("maps");
    await page.keyboard.press("Escape");
    expect(await screen(page)).toBe("home");
    // Ranks → profile → another profile (in place) → header Back: Ranks.
    await go(page, "/ranks");
    await go(page, "/u/profile-fixture");
    await player(page, "Profile Hopper");
    await go(page, "/u/other-player");
    await player(page, "Other Hopper");
    await page.locator(".screen-back").click();
    expect(await screen(page)).toBe("ranks");
    // Profile → Stats → Back restores that profile, not the last one opened elsewhere.
    await go(page, "/u/profile-fixture");
    await player(page, "Profile Hopper");
    await go(page, "/stats");
    await page.keyboard.press("Escape");
    expect(await screen(page)).toBe("profile");
    await player(page, "Profile Hopper");
    // Home clears the stack.
    await go(page, "/");
    expect(await screen(page)).toBe("home");

    // A map picked from a profile: once it is up, the menu over the game is the pause menu.
    await go(page, "/u/profile-fixture");
    await player(page, "Profile Hopper");
    await page.evaluate(() =>
      window.bunnyhopNativeMenu.onState({
        map: "bhop_fixture",
        loading: "",
        error: "",
        paused: false,
        style: "autohop",
        track: 0,
      }),
    );
    expect(await screen(page)).toBe("pause");
    await page.keyboard.press("Escape");
    expect(
      await page.evaluate(() =>
        JSON.parse(
          String(
            (window as unknown as { sent: unknown[] }).sent.filter((m) => !String(m).includes('"audioCue"')).at(-1),
          ),
        ),
      ),
    ).toEqual({ type: "resume" });
    // Picking the map that is already up resumes it, and leaves the pause menu for the next Esc.
    await go(page, "/maps");
    expect(await screen(page)).toBe("maps");
    await page.evaluate(() => window.bunnyhopNativeMenu.onState({ paused: true }));
    await go(page, "/?map=bhop_fixture");
    expect(
      JSON.parse(
        await page.evaluate(() =>
          String(
            (window as unknown as { sent: unknown[] }).sent.filter((m) => !String(m).includes('"audioCue"')).at(-1),
          ),
        ),
      ),
    ).toEqual({ type: "resume" });
    // (Drawn with the host's next state, not under the closing menu.)
    await page.evaluate(() => window.bunnyhopNativeMenu.onState({ paused: false }));
    expect(await screen(page)).toBe("pause");
    // A replay watched from a profile keeps the profile (the viewer returns there).
    await go(page, "/u/other-player");
    await player(page, "Other Hopper");
    await page.evaluate(() =>
      window.bunnyhopNativeMenu.onState({
        map: "bhop_other",
        playback: {
          active: true,
          tick: 0,
          totalTicks: 10,
          paused: false,
          speed: 1,
          camera: "eye",
          seconds: 0,
          tickInterval: 0.01,
        },
      }),
    );
    expect(await screen(page)).toBe("profile");
    // Rooms keep their own screen when the room's map changes.
    await page.evaluate(() => window.bunnyhopNativeMenu.open!("room"));
    await page.evaluate(() =>
      window.bunnyhopNativeMenu.onState({ map: "bhop_room_next", playback: { active: false } }),
    );
    expect(await page.locator(".native-room-screen").count()).toBe(1);
    expect(errors).toEqual([]);
    expect(writes.filter((w) => !w.endsWith("/notices"))).toEqual([]);
  } finally {
    await browser.close();
  }
}, 30_000);

test("Loadout opens on a category; the static stage keeps the web's view switch; a narrow profile stacks without overlap", async () => {
  const { browser, page, errors, writes } = await open(800, 600);
  try {
    await page.evaluate(() => window.bunnyhopNativeMenu.open!("loadout", "glove"));
    await page.locator(".lo-tab.on").filter({ hasText: "Gloves" }).waitFor();
    await page.locator(".lo-stage.ready").waitFor();
    // First person / Close-up as on the web: Close-up frames the authored sample closer. Inspect asks the host for its
    // live preview (this page stands in for a host; without one it's greyed, native-features.test.ts).
    await page.locator(".lo-viewseg").getByRole("radio", { name: "Close-up" }).click();
    expect(await page.locator(".lo-stage").getAttribute("data-view")).toBe("close");
    expect(
      await page.locator(".lo-viewseg").getByRole("radio", { name: "Close-up" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(await page.locator(".lo-insp").isVisible()).toBe(true);
    expect(await page.locator(".lo-insp").evaluate((button) => getComputedStyle(button).pointerEvents)).toBe("auto");
    // The stage keeps its 16:10 shape in view instead of stretching down the scrolling item grid.
    const stage = await page.evaluate(() => {
      const r = document.querySelector(".lo-stage")!.getBoundingClientRect();
      return { inView: r.bottom <= innerHeight + 1, ratio: Math.round((r.width / r.height) * 10) / 10 };
    });
    expect(stage).toEqual({ inView: true, ratio: 1.6 });
    await page.keyboard.press("Escape");
    expect(await screen(page)).toBe("home");
    await page.evaluate(() => window.bunnyhopNativeMenu.open!("loadout"));
    await page.locator(".lo-tab.on").filter({ hasText: "Knife" }).waitFor();

    await go(page, "/u/profile-fixture");
    await player(page, "Profile Hopper");
    await page.locator(".pf-main .pf-ov").first().waitFor();
    const layout = await page.evaluate(() => {
      const hero = document.querySelector(".pf-hero")!,
        main = document.querySelector(".pf-main")!.getBoundingClientRect(),
        body = document.querySelector(".native-profile-body")!;
      return {
        heroFits: hero.scrollHeight <= hero.clientHeight + 1,
        heroAbove: hero.getBoundingClientRect().bottom <= main.top + 1,
        bodyScrolls: body.scrollHeight > body.clientHeight,
      };
    });
    expect(layout).toEqual({ heroFits: true, heroAbove: true, bodyScrolls: true });
    expect(errors).toEqual([]);
    expect(writes.filter((w) => !w.endsWith("/notices"))).toEqual([]);
  } finally {
    await browser.close();
  }
}, 30_000);
