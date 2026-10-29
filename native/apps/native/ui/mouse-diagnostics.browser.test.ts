import { test, expect } from "bun:test";
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";

const SAMPLE = {
  active: false,
  seconds: 1,
  eventsPerSecond: 8000,
  events: 8000,
  peakBurst: 134,
  averageAgeMs: 4.2,
  maxAgeMs: 12,
  maxPumpMs: 0.8,
  relative: false,
  systemScaling: false,
  sdl: "3.4.18",
  backend: "IOHID",
  timestampKind: "device event",
  motionRateHz: 8000,
  timestampJitterMs: 0.012,
  droppedReports: 0,
};

test("mouse diagnostics show the delivered rate without claiming the hardware polling rate", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const html = await readFile(new URL("../../../target/native-menu/menu.html", import.meta.url), "utf8");
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) =>
      route.request().url() === "https://bunnyhop.lol/mouse-diagnostic-test"
        ? route.fulfill({ contentType: "text/html", body: html })
        : route.abort(),
    );
    await page.addInitScript(() => {
      localStorage.setItem("bunnyhop:onboarded", "1");
      localStorage.setItem("bunnyhop:first-seen", String(Date.now()));
      const messages: unknown[] = [];
      Object.assign(window, { messages });
      addEventListener("bunnyhop:native-message", (event) => messages.push((event as CustomEvent).detail));
    });
    await page.goto("https://bunnyhop.lol/mouse-diagnostic-test");
    await page.waitForFunction(() => !!window.bunnyhopNativeMenu);
    await page.evaluate(() => window.bunnyhopNativeMenu.open?.("settings", "mouse"));
    await page.locator('details.set-adv[data-sec="mouse"] summary').click();
    await page.getByRole("switch", { name: "Show input stats", exact: true }).click();
    await page.waitForTimeout(150);
    const settings = await page.evaluate(() =>
      (window as unknown as { messages: { type: string; patch?: unknown }[] }).messages.filter(
        (m) => m.type === "settings",
      ),
    );
    expect(settings).toEqual([{ type: "settings", patch: { mouseDiagnostics: true } }]);
    await page.evaluate((detail) => dispatchEvent(new CustomEvent("bunnyhop:mouse-diagnostics", { detail })), SAMPLE);
    const sample = page.locator('.set-row[data-label="Last sample"]');
    expect(await sample.textContent()).toContain("8,000 motion events/s");
    expect(await sample.textContent()).toContain("Last sample");
    expect(await sample.textContent()).toContain("IOHID · device event timestamps");
    expect(await sample.textContent()).toContain("8000 Hz moving · 0.012 ms timestamp jitter");
    const backendRow = page.locator('.set-row[data-label="Mouse backend"]');
    await backendRow.getByRole("radio", { name: "Raw", exact: true }).click();
    await page.waitForTimeout(150);
    const patches = await page.evaluate(() =>
      (window as unknown as { messages: { type: string; patch?: unknown }[] }).messages.filter(
        (message) => message.type === "settings",
      ),
    );
    expect(patches.at(-1)).toEqual({ type: "settings", patch: { inputBackend: "raw" } });
    const before = await sample.textContent();
    await page.evaluate(() =>
      dispatchEvent(new CustomEvent("bunnyhop:mouse-diagnostics", { detail: { eventsPerSecond: Infinity } })),
    );
    expect(await sample.textContent()).toBe(before);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 20_000);
