import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { HUD_ELEMENTS } from "../../web/src/hud/layout";
import { ACTIONS, DEFAULT_PREFS } from "../../web/src/ui/settings";
import { NATIVE_BIND_ACTIONS, state } from "./bridge";
import type { SeenRow } from "./settings-controls";
import { NATIVE_GATES, WEB_ROWS } from "./settings-gates";
import { REQUESTED_KEYS, requestedDefault } from "./settings-keys";

// Every row of the website's settings screen is in the native one, waiting for a host key (with the key it needs),
// or left out with a reason (settings-gates.ts). A row the website adds fails here until it is placed.

/** Website sections the native menu doesn't load: their rows are all excluded in the table. */
const SECTIONS_NOT_LOADED = ["paint", "measure"];
/** Graphics groups registered by the website's pack modules, which the native menu doesn't load. */
const GROUPS_NOT_LOADED = ["graphics/Install/", "graphics/Sky selection/", "graphics/Install sky pack/"];
/** Rows the website builds only in some places (another account state, the desktop link outside the app). */
const CONDITIONAL = [
  "mouse/Mouse/Show DPI on profile",
  "account/Account/Profile flag",
  "account/Account/Desktop app link",
];

const menu = readFile(new URL("../../../target/native-menu/menu.html", import.meta.url), "utf8");

async function rows(page: Page, hostState: unknown): Promise<SeenRow[]> {
  const html = await menu;
  await page.route("**/*", (route) =>
    route.request().url() === "https://bunnyhop.lol/coverage"
      ? route.fulfill({ contentType: "text/html", body: html })
      : route.abort(),
  );
  await page.addInitScript(() => {
    localStorage.setItem("bunnyhop:onboarded", "1");
    localStorage.setItem("bunnyhop:first-seen", String(Date.now()));
  });
  await page.goto("https://bunnyhop.lol/coverage");
  await page.evaluate((value) => window.bunnyhopNativeMenu.onState(value), hostState);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".settings .set-rail").waitFor();
  return page.evaluate(() => (window as Window & { __nativeSettingsRows?: () => SeenRow[] }).__nativeSettingsRows!());
}

const key = (row: SeenRow) => `${row.section}/${row.group}/${row.label}`;
const listed = (row: SeenRow) =>
  [key(row), `${row.section}/*/${row.label}`, `${row.section}/${row.group}/*`].some((k) => k in WEB_ROWS);

test("every website settings row is shown, waiting for a host key, or left out with a reason", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const seen = await rows(page, { settings: state.settings });
    const web = seen.filter((row) => !row.native);
    expect(web.filter((row) => !listed(row)).map(key)).toEqual([]);
    expect(
      seen
        .filter((row) => row.native)
        .map(key)
        .filter((k) => !(k in NATIVE_GATES)),
    ).toEqual([]);
    // Each listed row the screen didn't build is one the native menu doesn't load, or one the website builds only
    // in some situations.
    const built = new Set(seen.map(key));
    const unbuilt = Object.keys(WEB_ROWS).filter((k) => !k.includes("/*/") && !k.endsWith("/*") && !built.has(k));
    const explained = (k: string) =>
      SECTIONS_NOT_LOADED.includes(k.split("/")[0]) ||
      GROUPS_NOT_LOADED.some((g) => k.startsWith(g)) ||
      CONDITIONAL.includes(k);
    expect(unbuilt.filter((k) => !explained(k))).toEqual([]);
    for (const k of unbuilt.filter((k) => !CONDITIONAL.includes(k)))
      expect([k, "excluded" in WEB_ROWS[k]]).toEqual([k, true]);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 30_000);

test("with every key and capability, every row that isn't excluded is shown", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const requested = Object.fromEntries(REQUESTED_KEYS.map((entry) => [entry.key, requestedDefault(entry)]));
    const binds = Object.fromEntries([...NATIVE_BIND_ACTIONS, ...ACTIONS.map((a) => a.id)].map((a) => [a, []]));
    const settings = { ...state.settings, ...requested, binds, hudLayoutWeb: DEFAULT_PREFS.hud.layout };
    const capabilities = ["hudEditor", ...HUD_ELEMENTS.map((element) => `hud:${element.id}`)];
    const seen = await rows(page, { settings, capabilities });
    const waiting = seen.filter((row) => row.outcome === "hidden" || row.outcome === "unavailable").map(key);
    expect(waiting).toEqual([]);
  } finally {
    await browser.close();
  }
}, 30_000);
