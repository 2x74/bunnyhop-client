import { test, expect } from "bun:test";
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("yaw slider edits survive stale host updates before and after dispatch", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const html = await readFile(resolve(import.meta.dir, "../../../target/native-menu/menu.html"), "utf8");
    await page.route("**/*", route => route.request().url() === "https://bunnyhop.lol/settings-sync"
      ? route.fulfill({ contentType: "text/html", body: html }) : route.abort());
    await page.addInitScript(() => {
      (window as any).messages = [];
      window.addEventListener("bunnyhop:native-message", event => (window as any).messages.push((event as CustomEvent).detail));
    });
    await page.goto("https://bunnyhop.lol/settings-sync");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Search settings").fill("yaw speed");
    for (const [name, key, old, next] of [["Yaw speed", "yawSpeed", 118.888888, 170], ["Modifier yaw speed", "yawSpeedAlt", 210, 90]] as const) {
      const range = page.getByLabel(`${name} slider`, { exact: true });
      await range.evaluate((element, values) => {
        const input = element as HTMLInputElement;
        input.focus(); input.value = String(values.next);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        window.bunnyhopNativeMenu.onState({ settings: { [values.key]: values.old } });
      }, { key, old, next });
      expect(await range.inputValue()).toBe(String(next));
      await page.waitForTimeout(120);
      await page.evaluate(({ key, old }) => window.bunnyhopNativeMenu.onState({ settings: { [key]: old } }), { key, old });
      expect(await range.inputValue()).toBe(String(next));
      await range.dispatchEvent("change");
      expect(await page.evaluate(() => (window as any).messages.at(-1))).toEqual({ type: "settings", patch: { [key]: next } });
      await page.evaluate(({ key, next }) => window.bunnyhopNativeMenu.onState({ settings: { [key]: next } }), { key, next });
      await range.blur();
      await page.evaluate(({ key }) => window.bunnyhopNativeMenu.onState({ settings: { [key]: 200 } }), { key });
      expect(await range.inputValue()).toBe("200");
    }
    await page.getByLabel("Search settings").fill("music");
    expect(await page.getByRole("radio", { name: "No music", exact: true }).isVisible()).toBe(true);
  } finally { await browser.close(); }
}, 15_000);
