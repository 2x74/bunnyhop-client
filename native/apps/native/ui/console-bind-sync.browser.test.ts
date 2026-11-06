import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { DEFAULT_PREFS } from "../../web/src/ui/settings";
import { state, type SettingsPatch } from "./bridge";

interface Message {
  type: string;
  patch: SettingsPatch;
}
const messages = (page: Page) =>
  page.evaluate(() => (window as unknown as { messages: Message[] }).messages.filter((m) => m.type === "settings"));

async function changed(page: Page, before: number): Promise<SettingsPatch> {
  await page.waitForFunction(
    (count) =>
      (window as unknown as { messages: Message[] }).messages.filter((m) => m.type === "settings").length > count,
    before,
  );
  return (await messages(page)).at(-1)!.patch;
}

async function run(page: Page, command: string): Promise<SettingsPatch> {
  const count = (await messages(page)).length;
  await page.evaluate(
    (detail) => dispatchEvent(new CustomEvent("bunnyhop:native-console-command", { detail })),
    command,
  );
  return changed(page, count);
}

test("saved menu binds repair a stale host once; console and Settings removals survive host echoes", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const html = await readFile(new URL("../../../target/native-menu/menu.html", import.meta.url), "utf8");
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) =>
      route.request().url() === "https://bunnyhop.lol/bind-sync-test"
        ? route.fulfill({ contentType: "text/html", body: html })
        : route.abort(),
    );
    await page.addInitScript((saved) => {
      if (!localStorage.getItem("bunnyhop:settings")) localStorage.setItem("bunnyhop:settings", JSON.stringify(saved));
      localStorage.setItem("bunnyhop:onboarded", "1");
      localStorage.setItem("bunnyhop:first-seen", String(Date.now()));
      const messages: Message[] = [];
      Object.assign(window, { messages });
      addEventListener("bunnyhop:native-message", (event) => messages.push((event as CustomEvent).detail));
    }, DEFAULT_PREFS);
    await page.goto("https://bunnyhop.lol/bind-sync-test");
    await page.waitForFunction(() => !!window.bunnyhopNativeMenu);
    let host = structuredClone(state.settings);
    host.cmdBinds = { KeyA: "echo test; +moveleft" };
    host.aliases = { stale: "echo old" };
    host.binds.left = [];
    await page.evaluate((settings) => window.bunnyhopNativeMenu.onState({ settings }), host);
    const repair = (await messages(page)).at(-1)!.patch;
    expect(repair).toMatchObject({ cmdBinds: {}, aliases: {}, binds: { left: ["KeyA"] } });
    const echo = async (patch: SettingsPatch) => {
      host = { ...host, ...patch, binds: { ...host.binds, ...patch.binds } };
      await page.evaluate((settings) => window.bunnyhopNativeMenu.onState({ settings }), host);
    };
    await echo(repair);
    await echo(await run(page, 'bind a "echo test; +moveleft"'));
    const rebind = await run(page, "bind a +moveleft");
    expect(rebind).toMatchObject({ cmdBinds: {}, binds: { left: ["KeyA"] } });
    await echo(rebind);
    await echo(await run(page, 'bind a "echo test; +moveleft"'));
    const unbind = await run(page, "unbind a");
    expect(unbind.cmdBinds).toEqual({});
    await echo(unbind);
    await echo(await run(page, "bind a +moveleft"));
    expect(host.cmdBinds).toEqual({});
    await echo(await run(page, 'alias test "echo test"'));
    const unalias = await run(page, "unalias test");
    expect(unalias.aliases).toEqual({});
    await echo(unalias);
    for (const text of ["say gg", "echo test; +moveleft"]) {
      await echo(await run(page, `bind a "${text}"`));
      await page.evaluate(() => window.bunnyhopNativeMenu.open?.("settings", "keys"));
      const count = (await messages(page)).length;
      await page.getByRole("button", { name: `Remove ${text === "say gg" ? "gg" : text}`, exact: true }).click();
      const removed = await changed(page, count);
      expect(removed.cmdBinds).toEqual({});
      await echo(removed);
    }
    await echo(await run(page, "binds_default"));
    expect(host.cmdBinds).toEqual({});
    host.cmdBinds = { KeyB: "echo host" };
    await page.reload();
    await page.waitForFunction(() => !!window.bunnyhopNativeMenu);
    await page.evaluate((settings) => window.bunnyhopNativeMenu.onState({ settings }), host);
    expect((await messages(page)).filter((m) => m.patch.cmdBinds)).toEqual([]);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("bunnyhop:settings")!).cmdBinds)).toEqual({
      KeyB: "echo host",
    });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 30_000);

test("an install without saved command prefs keeps host binds on first sync and later launches", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const html = await readFile(new URL("../../../target/native-menu/menu.html", import.meta.url), "utf8");
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url() === "https://bunnyhop.lol/new-bind-test"
        ? route.fulfill({ contentType: "text/html", body: html })
        : route.abort(),
    );
    await page.goto("https://bunnyhop.lol/new-bind-test");
    await page.waitForFunction(() => !!window.bunnyhopNativeMenu);
    const host = structuredClone(state.settings);
    host.cmdBinds = { KeyA: "echo host" };
    await page.evaluate((settings) => window.bunnyhopNativeMenu.onState({ settings }), host);
    const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("bunnyhop:settings")!).cmdBinds);
    expect(await saved()).toEqual(host.cmdBinds);
    host.cmdBinds = { KeyB: "echo changed on host" };
    await page.reload();
    await page.waitForFunction(() => !!window.bunnyhopNativeMenu);
    await page.evaluate((settings) => window.bunnyhopNativeMenu.onState({ settings }), host);
    expect(await saved()).toEqual(host.cmdBinds);
  } finally {
    await browser.close();
  }
}, 15_000);
