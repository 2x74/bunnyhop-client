import { test, expect } from "bun:test";
import { chromium, webkit } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
import { gamepadActions } from "./gamepad";
test("standard controller mapping rejects malformed payloads and respects analog deadzone", () => {
  expect([...gamepadActions(null)]).toEqual([]);
  expect([...gamepadActions({ buttons: [], axes: [0.5, -0.5] })]).toEqual([]);
  const buttons = Array(16).fill(0);
  buttons[0] = 1;
  buttons[5] = 1;
  buttons[14] = 1;
  expect([...gamepadActions({ buttons, axes: [0, -0.8] })]).toEqual(["up", "left", "accept", "next"]);
});
test("first visit intro, controller modal dismissal, settings navigation and input safety", async () => {
  const browser = await (process.env.NATIVE_UI_ENGINE === "webkit" ? webkit : chromium).launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const writes: string[] = [],
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const html = await readFile(new URL("../../../target/native-menu/menu.html", import.meta.url), "utf8");
  await page.addInitScript(() => {
    Object.assign(window, { webkit: { messageHandlers: { bunnyhop: { postMessage: () => {} } } } });
  });
  await page.route("https://bunnyhop.lol/**", (route) => {
    const r = route.request();
    if (r.method() !== "GET") {
      writes.push(r.url());
      return route.fulfill({ status: 409, body: "{}" });
    }
    if (new URL(r.url()).pathname === "/native-intro-test")
      return route.fulfill({ contentType: "text/html", body: html });
    return route.fulfill({ status: 503, body: "{}" });
  });
  try {
    await page.goto("https://bunnyhop.lol/native-intro-test");
    await page.getByRole("dialog", { name: "Welcome to bunnyhop.lol" }).waitFor();
    if (process.env.NATIVE_UI_ARTIFACTS) {
      await mkdir(process.env.NATIVE_UI_ARTIFACTS, { recursive: true });
      await page.screenshot({ path: process.env.NATIVE_UI_ARTIFACTS + "/onboarding-fixture.png" });
    }
    const input = page.getByRole("textbox", { name: "Display name" });
    await input.fill("Local Hopper");
    const pad = async (button: number) =>
      page.evaluate((i) => {
        const buttons = Array(16).fill(0);
        buttons[i] = 1;
        window.bunnyhopNativeMenu.onGamepad?.({ buttons, axes: [0, 0] });
        window.bunnyhopNativeMenu.onGamepad?.({ buttons: [], axes: [] });
      }, button);
    await pad(13);
    expect(await input.inputValue()).toBe("Local Hopper");
    expect(await input.evaluate((el) => el === document.activeElement)).toBe(true);
    await pad(1);
    expect(await page.locator("dialog[open]").count()).toBe(0);
    expect(await page.evaluate(() => !!localStorage.getItem("bunnyhop:onboarded"))).toBe(true);
    await page.evaluate(() => window.bunnyhopNativeMenu.open?.("settings"));
    await pad(1);
    expect(await page.evaluate(() => document.body.dataset.screen)).toBe("home");
    await page.evaluate(() => window.bunnyhopNativeMenu.open?.("intro"));
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    expect(await page.locator("dialog[open]").count()).toBe(0);
    await page.evaluate(() => {
      window.bunnyhopNativeMenu.onState({ map: "bhop_fixture", paused: true });
      window.bunnyhopNativeMenu.open?.("home");
    });
    await page.getByRole("tab", { name: "Leaderboard", exact: true }).focus();
    await pad(5);
    expect(await page.getByRole("tab", { name: "Style", exact: true }).getAttribute("aria-selected")).toBe("true");
    await page.evaluate(() => window.bunnyhopNativeMenu.open?.("settings"));
    await page.locator(".screen-back").focus();
    await pad(0);
    expect(await page.evaluate(() => document.body.dataset.screen)).toBe("pause");
    expect(errors).toEqual([]);
    expect(writes.filter((url) => !url.endsWith("/notices"))).toEqual([]);
  } finally {
    await browser.close();
  }
}, 30_000);
