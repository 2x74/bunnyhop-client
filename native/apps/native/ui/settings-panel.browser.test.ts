import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { CLASSIC } from "../../web/src/hud/layout";
import { state } from "./bridge";

// The settings screen is the website's, in the native menu with no host: the tests play the host through
// bunnyhopNativeMenu.onState and read the messages the menu sends it.
type Message = { type: string; [key: string]: unknown };
type Init = { storage?: Record<string, string>; me?: unknown; savedSettings?: unknown };

const menu = readFile(new URL("../../../target/native-menu/menu.html", import.meta.url), "utf8");
const HOST_SETTINGS = JSON.parse(JSON.stringify(state.settings));

async function open(
  init: Init = {},
): Promise<{ page: Page; errors: string[]; uploads: unknown[]; close: () => Promise<void> }> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  const uploads: unknown[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const html = await menu;
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/settings-test") return route.fulfill({ contentType: "text/html", body: html });
    if (url.pathname === "/api/me" && init.me) return route.fulfill({ json: init.me });
    if (url.pathname === "/api/me/settings" && request.method() === "GET" && init.savedSettings) {
      return route.fulfill({ json: init.savedSettings });
    }
    if (url.pathname === "/api/me/settings" && request.method() === "POST") {
      uploads.push(request.postDataJSON());
      return route.fulfill({ json: { updatedAt: Date.now() } });
    }
    return route.abort();
  });
  await page.addInitScript((storage) => {
    localStorage.setItem("bunnyhop:onboarded", "1");
    localStorage.setItem("bunnyhop:first-seen", String(Date.now()));
    for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
    const sent: unknown[] = [];
    Object.assign(window, { sent });
    addEventListener("bunnyhop:native-message", (event) => sent.push((event as CustomEvent).detail));
  }, init.storage ?? {});
  await page.goto("https://bunnyhop.lol/settings-test");
  await host(page, { settings: HOST_SETTINGS });
  return { page, errors, uploads, close: () => browser.close() };
}

const host = (page: Page, value: unknown) => page.evaluate((v) => window.bunnyhopNativeMenu.onState(v), value);
const sent = (page: Page) => page.evaluate(() => (window as unknown as { sent: Message[] }).sent);
const count = async (page: Page) => (await sent(page)).length;

/** The settings patches sent since `from`, once the menu's short batching delay has passed. */
async function patchesSince(page: Page, from: number): Promise<unknown[]> {
  await page.waitForTimeout(150);
  return (await sent(page))
    .slice(from)
    .filter((message) => message.type === "settings")
    .map((message) => message.patch);
}

async function openSettings(page: Page, section?: string): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".settings .set-rail").waitFor();
  if (section) await page.locator(`.set-rail-item[data-sec="${section}"]`).click();
}

