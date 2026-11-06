import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { DEFAULT_PREFS } from "../../web/src/ui/settings";
import { buildSettingsDoc, type SettingsDoc } from "../../web/src/ui/settings-io";
import { state, type SettingsPatch } from "./bridge";

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the settings request");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type Message = { type: string; patch: SettingsPatch };
const sent = (page: Page) => page.evaluate(() => (window as unknown as { sent: Message[] }).sent);
const bind = async (page: Page, command: string) => {
  const count = (await sent(page)).length;
  await page.evaluate(
    (detail) => dispatchEvent(new CustomEvent("bunnyhop:native-console-command", { detail })),
    command,
  );
  await page.waitForFunction((count) => (window as unknown as { sent: Message[] }).sent.length > count, count);
};
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("bunnyhop:settings")!));

for (const scenario of [
  "startup",
  "late read",
  "serialized uploads",
  "host echo",
  "native shadow",
  "repair race",
] as const) {
  test(`account and host ordering: ${scenario}`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(5000);
      const html = await readFile(new URL("../../../target/native-menu/menu.html", import.meta.url), "utf8");
      const doc = buildSettingsDoc(structuredClone(DEFAULT_PREFS));
      doc.settings.cmdBinds = { Mouse2: "+turnright" };
      if (scenario === "native shadow") {
        doc.settings.cmdBinds = {};
        doc.settings.native = { cmdBinds: { Mouse2: "+turnright" }, aliases: { stale: "echo old" }, sensitivity: 99 };
      }
      let releaseRead = () => {};
      let releaseWrite = () => {};
      let reads = 0;
      const uploads: SettingsDoc[] = [];
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/settings-order") return route.fulfill({ contentType: "text/html", body: html });
        if (url.pathname === "/api/me")
          return route.fulfill({ json: { id: "order-test", name: "Player", provider: "discord" } });
        if (url.pathname === "/api/me/settings") {
          if (route.request().method() === "POST") {
            uploads.push(route.request().postDataJSON().doc);
            if (scenario === "serialized uploads" && uploads.length === 1)
              await new Promise<void>((resolve) => {
                releaseWrite = resolve;
              });
            return route.fulfill({ json: { updatedAt: Date.now() } });
          }
          reads++;
          if (scenario === "late read")
            await new Promise<void>((resolve) => {
              releaseRead = resolve;
            });
          return route.fulfill({
            json: {
              doc,
              updatedAt: scenario === "serialized uploads" || scenario === "host echo" ? 1 : Date.now() + 100_000,
            },
          });
        }
        return route.abort();
      });
      await page.addInitScript(
        ({ repair, defaults }) => {
          localStorage.setItem("bunnyhop:onboarded", "1");
          localStorage.setItem("bunnyhop:settings-at", String(Date.now()));
          localStorage.setItem("bunnyhop:settings-sync", repair ? "0" : "1");
          if (repair)
            localStorage.setItem(
              "bunnyhop:settings",
              JSON.stringify({ ...defaults, cmdBinds: { KeyA: "echo saved" } }),
            );
          if (!repair) localStorage.setItem("bunnyhop:native-bind-repair-081", "1");
          const sent: Message[] = [];
          Object.assign(window, { sent });
          addEventListener("bunnyhop:native-message", (event) => {
            const message = (event as CustomEvent).detail;
            if (message.type === "settings") sent.push(message);
          });
        },
        { repair: scenario === "repair race", defaults: DEFAULT_PREFS },
      );
      await page.goto("https://bunnyhop.lol/settings-order");
      await page.waitForFunction(() => !!window.bunnyhopNativeMenu);
      const echo = () =>
        page.evaluate((settings) => window.bunnyhopNativeMenu.onState({ settings }), structuredClone(state.settings));
      if (scenario === "startup") {
        await page.waitForTimeout(200);
        expect(reads).toBe(0);
      }
      if (scenario === "repair race") await bind(page, "bind mouse2 +turnright");
      await echo();
      if (scenario === "repair race") {
        expect((await stored(page)).cmdBinds.Mouse2).toBe("+turnright");
      } else if (scenario === "late read") {
        await until(() => reads > 0);
        await bind(page, "bind mouse2 +turnright");
        await bind(page, "bind mouse2 +right");
        releaseRead();
        await page.waitForTimeout(200);
        expect((await stored(page)).cmdBinds.Mouse2).toBeUndefined();
      } else if (scenario === "host echo") {
        await until(() => uploads.length === 1);
        await page.waitForTimeout(100);
        await page.clock.install();
        await echo();
        await page.clock.fastForward(5000);
        await page.waitForTimeout(100);
        expect(uploads.length).toBe(1);
      } else if (scenario === "serialized uploads") {
        await until(() => uploads.length === 1);
        await bind(page, "bind mouse2 +turnright");
        await bind(page, "bind mouse2 +right");
        await page.clock.install();
        await page.clock.fastForward(5000);
        expect(uploads.length).toBe(1);
        releaseWrite();
        await until(() => uploads.length === 2);
        expect(uploads.at(-1)!.settings.cmdBinds).not.toHaveProperty("Mouse2");
      } else {
        await page.waitForTimeout(200);
        if (scenario === "startup") expect((await stored(page)).cmdBinds.Mouse2).toBe("+turnright");
        else {
          expect((await sent(page)).some((message) => message.patch.cmdBinds?.Mouse2 === "+turnright")).toBe(false);
          expect((await stored(page)).sensitivity).not.toBe(99);
        }
      }
    } finally {
      await browser.close();
    }
  }, 15_000);
}
