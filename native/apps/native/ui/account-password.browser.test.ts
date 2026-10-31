import { test, expect } from "bun:test";
import { chromium, type Page } from "playwright";
import { mkdir, readFile } from "node:fs/promises";

const uiRoot = new URL(".", import.meta.url).pathname;
const menu = new URL("../../../target/native-menu/menu.html", import.meta.url).pathname;
const shots = "/tmp/bunnyhop-password-review";
const webviewSources = ["menu_webview_macos.mm", "menu_webview_gtk.cpp", "menu_webview_windows.cpp"];

/** The menu's Content-Security-Policy as a host writes it, joined across its string literals. */
async function hostPolicy(source: string): Promise<string> {
  const text = await readFile(`${uiRoot}../src/${source}`, "utf8");
  const start = text.indexOf("default-src 'none'");
  const last = "form-action 'none'";
  const body = text.slice(start, text.indexOf(last, start) + last.length);
  return body.replace(/"\s*\n\s*[@L]?"/g, "");
}

interface Fixture {
  user: { id: string; name: string; provider: string; avatarUrl: null; onboarded?: boolean };
  methods: { provider: string; label: string; since: string }[];
  password: { set: boolean; resetUntil: string | null; alias: boolean };
  loginAnswers: { status: number; body: unknown }[];
}

const runIdentity = {
  map: "bhop_eazy",
  track: 0,
  style: "autohop",
  build: "bunnyhop-native/123456789abc",
  wasm: "bunnyhop-web/abcdef012345",
};
const admitted = () => [{ build: runIdentity.build, wasm: runIdentity.wasm, until: Date.now() + 60_000 }];

const guest = (): Fixture => ({
  user: { id: "password-fixture", name: "Hopper", provider: "guest", avatarUrl: null },
  methods: [],
  password: { set: false, resetUntil: null, alias: false },
  loginAnswers: [],
});

async function openMenu(page: Page, fixture: Fixture, policy: string, onboarded = true): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((seen) => {
    const w = window as unknown as { webkit: unknown; __messages: unknown[] };
    w.__messages = [];
    w.webkit = { messageHandlers: { bunnyhop: { postMessage: (raw: string) => w.__messages.push(JSON.parse(raw)) } } };
    if (seen) localStorage.setItem("bunnyhop:onboarded", "1");
  }, onboarded);
  const html = await readFile(menu, "utf8");
  await page.routeWebSocket("**/*", (ws) => ws.close());
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/native-password-test")
      return route.fulfill({ contentType: "text/html", headers: { "Content-Security-Policy": policy }, body: html });
    if (!url.pathname.startsWith("/api/")) return route.fulfill({ status: 204 });
    let status = 200;
    let body: unknown = { error: "not_found" };
    if (url.pathname === "/api/me") body = fixture.user;
    else if (url.pathname === "/api/auth/providers") body = { discord: true, email: true };
    else if (url.pathname === "/api/config") body = { discordInvite: null };
    else if (url.pathname === "/api/me/account")
      body = {
        user: fixture.user,
        methods: fixture.methods,
        canUnlink: { password: fixture.methods.length > 1, email: false, discord: false },
        name: { changesLeft: 3, limit: 3, isDefault: false, resetAt: null },
        password: fixture.password,
      };
    else if (url.pathname === "/api/version") body = { wasm: runIdentity.wasm, native: admitted() };
    else if (url.pathname === "/api/runs/beat") body = { sid: "session", token: "t0" };
    else if (url.pathname === "/api/runs") body = { id: "best-run", status: "verified", pb: true };
    else if (url.pathname === "/api/auth/password/login") {
      const answer = fixture.loginAnswers.shift()!;
      status = answer.status;
      body = answer.body;
    } else status = 404;
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("https://bunnyhop.lol/native-password-test", { waitUntil: "domcontentloaded" });
  return errors;
}

const openAccount = async (page: Page) => {
  await page.evaluate(() => window.bunnyhopNativeMenu.open?.("home"));
  await page.locator(".guest-chip, .user-chip").first().waitFor();
  await page.locator("button.chip-name, .chip .name-edit button").first().click();
  const account = page.getByRole("dialog", { name: "Account", exact: true });
  await account.getByRole("textbox", { name: "Display name" }).waitFor();
  return account;
};

async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
  await mkdir(shots, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(7000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await run(page);
  } finally {
    await browser.close();
  }
}

test("no host's menu policy lets the Turnstile script or frame in", async () => {
  for (const source of webviewSources) {
    const policy = await hostPolicy(source);
    expect(policy).toContain("frame-src 'none'");
    expect(policy).not.toContain("challenges.cloudflare.com");
    expect(policy).toMatch(/script-src 'unsafe-inline'/);
  }
});

