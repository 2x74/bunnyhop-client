import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright";
import { readFile } from "node:fs/promises";

type Message = { type: string; action?: string; tick?: number; value?: boolean; options?: Record<string, unknown> };

// A 24 s run in a 43 s recording (the player report): idle at spawn before the timer starts. The host trims it to
// 1 s before the start and 1.5 s after the finish.
const TRIMMED = {
  active: true, id: "local-1", tick: 1250, totalTicks: 4300, tickInterval: .01, paused: true, speed: 1, camera: "eye",
  rangeStartTick: 1100, rangeEndTick: 3660, rangeTick: 150, rangeTotalTicks: 2560, elapsedSeconds: 1.5,
  fullRecording: false,
};
const FULL = { ...TRIMMED, rangeStartTick: 0, rangeEndTick: 4300, rangeTick: 1250, rangeTotalTicks: 4300,
  elapsedSeconds: 12.5, fullRecording: true };

async function openReplays(page: Page): Promise<string[]> {
  const html = await readFile(new URL("../../../target/native-menu/menu.html", import.meta.url), "utf8");
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.request().url() === "https://bunnyhop.lol/replay-viewer"
    ? route.fulfill({ contentType: "text/html", body: html }) : route.abort());
  await page.addInitScript(() => {
    localStorage.setItem("bunnyhop:onboarded", "1");
    localStorage.setItem("bunnyhop:first-seen", String(Date.now()));
    Object.assign(window, { messages: [] });
    window.addEventListener("bunnyhop:native-message", event => {
      (window as unknown as { messages: unknown[] }).messages.push((event as CustomEvent).detail);
    });
  });
  await page.goto("https://bunnyhop.lol/replay-viewer");
  const videoExport = { available: true, state: "idle", musicTracks: [] };
  await host(page, { map: "bhop_arcane", playback: TRIMMED, videoExport });
  await page.getByRole("button", { name: "Replays", exact: true }).click();
  return errors;
}

const host = (page: Page, value: Record<string, unknown>): Promise<void> =>
  page.evaluate(next => window.bunnyhopNativeMenu.onState(next), value);
const sent = (page: Page, type: string): Promise<Message[]> => page.evaluate(wanted =>
  (window as unknown as { messages: Message[] }).messages.filter(message => message.type === wanted), type);
const lastSent = async (page: Page, type: string): Promise<Message | undefined> => (await sent(page, type)).at(-1);

test("replay viewer: the timeline covers the trimmed range and Full recording restores the whole run", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors = await openReplays(page);
    const position = page.locator(".native-playback-position");
    const timeline = page.getByLabel("Replay tick", { exact: true });
    expect(await position.textContent()).toBe("00:01.500 / 00:25.600 · tick 1250");
    expect(await timeline.getAttribute("min")).toBe("1100");
    expect(await timeline.getAttribute("max")).toBe("3660");

    // Start, End and frame steps seek to absolute ticks inside the range.
    await page.getByRole("button", { name: "Start", exact: true }).click();
    expect(await lastSent(page, "replayControl")).toEqual({ type: "replayControl", action: "seek", tick: 1100 });
    await page.getByRole("button", { name: "End", exact: true }).click();
    expect(await lastSent(page, "replayControl")).toEqual({ type: "replayControl", action: "seek", tick: 3660 });
    await host(page, { playback: { tick: 3660, rangeTick: 2560, elapsedSeconds: 25.6 } });
    await page.getByRole("button", { name: "Next replay frame", exact: true }).click();
    expect(await lastSent(page, "replayControl")).toEqual({ type: "replayControl", action: "seek", tick: 3660 });

    // Dragging shows time from the range start.
    await timeline.fill("2100");
    expect(await position.textContent()).toBe("00:10.000 / 00:25.600 · tick 2100");
    await timeline.dispatchEvent("change");
    expect(await lastSent(page, "replayControl")).toEqual({ type: "replayControl", action: "seek", tick: 2100 });
    await host(page, { playback: { tick: 2100, rangeTick: 1000, elapsedSeconds: 10 } });

    const full = page.getByLabel("Full recording", { exact: true });
    expect(await full.isChecked()).toBe(false);
    await full.check();
    const showFull = { type: "replayControl", action: "fullRecording", value: true };
    expect(await lastSent(page, "replayControl")).toEqual(showFull);
    await host(page, { playback: FULL });
    await full.blur();
    await host(page, { playback: FULL });
    expect(await full.isChecked()).toBe(true);
    expect(await position.textContent()).toBe("00:12.500 / 00:43.000 · tick 1250");
    expect(await timeline.getAttribute("min")).toBe("0");
    expect(await timeline.getAttribute("max")).toBe("4300");
    await full.uncheck();
    expect(await lastSent(page, "replayControl")).toEqual({ ...showFull, value: false });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 20_000);

