import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright";
import { readFile } from "node:fs/promises";

// Custom CSS in the native menu: applied to the menus, resolved into the HUD
// theme the game draws, links fetched once through the asset proxy,
// Ctrl+Shift+V, and a .css file the host watches.

const PAGE = "https://bunnyhop.lol/custom-css-test";
// A 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const ASSET_PROXY = "https://bunnyhop.lol/api/css-asset?kind=asset";

interface Sent {
  type: string;
  theme?: { colors: Record<string, number[]>; elements: Record<string, { color?: number[]; opacity?: number }> };
  action?: string;
  purpose?: string;
  id?: string;
}

async function boot(page: Page, css: string): Promise<void> {
  const html = await readFile(new URL("../../../target/native-menu/menu.html", import.meta.url), "utf8");
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url === PAGE) return route.fulfill({ contentType: "text/html", body: html });
    if (url.startsWith(ASSET_PROXY)) return route.fulfill({ contentType: "image/png", body: PNG });
    return route.abort();
  });
  await page.addInitScript((stored) => {
    localStorage.setItem("bunnyhop:onboarded", "1");
    localStorage.setItem("bunnyhop:custom-css", JSON.stringify({ on: true, css: stored }));
    const sent: unknown[] = [];
    Object.assign(window, { sent });
    window.addEventListener("bunnyhop:native-message", (event) => sent.push((event as CustomEvent).detail));
  }, css);
  await page.goto(PAGE);
}

function sent(page: Page, type: string): Promise<Sent[]> {
  return page.evaluate((wanted) => (window as unknown as { sent: Sent[] }).sent.filter((m) => m.type === wanted), type);
}

async function lastTheme(page: Page): Promise<NonNullable<Sent["theme"]>> {
  return (await sent(page, "hudTheme")).at(-1)!.theme!;
}

const rootVariable = (page: Page, name: string): Promise<string> =>
  page.evaluate((variable) => getComputedStyle(document.documentElement).getPropertyValue(variable).trim(), name);

/** Waits until the root variable `name` is (or, with equal false, isn't) `value`. */
async function waitForVariable(page: Page, name: string, value: string, equal = true): Promise<void> {
  await page.waitForFunction(([variable, wanted, same]) => {
    const current = getComputedStyle(document.documentElement).getPropertyValue(variable as string).trim();
    return (current === wanted) === same;
  }, [name, value, equal] as const);
}

const close = (actual: number[] | undefined, expected: number[]): void => {
  expect(actual?.length).toBe(expected.length);
  expected.forEach((value, index) => expect(Math.abs(actual![index] - value)).toBeLessThan(0.01));
};

const CSS = `:root { --amber: #7fd1ff; --gain: #00ff00; }
#hud [data-el="speed"] { color: #ff00ff; opacity: 0.5; }
#hud [data-el="stats"] { opacity: 0.25; }
#custom-art::after { content: ""; background: url(https://img.test/bunny.png); }`;

test("custom CSS styles the menus and becomes the HUD theme", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await boot(page, CSS);

    expect(await rootVariable(page, "--amber")).toBe("#7fd1ff");
    await page.waitForFunction(() => (window as unknown as { sent: Sent[] }).sent.some((m) => m.type === "hudTheme"));
    const theme = await lastTheme(page);
    close(theme.colors.accent, [127 / 255, 209 / 255, 1, 1]);
    close(theme.colors.gain, [0, 1, 0, 1]);
    expect(theme.colors.text).toBeUndefined();
    close(theme.elements.speed.color, [1, 0, 1, 1]);
    expect(theme.elements.speed.opacity).toBeCloseTo(0.5);
    expect(theme.elements.runStats).toEqual({ opacity: 0.25 });

    // The image link was fetched through the proxy and applied as a blob: URL.
    await page.waitForFunction(() => document.adoptedStyleSheets.some((sheet) =>
      [...sheet.cssRules].some((rule) => rule.cssText.includes("blob:https://bunnyhop.lol/"))));

    // Ctrl+Shift+V: off, and the HUD goes back to its own colours.
    await page.locator("body").press("Control+Shift+KeyV");
    await waitForVariable(page, "--amber", "#7fd1ff", false);
    expect(await lastTheme(page)).toEqual({ colors: {}, elements: {} });
    await page.locator("body").press("Control+Shift+KeyV");
    await waitForVariable(page, "--amber", "#7fd1ff");
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 30000);

test("Settings -> Custom CSS: the editor applies as you type and a .css file replaces it", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await boot(page, "");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator('.nset-rail-item[data-section="css"]').click();

    await page.getByRole("button", { name: "Edit CSS", exact: true }).click();
    await page.getByRole("textbox", { name: "Custom CSS" }).fill(":root { --cream: #ffffff; }");
    await waitForVariable(page, "--cream", "#ffffff");
    await page.getByRole("dialog").getByText("Applied.").waitFor();
    close((await lastTheme(page)).colors.text, [1, 1, 1, 1]);
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

    // A file chosen through the host is used instead of the pasted CSS.
    await page.getByRole("button", { name: "Choose .css file…", exact: true }).click();
    await page.waitForFunction(() => (window as unknown as { sent: Sent[] }).sent.some((m) => m.type === "file"));
    const request = (await sent(page, "file")).at(-1)!;
    expect(request).toMatchObject({ action: "open", purpose: "css" });
    await page.evaluate((id) => {
      const text = ":root { --cream: #00ffff; }";
      const detail = { id, purpose: "css", action: "open", ok: true, cancelled: false, name: "theme.css", text };
      window.dispatchEvent(new CustomEvent("bunnyhop:native-file", { detail }));
    }, request.id);
    await waitForVariable(page, "--cream", "#00ffff");
    await page.locator(".nset-hint", { hasText: /^theme\.css$/ }).waitFor();

    // The host sends the file again when it's saved.
    await page.evaluate(() => {
      const detail = { name: "theme.css", text: ":root { --cream: #ffff00; }", error: "" };
      window.dispatchEvent(new CustomEvent("bunnyhop:native-css-file", { detail }));
    });
    await waitForVariable(page, "--cream", "#ffff00");

    // Stop using: back to the pasted CSS.
    await page.getByRole("button", { name: "Stop using", exact: true }).click();
    await waitForVariable(page, "--cream", "#ffffff");
    expect((await sent(page, "file")).at(-1)).toMatchObject({ action: "unwatch", purpose: "css" });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 30000);
