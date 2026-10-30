// Account -> Edit avatar in the built menu, with a fake host (it answers every picture with a stand-in) and a mocked
// API. What gets saved must pass the server's own checks: apps/api/src/bunny-avatar.ts runs cleanAvatar on the spec
// and cosmeticsProblem on avatarCosmetics(spec) against what the account owns, both from the shared web code here.
import { test, expect } from "bun:test";
import { chromium, type Page } from "playwright";
import { readFile } from "node:fs/promises";
import { COSMETICS, cosmeticsProblem, DEFAULT_COSMETICS, isUnlocked } from "../../web/src/progression";
import { avatarCosmetics, cleanAvatar, defaultAvatar, type AvatarSpec } from "../../web/src/avatar/spec";

const menu =
  process.env.NATIVE_AVATAR_MENU ?? new URL("../../../target/native-menu/menu.html", import.meta.url).pathname;
const PLAYER = { id: "avatar-fixture1", name: "Avatar Hopper", avatarUrl: null, provider: "discord" };
const LEVEL = 9;
const UNLOCKED = COSMETICS.filter((c) => isUnlocked(c, LEVEL, [])).map((c) => c.id);
// The colourway the account wears (owned, not free) and another owned one to switch to.
const [WORN, OTHER] = COSMETICS.filter(
  (c) => c.slot === "outfit" && c.unlock.kind !== "free" && UNLOCKED.includes(c.id),
);
const SAVED_URL = "https://bunnyhop.lol/api/avatars/avatar-fixture1/0123456789abcdef.webp";

interface Sent {
  type: string;
  id?: number;
  output?: string;
  live?: boolean;
  focus?: string;
  spec?: Record<string, unknown>;
  backdrop?: Record<string, unknown>;
}

interface Fixture {
  page: Page;
  saves: { spec: AvatarSpec; image: string }[];
  close: () => Promise<void>;
}

async function openMenu(signedIn: boolean): Promise<Fixture> {
  const html = await readFile(menu, "utf8");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  const saves: { spec: AvatarSpec; image: string }[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const sent: unknown[] = [];
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ" +
      "AAAADUlEQVR4nGNg+M/wHwAEAQH/b2NIewAAAABJRU5ErkJggg==";
    const answer = (m: { id: number; output: string }) => {
      const reply =
        m.output === "webp" ? { webp: "stand-in" } : m.output === "file" ? { saved: "/tmp/a.png" } : { png };
      (window as unknown as { bunnyhopNativeAvatar?: (r: unknown) => void }).bunnyhopNativeAvatar?.({
        id: m.id,
        ...reply,
      });
    };
    const post = (raw: string) => {
      const message = JSON.parse(raw);
      sent.push(message);
      if (message.type === "avatarRender") setTimeout(() => answer(message), 5);
    };
    Object.assign(window, { __sent: sent, webkit: { messageHandlers: { bunnyhop: { postMessage: post } } } });
    localStorage.setItem("bunnyhop:onboarded", "1");
  });
  await page.route("https://bunnyhop.lol/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/native-avatar-test") return route.fulfill({ contentType: "text/html", body: html });
    if (!path.startsWith("/api/")) return route.fulfill({ status: 204 });
    if (!signedIn) return json({ error: "offline_fixture" }, 503);
    if (path === "/api/me") return json(PLAYER);
    if (path === "/api/me/cosmetics")
      return json({ choice: { ...DEFAULT_COSMETICS, outfit: WORN.id }, level: LEVEL, unlocked: UNLOCKED });
    if (path === "/api/me/avatar/bunny" && request.method() === "GET")
      return json({ spec: defaultAvatar(PLAYER.id, WORN.id), custom: false, url: "" });
    if (path === "/api/me/avatar/bunny" && request.method() === "POST") {
      const body = request.postDataJSON() as { spec: AvatarSpec; image: string };
      saves.push(body);
      return json({ spec: cleanAvatar(body.spec), custom: true, url: SAVED_URL });
    }
    return json({ error: "offline_fixture" }, 503);
  });
  await page.goto("https://bunnyhop.lol/native-avatar-test");
  await page.waitForFunction(() => !!window.bunnyhopNativeMenu);
  const close = async () => {
    await browser.close();
    expect(errors).toEqual([]);
  };
  return { page, saves, close };
}

