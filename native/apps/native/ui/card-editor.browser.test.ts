import { test, expect } from "bun:test";
import { chromium, type Page } from "playwright";
import { readFile } from "node:fs/promises";
import { COSMETICS } from "../../web/src/progression";
import { DEFAULT_PLAYER_GLOW } from "../../web/src/player/glow-config";
import { fullProfileFixture, profileRunFixture as run } from "./profile-fixture";

// Edit card is the website's (web ui/card-editor.ts) inside the native profile: the overall Number One picks the
// title's colour under Title, and a supporter's name colour, effect and gradient are under Name. Writes are mocked.
const menu =
  process.env.NATIVE_PROFILE_MENU ?? new URL("../../../target/native-menu/menu.html", import.meta.url).pathname;

function numberOneSupporter() {
  const profile = structuredClone(fullProfileFixture) as typeof fullProfileFixture & Record<string, unknown>;
  profile.rank = { ...profile.rank, rank: 1, group: { id: "number-one", name: "Number One", color: "#ffffff" } };
  profile.supporterSettings = {
    playerGlow: DEFAULT_PLAYER_GLOW,
    since: "2026-10-01T00:00:00Z",
    nameColor: "rose",
    nameEffect: "paint",
    nameColor2: null,
    showBadge: true,
    showOnBoard: true,
  };
  return profile;
}

async function openEditor(page: Page, writes: { path: string; body: unknown }[]) {
  const profile = numberOneSupporter();
  const html = await readFile(menu, "utf8");
  await page.addInitScript(() => {
    (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { bunnyhop: { postMessage: () => {} } } };
    localStorage.setItem("bunnyhop:onboarded", "1");
  });
  await page.route("https://bunnyhop.lol/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/native-card-editor-test") return route.fulfill({ contentType: "text/html", body: html });
    if (!path.startsWith("/api/")) return route.fulfill({ status: 204 });
    if (request.method() !== "GET") writes.push({ path, body: request.postDataJSON() });
    let body: unknown;
    if (path === "/api/me") body = { ...profile.player };
    else if (path === "/api/players/profile-fixture") body = profile;
    else if (path.endsWith("/runs")) body = { total: 1, runs: [run] };
    else if (path === "/api/me/cosmetics" && request.method() === "GET")
      body = { choice: profile.cosmetics, level: 12, unlocked: COSMETICS.map((c) => c.id) };
    else if (path === "/api/me/cosmetics") body = { ...profile.cosmetics, ...request.postDataJSON() };
    else if (path === "/api/me/supporter") body = { ...profile.supporterSettings, ...request.postDataJSON() };
    else return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"offline_fixture"}' });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("https://bunnyhop.lol/native-card-editor-test");
  await page.waitForFunction(() => !!window.bunnyhopNativeMenu);
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("bunnyhop:navigate", { detail: { url: "https://bunnyhop.lol/u/profile-fixture" } }),
    ),
  );
  await page.getByRole("button", { name: "Edit card", exact: true }).click();
  await page.getByRole("region", { name: "Edit your card" }).waitFor();
}

test("the Number One picks the title colour and a supporter the name gradient in Edit card", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  const writes: { path: string; body: unknown }[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await openEditor(page, writes);
    expect(await page.locator(".ce-part").allInnerTexts()).toEqual([
      "Background",
      "Frame",
      "Title",
      "Name",
      "Badges",
      "Links",
    ]);
    await page.locator(".ce-part[data-part=title]").click();
    const colour = page.getByLabel("Number One colour");
    expect(await colour.inputValue()).toBe("#ffffff");
    await colour.evaluate((input: HTMLInputElement) => {
      input.value = "#ff3366";
      input.dispatchEvent(new Event("input"));
      input.dispatchEvent(new Event("change"));
    });
    await page.waitForFunction(() => document.querySelector(".ce .pf-status")?.textContent?.includes("Saved"));
    expect(writes).toContainEqual({ path: "/api/me/cosmetics", body: { rankColor: "#ff3366" } });
    await page.locator(".ce-part[data-part=name]").click();
    expect(await page.locator(".ce-label").allInnerTexts()).toEqual(["Colour", "Effect", "Second colour"]);
    const saved = page.waitForRequest((r) => r.url().endsWith("/api/me/supporter") && r.method() !== "GET");
    await page.locator(".ce-item", { hasText: "Aqua" }).last().click();
    expect((await saved).postDataJSON()).toEqual({ nameColor2: "aqua" });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 30_000);
