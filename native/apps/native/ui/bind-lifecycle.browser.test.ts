import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { DEFAULT_PREFS } from "../../web/src/ui/settings";
import { buildSettingsDoc } from "../../web/src/ui/settings-io";
import type { SettingsPatch } from "./bridge";

type Message = { type: string; patch: SettingsPatch };
const sent = (page: Page) => page.evaluate(() => (window as unknown as { sent: Message[] }).sent);
const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("bunnyhop:settings")!));

async function command(page: Page, text: string): Promise<SettingsPatch> {
  const count = (await sent(page)).length;
  await page.evaluate((detail) => dispatchEvent(new CustomEvent("bunnyhop:native-console-command", { detail })), text);
  await page.waitForFunction((count) => (window as unknown as { sent: Message[] }).sent.length > count, count);
  return (await sent(page)).at(-1)!.patch;
}

for (const lifecycle of [
  "run finish",
  "map change",
  "menu reopen",
  "restart",
  "account sync",
  "optimistic read",
  "account deletion",
] as const) {
  test(`ThrowTop's binds survive ${lifecycle} with late host echoes and signed-in settings`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "native-bind-lifecycle-"));
    const binary = join(dir, "host");
    const root = resolve(import.meta.dir, "..");
    const compiler = Bun.spawnSync([
      "c++",
      "-std=c++20",
      "-O0",
      "-I",
      join(root, "src"),
      "-I",
      join(root, "include"),
      "-I",
      join(root, "vendor"),
      join(import.meta.dir, "fixtures/bind-host.cpp"),
      "-o",
      binary,
    ]);
    if (compiler.exitCode) throw new Error(compiler.stderr.toString());
    const host = (request: unknown = {}) => {
      const result = Bun.spawnSync([binary, join(dir, "settings.json")], {
        stdin: new TextEncoder().encode(JSON.stringify(request)),
      });
      if (result.exitCode) throw new Error(result.stderr.toString());
      return JSON.parse(result.stdout.toString());
    };
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(6000);
      const html = await readFile(new URL("../../../target/native-menu/menu.html", import.meta.url), "utf8");
      const old = structuredClone(DEFAULT_PREFS);
      old.cmdBinds = { KeyA: "echo test; +moveleft" };
      old.binds.left = [];
      old.aliases = { stale: "echo old" };
      const oldRemote = buildSettingsDoc(old);
      oldRemote.settings.cmdBinds = { ...old.cmdBinds, Mouse2: "+turnright" };
      let remote = { doc: oldRemote, updatedAt: 1 };
      const uploads: (typeof remote.doc)[] = [];
      let accountReads = 0;
      let runUploads = 0;
      const identity = {
        map: "bhop_eazy",
        track: 0,
        style: "autohop",
        build: "bunnyhop-native/123456789abc",
        wasm: "bunnyhop-web/791871b0244d",
      };
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/bind-lifecycle") return route.fulfill({ contentType: "text/html", body: html });
        if (url.pathname === "/api/me")
          return route.fulfill({ json: { id: "throwtop-test", name: "Player", provider: "discord" } });
        if (url.pathname === "/api/version")
          return route.fulfill({
            json: { wasm: identity.wasm, native: [{ ...identity, until: Date.now() + 60_000 }] },
          });
        if (url.pathname === "/api/runs" && route.request().method() === "POST") {
          runUploads++;
          return route.fulfill({ json: { id: "mock-finished-run", status: "verified", rank: 5 } });
        }
        if (url.pathname === "/api/me/settings") {
          if (route.request().method() === "POST") {
            const doc = route.request().postDataJSON().doc;
            uploads.push(doc);
            remote = { doc, updatedAt: Date.now() };
            return route.fulfill({ json: { updatedAt: remote.updatedAt } });
          }
          accountReads++;
          return route.fulfill({ json: remote });
        }
        return route.abort();
      });
      await page.addInitScript((old) => {
        if (!localStorage.getItem("bunnyhop:settings")) {
          localStorage.setItem("bunnyhop:settings", JSON.stringify(old));
          localStorage.setItem("bunnyhop:native-bind-repair-081", "1");
          localStorage.setItem("bunnyhop:settings-at", String(Date.now()));
          localStorage.setItem("bunnyhop:settings-sync", "1");
        }
        localStorage.setItem("bunnyhop:onboarded", "1");
        const sent: Message[] = [];
        Object.assign(window, { sent });
        addEventListener("bunnyhop:native-message", (event) => {
          const message = (event as CustomEvent).detail;
          if (message.type === "settings") sent.push(message);
        });
      }, old);
      await page.goto("https://bunnyhop.lol/bind-lifecycle");
      await page.waitForFunction(() => !!window.bunnyhopNativeMenu);
      const echo = (settings: unknown, extra = {}) =>
        page.evaluate((value) => window.bunnyhopNativeMenu.onState(value), { settings, ...extra });
      await echo(host({ patch: { cmdBinds: old.cmdBinds, aliases: old.aliases, binds: { left: [] } } }).settings);
      await echo(host({ patch: await command(page, "bind a +moveleft") }).settings);
      await echo(host({ patch: await command(page, 'bind f9 "echo fixed"') }).settings);
      await echo(host({ patch: await command(page, "unalias stale") }).settings);
      const unknown = await command(page, "bind mouse2 +turnright");
      const stale = host({ patch: unknown }).settings;
      expect(host({ key: "Mouse2" }).command).toBe("+turnright");
      const latest = await command(page, "bind mouse2 +right");
      // Another local mutation used to acknowledge optimistic state before a host echo arrived.
      const pending = lifecycle === "optimistic read" ? await command(page, 'bind f8 "echo latest"') : {};
      if (lifecycle === "restart") {
        // Terminate the menu before the host receives the latest patches.
        await page.reload();
        await page.waitForFunction(() => !!window.bunnyhopNativeMenu);
        await echo(host().settings);
        await page.waitForFunction(() =>
          (window as unknown as { sent: Message[] }).sent.some(
            (m) => m.patch.cmdBinds && !("Mouse2" in m.patch.cmdBinds),
          ),
        );
        for (const message of await sent(page)) host({ patch: message.patch });
      } else if (lifecycle === "account deletion") {
        host({ patch: latest });
      } else {
        await page.clock.install();
        await page.clock.fastForward(lifecycle === "optimistic read" ? 0 : 3500);
        await echo(
          stale,
          lifecycle === "map change"
            ? { map: "bhop_eazy", loading: false }
            : lifecycle === "run finish"
              ? { map: "bhop_eazy", paused: true, timer: { status: 2, seconds: 12, timeMs: 12000 } }
              : { paused: true },
        );
        expect((await saved(page)).cmdBinds.Mouse2).toBeUndefined();
        host({ patch: latest });
        host({ patch: pending });
      }
      await echo(host().settings);
      if (lifecycle === "run finish") {
        const before = accountReads;
        await page.evaluate((identity) => {
          window.bunnyhopNativeMenu.onRunEvent({ type: "reset", generation: 1 });
          window.bunnyhopNativeMenu.onRunEvent({
            type: "finish",
            generation: 1,
            ...identity,
            replayBase64: btoa("mock-transport-replay"),
          });
        }, identity);
        const deadline = Date.now() + 5000;
        while ((runUploads === 0 || accountReads <= before) && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20));
        expect(runUploads).toBe(1);
        expect(accountReads).toBeGreaterThan(before);
      }
      if (lifecycle === "menu reopen") await page.evaluate(() => window.bunnyhopNativeMenu.open?.("settings", "keys"));
      await page.clock.install().catch(() => {});
      await page.clock.fastForward(5000);
      await page.waitForTimeout(100);
      // Upload deletions and refresh the account, as a verified finish does.
      await page.evaluate(() => dispatchEvent(new CustomEvent("bunnyhop:account")));
      await page.waitForTimeout(200);
      expect(uploads.length).toBeGreaterThan(0);
      expect(uploads.at(-1)!.settings.cmdBinds).not.toHaveProperty("Mouse2");
      expect(uploads.at(-1)!.settings.cmdBinds).not.toHaveProperty("KeyA");
      expect(uploads.at(-1)!.settings.aliases).toEqual({});
      for (const message of await sent(page)) host({ patch: message.patch });
      await page.reload();
      await page.waitForFunction(() => !!window.bunnyhopNativeMenu);
      await echo(host().settings);
      expect(host({ key: "Mouse2" }).command).toBeUndefined();
      expect(host({ key: "Mouse2" }).yaw).not.toBe(0);
      expect(host({ key: "KeyA" })).toMatchObject({ side: -450 });
      expect((await saved(page)).cmdBinds).not.toHaveProperty("Mouse2");
      expect((await saved(page)).aliases).toEqual({});
    } finally {
      await browser.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
}
