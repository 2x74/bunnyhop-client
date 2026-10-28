import { test, expect } from "bun:test";
import { chromium, webkit } from "playwright";
import { readFile } from "node:fs/promises";
test("native intro sends acting poses, follows form reactions, and cancels frames on dismissal", async () => {
  const browser = await (process.env.NATIVE_UI_ENGINE === "webkit" ? webkit : chromium).launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } }),
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const html = await readFile(
    process.env.NATIVE_UI_MENU ?? new URL("../../../target/native-menu/menu.html", import.meta.url),
    "utf8",
  );
  await page.addInitScript(() => {
    const frames: Record<string, any>[] = [];
    Object.assign(window, {
      introFrames: frames,
      webkit: {
        messageHandlers: {
          bunnyhop: {
            postMessage: (raw: string) => {
              const job = JSON.parse(raw);
              if (job.type !== "loadoutPreview") return;
              frames.push(job);
              setTimeout(() => {
                (window as any).bunnyhopNativeLoadoutPreview?.({ id: job.id, png: "" });
              }, 10);
            },
          },
        },
      },
    });
  });
  const user = { id: "intro-fixture", name: "Intro Hopper", provider: "guest", avatarUrl: null, onboarded: false };
  await page.route("https://bunnyhop.lol/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/intro-stage-test") return route.fulfill({ contentType: "text/html", body: html });
    if (path === "/api/me" || path === "/api/me/name") return route.fulfill({ json: user });
    if (path === "/api/names/check") return route.fulfill({ json: { ok: true, available: true } });
    if (path === "/api/me/cosmetics") return route.fulfill({ json: {} });
    return route.fulfill({ status: 503, body: "{}" });
  });
  try {
    await page.goto("https://bunnyhop.lol/intro-stage-test");
    const intro = page.getByRole("dialog", { name: "Welcome to bunnyhop.lol" });
    await intro.waitFor();
    await page.waitForFunction(() => ((window as any).introFrames?.length ?? 0) > 8);
    const get = () =>
      page.evaluate(() => ((window as any).introFrames as any[]).filter((f) => f.view === "onboarding"));
    const first = await get();
    expect(first.length).toBeGreaterThan(8);
    expect(
      first.every(
        (f) =>
          f.stage.position.length === 3 &&
          f.stage.velocity.length === 3 &&
          Object.values(f.stage.acting).every(Number.isFinite),
      ),
    ).toBe(true);
    expect(first.some((f) => f.stage.position[2] > 0)).toBe(true);
    const input = page.getByRole("textbox", { name: "Display name" });
    await input.fill("!");
    await page.waitForTimeout(220);
    expect((await get()).slice(-4).some((f) => Math.abs(f.stage.acting.headRoll) > 1)).toBe(true);
    await input.fill("Intro Hopper");
    expect(await intro.locator(".native-intro-tag").textContent()).toBe("Intro Hopper");
    await intro.getByRole("button", { name: "Next", exact: true }).click();
    await intro.getByRole("heading", { name: "Pick a colour." }).waitFor();
    await intro.locator(".native-intro-colours button").nth(1).click();
    await intro.getByRole("button", { name: "Next", exact: true }).click();
    await intro.getByRole("heading", { name: "Match your mouse sensitivity." }).waitFor();
    await intro.getByRole("spinbutton", { name: "Your sensitivity" }).fill("2");
    await intro.getByRole("button", { name: "Next", exact: true }).click();
    await intro.getByRole("heading", { name: "Have you bhopped before?" }).waitFor();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    const n = (await get()).length;
    await page.waitForTimeout(180);
    expect((await get()).length).toBe(n);
    expect(await page.locator(".native-intro-canvas").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => {
      (window as any).bunnyhopNativeMenu.open("intro");
    });
    await intro.waitFor();
    await page.waitForTimeout(160);
    const reduced = (await get()).slice(n);
    expect(reduced.length).toBeGreaterThan(0);
    expect(
      reduced.every((f) => f.stage.grounded && f.stage.position[2] === 0 && f.stage.squash === 0 && f.stage.spin === 0),
    ).toBe(true);
    await page.keyboard.press("Escape");
  } finally {
    await browser.close();
  }
}, 30_000);
