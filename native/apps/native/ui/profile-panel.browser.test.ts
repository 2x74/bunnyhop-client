import { test, expect } from "bun:test";
import { chromium } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
import { DEFAULT_COSMETICS, COSMETICS } from "../../web/src/progression";
import { fullProfileFixture as profile, profileRunFixture as run } from "./profile-fixture";
const menu =
  process.env.NATIVE_PROFILE_MENU ?? new URL("../../../target/native-menu/menu.html", import.meta.url).pathname;

test("native profile uses full shared card/stats/points/runs/editor with no WebGL and mocked writes only", async () => {
  await mkdir("/tmp/bunnyhop-profile-review", { recursive: true });
  const html = await readFile(menu!, "utf8"),
    browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5000);
  const errors: string[] = [],
    writes: { path: string; body: unknown }[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { bunnyhop: { postMessage: () => {} } } };
    localStorage.setItem("bunnyhop:onboarded", "1");
  });
  await page.route("https://bunnyhop.lol/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    let body: unknown = {};
    if (path === "/native-profile-test") return route.fulfill({ contentType: "text/html", body: html });
    if (!path.startsWith("/api/")) return route.fulfill({ status: 204 });
    if (req.method() !== "GET") writes.push({ path, body: req.postDataJSON() });
    if (path === "/api/me") body = { ...profile.player };
    else if (path === "/api/config") body = { discordInvite: null, discordMembership: false };
    else if (path === "/api/players/profile-fixture") body = profile;
    else if (path.endsWith("/points"))
      body = { scope: url.searchParams.get("scope") ?? "all", records: [{ ...run, counted: 122 }] };
    else if (path.endsWith("/stats"))
      body = {
        totals: { mapsCompleted: 6, jumps: 123, playtimeSeconds: 3600, runTimeMs: 1234000, verifiedRuns: 11 },
        styles: [],
        maps: [{ map: "bhop_fixture", runs: 11 }],
        activity: [{ at: Math.floor(Date.now() / 86_400_000) * 86_400_000, runs: 11 }],
      };
    else if (path.endsWith("/gauntlets")) body = { pbs: [], weeklyWins: [] };
    else if (path.endsWith("/runs")) body = { total: 1, runs: [run] };
    else if (path === "/api/me/cosmetics")
      body =
        req.method() === "GET"
          ? { choice: profile.cosmetics, level: 12, unlocked: COSMETICS.map((c) => c.id) }
          : { ...profile.cosmetics, ...req.postDataJSON() };
    else if (path.includes("/friends"))
      body = { friends: [], following: [], followers: [], canMessage: true, appearOffline: false };
    else if (path.endsWith("/favorites")) body = { maps: [] };
    else if (path.endsWith("/pbs")) body = { pbs: [], next: null };
    else if (path === "/api/auth/providers") body = { discord: true, email: true };
    else
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "offline_fixture" }),
      });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  try {
    await page.goto("https://bunnyhop.lol/native-profile-test");
    await page.waitForFunction(() => !!window.bunnyhopNativeMenu);
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("bunnyhop:navigate", { detail: { url: "https://bunnyhop.lol/u/profile-fixture" } }),
      ),
    );
    await page.locator(".pc-name").filter({ hasText: "Profile Hopper" }).waitFor();
    expect(await page.locator(".pc-stats").count()).toBe(1);
    expect(await page.getByRole("heading", { name: "Top points", exact: true }).count()).toBe(1);
    expect(await page.locator(".st-player").innerText()).toContain("Maps completed");
    expect(await page.locator(".st-player").innerText()).toContain("Last 30 days");
    expect(await page.locator(".pf-pts").innerText()).toContain("125");
    // The activity graph has the day's bar (activity rows are UTC day starts, stats-screen.ts activityChart).
    expect(await page.locator(".st-days-bars span:not(.zero)").count()).toBe(1);
    expect(await page.locator(".st-days .st-axis").innerText()).toContain("11 finishes");
    await page.screenshot({ path: "/tmp/bunnyhop-profile-review/overview.png" });
    await page.getByRole("tab", { name: /^Runs/ }).click();
    await page.locator(".pf-runs .pf-run-map").first().waitFor();
    expect(await page.locator(".pf-runs").innerText()).toContain("All replays");
    await page.getByRole("button", { name: /All replays/ }).click();
    await page.locator(".pf-runs .pf-run-map").first().waitFor();
    expect(await page.locator(".pf-runs").innerText()).toContain("fixture");
    await page.screenshot({ path: "/tmp/bunnyhop-profile-review/runs.png" });
    await page.getByRole("tab", { name: /^Overview/ }).click();
    await page.getByRole("button", { name: "Edit card", exact: true }).click();
    await page.getByRole("region", { name: "Edit your card" }).waitFor();
    expect(await page.locator(".ce").innerText()).toContain("Badges");
    expect(await page.locator(".ce").innerText()).toContain("Links");
    await page.screenshot({ path: "/tmp/bunnyhop-profile-review/card-editor.png" });
    const pick = page.locator(".ce-item:not(.locked):not(.on)").first();
    await pick.click();
    await page.waitForFunction(() => document.querySelector(".ce .pf-status")?.textContent?.includes("Saved"));
    expect(writes.some((w) => w.path === "/api/me/cosmetics")).toBe(true);
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("tab", { name: /^Loadout/ }).click();
    await page.locator(".lo-body").waitFor();
    await page.screenshot({ path: "/tmp/bunnyhop-profile-review/loadout.png" });
    expect(await page.evaluate(() => window.__nativeMenuGraphics?.attempts)).toBe(0);
    expect(errors).toEqual([]);
    expect(writes.filter((w) => !w.path.endsWith("/notices") && w.path !== "/api/me/cosmetics")).toEqual([]);
  } catch (error) {
    console.log(await page.locator(".native-profile-body").innerText());
    console.log(errors);
    throw error;
  } finally {
    await browser.close();
  }
}, 30000);
