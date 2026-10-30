import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright";
import { readFile } from "node:fs/promises";

type Message = {
  type: string;
  action?: string;
  id?: number;
  title?: string;
  tick?: number;
  value?: boolean;
  kind?: string;
  name?: string;
  options?: Record<string, unknown>;
  paused?: boolean;
  camera?: string;
  speed?: number;
};

// A 24 s run in a 43 s recording (the player report): idle at spawn before the timer starts. The host trims it to
// 1 s before the start and 1.5 s after the finish.
const TRIMMED = {
  active: true,
  id: "local-1",
  tick: 1250,
  totalTicks: 4300,
  tickInterval: 0.01,
  paused: true,
  speed: 1,
  camera: "eye",
  rangeStartTick: 1100,
  rangeEndTick: 3660,
  rangeTick: 150,
  rangeTotalTicks: 2560,
  elapsedSeconds: 1.5,
  fullRecording: false,
};
const FULL = {
  ...TRIMMED,
  rangeStartTick: 0,
  rangeEndTick: 4300,
  rangeTick: 1250,
  rangeTotalTicks: 4300,
  elapsedSeconds: 12.5,
  fullRecording: true,
};
const REPLAY = {
  id: "local-1",
  name: "Profile Hopper",
  map: "bhop_arcane",
  style: "autohop",
  track: 0,
  seconds: 24.1,
  recordedAt: Date.UTC(2026, 9, 27),
  bytes: 4096,
};

async function openViewer(page: Page): Promise<string[]> {
  const html = await readFile(new URL("../../../target/native-menu/menu.html", import.meta.url), "utf8");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    route.request().url() === "https://bunnyhop.lol/replay-viewer"
      ? route.fulfill({ contentType: "text/html", body: html })
      : route.abort(),
  );
  await page.addInitScript(() => {
    localStorage.setItem("bunnyhop:onboarded", "1");
    localStorage.setItem("bunnyhop:first-seen", String(Date.now()));
    Object.assign(window, { messages: [] });
    window.addEventListener("bunnyhop:native-message", (event) => {
      (window as unknown as { messages: unknown[] }).messages.push((event as CustomEvent).detail);
    });
  });
  await page.goto("https://bunnyhop.lol/replay-viewer");
  const videoExport = { available: true, state: "idle", musicTracks: [] };
  await host(page, { map: "bhop_arcane", playback: TRIMMED, videoExport, replays: [REPLAY] });
  await page.getByRole("button", { name: "Replays", exact: true }).click();
  await page.getByRole("dialog", { name: "Replay viewer" }).waitFor();
  return errors;
}

const host = (page: Page, value: Record<string, unknown>): Promise<void> =>
  page.evaluate((next) => window.bunnyhopNativeMenu.onState(next), value);
const sent = (page: Page, type: string): Promise<Message[]> =>
  page.evaluate(
    (wanted) => (window as unknown as { messages: Message[] }).messages.filter((message) => message.type === wanted),
    type,
  );
const lastSent = async (page: Page, type: string): Promise<Message | undefined> => (await sent(page, type)).at(-1);

async function withViewer(run: (page: Page, errors: string[]) => Promise<void>): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors = await openViewer(page);
    await run(page, errors);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}

test(
  "replay viewer: the web viewer's layout over native playback",
  () =>
    withViewer(async (page) => {
      // The run's title along the top, as on the web: who, the time, then the map and style.
      expect(await page.locator("#rv .rv-title").textContent()).toBe("Profile Hopper00:24.100");
      expect(await page.locator("#rv .rv-sub").textContent()).toContain("bhop_arcane · Normal");
      // The page under it is hidden (web viewer.css body.viewer-open).
      expect(await page.locator("#overlay").isHidden()).toBe(true);
      for (const name of ["Play / pause (Space)", "Export video", "Practice from here", "Close replay viewer"]) {
        const label =
          name === "Export video"
            ? "Render this replay to a video (E)"
            : name === "Practice from here"
              ? "Take over from this moment, in practice (P)"
              : name;
        expect(await page.getByRole("button", { name: label, exact: true }).isVisible()).toBe(true);
      }
      // The speed and camera the host reports are the lit segments.
      expect(await page.locator("#rv .rv-panel .rv-seg-btn.on").allTextContents()).toEqual(["1×", "In-eye"]);
      await page.getByRole("button", { name: "Free path: a drone following the run (4)" }).click();
      expect(await lastSent(page, "replayControl")).toEqual({
        type: "replayControl",
        action: "camera",
        camera: "flyby",
      });
      await page.getByRole("button", { name: "Playback speed 2× ([ / ])" }).click();
      expect(await lastSent(page, "replayControl")).toEqual({ type: "replayControl", action: "speed", speed: 2 });
      // Keys work as in the web viewer.
      await page.keyboard.press("Space");
      expect(await lastSent(page, "replayControl")).toEqual({ type: "replayControl", action: "pause", paused: false });
      await page.keyboard.press("Digit2");
      expect(await lastSent(page, "replayControl")).toEqual({
        type: "replayControl",
        action: "camera",
        camera: "chase",
      });
    }),
  20_000,
);

