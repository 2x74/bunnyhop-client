import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright";
import { readFile } from "node:fs/promises";
import type { RecentWr } from "../../web/src/api";
import { defaultAvatarPath } from "../../web/src/avatar/spec";
import { nativeProfileFixture } from "./profile-fixture";

type Message = { type: string; [key: string]: unknown };
type FixtureWindow = Window & { messages: Message[]; recordsNow: number };
const NOW = Date.UTC(2026, 10, 6, 20);
const NAMES = [
  "bhop_eazy",
  "bh_aztec",
  "bhop_1",
  "bhop_13",
  "bhop_ambience",
  "bhop_easyhop",
  "bhop_2_easy",
  "bhop_alley",
];
const INDEX = {
  maps: NAMES.map((name, index) => ({
    name,
    title: name,
    tier: 1,
    size: 1024,
    thumbnail: index === 0 ? "https://bunnyhop.lol/thumbs/native-cache.svg" : null,
  })),
};
const RECORDS: RecentWr[] = NAMES.slice(0, 6).map((map, index) => ({
  runId: `wr-run-${index}`,
  map,
  tier: index + 1,
  style: index === 1 ? "scroll" : "autohop",
  thumbnailUrl: index === 2 ? "https://bunnyhop.lol/thumbs/feed.svg" : null,
  time: 12.582 + index,
  ticks: 1258 + index * 100,
  date: new Date(NOW - (index + 3) * 60_000).toISOString(),
  player: {
    ...nativeProfileFixture(`holder-${index}`, `Holder ${index}`, false).player,
    verified: index === 0,
    avatarUrl: null,
  },
}));
const IMAGE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#333"/></svg>';
interface Answer {
  status?: number;
  records: RecentWr[];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function open(answer: () => Promise<Answer> = async () => ({ records: RECORDS }), indexGate?: Promise<void>) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(5000);
  const html = await readFile(new URL("../../../target/native-menu/menu.html", import.meta.url), "utf8");
  const errors: string[] = [],
    requests: { path: string; cookie: string }[] = [];
  const requestSeen = deferred<void>(),
    answerSent = deferred<void>();
  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .context()
    .addCookies([{ name: "bh_session", value: "records-fixture", domain: "bunnyhop.lol", path: "/", secure: true }]);
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname === "/native-records-test") return route.fulfill({ contentType: "text/html", body: html });
    if (url.pathname === "/index.json") {
      await indexGate;
      return route.fulfill({ json: INDEX });
    }
    if (url.pathname === "/api/records/wrs") {
      requests.push({ path: url.pathname + url.search, cookie: (await request.allHeaders()).cookie ?? "" });
      requestSeen.resolve();
      const response = await answer();
      await route.fulfill({ status: response.status ?? 200, json: { at: NOW, records: response.records } });
      answerSent.resolve();
      return;
    }
    if (/^\/api\/players\/holder-\d$/.test(url.pathname)) {
      const id = url.pathname.split("/").at(-1)!;
      return route.fulfill({ json: nativeProfileFixture(id, `Holder ${id.at(-1)}`, false) });
    }
    if (/^\/api\/runs\/wr-run-\d\/replay$/.test(url.pathname))
      return route.fulfill({ contentType: "application/octet-stream", body: Buffer.from([1, 2, 3]) });
    if (url.pathname.startsWith("/thumbs/") || url.pathname.startsWith("/avatars/"))
      return route.fulfill({ contentType: "image/svg+xml", body: IMAGE });
    return route.abort();
  });
  await page.addInitScript((now) => {
    localStorage.setItem("bunnyhop:onboarded", "1");
    localStorage.setItem("bunnyhop:first-seen", String(now));
    const fixture = window as unknown as FixtureWindow;
    fixture.messages = [];
    fixture.recordsNow = now;
    Date.now = () => fixture.recordsNow;
    window.addEventListener("bunnyhop:native-message", (event) => fixture.messages.push((event as CustomEvent).detail));
  }, NOW);
  await page.goto("https://bunnyhop.lol/native-records-test?attract=bhop_eazy", { waitUntil: "domcontentloaded" });
  return {
    page,
    requests,
    errors,
    requested: requestSeen.promise,
    answered: answerSent.promise,
    close: () => browser.close(),
  };
}
const ready = (page: Page) => page.locator(".home-recs:not([aria-busy]) .home-rec").first().waitFor();
async function redraw(page: Page) {
  await page.evaluate(() => {
    window.bunnyhopNativeMenu.open?.("settings");
    window.bunnyhopNativeMenu.open?.("home");
  });
}
const visible = (page: Page, selector: string) => page.locator(`${selector}:visible`).count();