async function openEditor(page: Page): Promise<void> {
  await page.locator("button[aria-label$=': name and account']").first().click();
  await page.getByRole("button", { name: "Edit avatar", exact: true }).click();
  await page.locator(".av-dialog .av-picture[src^='data:image/png']").waitFor();
}

const sentMessages = (page: Page) => page.evaluate(() => (window as unknown as { __sent: Sent[] }).__sent);
const renders = async (page: Page) => (await sentMessages(page)).filter((m) => m.type === "avatarRender");

test("the editor saves to the signed-in account with a spec the server accepts", async () => {
  const { page, saves, close } = await openMenu(true);
  try {
    await openEditor(page);
    await page.getByRole("button", { name: "Use as my avatar" }).waitFor();
    // It opens on the account's default: the pose its id picks, in the colourway it wears, in that colourway's studio.
    await page.waitForFunction(
      (worn) => (window as unknown as { __sent: Sent[] }).__sent.some((m) => m.live && m.spec?.outfit === worn),
      WORN.id,
    );
    const opened = (await renders(page)).filter((m) => m.live).at(-1)!;
    const fallback = defaultAvatar(PLAYER.id, WORN.id);
    expect(opened.spec).toMatchObject({ outfit: WORN.id, pose: fallback.pose, frame: fallback.frame });
    expect(opened.backdrop).toMatchObject({ kind: "studio", glow: expect.stringMatching(/^#[0-9a-f]{6}$/) });

    // A colourway the account owns but isn't free, from the picker's thumbnails.
    const owned = OTHER;
    const locked = COSMETICS.find((c) => c.slot === "outfit" && !UNLOCKED.includes(c.id))!;
    await page.locator(".av-pick", { hasText: "Colourway" }).click();
    await page.locator(".av-tile", { hasText: owned.name }).click();
    expect(await page.locator(".av-tile", { hasText: locked.name }).count()).toBe(0);
    const thumbs = (await renders(page)).filter(
      (m) => !m.live && m.output === "preview" && m.backdrop?.kind === "clear",
    );
    expect(thumbs.length).toBeGreaterThan(1);
    await page.getByRole("option", { name: "Salute", exact: true }).click();

    await page.getByRole("button", { name: "Use as my avatar" }).click();
    await page.locator(".av-status", { hasText: "Saved." }).waitFor();
    expect(saves).toHaveLength(1);
    const { spec, image } = saves[0];
    expect(image).toBe("stand-in");
    expect(spec).toMatchObject({ outfit: owned.id, pose: "salute", hand: "none" });
    // What the server stores is what the editor showed, and every cosmetic in it is the account's.
    expect(cleanAvatar(spec)).toEqual(spec);
    expect(cosmeticsProblem(avatarCosmetics(spec), LEVEL, [])).toBeNull();
    const webp = (await renders(page)).find((m) => m.output === "webp")!;
    expect(webp).toMatchObject({ size: 256, spec: { outfit: owned.id, pose: "salute", hand: "none" } });
  } finally {
    await close();
  }
}, 30_000);

test("without an account: free items only, no save, and Download still works", async () => {
  const { page, saves, close } = await openMenu(false);
  try {
    await page.locator("button[aria-label$=': name and account']").first().click();
    await page.getByRole("button", { name: "Edit avatar", exact: true }).click();
    await page.locator(".av-dialog .av-status", { hasText: "Not signed in" }).waitFor();
    await page.getByRole("button", { name: "Sign in to use it" }).click();
    expect(saves).toHaveLength(0);
    await page.locator(".av-pick", { hasText: "Colourway" }).click();
    const names = await page.locator(".av-tile-name").allTextContents();
    const free = COSMETICS.filter((c) => c.slot === "outfit" && c.unlock.kind === "free").map((c) => c.name);
    expect(names.sort()).toEqual(free.sort());
    await page.getByRole("button", { name: "Done" }).click();
    await page.getByRole("button", { name: "Download PNG" }).click();
    await page.locator(".av-status", { hasText: "Saved /tmp/a.png" }).waitFor();
    const file = (await renders(page)).find((m) => m.output === "file")!;
    expect(file).toMatchObject({ size: 1024 });
  } finally {
    await close();
  }
}, 30_000);