/** Waits until `read` gives `expected` (the screen redraws a moment after the host speaks). */
async function poll<T>(read: () => Promise<T>, expected: T, timeoutMs = 4000): Promise<void> {
  const until = Date.now() + timeoutMs;
  let value: unknown = await read();
  while (JSON.stringify(value) !== JSON.stringify(expected) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  expect(value).toEqual(expected);
}

const row = (page: Page, section: string, label: string) =>
  page.locator(`section.set-sec[data-sec="${section}"] .set-row[data-label="${label}"]`);

test("search, a change as one native patch, and host state that arrives late", async () => {
  const { page, errors, close } = await open();
  try {
    await openSettings(page);
    // The website's search: words and aliases find their rows; nothing found shows the empty state.
    await page.getByLabel("Search settings").fill("fov");
    await poll(() => row(page, "mouse", "Sensitivity").isVisible(), false);
    expect(await row(page, "mouse", "Field of view").isVisible()).toBe(true);
    await page.getByLabel("Search settings").fill("cl_yawspeed");
    await poll(() => row(page, "keys", "Turn speed").isVisible(), true);
    await page.getByLabel("Search settings").fill("qqqqzz");
    expect(await page.locator(".set-empty").isVisible()).toBe(true);
    await page.getByLabel("Search settings").fill("");

    const box = page.getByLabel("Sensitivity value", { exact: true });
    const from = await count(page);
    await box.fill("3.25");
    await box.press("Enter");
    expect(await patchesSince(page, from)).toEqual([{ sensitivity: 3.25 }]);
    // An older state from the host still says 2: the box keeps the player's value until the host echoes it.
    await host(page, { settings: { ...HOST_SETTINGS, sensitivity: 2 } });
    expect(await box.inputValue()).toBe("3.25");
    await host(page, { settings: { ...HOST_SETTINGS, sensitivity: 3.25 } });

    // A change made outside the screen (a bind in game) shows on it.
    await host(page, { settings: { ...HOST_SETTINGS, sensitivity: 3.25, fov: 100 } });
    await poll(() => page.getByLabel("Field of view value", { exact: true }).inputValue(), "100");
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 30_000);

test("rows follow what the host has", async () => {
  const { page, errors, close } = await open();
  try {
    await openSettings(page, "hud");
    expect(await row(page, "hud", "Opacity").count()).toBe(0);
    expect(await row(page, "hud", "Spectator list").count()).toBe(0);
    // An update adds keys overlay opacity and the spectator list: their rows appear, and the new key starts at the
    // player's website setting rather than the host's default.
    const from = await count(page);
    await host(page, {
      settings: { ...HOST_SETTINGS, hudKeysOpacity: 0.6 },
      capabilities: ["hud:speed", "hud:spectators"],
    });
    await poll(() => row(page, "hud", "Opacity").count(), 1);
    expect(await row(page, "hud", "Spectator list").count()).toBe(1);
    expect(await patchesSince(page, from)).toEqual([{ hudKeysOpacity: 1 }]);
    // From then on the host's value shows.
    await host(page, { settings: { ...HOST_SETTINGS, hudKeysOpacity: 0.6 } });
    await poll(() => row(page, "hud", "Opacity").getByLabel("Opacity value").inputValue(), "60");
    // Bloom drives the Source look's bloom and the Enhanced and Cinematic glow alike: it shows once the host has it.
    expect(await row(page, "graphics", "Bloom").count()).toBe(0);
    await host(page, { settings: { ...HOST_SETTINGS, hudKeysOpacity: 0.6, graphicsBloom: true } });
    await poll(() => row(page, "graphics", "Bloom").count(), 1);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 30_000);

test("keys: turn speeds in the host's ranges, and native-only binds take keys from web actions", async () => {
  const { page, errors, close } = await open();
  try {
    await openSettings(page, "keys");
    const speed = row(page, "keys", "Turn speed").locator("input[type=range]");
    expect([await speed.getAttribute("min"), await speed.getAttribute("max")]).toEqual(["60", "720"]);
    let from = await count(page);
    await page.getByLabel("Turn speed value", { exact: true }).fill("300");
    await page.getByLabel("Turn speed value", { exact: true }).press("Enter");
    await page.getByLabel("Fast turn value", { exact: true }).fill("2.5");
    await page.getByLabel("Fast turn value", { exact: true }).press("Enter");
    expect(await patchesSince(page, from)).toEqual([{ yawSpeed: 300, angleSpeedKey: 2.5 }]);

    await page.locator('details.set-adv[data-sec="keys"] summary').click();
    from = await count(page);
    await page.locator('.bind[data-action="chat"][data-slot="0"]').click();
    await page.waitForTimeout(50);
    await page.keyboard.press("KeyL");
    // L was the website's flashlight key: it moves to chat.
    expect(await patchesSince(page, from)).toEqual([{ binds: { flashlight: [], chat: ["KeyL"] } }]);
    expect(await page.locator('.bind[data-action="chat"][data-slot="0"]').textContent()).toBe("L");
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 30_000);

test("native sections: display, Discord, sound packs", async () => {
  const { page, errors, close } = await open();
  try {
    await openSettings(page, "display");
    let from = await count(page);
    await row(page, "display", "Window mode").getByRole("radio", { name: "Borderless" }).click();
    await row(page, "display", "Window controls").getByRole("button", { name: "Center" }).click();
    expect((await sent(page)).slice(from)).toContainEqual({ type: "window", action: "center" });
    expect(await patchesSince(page, from)).toEqual([{ windowMode: "borderless" }]);
    // Alt+Enter in game changes the window mode: the screen follows.
    await host(page, { settings: { ...HOST_SETTINGS, windowMode: "fullscreen" } });
    const fullscreen = row(page, "display", "Window mode").getByRole("radio", { name: "Fullscreen" });
    await poll(() => fullscreen.getAttribute("aria-checked"), "true");

    await page.locator('.set-rail-item[data-sec="discord"]').click();
    from = await count(page);
    await row(page, "discord", "Privacy mode").getByRole("switch").click();
    expect(await patchesSince(page, from)).toEqual([{ privacyMode: true }]);

    await page.locator('.set-rail-item[data-sec="audio"]').click();
    await page.locator('details.set-adv[data-sec="audio"] summary').click();
    from = await count(page);
    await row(page, "audio", "Effects pack").getByRole("radio", { name: "Custom" }).click();
    await row(page, "audio", "Mute all").getByRole("switch").click();
    expect(await patchesSince(page, from)).toEqual([{ sfxPack: "custom", muted: true }]);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 30_000);

test("export and import use the website's format through the host's file dialogs", async () => {
  const { page, errors, close } = await open();
  try {
    await openSettings(page);
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const code = page.getByLabel("Settings code");
    await poll(async () => (await code.inputValue()).startsWith("bhs1."), true);
    await page.getByRole("button", { name: "Save .json file" }).click();
    await poll(async () => (await sent(page)).some((m) => m.type === "file"), true);
    const save = (await sent(page)).filter((m) => m.type === "file").at(-1)!;
    expect(save).toMatchObject({ action: "save", purpose: "settings" });
    expect(JSON.parse(String(save.text)).format).toBe("bunnyhop.lol/settings");
    await page.evaluate((id) => {
      const detail = { id, purpose: "settings", action: "save", ok: true, cancelled: false, name: "mine.json" };
      dispatchEvent(new CustomEvent("bunnyhop:native-file", { detail }));
    }, save.id);
    await page.locator(".xfer-status", { hasText: "Saved mine.json." }).waitFor();

    // A file the desktop client saved before it used the website's format.
    await page.getByRole("tab", { name: "Import" }).click();
    await page.getByRole("button", { name: "Choose file…" }).click();
    await poll(async () => (await sent(page)).filter((m) => m.type === "file").length, 2);
    const open = (await sent(page)).filter((m) => m.type === "file").at(-1)!;
    expect(open).toMatchObject({ action: "open", purpose: "settings" });
    const old = JSON.stringify({ format: "bunnyhop-native-settings", version: 1, settings: { sensitivity: 1.5 } });
    await page.evaluate(
      ([id, text]) => {
        const detail = { id, purpose: "settings", action: "open", ok: true, cancelled: false, name: "old.json", text };
        dispatchEvent(new CustomEvent("bunnyhop:native-file", { detail }));
      },
      [open.id, old],
    );
    await poll(async () => (await code.inputValue()).includes("bunnyhop.lol/settings"), true);
    const from = await count(page);
    await page.getByRole("button", { name: "Import", exact: true }).last().click();
    expect(await patchesSince(page, from)).toEqual([{ sensitivity: 1.5 }]);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 30_000);

test("old presets show up as profiles", async () => {
  const presets = { active: "", list: [{ name: "Practice", settings: { crosshairColor: "#ff0000" } }] };
  const { page, errors, close } = await open({
    storage: { "bunnyhop:native-settings-presets:v1": JSON.stringify(presets) },
  });
  try {
    await openSettings(page);
    expect(await page.getByLabel("Settings profile").locator("option").allTextContents()).toContain("Practice");
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 30_000);

test("settings kept with the account upload one document with native settings and newer website keys", async () => {
  const remote = {
    format: "bunnyhop.lol/settings",
    version: 1,
    exported: "",
    settings: { sensitivity: 1, futureKnob: 7 },
  };
  const { page, errors, uploads, close } = await open({
    me: { id: "u1", name: "Player", provider: "discord" },
    savedSettings: { doc: remote, updatedAt: 1 },
    storage: { "bunnyhop:settings-sync": "1", "bunnyhop:settings-at": String(Date.now()) },
  });
  try {
    await poll(async () => uploads.length > 0, true, 8000);
    const doc = (uploads.at(-1) as { doc: { settings: Record<string, unknown> } }).doc;
    expect(doc.settings.futureKnob).toBe(7);
    expect(doc.settings.native).toMatchObject({ discordJoin: true, sfxPack: "default" });
    expect("windowMode" in (doc.settings.native as object)).toBe(false);
    // With sync running, the account panel offers its switch.
    await openSettings(page, "account");
    await row(page, "account", "Name and sign-in").getByRole("button", { name: "Open account" }).click();
    await page.getByText("Keep settings with my account").waitFor();
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 30_000);

test("Edit layout and Paint reach the host", async () => {
  const { page, errors, close } = await open();
  try {
    // A host with the website's layout model has the website's Edit layout row; the host runs the editor.
    await host(page, { settings: { ...HOST_SETTINGS, hudLayoutWeb: CLASSIC } });
    await openSettings(page, "hud");
    const from = await count(page);
    await page.getByRole("button", { name: "Edit layout" }).click();
    await poll(async () => (await sent(page)).slice(from).some((message) => message.type === "hudEditor"), true);
    await page.locator('.set-rail-item[data-sec="paint"]').click();
    const before = await count(page);
    const paint = page.locator('section[data-sec="paint"]');
    await paint.getByRole("radio", { name: "Cyan" }).click();
    await paint.locator(".set-row", { hasText: "Marks" }).getByRole("button", { name: "Clear paint" }).click();
    const messages = (await sent(page)).slice(before);
    expect(messages).toContainEqual({ type: "paint", action: "clear" });
    expect(await patchesSince(page, before)).toContainEqual({ paint: { color: "#40dcff", size: "medium" } });
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});