test("a guest signs in with a password, and a required check that can't load points to email or Discord", async () => {
  await withPage(async (page) => {
    const fixture = guest();
    const checkRequired = {
      status: 403,
      body: { error: "turnstile_required", message: "Please pass the security check.", siteKey: "site-key" },
    };
    fixture.loginAnswers = [checkRequired];
    const errors = await openMenu(page, fixture, await hostPolicy("menu_webview_macos.mm"));
    const account = await openAccount(page);
    await expect(account.getByRole("heading", { name: "Save progress" }).isVisible()).resolves.toBe(true);
    await page.screenshot({ path: `${shots}/guest.png` });
    await account.getByRole("button", { name: "Already have an account? Sign in" }).click();
    await account.getByRole("textbox", { name: "Name or email" }).fill("Returning");
    await account.getByLabel("Password", { exact: true }).fill("correct horse");
    await page.screenshot({ path: `${shots}/sign-in.png` });
    await account.getByRole("button", { name: "Sign in", exact: true }).click();
    // The policy refuses the script, so its load error lands on the fallback text, not on the 10 s timeout.
    await account.getByText("The security check can't load here.").waitFor({ timeout: 4000 });
    expect(await account.locator("iframe").count()).toBe(0);
    await page.screenshot({ path: `${shots}/no-check.png` });

    fixture.user = { ...fixture.user, name: "Returning", provider: "account" };
    fixture.methods = [{ provider: "password", label: "Returning", since: "2026-10-30T00:00:00Z" }];
    fixture.password = { set: true, resetUntil: null, alias: false };
    fixture.loginAnswers = [{ status: 200, body: { user: fixture.user, outcome: "signed_in" } }];
    await account.getByRole("button", { name: "Sign in", exact: true }).click();
    await account.locator(".acct-who-status", { hasText: "Signed in with a password" }).waitFor();
    await account.getByText("You sign in with this name.").waitFor();
    await account.getByText("Sign in as Returning").waitFor();
    await page.screenshot({ path: `${shots}/signed-in.png` });
    expect(errors).toEqual([]);
  });
}, 30000);

test("forgot password goes through the host's sign-in and the auth return opens the new password form", async () => {
  await withPage(async (page) => {
    const fixture = guest();
    fixture.user = { ...fixture.user, provider: "discord" };
    fixture.methods = [
      { provider: "password", label: "Hopper", since: "2026-10-30T00:00:00Z" },
      { provider: "discord", label: "hopper", since: "2026-10-30T00:00:00Z" },
    ];
    fixture.password = { set: true, resetUntil: null, alias: false };
    const errors = await openMenu(page, fixture, await hostPolicy("menu_webview_windows.cpp"));
    const account = await openAccount(page);
    await account.getByRole("button", { name: "Change", exact: true }).click();
    await account.getByRole("button", { name: "Remove password (press and hold)" }).waitFor();
    await page.screenshot({ path: `${shots}/change.png` });
    await account.getByRole("button", { name: "Forgot password?" }).click();
    await account.getByText("then you have 15 minutes").waitFor();
    await page.screenshot({ path: `${shots}/forgot.png` });
    await account.getByRole("button", { name: "Sign in with Discord" }).first().click();
    const sent = await page.evaluate(
      () => (window as unknown as { __messages: { type: string; url?: string }[] }).__messages,
    );
    const auth = sent.find((message) => message.type === "openAuth");
    expect(auth?.url).toContain("/api/auth/discord");

    fixture.password = { set: true, resetUntil: new Date(Date.now() + 900_000).toISOString(), alias: false };
    await page.evaluate(() => window.bunnyhopNativeMenu.onAuth?.());
    await account.getByLabel("New password", { exact: false }).first().waitFor();
    await account.getByText("without the old one until").waitFor();
    expect(await account.getByLabel("Current password").count()).toBe(0);
    await page.screenshot({ path: `${shots}/reset.png` });
    expect(errors).toEqual([]);
  });
}, 30000);

test("onboarding offers name and password first, then Discord and email", async () => {
  await withPage(async (page) => {
    const fixture = guest();
    const errors = await openMenu(page, fixture, await hostPolicy("menu_webview_gtk.cpp"), false);
    const intro = page.getByRole("dialog", { name: "Welcome to bunnyhop.lol" });
    await intro.getByRole("button", { name: "Already play? Sign in" }).click();
    await intro.getByRole("textbox", { name: "Name or email" }).waitFor();
    await intro.getByText("makes this guest a separate account").waitFor();
    const order = await intro
      .locator(".native-intro-signin > *")
      .evaluateAll((items) => items.map((item) => item.tagName + (item.className ? `.${item.className}` : "")));
    expect(order[0]).toContain("FORM");
    await page.screenshot({ path: `${shots}/onboarding.png` });
    await intro.getByRole("button", { name: "Forgot password?" }).click();
    await intro.getByText("An account with neither can't be reset.").waitFor();
    await intro.getByRole("button", { name: "Back", exact: true }).click();
    await intro.getByRole("textbox", { name: "Display name" }).waitFor();
    expect(errors).toEqual([]);
  });
}, 30000);

test("a guest's verified best offers Keep this run, and resuming takes the focus out of its field", async () => {
  await withPage(async (page) => {
    const errors = await openMenu(page, guest(), await hostPolicy("menu_webview_macos.mm"));
    await page.evaluate((identity) => {
      const menu = window.bunnyhopNativeMenu;
      const generation = 1;
      menu.onRunEvent?.({ type: "reset", generation });
      menu.onRunEvent?.({ type: "beat", generation, ...identity, tick: 0, hash: "1234abcd", paused: false });
      menu.onRunEvent?.({ type: "finish", generation, ...identity, replayBase64: btoa("bhr-mock-transport-bytes") });
    }, runIdentity);
    await page.waitForFunction(() =>
      (window as unknown as { __messages: { type: string; text?: string }[] }).__messages.some(
        (message) => message.type === "hudToast" && message.text?.startsWith("Keep this run"),
      ),
    );
    await page.evaluate(() => window.bunnyhopNativeMenu.onState?.({ map: "bhop_eazy", loading: false, paused: true }));
    const block = page.locator(".keep-run");
    const field = block.getByPlaceholder("Password, 8 characters or more");
    await field.waitFor();
    expect(await field.evaluate((input) => input === document.activeElement)).toBe(false);
    await page.screenshot({ path: `${shots}/keep-run.png` });
    await field.focus();
    await page.evaluate(() => window.bunnyhopNativeMenu.onState?.({ paused: false }));
    expect(await page.evaluate(() => document.activeElement?.closest(".keep-run") ?? null)).toBeNull();
    expect(errors).toEqual([]);
  });
}, 30000);
