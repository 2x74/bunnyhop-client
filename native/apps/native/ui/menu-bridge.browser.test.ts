import { test, expect } from "bun:test";
import { chromium, type Page } from "playwright";
import { readFile } from "node:fs/promises";

const menu = new URL("../../../target/native-menu/menu.html", import.meta.url).pathname;
const MENU_URL = "https://bunnyhop.lol/__native_menu__/index.html";
const EMPTY_BOARD = { scope: "all", total: 0, ranked: 0, offset: 0, limit: 50, entries: [], pinned: [], me: null };

// The menu as the Windows host ran it up to v0.6.3: messages only reached the game from the exact menu address.
async function open() {
  const html = await readFile(menu, "utf8"),
    browser = await chromium.launch({ headless: true }),
    page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(5000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript((address) => {
    const received: unknown[] = [];
    Object.assign(window, {
      received,
      webkit: {
        messageHandlers: {
          bunnyhop: {
            postMessage: (raw: string) => {
              if (location.href === address) received.push(JSON.parse(raw));
            },
          },
        },
      },
    });
    localStorage.setItem("bunnyhop:onboarded", "1");
  }, MENU_URL);
  await page.route("https://bunnyhop.lol/**", (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.url() === MENU_URL) return route.fulfill({ contentType: "text/html", body: html });
    if (path.startsWith("/api/ranks/"))
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(EMPTY_BOARD) });
    if (path === "/api/gauntlets")
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ gauntlets: [], me: null }) });
    return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"offline_fixture"}' });
  });
  await page.goto(MENU_URL);
  await page.waitForFunction(() => !!window.bunnyhopNativeMenu);
  return { browser, page };
}

const go = (page: Page, url: string) =>
  page.evaluate(
    (target) =>
      window.dispatchEvent(new CustomEvent("bunnyhop:navigate", { detail: { url: `https://bunnyhop.lol${target}` } })),
    url,
  );

/** A map pick after the screen has settled: what pressing Play sends, and whether the game heard it. */
async function playAfterVisiting(page: Page, url: string): Promise<{ address: string; heard: boolean }> {
  await go(page, url);
  await page.waitForTimeout(400);
  await go(page, "/");
  const address = await page.evaluate(() => location.href);
  const heard = await page.evaluate(() => {
    const received = (window as unknown as { received: { type: string; id?: string }[] }).received;
    received.length = 0;
    window.dispatchEvent(
      new CustomEvent("bunnyhop:navigate", { detail: { url: "https://bunnyhop.lol/?map=bhop_sqee" } }),
    );
    return received.some((message) => message.type === "selectMap" && message.id === "bhop_sqee");
  });
  return { address, heard };
}

for (const screen of ["/ranks", "/gauntlets"]) {
  test(`pressing Play still reaches the game after opening ${screen}`, async () => {
    const { browser, page } = await open();
    try {
      const { address, heard } = await playAfterVisiting(page, screen);
      expect(address).toBe(MENU_URL);
      expect(heard).toBe(true);
    } finally {
      await browser.close();
    }
  });
}
