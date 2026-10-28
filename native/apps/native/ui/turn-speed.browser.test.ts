import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright";
import { readFile } from "node:fs/promises";

type Message = { type: string; patch?: Record<string, unknown> };

async function openSettings(page: Page): Promise<string[]> {
  const html = await readFile(new URL("../../../target/native-menu/menu.html", import.meta.url), "utf8");
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.request().url() === "https://bunnyhop.lol/turn-speed"
    ? route.fulfill({ contentType: "text/html", body: html }) : route.abort());
  await page.addInitScript(() => {
    localStorage.setItem("bunnyhop:onboarded", "1");
    localStorage.setItem("bunnyhop:first-seen", String(Date.now()));
    Object.assign(window, { messages: [] });
    window.addEventListener("bunnyhop:native-message", event => {
      (window as unknown as { messages: unknown[] }).messages.push((event as CustomEvent).detail);
    });
  });
  await page.goto("https://bunnyhop.lol/turn-speed");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  return errors;
}

const settingsMessages = (page: Page): Promise<Message[]> => page.evaluate(() =>
  (window as unknown as { messages: Message[] }).messages.filter(message => message.type === "settings"));
const lastPatch = async (page: Page): Promise<Record<string, unknown> | undefined> =>
  (await settingsMessages(page)).at(-1)?.patch;
const hostSettings = (page: Page, settings: Record<string, unknown>): Promise<void> =>
  page.evaluate(value => window.bunnyhopNativeMenu.onState({ settings: value }), settings);

test("turn speed: Keys → Turning sends cl_yawspeed and cl_anglespeedkey in the host's ranges", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors = await openSettings(page);
    const search = page.getByLabel("Search settings");

    // Search finds both by their console names, and the fast-turn bind by +speed.
    await search.fill("cl_anglespeedkey");
    expect(await page.getByLabel("Fast turn", { exact: true }).isVisible()).toBe(true);
    expect(await page.locator(".nset-sec:visible h2").allTextContents()).toEqual(["Keys"]);
    await search.fill("+speed");
    expect(await page.getByLabel("Fast turn (+speed) binding").isVisible()).toBe(true);
    await search.fill("cl_yawspeed");
    const turnSpeed = page.getByLabel("Turn speed", { exact: true });
    expect(await turnSpeed.inputValue()).toBe("210");
    expect(await page.getByText("a change applies from your next restart").isVisible()).toBe(true);
    expect(await page.getByText("In Legit Scroll, turn binds only work in practice.").isVisible()).toBe(true);

    // Out of range is refused in the menu, not sent for the host to reject.
    await turnSpeed.fill("1000");
    await turnSpeed.blur();
    expect(await page.getByText("Turn speed: choose 60–720.").isVisible()).toBe(true);
    expect(await settingsMessages(page)).toEqual([]);
    await turnSpeed.fill("300.4");
    await turnSpeed.blur();
    expect(await lastPatch(page)).toEqual({ yawSpeed: 300 });

    await search.fill("fast turn");
    const fastTurn = page.getByLabel("Fast turn", { exact: true });
    expect(await fastTurn.inputValue()).toBe("2");
    await fastTurn.fill("2.37");
    await fastTurn.blur();
    expect(await lastPatch(page)).toEqual({ angleSpeedKey: 2.35 });
    await fastTurn.fill("0.5");
    await fastTurn.blur();
    expect(await page.getByText("Fast turn: choose 1–4.").isVisible()).toBe(true);
    expect(await lastPatch(page)).toEqual({ angleSpeedKey: 2.35 });

    // The slider moves in the same steps; Default goes back to 2.
    const slider = page.getByLabel("Fast turn slider", { exact: true });
    expect(await slider.getAttribute("min")).toBe("1");
    expect(await slider.getAttribute("max")).toBe("4");
    await slider.fill("3.5");
    await page.waitForTimeout(150);
    expect(await lastPatch(page)).toEqual({ angleSpeedKey: 3.5 });
    await hostSettings(page, { angleSpeedKey: 3.5 });
    const fastTurnRow = page.locator(".nset-row", { has: fastTurn });
    await fastTurnRow.getByRole("button", { name: "Default", exact: true }).click();
    expect(await lastPatch(page)).toEqual({ angleSpeedKey: 2 });

    // Bind fast turn to Left Shift.
    await page.getByLabel("Fast turn (+speed) binding").click();
    await page.keyboard.press("ShiftLeft");
    expect(await lastPatch(page)).toEqual({ binds: { turnFast: ["ShiftLeft"] } });

    const sent = JSON.stringify(await settingsMessages(page));
    expect(sent).not.toContain("yawSpeedAlt");
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 20_000);

test("turn speed: a website v29 settings code applies turn speed, fast turn and its bind", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors = await openSettings(page);
    const code = (await readFile(new URL("./web-settings-v29.txt", import.meta.url), "utf8")).trim();
    await page.getByLabel("Search settings").fill("import");
    await page.getByLabel("Settings code or JSON", { exact: true }).fill(code);
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await page.waitForFunction(() => (window as unknown as { messages: Message[] }).messages
      .some(message => message.type === "settings"));
    const patch = await lastPatch(page);
    expect(patch?.yawSpeed).toBe(300);
    expect(patch?.angleSpeedKey).toBe(2.5);
    expect((patch?.binds as Record<string, string[]>).turnFast).toEqual(["ShiftLeft"]);
    const summary = await page.getByText(/^Imported \d+ settings/).textContent();
    expect(summary).not.toMatch(/yawSpeed|angleSpeedKey|turnFast/);

    // The rows show the imported values once the host confirms them.
    await hostSettings(page, { yawSpeed: 300, angleSpeedKey: 2.5 });
    await page.getByLabel("Search settings").fill("turnbind");
    expect(await page.getByLabel("Turn speed", { exact: true }).inputValue()).toBe("300");
    expect(await page.getByLabel("Fast turn", { exact: true }).inputValue()).toBe("2.5");
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 20_000);