test(
  "replay viewer: the timeline covers the trimmed range and Full recording restores the whole run",
  () =>
    withViewer(async (page) => {
      const time = page.locator("#rv .rv-time");
      const timeline = page.getByRole("slider", { name: "Replay timeline" });
      expect(await time.textContent()).toBe("00:01.500 / 00:25.600");
      expect(await page.locator("#rv .rv-tick").textContent()).toBe("tick 1250");
      expect(await timeline.getAttribute("aria-valuemin")).toBe("1100");
      expect(await timeline.getAttribute("aria-valuemax")).toBe("3660");

      // Start, End and tick steps seek to absolute ticks inside the range.
      await page.getByRole("button", { name: "Start (Home)", exact: true }).click();
      expect(await lastSent(page, "replayControl")).toEqual({ type: "replayControl", action: "seek", tick: 1100 });
      await page.getByRole("button", { name: "End (End)", exact: true }).click();
      expect(await lastSent(page, "replayControl")).toEqual({ type: "replayControl", action: "seek", tick: 3660 });
      await host(page, { playback: { tick: 3660, rangeTick: 2560, elapsedSeconds: 25.6 } });
      await page.getByRole("button", { name: "Next tick (.)", exact: true }).click();
      expect(await lastSent(page, "replayControl")).toEqual({ type: "replayControl", action: "seek", tick: 3660 });

      // A click halfway along the bar seeks halfway through the range, and the clock counts from the range start.
      const box = (await page.locator("#rv .rv-tl-canvas").boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      const seek = (await lastSent(page, "replayControl"))!;
      expect(seek.action).toBe("seek");
      expect(Math.abs(seek.tick! - 2380)).toBeLessThanOrEqual(3);
      expect(await time.textContent()).toBe(
        `00:${((seek.tick! - 1100) / 100).toFixed(3).padStart(6, "0")} / 00:25.600`,
      );
      await host(page, {
        playback: { tick: seek.tick, rangeTick: seek.tick! - 1100, elapsedSeconds: (seek.tick! - 1100) / 100 },
      });

      const full = page.getByRole("button", { name: /^Show the whole recording/ });
      expect(await full.getAttribute("aria-pressed")).toBe("false");
      await full.click();
      expect(await lastSent(page, "replayControl")).toEqual({
        type: "replayControl",
        action: "fullRecording",
        value: true,
      });
      await host(page, { playback: FULL });
      expect(await full.getAttribute("aria-pressed")).toBe("true");
      expect(await time.textContent()).toBe("00:12.500 / 00:43.000");
      expect(await timeline.getAttribute("aria-valuemin")).toBe("0");
      expect(await timeline.getAttribute("aria-valuemax")).toBe("4300");
      await full.click();
      expect(await lastSent(page, "replayControl")).toEqual({
        type: "replayControl",
        action: "fullRecording",
        value: false,
      });
    }),
  20_000,
);

test(
  "replay viewer: Practice from here sends the shown tick and shows why the host refused",
  () =>
    withViewer(async (page) => {
      const practice = page.getByRole("button", { name: "Take over from this moment, in practice (P)", exact: true });
      const note = page.locator("#rv .rv-notice");

      // While playing, the host continues from the tick it is showing.
      await practice.click();
      expect(await lastSent(page, "practiceFromReplay")).toEqual({ type: "practiceFromReplay" });
      const refused = "Replay style or map zones do not match current practice.";
      await host(page, { error: refused });
      expect(await note.textContent()).toBe(refused);

      // After a seek, before the host has caught up, the tick being shown goes with it.
      await page.getByRole("button", { name: "End (End)", exact: true }).click();
      await practice.click();
      expect(await lastSent(page, "practiceFromReplay")).toEqual({ type: "practiceFromReplay", tick: 3660 });

      // An error left over from before the request is not taken for the answer.
      await host(page, { playback: { tick: 3660 } });
      expect(await note.isHidden()).toBe(true);
      const gauntlet = "No practice during a gauntlet.";
      await host(page, { error: gauntlet });
      expect(await note.textContent()).toBe(gauntlet);

      // Accepted: the host leaves the replay, the viewer closes and the vault is the Replays screen again.
      await practice.click();
      await host(page, { error: "", playback: { active: false, id: "" } });
      expect(await page.locator("#rv").count()).toBe(0);
      expect(await page.locator(".native-replays").isVisible()).toBe(true);
    }),
  20_000,
);

test(
  "replay viewer: the host's answer to Practice from here is the reason shown",
  () =>
    withViewer(async (page) => {
      const practice = page.getByRole("button", { name: "Take over from this moment, in practice (P)", exact: true });
      const note = page.locator("#rv .rv-notice");
      const answer = (value: Record<string, unknown>) =>
        page.evaluate((result) => window.bunnyhopNativeMenu.onPracticeFromReplayResult?.(result), {
          type: "practiceFromReplayResult",
          ...value,
        });

      await practice.click();
      const wrongMap = "That replay is bhop_arcane. Switch to it first.";
      await answer({ ok: false, reason: wrongMap });
      expect(await note.textContent()).toBe(wrongMap);
      // Once the host answers, an unrelated error line isn't taken for the answer.
      await practice.click();
      await host(page, { error: "Map download failed." });
      await host(page, { playback: { tick: 1300 } });
      expect(await note.isHidden()).toBe(true);
      await answer({
        ok: false,
        reason: "That replay is from an older version of the game, so it can only be watched.",
      });
      expect(await note.textContent()).toContain("older version");
      // Accepted: no reason, and the host leaves the replay.
      await practice.click();
      await answer({ ok: true, reason: null });
      expect(await note.isHidden()).toBe(true);
      await host(page, { error: "", playback: { active: false, id: "" } });
      expect(await page.locator("#rv").count()).toBe(0);
    }),
  20_000,
);

test(
  "replay viewer: run times are the host's whole milliseconds",
  () =>
    withViewer(async (page) => {
      // seconds a hair under the score (a float tick clock) still shows the server's time.
      await host(page, { replays: [{ ...REPLAY, seconds: 24.0999, timeMs: 24100 }], playback: { timeMs: 24100 } });
      expect(await page.locator("#rv .rv-time-big").textContent()).toBe("00:24.100");
      await host(page, { replays: [{ ...REPLAY, seconds: 24.0999, timeMs: 24101 }] });
      expect(await page.locator("#rv .rv-time-big").textContent()).toBe("00:24.101");
    }),
  20_000,
);

test(
  "replay video export: presets, codecs and the clip, queued while the game keeps running",
  () =>
    withViewer(async (page) => {
      await host(page, {
        videoExport: {
          available: true,
          state: "idle",
          codecs: [
            { id: "h264", label: "H.264", software: "libx264", hardware: "h264_videotoolbox" },
            { id: "hevc", label: "HEVC", software: "libx265", hardware: "" },
            { id: "av1", label: "AV1", software: "", hardware: "" },
            { id: "prores", label: "ProRes", software: "prores_ks", hardware: "" },
          ],
        },
      });
      await page.getByRole("button", { name: "Render this replay to a video (E)" }).click();
      const card = page.getByRole("dialog", { name: "Export video" });
      expect(await card.isVisible()).toBe(true);
      const save = card.getByRole("button", { name: "Export", exact: true });
      const clipStart = card.getByLabel("Video clip start seconds", { exact: true });
      const clipEnd = card.getByLabel("Video clip end seconds", { exact: true });
      expect(await clipStart.inputValue()).toBe("0");
      expect(await clipEnd.inputValue()).toBe("25.6");
      expect(await card.locator(".rv-ex-info").textContent()).toContain("h264_videotoolbox (hardware)");

      // Untouched: the website's Standard export, no from / to, so the host exports 1 s before the start to 1.5 s
      // after the finish.
      await save.click();
      const standard = await lastSent(page, "videoExport");
      expect(standard).toMatchObject({ action: "start", title: "Profile Hopper · bhop_arcane" });
      expect(standard?.options).toMatchObject({
        width: 1920,
        height: 1080,
        fps: 60,
        quality: "high",
        camera: "chase",
        codec: "h264",
        encoder: "auto",
        samples: 1,
        shutter: 0,
        supersample: 1,
        speed: true,
        keys: true,
        fullRecording: false,
      });
      expect(standard?.options && "from" in standard.options).toBe(false);

      // Segments pick the size, camera, codec and motion blur; an encoder FFmpeg lacks can't be picked.
      await card.getByRole("radio", { name: "Portrait 9:16" }).click();
      await card.getByRole("radio", { name: "8K" }).click();
      await card.getByRole("radio", { name: "Free path (flyby)" }).click();
      await card.getByRole("radio", { name: "HEVC" }).click();
      await card.getByRole("radio", { name: "Strong" }).click();
      expect(await card.getByRole("radio", { name: "AV1" }).isDisabled()).toBe(true);
      await card.getByLabel("Export full recording", { exact: true }).check();
      await save.click();
      expect((await lastSent(page, "videoExport"))?.options).toMatchObject({
        width: 4320,
        height: 7680,
        camera: "flyby",
        codec: "hevc",
        samples: 8,
        shutter: 180,
        fullRecording: true,
      });

      // Presets: Shorts is a portrait in-eye clip; Editing a clean ProRes intermediate with the sound as a WAV.
      await card.getByRole("button", { name: "Shorts", exact: true }).click();
      await save.click();
      expect((await lastSent(page, "videoExport"))?.options).toMatchObject({
        width: 1080,
        height: 1920,
        camera: "eye",
        keys: false,
      });
      await card.getByRole("button", { name: "Editing", exact: true }).click();
      await save.click();
      expect((await lastSent(page, "videoExport"))?.options).toMatchObject({
        quality: "edit",
        codec: "prores",
        hud: false,
        speed: false,
        audioFile: true,
      });

      // A clip is times on the timeline, sent as absolute ticks; a backwards clip isn't sent.
      await card.getByLabel("Export full recording", { exact: true }).uncheck();
      await clipStart.fill("2");
      await clipEnd.fill("10");
      await save.click();
      expect((await lastSent(page, "videoExport"))?.options).toMatchObject({
        fullRecording: false,
        from: 1300,
        to: 2100,
      });
      const exports = (await sent(page, "videoExport")).length;
      await clipEnd.fill("30");
      expect(await save.isDisabled()).toBe(true);
      expect((await sent(page, "videoExport")).length).toBe(exports);

      // A different range (Full recording in the viewer) fills the clip in again.
      await host(page, { playback: FULL });
      expect(await clipEnd.inputValue()).toBe("43");

      // Running exports show in the queue with their progress; more can be queued, and each can be canceled.
      await host(page, {
        videoExport: {
          available: true,
          state: "capturing",
          queue: [
            {
              id: 4,
              title: "Profile Hopper · bhop_arcane",
              state: "rendering",
              frame: 10,
              frames: 100,
              eta: 12,
              fps: 30,
            },
          ],
        },
      });
      expect(await card.getByRole("status").first().textContent()).toBe("Frame 10 / 100 · 10% · 0:12 left · 30 fps");
      expect(await card.getByRole("button", { name: "Add to queue", exact: true }).isEnabled()).toBe(true);
      await card.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await lastSent(page, "videoExport")).toEqual({ type: "videoExport", action: "cancel", id: 4 });
      await page.keyboard.press("Escape");
      expect(await card.isHidden()).toBe(true);
    }),
  20_000,
);

