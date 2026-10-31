import { test, expect } from "bun:test";
import { chromium, type Page } from "playwright";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const menu = new URL("../../../target/native-menu/menu.html", import.meta.url).pathname;
const out = resolve(import.meta.dir, "../../../target/native-menu/web-port");
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

test("a load that fails fast shows the failure every time, with a Retry the game hears", async () => {
  const { browser, page } = await open();
  try {
    const failOnce = () =>
      page.evaluate(() => {
        const progress = { map: "bhop_sqee", stage: "renderer", message: "Preparing" };
        // The host's publish_now as the download settles, then its next publish.
        window.bunnyhopNativeMenu.onState({ loading: "Preparing", loadProgress: progress, error: "" });
        window.bunnyhopNativeMenu.onState({
          loading: "",
          error: "Network unavailable",
          loadProgress: { ...progress, stage: "error", message: "Network unavailable" },
        });
      });
    await failOnce();
    await page.getByRole("heading", { name: "Map could not load" }).waitFor();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    expect(await page.locator(".native-loading").count()).toBe(0);
    await failOnce();
    await page.getByRole("heading", { name: "Map could not load" }).waitFor();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    const received = await page.evaluate(() => (window as unknown as { received: unknown[] }).received);
    expect(received).toContainEqual({ type: "mapLoad", action: "retry" });
  } finally {
    await browser.close();
  }
});

test("an error nothing caught reaches the game's log, once", async () => {
  const { browser, page } = await open();
  try {
    const logged = await page.evaluate(async () => {
      const received = (window as unknown as { received: { type: string; text?: string }[] }).received;
      received.length = 0;
      for (const delay of [0, 0])
        setTimeout(() => {
          throw new Error("menu fixture failure");
        }, delay);
      void Promise.reject(new Error("menu fixture rejection"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      return received.filter((message) => message.type === "menuLog").map((message) => message.text ?? "");
    });
    expect(logged.filter((text) => text.includes("menu fixture failure")).length).toBe(1);
    expect(
      logged.filter((text) => text.startsWith("unhandled rejection") && text.includes("menu fixture rejection")).length,
    ).toBe(1);
  } finally {
    await browser.close();
  }
});

test("Settings opens the log folder, and searching for the log finds the row", async () => {
  const { browser, page } = await open();
  try {
    const path = "C:\\Users\\player\\AppData\\Roaming\\bunnyhop.lol\\Bunnyhop Native";
    await page.evaluate(() => window.bunnyhopNativeMenu.open?.("settings", "data"));
    await page.evaluate(
      (folder) =>
        window.dispatchEvent(
          new CustomEvent("bunnyhop:data-folder", {
            detail: { path: folder, defaultPath: folder, isDefault: true, configured: folder },
          }),
        ),
      path,
    );
    const button = page.getByRole("button", { name: "Open log folder", exact: true });
    await button.scrollIntoViewIfNeeded();
    await mkdir(out, { recursive: true });
    await page.screenshot({ path: resolve(out, "settings-log-folder.png") });
    await button.click();
    const received = await page.evaluate(() => (window as unknown as { received: unknown[] }).received);
    expect(received).toContainEqual({ type: "dataFolder", action: "revealLogs" });

    expect(await page.getByText("send us bunnyhop-native.log", { exact: false }).isVisible()).toBe(true);

    await page.getByLabel("Search settings").fill("crash log");
    await page.getByRole("button", { name: "Request data or deletion" }).waitFor({ state: "hidden" });
    expect(await button.isVisible()).toBe(true);
  } finally {
    await browser.close();
  }
});