test("replay viewer: Practice from here sends the shown tick and shows why the host refused", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors = await openReplays(page);
    const practice = page.getByRole("button", { name: "Practice from here", exact: true });
    const note = page.locator(".native-playback [role=status]");

    // While playing, the host continues from the tick it is showing.
    await practice.click();
    expect(await lastSent(page, "practiceFromReplay")).toEqual({ type: "practiceFromReplay" });
    const refused = "Replay style or map zones do not match current practice.";
    await host(page, { error: refused });
    expect(await note.textContent()).toBe(refused);

    // After a seek, before the host has caught up, the tick being shown goes with it.
    await page.getByLabel("Replay tick", { exact: true }).fill("2000");
    await page.getByLabel("Replay tick", { exact: true }).dispatchEvent("change");
    await practice.click();
    expect(await note.textContent()).toBe("");
    expect(await lastSent(page, "practiceFromReplay")).toEqual({ type: "practiceFromReplay", tick: 2000 });

    // An error left over from before the request is not taken for the answer.
    await host(page, { playback: { tick: 2000 } });
    expect(await note.textContent()).toBe("");
    const gauntlet = "No practice during a gauntlet.";
    await host(page, { error: gauntlet });
    expect(await note.textContent()).toBe(gauntlet);

    // Accepted: the host leaves the replay and the controls go away.
    await practice.click();
    await host(page, { error: "", playback: { active: false, id: "" } });
    expect(await page.locator(".native-playback").isHidden()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 20_000);

test("replay video export: the default range unless Full recording or a clip is chosen", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors = await openReplays(page);
    const save = page.getByRole("button", { name: "Save MP4 to Downloads", exact: true });
    const clipStart = page.getByLabel("Video clip start seconds", { exact: true });
    const clipEnd = page.getByLabel("Video clip end seconds", { exact: true });
    expect(await clipStart.inputValue()).toBe("0");
    expect(await clipEnd.inputValue()).toBe("25.6");

    // Untouched: no from / to, so the host exports 1 s before the start to 1.5 s after the finish.
    await save.click();
    const trimmed = (await lastSent(page, "videoExport"))?.options;
    expect(trimmed?.fullRecording).toBe(false);
    expect(trimmed && "from" in trimmed).toBe(false);
    expect(trimmed && "to" in trimmed).toBe(false);

    await page.getByLabel("Export full recording", { exact: true }).check();
    await save.click();
    const whole = (await lastSent(page, "videoExport"))?.options;
    expect(whole?.fullRecording).toBe(true);
    expect(whole && "from" in whole).toBe(false);

    // A clip is times on the timeline, sent as absolute ticks.
    await page.getByLabel("Export full recording", { exact: true }).uncheck();
    await clipStart.fill("2");
    await clipEnd.fill("10");
    await save.click();
    const clip = { fullRecording: false, from: 1300, to: 2100 };
    expect((await lastSent(page, "videoExport"))?.options).toMatchObject(clip);
    const exports = (await sent(page, "videoExport")).length;
    await clipEnd.fill("30");
    await save.click();
    expect((await sent(page, "videoExport")).length).toBe(exports);

    // A different range (Full recording in the viewer) fills the clip in again.
    await host(page, { playback: FULL });
    expect(await clipEnd.inputValue()).toBe("43");
    await save.click();
    expect((await lastSent(page, "videoExport"))?.options).not.toHaveProperty("to");
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 20_000);