test(
  "replay viewer: Compare once the host draws it, Share and Report for a server run",
  () =>
    withViewer(async (page) => {
      const compare = page.getByRole("button", { name: "Overlay a second replay as a ghost (C)" });
      // A host without the feature: no Compare button, and no Share or Report for a local replay.
      expect(await compare.isHidden()).toBe(true);
      expect(await page.locator("#rv").getByRole("button", { name: "Share", exact: true }).isHidden()).toBe(true);

      await host(page, {
        playback: { features: ["compare"], player: { name: "oiwa", runId: "run-123", id: "player-oiwa" } },
      });
      expect(await compare.isVisible()).toBe(true);
      expect(await page.locator("#rv .rv-title b").textContent()).toBe("oiwa");
      expect(await page.locator("#rv").getByRole("button", { name: "Share", exact: true }).isVisible()).toBe(true);

      // A .bhr from disk goes to the host as the compare ghost.
      await compare.click();
      expect(await page.getByRole("menuitem").allTextContents()).toEqual([
        "Your PBMain · Normal",
        "World recordTop of the leaderboard",
        "Replay file….bhr from disk",
      ]);
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("menuitem", { name: /^Replay file/ }).click();
      await (
        await chooser
      ).setFiles({ name: "rival.bhr", mimeType: "application/octet-stream", buffer: Buffer.from([1, 2, 3, 4]) });
      await page.waitForFunction(() =>
        (window as unknown as { messages: Message[] }).messages.some((message) => message.type === "replayCompare"),
      );
      expect(await lastSent(page, "replayCompare")).toMatchObject({ action: "set", kind: "custom", name: "rival" });

      await host(page, { playback: { compare: { kind: "custom", name: "rival", endTick: 3000 } } });
      expect(await compare.textContent()).toBe("vs rival");
      await compare.click();
      await page.getByRole("menuitem", { name: /^Remove ghost/ }).click();
      expect(await lastSent(page, "replayCompare")).toEqual({ type: "replayCompare", action: "clear" });

      // ✕ ends the replay.
      await page.getByRole("button", { name: "Close replay viewer" }).click();
      expect(await lastSent(page, "replayControl")).toEqual({ type: "replayControl", action: "stop" });
    }),
  20_000,
);