test("recent WRs use native replay/profile routes, player bunnies and map-name thumbnails", async () => {
  const index = deferred<void>(),
    fixture = await open(undefined, index.promise);
  const { page } = fixture;
  try {
    await fixture.answered;
    await page.locator(".home-recs[aria-busy=true]").waitFor();
    expect(await page.locator(".home-rec-wait").count()).toBe(6);
    expect(await page.locator(".home-rec[data-run]").count()).toBe(0);
    index.resolve();
    await ready(page);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0].path).toBe("/api/records/wrs?limit=6");
    expect(fixture.requests[0].cookie).toContain("bh_session=records-fixture");
    expect(await page.locator(".home-right > :first-child").getAttribute("class")).toBe("home-grid");
    expect(await page.locator(".home-right > :last-child").getAttribute("class")).toBe("home-records");
    const first = page.locator(".home-rec").first();
    expect(await first.locator(".home-rec-map b").textContent()).toBe("bhop_eazy");
    expect(await first.locator(".home-rec-time").innerText()).toContain("Normal");
    expect(await first.locator(".home-rec-time b").textContent()).toBe("00:12.582");
    expect(await first.locator(".home-rec-whotext small").textContent()).toBe("3 min ago");
    expect(await first.locator(".home-tile-tier").getAttribute("class")).toContain("t1");
    expect(await first.locator(".home-rec-av").getAttribute("src")).toBe(defaultAvatarPath("holder-0", null));
    await first.locator(".home-rec-art img.full").waitFor();
    expect(await first.locator(".home-rec-art img.full").getAttribute("src")).toContain("native-cache.svg");
    expect(await page.locator(".home-rec").nth(1).locator(".card-initials").textContent()).toBe("BH");
    await page.locator(".home-rec").nth(2).locator(".home-rec-art img.full").waitFor();
    expect(await page.locator(".home-rec").nth(2).locator(".home-rec-art img.full").getAttribute("src")).toContain(
      "feed.svg",
    );
    expect(await first.locator(".home-rec-who").getAttribute("href")).toBe("/u/holder-0");
    await first.locator(".home-rec-who").click();
    await page.locator('body[data-screen="profile"] .profile').waitFor();
    expect(await page.locator(".screen-head h2").textContent()).toBe("Profile");
    await page.evaluate(() => window.bunnyhopNativeMenu.open?.("home"));
    await ready(page);
    await page.locator(".home-rec-run").first().click();
    await page.waitForFunction(() =>
      (window as unknown as FixtureWindow).messages.some((message) => message.type === "replayData"),
    );
    expect(
      await page.evaluate(() =>
        (window as unknown as FixtureWindow).messages.find((message) => message.type === "replayData"),
      ),
    ).toMatchObject({ type: "replayData", action: "play", name: "WR · Holder 0", replayBase64: "AQID" });
    expect(fixture.errors).toEqual([]);
  } finally {
    index.resolve();
    await fixture.close();
  }
}, 30_000);

test("home shares WR answers and in-flight requests for exactly 60 seconds", async () => {
  const answer = deferred<Answer>(),
    fixture = await open(() => answer.promise);
  const { page } = fixture;
  try {
    await fixture.requested;
    await page.locator(".home-recs[aria-busy=true]").waitFor();
    await redraw(page);
    expect(fixture.requests).toHaveLength(1);
    answer.resolve({ records: RECORDS });
    await ready(page);
    await page.evaluate(() => {
      (window as unknown as FixtureWindow).recordsNow += 59_999;
    });
    await redraw(page);
    await ready(page);
    expect(fixture.requests).toHaveLength(1);
    await page.evaluate(() => {
      (window as unknown as FixtureWindow).recordsNow += 1;
    });
    await redraw(page);
    await ready(page);
    expect(fixture.requests).toHaveLength(2);
  } finally {
    answer.resolve({ records: RECORDS });
    await fixture.close();
  }
}, 30_000);

test("short windows show 4 maps and 6/4/3 WRs; stacked windows show everything and scroll", async () => {
  const fixture = await open(),
    { page } = fixture;
  try {
    await ready(page);
    await page.locator(".home-grid .home-tile").first().waitFor();
    for (const [width, height, maps, records] of [
      [2560, 1440, 6, 6],
      [1920, 1080, 4, 6],
      [1600, 900, 4, 6],
      [1366, 768, 4, 4],
      [1280, 720, 4, 3],
      [1280, 861, 4, 6],
      [1280, 760, 4, 3],
      [1600, 1261, 6, 6],
      [900, 800, 6, 6],
      [420, 860, 6, 6],
    ]) {
      await page.setViewportSize({ width, height });
      expect(await visible(page, ".home-tile"), `${width}x${height} maps`).toBe(maps);
      expect(await visible(page, ".home-rec"), `${width}x${height} records`).toBe(records);
      if (width > 928) {
        const right = await page.locator(".home-right").boundingBox();
        expect(right!.y + right!.height, `${width}x${height} fit`).toBeLessThanOrEqual(height);
      }
    }
    await page.locator(".home-rec").last().scrollIntoViewIfNeeded();
    expect(await page.locator("#menu").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 30_000);

test("empty and failed records keep the shared home states, and errors can retry immediately", async () => {
  let mode: "empty" | "error" | "full" = "empty";
  const fixture = await open(async () => ({
    status: mode === "error" ? 503 : 200,
    records: mode === "full" ? RECORDS : [],
  }));
  const { page } = fixture;
  try {
    await page.getByText("No new world records lately", { exact: true }).waitFor();
    expect(await page.locator(".home-records").isVisible()).toBe(true);
    expect(await page.locator(".home-recs").getAttribute("aria-busy")).toBeNull();
    mode = "error";
    await page.evaluate(() => {
      (window as unknown as FixtureWindow).recordsNow += 60_000;
    });
    await redraw(page);
    await page.waitForFunction(() => document.querySelector<HTMLElement>(".home-records")?.hidden === true);
    expect(await visible(page, ".home-tile")).toBe(6);
    mode = "full";
    await redraw(page);
    await ready(page);
    expect(fixture.requests).toHaveLength(3);
    expect(await visible(page, ".home-tile")).toBe(4);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 30_000);
