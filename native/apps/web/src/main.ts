// The Wavedash build's fetch / socket / image / page-load patches, before any other module runs (platform/boot.ts).
import { appLocation } from "./platform/navigation";
import "./platform/boot";
import { myProfile } from "./ui/account-state";
import { PlayerShadowProxy } from "./graphics/player-shadow";
import "./texture-packs/settings";
import "./sky-packs/settings";
import { GraphicsPipeline } from "./graphics/pipeline";
import { warmPrograms } from "./graphics/warm-programs";
// First: the feedback form's client error log (ring buffer of uncaught errors / rejections / console.error).
import { openFeedback, setGameInfo } from "./feedback/state";
import * as THREE from "three";
import { clientPresence, nativeClient, watchClientSettings, type ClientRoom } from "./client-bridge";
import { FrameBenchmark } from "./benchmark";
import { roomActions, roomUrl } from "./net/presence";
import { mapImages } from "./ui/thumbs";
import wasmUrl from "./wasm/bunnyhop_core.wasm?url";
import { Attract } from "./attract";
import { Arrival } from "./arrival";
import { backdropLive, backdropRendered } from "./ui/backdrop";
import { takeLocalPop } from "./ui/nav";
import { stopMenuWork } from "./ui/menu-work";
import { attackReport, restartPoint, Core, DEFAULT_SETTINGS, EVENT_ANGLES_CHANGED, EVENT_ATTACK, EVENT_JUMPED, EVENT_TELEPORTED, weaponReport, type PlayerState, type RestartPoint } from "./core";
import { hasRawUpdate, Input, isTextField, type UserCmd } from "./input";
import { ExperimentWeapons, LiveInputCapture, InputExperimentCapture, experimentRejection, localInputExperimentAllowed, pumpInputExperiment } from "./input-experiment";
import type { SampledInput, SamplerSource } from "./input-sampler";
import { InputDebug, summary as inputSummary } from "./input-debug";
import { initPlayLock, resumePlay, setPlayAttempt, showStartPrompt } from "./play-lock";
import { buildWorld, type WorldView } from "./render";
import { debugHookOptIn, RunSession } from "./session";
import { fetchMapIndex, goToMainMenu, initMenu, revealGame, showError, showHome, showLoading, showReady } from "./menu";
import { gameView, keyLabel, prefs, verticalFov } from "./ui/settings";
import { applyPalette } from "./palette";
import { setUiHidden, uiHidden } from "./ui/hide-ui";
import { isStyleId, styleSettings, type StyleId } from "./styles";
import { turnBindsAllowed } from "./turn-binds";
import { nullBindsAllowed } from "./null-binds";
import { resolveGauntlet, startGauntletMode } from "./gauntlet/mode";
import { readQueue, settleQueue } from "./map-queue";
import { startQueueMode } from "./queue-mode";
import { GAUNTLET_STYLE } from "./gauntlet/state";
import { selectedStyle, setSelectedStyle } from "./ui/style-picker";
import { afterPaint, fmtBytes } from "./ui/dom";
import { countJump, hasFinishedAMap, recordMapPlayed } from "./ui/stats";
import { api, ApiError } from "./api";
import { goToLobby, lobbyIdFromParam } from "./net/lobby";
import { decodeReplay, INSPECT_HOLD, INSPECT_RELEASE, YAW_SET_PUSHER, YAW_SET_SPAWN, YAW_SET_TELEPORT } from "./replay";
import { ReplayViewer } from "./viewer/viewer";
import { watchFromUrl } from "./gauntlet/watch";
import { preloadedViewerRequest, onViewerRequest, openReplayViewer, takePending, viewerTargetFromUrl, type ViewerRequest } from "./viewer/request";
import { ThirdPerson } from "./viewer/thirdperson";
import { Viewmodel } from "./viewmodel/viewmodel";
import { WeaponPresenter } from "./viewmodel/weapons";
import { GunPresenter } from "./viewmodel/guns/presenter";
import { HitEffects } from "./effects";
import { scheduleImpactSurfaces } from "./audio/impacts";
import { isWeaponAction } from "./binds";
import "./viewmodel/settings"; // Settings -> Viewmodel
import "./ui/account-settings"; // Settings -> Account (name, sign-in, replay the intro)
import { initCustomCss } from "./custom-css";
import "./custom-css/section"; // Settings -> Custom CSS
import { initAudio, PlayerAudio, runSounds, setListenerFromCamera } from "./audio";
import { AutoRestart } from "./auto-restart";
import { buildSurfaces } from "./audio/surfaces";
import { registerAudioSettings } from "./audio/settings-section";
import { TUTORIAL_MAP } from "./tutorial/data";
import { fetchBytes, withTimeout } from "./content/fetch";
import { bspUrl, indexSha } from "./content/map-url";
import { contentLoading, loadErrorActions } from "./content/load-screen";
import { RestartGuard, type GuardedAction } from "./restart-guard";
import { CONFIRM_MS, LeaveHold } from "./leave-confirm";
import { SoloChat } from "./solo-chat";
import { chatGame } from "./chat-game";
import { initChunkRecovery, initUpdateCheck, setUpdateBusy } from "./update";
import { WAVEDASH } from "./platform/env";
import { initPlatform } from "./platform/hooks";
import { initMouseProfileSync } from "./mouse-profile";
import { initPresence } from "./presence";
import { initSocial, setPlaying as setSocialPlaying, setWatching as setSocialWatching } from "./social/state";
import { initDock } from "./social/dock";
import { registerSocialCommands } from "./social/commands";
import { setSharedRenderer } from "./shared-gl";
import { Practice } from "./practice-mode/controller";
import { practiceMenuView } from "./practice-mode/menu-view";
import { practiceUnavailable, thirdPersonBlocked } from "./practice-mode/rules";
import { giveWeapon, initWeaponCommands, openGunPicker, registerWeaponChatCommands, weaponsAfterRestart, weaponsAfterTick, weaponsBeforeTick } from "./weapon-commands";
import { startPlaytime } from "./playtime";
import { mapTime } from "./map-time";
import { deviceIdSettled } from "./device";
import { setCosmeticsStill } from "./viewmodel/finishes/shader";
import { PotatoHint } from "./potato-hint";
import { CanvasVideoGrade } from "./video-grade";
import { initTriggerOverlay, triggerOverlayFrame } from "./triggers";
import { FrameLoop, GpuFence } from "./frame-loop";
import { autoTuneGraphics } from "./gfx-auto";
import { toast, whisper } from "./notify";
import { clearPaint, initPaint, paintFrame, paintVisible, registerPaint, requestPaint } from "./paint";
import { registerMovementStats } from "./movement-stats";
import { openLastJump } from "./movement-stats/share";
import { clearMeasure, initMeasure, measureFrame, measureVisible, registerMeasure, requestMeasure } from "./measure";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const canvasVideoGrade = new CanvasVideoGrade();
// Sounds + music: preloads now, starts on the first click / key press (autoplay rules). Never touches the sim.
// The player's own stylesheet (custom-css/): first, so the menus come up styled.
initCustomCss();
initAudio();
registerAudioSettings();
registerPaint();
registerMovementStats();
registerMeasure();
// Before anything loads lazily: a tab older than the deploy reloads (or says so) instead of failing on a missing chunk.
initChunkRecovery();
const params = appLocation().searchParams;

// A software renderer (no GPU) seen for the first time: Lowest graphics before the context is made (gfx-auto.ts).
const gfxAuto = autoTuneGraphics();
// Antialiasing (Settings → Graphics) applies from the next page load: a context can't change it. So does the low-latency
// canvas: a desynchronized context, so frames past the refresh rate reach the screen (frame-loop.ts). Its context is made here (three.js has no option for it) with three's own attributes, alpha
// off as three renders it anyway.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: prefs.get().graphics.antialias, powerPreference: "high-performance", context: lowLatencyContext() });
const graphicsPipeline = new GraphicsPipeline(renderer);
function lowLatencyContext(): WebGL2RenderingContext | undefined {
  if (!prefs.get().graphics.lowLatency) return undefined;
  const attrs = { alpha: false, depth: true, stencil: false, antialias: prefs.get().graphics.antialias, premultipliedAlpha: true, preserveDrawingBuffer: true, powerPreference: "high-performance", desynchronized: true } as WebGLContextAttributes;
  return canvas.getContext("webgl2", attrs) ?? undefined;
}
const gpuFence = new GpuFence(renderer.getContext());
// Unlock cards draw their little 3D models with it (notify/item3d.ts): no second context.
setSharedRenderer(renderer);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb3d9);
// Every render of the world (game, replay viewer, export) culls it for that render's camera first (cull.ts).
scene.onBeforeRender = (_r, _s, cam) => world?.cull(cam);
const camera = new THREE.PerspectiveCamera(verticalFov(90), 1, 2, 60000);
camera.rotation.order = "YXZ";
const maxAniso = renderer.capabilities.getMaxAnisotropy();

function resize() {
  // Source is Hor+: vertical FOV stays fixed (fov_desired is horizontal at 4:3). A fixed aspect ratio (Settings →
  // Graphics) draws at that ratio, stretched over the window or between black bars (style.css body.game-bars).
  const p = prefs.get();
  const v = gameView(p.graphics, innerWidth, innerHeight);
  renderer.setPixelRatio(1);
  renderer.setSize(v.bufW, v.bufH, false);
  canvas.style.setProperty("--game-w", `${v.cssW}px`);
  canvas.style.setProperty("--game-h", `${v.cssH}px`);
  document.body.classList.toggle("game-bars", v.cssW < innerWidth - 0.5 || v.cssH < innerHeight - 0.5);
  document.body.classList.toggle("game-pixelated", p.graphics.pixelated);
  graphicsPipeline.setSize(v.bufW, v.bufH);
  camera.aspect = v.aspect;
  camera.fov = verticalFov(p.fov);
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);

function applyAnisotropy(root: THREE.Object3D, n: number) {
  const v = Math.max(1, Math.min(n, maxAniso));
  root.traverse((o) => {
    const mats = (o as THREE.Mesh).material;
    if (!mats) return;
    for (const m of Array.isArray(mats) ? mats : [mats]) {
      const t = (m as THREE.MeshBasicMaterial).map;
      if (t && t.anisotropy !== v) {
        t.anisotropy = v;
        t.needsUpdate = true;
      }
    }
  });
}

const input = new Input(canvas);
// Input diagnostics overlay (Settings → Mouse & view → Show input stats, or ?inputdebug=1 for this page load).
const inputDebug = new InputDebug(input);
const inputDebugParam = params.get("inputdebug") === "1";
if (import.meta.env.DEV || inputDebugParam) Object.assign(window, { __inputStats: () => inputSummary(input) });
let inputExperiment = false;
let experimentFailure = false;
// Per-report delivery where the browser has it (strafes.io's order): pointerrawupdate, else pointermove + coalesced.
let experimentSource: SamplerSource = hasRawUpdate() ? "pointerrawupdate" : "pointermove";
/** The sampler's holdback: what timed input has learned this session (timed-input.ts), at least 2 ms. */
const experimentHoldback = () => Math.min(20, Math.max(2, Math.ceil(input.timedStats.holdbackMs * 2) / 2));
let experimentBadge: HTMLElement | null = null;
const experimentCapture = new InputExperimentCapture();
const liveCapture = new LiveInputCapture();
const experimentWeapons = new ExperimentWeapons(input);
input.onSamplerDelivery = (d) => experimentCapture.record("delivery", d);
input.onSamplerReset = (r) => experimentCapture.record("reset", r);
let run: RunSession | null = null;
let world: WorldView | null = null;

// Client preferences, applied live (none of these touch the simulation).
prefs.watch((p) => {
  canvasVideoGrade.set(p.graphics);
  input.settings.sensitivity = p.sensitivity;
  input.settings.verticalSensitivityEnabled = p.verticalSensitivityEnabled;
  input.settings.verticalSensitivity = p.verticalSensitivity;
  input.settings.m_pitch = p.invertY ? -0.022 : 0.022;
  input.rawInput = p.rawInput;
  input.rawUpdates = p.graphics.uncapped; // from the next lock (frame-loop.ts)
  input.filter.enabled = p.spikeFilter;
  input.timed = p.timedInput;
  run?.turnSpeedChanged(); // turn binds: now when never submitted, else from the next restart (session.ts)
  inputDebug.setEnabled(p.inputStats || inputDebugParam);
  input.setBinds(p.binds);
  graphicsPipeline.setOptions(p.graphics);
  resize();
  if (applyPalette(p.colorBlind)) run?.view.recolor(); // colour-blind palette (palette.ts): CSS variables, then the zones
  setCosmeticsStill(p.graphics.potato); // animated finishes and hats hold still in Potato mode
  document.body.classList.toggle("potato", p.graphics.potato); // and the HUD drops its blurs (hud.css)
  if (world) {
    world.setPotato(p.graphics.potato);
    world.setFlashlight(p.graphics.flashlight);
    world.setFullbright(p.graphics.fullbright);
    applyAnisotropy(world.root, p.graphics.anisotropy);
  }
});

let viewer: ReplayViewer | null = null;
// Pointer lock + fullscreen / keyboard lock + Esc pause / resume + the Ctrl+W leave guard (play-lock.ts).
initPlayLock(input);
initMenu({
  resume: () => void resumePlay(),
  restart: () => run && !viewer?.active && restart(),
  watching: () => !!viewer?.active,
  locked: () => input.locked,
});
// A newer deploy while this tab is open: a quiet "new version ready · Reload" in menus, never mid-run (update.ts). Not in
// the Wavedash build: it is updated by publishing a new build there, which a reload of this one never reaches.
if (!WAVEDASH) initUpdateCheck();
// Settings kept with the account; the Wavedash build's SDK, stats and outside links (platform/hooks.ts).
initPlatform();
if (gfxAuto.software)
  toast(gfxAuto.tuned ? "Your browser isn't using your graphics card, so graphics are on Lowest. Turn on hardware acceleration for much higher FPS." : "Your browser isn't using your graphics card. Turn on hardware acceleration for much higher FPS.", {
    key: "software-gl",
    ms: 16_000,
    action: { label: "How", run: () => toast("In your browser's settings, search for “hardware acceleration”, turn it on, then restart the browser.", { key: "software-gl-how", ms: 14_000 }) },
  });
initMouseProfileSync();
void myProfile(); // Hydrate account-owned cosmetics even when a map or replay opens directly.
initPresence(); // the Discord server's Online count (anonymous, every 10 min)
// Friends (social/): the live list and socket, the dock bottom right of the menus, and the chat commands.
initSocial();
initDock();
registerSocialCommands();
// This browser's device id in all its stores (cookie, localStorage, IndexedDB; device.ts), before the first API call.
void deviceIdSettled();
// Map picked from the main menu is a pushState; going Back returns to the menu. (Unless the menu went Back itself from
// a profile it opened: then the screen under it is still there, ui/nav.ts claimNextPop.)
addEventListener("popstate", () => takeLocalPop() || location.reload());

// Downloads time out and retry (content/fetch.ts): a stalled request shows an error with Retry instead of loading forever.
const wasmBytesP = fetchBytes(wasmUrl) as Promise<Uint8Array<ArrayBuffer>>;
wasmBytesP.catch(() => {}); // reported by the map load that awaits it

/**
 * Downloads a BSP with progress against the map index's (uncompressed) size: the edge compresses map downloads, so
 * Content-Length is missing or the compressed size (research/COMPRESSION.md). Timeouts and retries (`onRetry`: attempt
 * about to start, why the last one failed).
 */
async function downloadMap(name: string, onProgress: (got: number, total: number | null) => void, onRetry?: (attempt: number, why: string) => void, buildSha: string | null = null): Promise<Uint8Array> {
  // The index is usually loaded already (menu, map browser); a direct ?map= link fetches it alongside the BSP.
  let indexSize: number | null = null;
  const entry = fetchMapIndex().then((maps) => {
    const map = maps.find((m) => m.name === name);
    indexSize = map?.size ?? null;
    return map;
  }, () => undefined);
  // The index (usually loaded already) names the file's sha: download it by hash (/api/bsp/<sha>.bsp: no lookups on the
  // server, cached for good, resumable). Without it within 1.5 s, by name as before.
  const identity = await withTimeout(entry, 1500, undefined);
  // `buildSha`: a particular build of the map (a gauntlet's split replays on the build it was run on).
  const sha = buildSha ?? indexSha(identity);
  if (buildSha && identity?.sha256 !== buildSha) indexSize = null;
  try {
    return await fetchBytes(bspUrl(name, sha), {
      cacheSha256: nativeClient() ? sha ?? undefined : undefined,
      attempts: 4,
      // A connection that stops sending is dropped after 8 s and the download continues where it stopped.
      resume: !!sha,
      sha256: sha ?? undefined,
      idleTimeoutMs: 8_000,
      accept: (r) => ((r.headers.get("content-type") ?? "").includes("text/html") ? "HTTP 404" : null),
      expectedSize: () => indexSize,
      onProgress,
      onRetry: (attempt, e) => onRetry?.(attempt, e.message),
    });
  } catch (e) {
    const why = (e as Error)?.message ?? String(e);
    // The error screen says it in words (mapLoadError); the raw cause goes under it.
    throw Object.assign(new Error(/^HTTP 404/.test(why) ? `404 ${name}.bsp` : why), { download: /^HTTP 404/.test(why) ? "missing" : "network" });
  }
}

// Replay viewer URLs (/replay/<runId>, ?replay=run:<id> | pb | pending | <url>; viewer/request.ts): the replay's
// header names the map to load; the viewer opens once the map is ready.
let viewerStart: ViewerRequest | null = null;
let replayMap: string | null = null;
const urlViewer = viewerTargetFromUrl();
if (urlViewer) {
  const tg = urlViewer.target;
  try {
    let bytes: Uint8Array | null = null;
    let name = "";
    if (tg === "pending") bytes = takePending();
    else if ("url" in tg) {
      const r = await fetch(tg.url);
      if (r.ok) bytes = new Uint8Array(await r.arrayBuffer());
    } else if ("runId" in tg) {
      bytes = await api.replay(tg.runId);
      name = tg.name ?? "";
    }
    if (bytes) {
      replayMap = (await decodeReplay(bytes)).header.map;
      viewerStart = preloadedViewerRequest(bytes, name, tg !== "pending" && "runId" in tg ? tg.runId : undefined);
    } else if ("pb" in (tg as object)) {
      viewerStart = { target: { pb: { map: params.get("map") ?? "", style: urlViewer.style, track: urlViewer.track } } };
    } else viewerStart = { target: { bytes: new Uint8Array(0), name: "" } };
  } catch (e) {
    console.warn("replay link:", e);
    if (!params.get("map")) {
      // No map to fall back on: say why, with the way back to the main menu.
      history.replaceState(null, "", "/");
      showError("That replay didn't load", "It may have been removed, or the leaderboards are offline.", [], { cause: e instanceof Error && e.message !== "API unavailable" ? e.message : undefined });
      throw e;
    }
    // Opened later so the viewer can say why it failed.
    viewerStart = "runId" in (tg as object) ? { target: tg as { runId: string } } : null;
  }
}

// Watching a whole gauntlet attempt (/g/<slug>/watch/<attemptId>[?i=<n>], gauntlet/watch.ts): split n's replay on the
// map build it was run on; the viewer's gauntlet layer goes on to the next split.
let replayBuild: string | null = null;
const urlWatch = urlViewer ? null : watchFromUrl();
if (urlWatch) {
  try {
    const plan = await api.gauntletWatch(urlWatch.attemptId);
    const split = plan.splits[Math.min(urlWatch.idx, plan.splits.length - 1)];
    if (!split || plan.gauntlet.slug !== urlWatch.slug) throw new Error("This attempt has no runs to watch.");
    const bytes = await api.replay(split.runId);
    replayMap = (await decodeReplay(bytes)).header.map;
    replayBuild = /^[0-9a-f]{64}$/.test(split.mapSha256) ? split.mapSha256 : null;
    viewerStart = { ...preloadedViewerRequest(bytes, plan.gauntlet.title, split.runId), gauntlet: { plan, idx: split.idx } };
  } catch (e) {
    console.warn("gauntlet watch link:", e);
    history.replaceState(null, "", `/g/${encodeURIComponent(urlWatch.slug)}`);
    showError("That gauntlet run didn't load", "It may still be in progress, or the leaderboards are offline.", [], { cause: e instanceof Error && e.message !== "API unavailable" ? e.message : undefined });
    throw e;
  }
}

// Private lobby invites (?lobby=<code>, net/lobby.ts): straight into the lobby, on the map it is playing.
const lobbyId = params.get("server") ? null : lobbyIdFromParam(params.get("lobby"));
if (lobbyId) {
  try {
    await goToLobby(lobbyId);
    await new Promise(() => {}); // navigating
  } catch (e) {
    history.replaceState(null, "", "/");
    const closed = e instanceof ApiError && e.status === 404;
    showError(closed ? "This lobby has closed" : "Couldn't reach this lobby", closed ? "Lobbies close after 15 minutes with nobody in them. Ask your friend for a new invite." : "Try the link again in a moment.", [], { cause: closed ? undefined : String((e as Error)?.message ?? e) });
    throw e;
  }
}

// A room link with no map (?server=<id>; the desktop client's Discord Join): into the room on the map it is playing.
const bareServer = params.get("server") && !params.get("map") && !replayMap ? params.get("server")! : null;
if (bareServer) {
  try {
    const room = (await api.servers()).find((r) => r.id === bareServer);
    const map = room?.online ? (room.changing ?? room.map) : null;
    if (!room || !map) throw new ApiError(404, "not_found", "no such server");
    location.replace(roomUrl(room.id, map));
    await new Promise(() => {}); // navigating
  } catch (e) {
    history.replaceState(null, "", "/");
    const gone = e instanceof ApiError && e.status === 404;
    showError(gone ? "This server isn't running" : "Couldn't reach this server", gone ? "Pick another one in Play online." : "Try again in a moment.", [], { cause: gone ? undefined : String((e as Error)?.message ?? e) });
    throw e;
  }
}

// A gauntlet attempt (?gauntlet=<id>, gauntlet/mode.ts): a page on another map than the attempt's current one goes there
// (a reload or a crash resumes the attempt), a finished attempt to its result.
const gauntletStart = await resolveGauntlet(params);
// Playing a set in order (map-queue.ts): it goes on only on the map it's waiting for, played solo. Any other page ends it.
const queued = settleQueue(gauntletStart || params.get("server") || params.get("replay") ? null : params.get("map"));

// Main menu: the featured map plays in the background (attract.ts) until the chosen map is built.
let attract: Attract | null = params.get("map") || replayMap ? null : Attract.start(renderer, wasmBytesP, (name) => downloadMap(name, () => {}), (s, c, t) => graphicsPipeline.render(s, c, t));
// /?apply=moderator (the static /about and /changelog pages' "apply in Feedback"): the form on a moderator application.
if (params.get("apply") === "moderator" && api.available()) {
  history.replaceState(null, "", appLocation().pathname + appLocation().search.replace(/([?&])apply=moderator(&|$)/, (_m, a: string, b: string) => (b ? a : "")) + appLocation().hash);
  openFeedback({ category: "application" });
}
// The static privacy page can open intake directly, including when the API is offline.
if (params.get("privacy") === "data") {
  void import("./ui/privacy").then((m) => {
    m.openPrivacyDialog();
    const url = appLocation();
    url.searchParams.delete("privacy");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  });
}
const mapName = params.get("map") ?? replayMap ?? (await showHome());
// Run style: ?style=<id> (e.g. links from a leaderboard) else the last one picked (map browser / pause menu / F3).
const styleParam = params.get("style");
if (isStyleId(styleParam) && !gauntletStart) setSelectedStyle(styleParam);
// (Gauntlets are Normal only: this session runs Normal without changing the style you picked for other maps.)
const style = gauntletStart ? (GAUNTLET_STYLE as StyleId) : selectedStyle();
localStorage.setItem("bunnyhop:last-map", mapName);
setSocialPlaying(mapName, style); // friends see the map (and the room, once joined: social/state.ts)
document.title = `${mapName} · bunnyhop.lol`;
const loading = showLoading(mapName);
await loading.stage("Downloading map", 0);

let core: Core;
let bsp: Uint8Array | undefined;
let wasmBytes: Uint8Array<ArrayBuffer>;
let content: ReturnType<typeof contentLoading> | null = null;
let worldPrograms: Promise<void> = Promise.resolve();
try {
  let lastPaint = 0;
  const cached = attract?.takeBsp(mapName);
  bsp = cached ?? await downloadMap(
    mapName,
    (got, total) => {
      const now = performance.now();
      if (now - lastPaint < 50) return;
      lastPaint = now;
      void loading.stage("Downloading map", total ? (got / total) * 0.7 : null, total ? `${fmtBytes(got)} / ${fmtBytes(total)}` : fmtBytes(got));
    },
    (attempt, why) => void loading.stage("Downloading map", null, /resuming/.test(why) ? `${why}…` : `${why}: retrying (${attempt}/4)…`),
    mapName === replayMap ? replayBuild : null,
  );
  await loading.stage("Starting engine", 0.72, fmtBytes(bsp.length));
  wasmBytes = await wasmBytesP;
  core = await Core.create(wasmBytes);
  await loading.stage("Parsing BSP", 0.76);
  await afterPaint();
  core.loadMap(bsp);
  core.setSettings(styleSettings(style));
  await loading.stage("Building world", 0.82, "textures, lightmaps, geometry");
  await afterPaint();
  content = contentLoading(loading, 0.82, 0.92);
  world = await buildWorld(core, renderer, { bsp, content: content.options });
  content.done();
  attract?.stop();
  attract = null;
  resize();
  world.setPotato(prefs.get().graphics.potato);
  world.setFlashlight(prefs.get().graphics.flashlight);
  world.setFullbright(prefs.get().graphics.fullbright);
  applyAnisotropy(world.root, prefs.get().graphics.anisotropy);
  scene.add(world.root);
  // Every program the map draws with, culled parts included, for the screen and the look's render targets (water
  // captures, the HDR scene target): started now, compiling in parallel while the run is set up (awaited before Ready).
  worldPrograms = warmPrograms(renderer, world.root, camera, scene).catch(() => {});
} catch (e) {
  console.error(e);
  content?.done();
  attract?.stop();
  resize();
  // A map that isn't there gets the way back to the maps (Retry can't help); a download that broke off gets Retry.
  const why = (e as { download?: string })?.download;
  const cause = String((e as Error)?.message ?? e);
  if (why === "missing") showError("That map didn't load", "It isn't on the server.", [], { cause, back: "maps" });
  else if (why === "network") showError("That map didn't load", "The download stopped. Check your connection and try again.", loadErrorActions(false), { cause });
  else showError("That map didn't load", "Something went wrong while building it.", loadErrorActions(!!bsp), { cause });
  throw e;
}
const w = world!;
recordMapPlayed(mapName);
// Footstep surfaces + water from the render mesh (audio only).
buildSurfaces(core);
// Knife / bullet hit surfaces (any orientation; built when idle) and the hit effects (marks, puffs, tracers).
scheduleImpactSurfaces(core);
const hitEffects = new HitEffects();
scene.add(hitEffects.root);
const playerAudio = new PlayerAudio();

let prev: PlayerState = core.state();
let curr: PlayerState = prev;

/** The view the core sets: a spawn / restart (YAW_SET_SPAWN) or a teleport's angles (YAW_SET_TELEPORT); v8 counted yaw. */
function applyTeleportAngles(s: PlayerState, kind = YAW_SET_SPAWN) {
  if (kind === YAW_SET_TELEPORT) input.rebasePhysicsView(s.teleportAngles[1],s.teleportAngles[0],kind);
  else input.restartSamplerView(s.teleportAngles[1],s.teleportAngles[0],kind);
}
applyTeleportAngles(curr);
// Dev hook for automated visual checks (pointer lock can't engage in automation).
if (import.meta.env.DEV) Object.assign(window, { bunnyhop: { input, core, camera, scene, renderer, graphicsPipeline, world: w } });

/** R / B / M / style switches: reset onto `track` (default: current) at its start-zone restart point. */
function restart(track?: number, at?: RestartPoint | null) {
  liveCapture.stop(); // a core/world reset ends this independently reproducible segment
  if (liveCapture.status.stopping) liveCapture.fail("Restart during command application requires a new capture");
  const view = run!.resetCore(track, at ?? null);
  playerAudio.reset();
  prev = curr = core.state();
  input.restartSamplerView(curr.teleportAngles[1],view?.pitch ?? curr.teleportAngles[0],YAW_SET_SPAWN);
  // A new attempt is a practice run only if it starts in third person (or practice mode is on: session.ts).
  run!.practice = thirdPerson.active;
  practice?.onRestart();
  thirdPerson.snap();
  viewmodel?.draw();
  weapons?.reset(curr);
  guns?.reset(weaponReport(core));
  // A restart keeps the guns you gave yourself (!usp, !glock): asked for again in the next commands (weapon-commands.ts).
  weaponsAfterRestart();
}
// Live third person (CS:S `thirdperson`): camera only, never changes the commands fed to the sim.
const thirdPerson = new ThirdPerson(scene, core);
const playerShadow = new PlayerShadowProxy(scene, thirdPerson.shadowRoot);
// First-person viewmodel (viewmodel/): bunny hands + carrot blade, CS:S knife style. Cosmetic only: mouse swings are
// non-movement binds (input.ts gives movement binds priority) and never reach the commands fed to the sim.
let viewmodel: Viewmodel | null = null;
// Weapons (viewmodel/weapons.ts): the simulated knife's swings and the map-given guns, presentation only.
let weapons: WeaponPresenter | null = null;
// Gun models (viewmodel/guns/): the map-given guns' viewmodel, sounds, impacts and the bunny's gun, from the core's
// weapon reports (research/WEAPONS.md). Presentation only.
let guns: GunPresenter | null = null;
// Practice mode (practice-mode/): noclip, checkpoints, +left / +right. Solo only, not on the tutorial.
let practice: Practice | null = null;
/** The zone editor (Z) is a dev tool: the dev server, or ?debug=1 / the debug opt-in. Players have no key for it. */
const zoneEditorAllowed = import.meta.env.DEV || debugHookOptIn();

// Timer, zones, replays, PB ghost, HUD, zone editor and replay watching (see session.ts).
await loading.stage("Preparing run", 0.94, "zones, PB ghost");
await afterPaint();
run = await RunSession.create({
  core, scene, canvas, input, map: mapName, bsp, wasmBytes, style, renderer,
  mainTrackOnly: !!gauntletStart,
  practiceSpawns: !practiceUnavailable({ inRoom: !!params.get("server"), tutorial: mapName === TUTORIAL_MAP, gauntlet: !!gauntletStart }),
  onResync: () => { prev = curr = core.state(); input.resetSampler(performance.now(), "session-resync"); },
  restart,
  tick,
});
const session = run;
// The renderer's per-map choices (lighting profiles, the Ambience showcase) from the first frame, not after the ready screen.
graphicsPipeline.setMap(mapName, session.mapSha256);
// Leave guard: a timed attempt counts as in progress (play-lock.ts; it also guards whenever you're playing).
setPlayAttempt(() => session.timer.status === "running");
setUpdateBusy(() => session.timer.status === "running");
viewmodel = new Viewmodel();
const vm = viewmodel;
vm.onAttack = (kind) => {
  session.recordCosmetic(kind); // replay cosmetic trailer (ghosts / replays show the swing)
  mp?.onAttack(kind); // other players see it
  thirdPerson.attack(kind);
};
// Inspect tricks (viewmodel/inspects/: tap F, re-press to chain, hold to loop): the replay's inspect trailer, rooms
// (sample flags) and the third-person model replay them. Signals are combo.ts SIG_START / SIG_NEXT (= INSPECT_START /
// INSPECT_NEXT); the held level is sent every sample and recorded as edges.
let inspectHeld = false;
vm.inspects.onSignal = (sig) => {
  session.recordInspect(sig);
  mp?.onInspect(sig);
  thirdPerson.inspect(sig);
};
if (import.meta.env.DEV) Object.assign(window, { __viewmodel: vm });
const gunView = (guns = new GunPresenter({ core, scene, onGun: (id) => thirdPerson.setGun(id), onSilencer: (on) => thirdPerson.setGunSilencer(on) }));
const arms = (weapons = new WeaponPresenter({
  core,
  vm,
  effects: hitEffects,
  physics: () => session.settings.physics,
  guns: gunView,
}));
if (import.meta.env.DEV) Object.assign(window, { __weapons: arms, __hitEffects: hitEffects, __guns: gunView });
restart(0);
// !showtriggers / !showclips (triggers/): drawn from the core's own trigger and clip data, after the session has set the
// map's physics version (which brushes block depends on it).
initTriggerOverlay(core, w.root);
practice = new Practice({
  map: mapName, core, session, input,
  inRoom: !!params.get("server"),
  tutorial: mapName === TUTORIAL_MAP,
  gauntlet: !!gauntletStart,
  restart: () => restart(),
  resync: (view) => {
    prev = curr = core.state();
    if (view) {
      input.setYaw(view.yaw, YAW_SET_SPAWN);
      input.pitch = view.pitch;
    }
    input.resetSampler(performance.now(), "practice-resync");
    thirdPerson.snap();
    playerAudio.reset();
    arms.reset(curr);
    gunView.reset(weaponReport(core));
  },
  // Practice keys where practice doesn't work: the tutorial's own keys (X shows the demo); the dev zone editor's Z
  // while practice mode is off.
  fallthrough: (code) => !!tutorial?.onKey(code) || (zoneEditorAllowed && code === "KeyZ" && session.onKey(code)),
  menu: practiceMenuView(),
});
const practiceMode = practice;
// Gauntlet mode: the tag on this map's runs, the HUD line, pings, the next map's prefetch and the split flow.
if (gauntletStart) startGauntletMode(gauntletStart, session);
// A set played in order: the next map after a finish (queue-mode.ts).
startQueueMode({ session, map: mapName, arrived: queued, gauntlet: !!gauntletStart });
// Tutorial mode on the tutorial map: lessons, strafe guide, demos (tutorial/mode.ts, loaded on demand).
const tutorial = mapName === TUTORIAL_MAP ? await (await import("./tutorial/mode")).startTutorialMode({ session, core, input, scene, bsp, wasmBytes, restart }) : null;
// The rest of the scene (your own bunny, zones, floor guns) joins the world's programs, so no part of the map, its
// water or its HDR target compiles a program inside a frame. A slow driver gets 10 s; the rest finishes in the background.
// Then the whole map is drawn once through the look's offscreen passes (water captures, HDR target), so the GPU's
// first draws into them happen here too, not when a part of the map is first seen; Ready waits for the GPU to finish.
await loading.stage("Compiling shaders", 0.97);
try {
  graphicsPipeline.compilePasses(scene);
} catch (e) {
  console.warn("compile passes:", e);
}
await Promise.race([
  Promise.all([worldPrograms, warmPrograms(renderer, scene, camera, scene).catch(() => {})])
    .then(() => graphicsPipeline.warmDraw(scene, camera))
    .catch((e) => console.warn("warm draw:", e)),
  new Promise((r) => setTimeout(r, 10_000)),
]);
await loading.stage("Ready", 1);
// A new player's first look (until their first finish on a real map, and always in the tutorial): the world and one
// "Click to start" line, not the pause menu with its empty leaderboard. Esc opens the menu. Returning players get the
// menu as before (style, board and replays before a run). Not in rooms or when opening a replay; not on phones.
const firstLook =
  (mapName === TUTORIAL_MAP || !hasFinishedAMap()) && !params.get("server") && !viewerStart && !matchMedia("(pointer: coarse)").matches;
// Arriving: the camera swoops down into first person as the loading screen lifts (arrival.ts; camera only, before the
// run). Not into a replay or a room (their own cameras: spectating, races), not with reduced motion or potato mode.
const arrival = new Arrival();
/** Frames drawn since the map loaded: the loading screen lifts off after the first few (heavy maps draw slowly at first). */
let arriveFrames = 0;
function drawn(now: number): void {
  if (arriveFrames < 0 || ++arriveFrames < 3) return;
  arriveFrames = -1;
  arrival.go(now);
  revealGame();
}
if (!viewerStart && !params.get("server") && !matchMedia("(prefers-reduced-motion: reduce)").matches && !prefs.get().graphics.potato && !document.body.classList.contains("potato"))
  arrival.start(core, [curr.position[0], curr.position[1], curr.position[2] + curr.viewOffsetZ], input.yaw);
await showReady({ menu: !firstLook });
if (firstLook) showStartPrompt();

// Replay viewer: its own physics-only sim instance; the live run below is paused, never stepped or restored by it.
viewer = new ReplayViewer({
  renderer, graphicsPipeline, scene, camera, world: w, map: mapName, bsp, wasmBytes, mapSha256: session.mapSha256,
  style: () => session.selectedStyle,
  resize,
  practiceFrom: (replay, tick) => practice?.fromReplay(replay, tick) ?? "Practice isn't available here.",
  onWorldUpdate: (sim, origins) => triggerOverlayFrame(origins, sim, uiHidden()),
  onOpen: () => {
    stopMenuWork();
    paintVisible(false);
    measureVisible(false);
    setSocialWatching(mapName);
    playerShadow.setEnabled(false);
    input.resetSampler(performance.now(), "viewer-open");
    hitEffects.clear();
    gunView.impacts.clear();
    gunView.floor.root.visible = false; // the viewer shows the replay's own floor guns
    session.ghosts.setHidden(true);
    thirdPerson.setHidden(true);
  },
  onClose: () => {
    paintVisible(true);
    setSocialWatching(false);
    input.resetSampler(performance.now(), "viewer-close");
    gunView.floor.root.visible = true;
    session.ghosts.setHidden(false);
    thirdPerson.setHidden(false);
    resize();
    void showReady();
  },
});
const replayViewer = viewer;
onViewerRequest((r) => void replayViewer.open(r));
Object.assign(window, { openReplayViewer });
if (import.meta.env.DEV) Object.assign(window, { __viewer: replayViewer });
if (viewerStart) void replayViewer.open(viewerStart);

// Multiplayer (?server=<id>): the room relays everyone's locally simulated movement (net/mp.ts, loaded on demand).
// Solo play never loads it; the hooks below are all no-ops when mp is null.
const serverId = params.get("server");
// The game behind the chat commands (chat-game.ts): your keys for !help, practice mode, styles, !wr / !pb.
const game = chatGame({ map: mapName, session, practice: practiceMode });
// ?spectate=<player id> (the friends list's Spectate, social/spectate.ts): watch them on arrival. Read once and dropped
// from the address, so a reload or Leave server doesn't carry it.
const spectateId = serverId ? params.get("spectate") : null;
if (params.has("spectate")) {
  const url = appLocation();
  url.searchParams.delete("spectate");
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
}
const mp = serverId ? (await import("./net/mp")).startMultiplayer({ serverId, map: mapName, scene, core, input, session, restart, impacts: gunView.impacts, game, renderer, spectate: spectateId }) : null;
// Chat in solo play (solo-chat.ts): Y types the same commands as in rooms (!r, !setstart, !help; chat-commands.ts).
// Not on the tutorial map, whose lessons own the restart keys.
const soloChat = mp || tutorial ? null : new SoloChat({ input, session, restart: (t) => restart(t), enabled: () => !replayViewer.active, game });
session.multiplayer = mp !== null;
const desktopClient = nativeClient();
// Desktop client (client-bridge.ts). With its "Uncap the whole browser" on, rAF is unthrottled, so it waits on the GPU
// like the uncapped loop (frame-loop.ts gateRaf).
let browserUncapped = false;
watchClientSettings((s) => {
  browserUncapped = s.browserUncapped === true;
});
// A run's stats card shows its frame cap (session.ts runPlay): the limit, and whether frames waited for the display.
session.frameCap = () => {
  const g = prefs.get().graphics;
  return { limit: g.fpsLimit, vsync: !(g.uncapped || browserUncapped) };
};
// F10 → Benchmark: frame times over 30 s of play (benchmark.ts).
const benchmark = desktopClient?.onBenchmark
  ? new FrameBenchmark({
      say: (text) => session.hud.toast(text, 3500),
      done: (result) => desktopClient.benchmarkResult?.(result),
      describe: () => {
        const g = prefs.get().graphics;
        const c = renderer.domElement;
        return {
          map: mapName,
          graphics: { potato: g.potato, resolutionScale: g.resolutionScale, antialias: g.antialias, uncapped: g.uncapped, lowLatency: g.lowLatency, fpsLimit: g.fpsLimit, browserUncapped, width: c.width, height: c.height },
        };
      },
    })
  : null;
if (benchmark) desktopClient!.onBenchmark!((r) => benchmark.start(r.seconds));
// The room for Discord Join, read twice a second (the summary builds strings).
let presenceRoom: ClientRoom | null = null;
let presenceRoomAt = -1e9;
// Time played (playtime.ts): while the game runs (pointer locked: not in a menu or paused) and you're not watching a
// replay or spectating. Practice, the tutorial and rooms count.
// The same seconds are this map's time played on this device (map-time.ts).
startPlaytime(() => input.locked && !replayViewer.active && !(mp?.isSpectating ?? false), (s) => mapName !== TUTORIAL_MAP && mapTime.played(mapName, s));
// Weapon commands (weapon-commands.ts): !usp / !glock / !knife / !gun / !guns in chat, their binds below.
initWeaponCommands({ input: experimentWeapons.input, session, canGive: () => !replayViewer.active && !(mp?.isSpectating ?? false) && !practiceMode.noclipping });
registerWeaponChatCommands();
initPaint(w.root, camera, () => !replayViewer.active && !(mp?.isSpectating ?? false), w.skyFaces);
initMeasure(w.root, scene, camera, () => !replayViewer.active && !(mp?.isSpectating ?? false), w.skyFaces);

// This facility exists ONLY on a loopback Vite dev server. No production query/storage enablement.
if (localInputExperimentAllowed(import.meta.env.DEV, location.hostname)) {
  const badge = experimentBadge = document.createElement("div");
  badge.style.cssText = "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:99999;background:#39180b;color:#fff;padding:8px;font:13px monospace;pointer-events:none";
  badge.hidden = true;
  document.body.append(badge);
  const context = () => ({ multiplayer: !!mp, tutorial: !!tutorial, practice: session.practicing || practiceMode.noclipping, editor: !!session.editor?.active, queue: !!readQueue(), gauntlet: !!gauntletStart || !!session.modeLock, nullBinds: prefs.get().nullBinds, thirdPerson: thirdPerson.active, debug: session.debug, autoRestart: prefs.get().autoRestart.when !== "off", tickInterval: session.settings.tickInterval });
  const enable = (source: SamplerSource = experimentSource) => {
    const rejected = experimentRejection(context());
    if (rejected) throw new Error(rejected);
    if (inputExperiment) throw new Error("Input experiment already enabled");
    input.enableSampler({ source, origin: performance.now(), holdbackMs: experimentHoldback() });
    experimentSource = source;
    session.markExperimentalInput();
    inputExperiment = true; experimentFailure = false;
    badge.hidden = false;
    badge.textContent = "EXPERIMENTAL INPUT · PERMANENTLY UNRANKED · local diagnostics only";
    restart(); // never mix a partially ranked attempt with the experiment
  };
  Object.assign(window, { __inputExperiment: {
    enable,
    disable: () => {
      liveCapture.stop(); input.disableSampler(); inputExperiment = false; experimentFailure = false;
      badge.textContent = "INPUT EXPERIMENT OFF · SESSION STILL UNRANKED · reload to rank";
      restart();
    },
    startLiveCapture: async () => {
      if (!inputExperiment || experimentFailure) throw new Error("Enable a healthy local experiment first");
      const rejected = experimentRejection(context());
      if (rejected) throw new Error(rejected);
      // Hash before the synchronous restart/attach/enable section; no uncaptured simulation after restart.
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", wasmBytes)), b => b.toString(16).padStart(2, "0")).join("");
      if (!inputExperiment || experimentFailure || experimentRejection(context())) throw new Error("Experiment context changed");
      liveCapture.stop(); input.disableSampler(); restart();
      liveCapture.start(input, { explicitRestart:true, wasmSha256:hash, initial:core.state(), header:{
        map:mapName, mapSha256:session.mapSha256, settings:session.settings, style:session.runStyle,
        prespeedCap:session.timer.options.prespeedCap, timerRules:session.timer.rules,
        startTick:0, endTick:0, track:session.timer.track, spawn:restartPoint(core),
        zones:session.zones?.zones ?? [], clientBuild:session.clientBuild, player:"local-unranked", recordedAt:Date.now(),
      } }, () => core.state());
      input.enableSampler({ source:experimentSource, origin:performance.now(), holdbackMs:experimentHoldback() });
      return liveCapture.status;
    },
    stopLiveCapture: () => liveCapture.stop(),
    discardLiveCapture: () => liveCapture.clear(),
    exportLiveCapture: () => {
      const blob = new Blob([liveCapture.export()], { type:"application/json" });
      const url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = "input-live-evidence.json"; a.click(); URL.revokeObjectURL(url);
    },
    startCapture: () => {
      if (!inputExperiment) throw new Error("Enable the experiment first");
      input.resetSampler(performance.now(), "capture-start");
      experimentCapture.start({ map: mapName, mapSha256: session.mapSha256, clientBuild: session.clientBuild,
        settings: session.settings, source: experimentSource, mouse: { ...input.settings },
        filterEnabled: input.filter.enabled, state: core.state(), track: session.timer.track, style: session.runStyle,
        view: { yaw: input.yaw, pitch: input.pitch } });
    },
    stopCapture: () => experimentCapture.stop(),
    status: () => ({ enabled: inputExperiment, failed: experimentFailure, permanentlyUnranked: session.experimentalInput, capture: experimentCapture.state, liveCapture:liveCapture.status, sampler: input.samplerState }),
    export: () => {
      const blob = new Blob([experimentCapture.export()], { type: "application/json" });
      const url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = "input-experiment.json"; a.click(); URL.revokeObjectURL(url);
    },
  } });
}


// Feedback form (feedback/): what "Attach game info" says about the live run. Read only when a report is sent.
const r1 = (n: number) => Math.round(n * 10) / 10;
setGameInfo(() => {
  const t = session.timer;
  const v = curr.velocity;
  return {
    inGame: true,
    map: mapName,
    mapSha256: session.mapSha256,
    clientBuild: session.clientBuild,
    style: session.runStyle,
    track: t.track,
    timer: { status: t.status, ticks: t.ticks(), inStart: t.inStart },
    position: curr.position.map(r1),
    velocity: v.map(r1),
    speed: Math.round(Math.hypot(v[0], v[1])),
    grounded: curr.grounded,
    crouched: curr.crouched,
    view: [r1(input.pitch), r1(input.yaw)],
    tick: curr.tick,
    practice: session.unranked,
    thirdPerson: thirdPerson.active,
    watchingReplay: replayViewer.active,
    spectating: mp?.isSpectating ?? false,
    input: inputSummary(input), // mouse / frame-time stats (input-debug.ts): flicks and freezes come with numbers
  };
});

/** R / M / B. With Settings → Keys → Hold to restart on, they fire after a short hold (restart-guard.ts). */
const restartAction = (a: GuardedAction) => {
  if (a === "restart") restart();
  else if (a === "restartMain") restart(0);
  else session.restartBonus();
};
const restartGuard = new RestartGuard({ input, fire: restartAction });
/** Settings -> Keys -> Auto restart: checked once per frame, after the ticks. */
const autoRestart = new AutoRestart();
/** Main menu bind (unbound by default): during a timed run it's held to leave, on the restart ring (leave-confirm.ts). */
const leaveHold = new LeaveHold({
  held: () => input.actionHeld("mainMenu"),
  ring: restartGuard.ring,
  leave: () => goToMainMenu(),
  key: () => {
    const c = prefs.get().binds.mainMenu?.find((b) => !b.startsWith("MWheel") && b !== "MouseWheel") ?? prefs.get().binds.mainMenu?.[0];
    return c ? keyLabel(c) : "the key";
  },
  ask: (text) => session.hud.toast(text, CONFIRM_MS, "leave"),
});
input.onAction = (a, code) => {
  if (replayViewer.active) return;
  if (a === "paint" || a === "paintOnce") return void requestPaint();
  if (a === "clearPaint") return clearPaint();
  if (a === "lastLj") return openLastJump();
  if (a === "measurePoint") return requestMeasure();
  if (a === "clearMeasure") return clearMeasure();
  if (a === "mainMenu") return leaveHold.press(performance.now(), session.timer.started);
  if (isWeaponAction(a)) {
    // Weapon keys (1 / 2 / 3 / Q / G): a slot request in the next command. The zone editor keeps its digit keys, and
    // the tutorial map (no guns) its own keys: G is the strafe guide there.
    if (tutorial?.onKey(code)) return;
    if (session.editor?.active) session.onKey(code);
    else if (a === "drop") input.requestDrop();
    else if (a === "reload") input.requestReload();
    else if (a === "nextWeapon" || a === "prevWeapon") {
      // Cycle through the held slots (primary, secondary, knife), like CS:S invnext / invprev.
      const order = [1, 2, 3].filter((s) => arms.holdsSlot(s));
      const at = order.indexOf(arms.activeSlot());
      if (order.length > 1) input.requestSlot(order[(at + (a === "nextWeapon" ? 1 : order.length - 1)) % order.length]);
    } else {
      const slot = arms.slotFor(a);
      if (slot) input.requestSlot(slot);
    }
    return;
  }
  if (a === "flashlight") {
    prefs.update((p) => (p.graphics.flashlight = !p.graphics.flashlight));
    whisper(prefs.get().graphics.flashlight ? "Flashlight on" : "Flashlight off", { key: "toggle" });
    return;
  }
  if (a === "hideUi") {
    // Hide UI in game (ui/hide-ui.ts), playing or spectating: saved, so you can play with it hidden. The frame loop
    // applies it. Not on the tutorial map: its coach is the point there.
    if (tutorial) return whisper("The UI stays on in the tutorial.");
    prefs.update((p) => (p.hud.hidden = !p.hud.hidden));
    return;
  }
  if (tutorial?.onAction(a)) return;
  if (a === "mute" || a === "nextTrack") return; // audio/index.ts handles these everywhere (menus, viewer too)
  if (mp?.onAction(a)) return;
  if (practiceMode.onAction(a, code)) return;
  if (a === "turnLeft" || a === "turnRight" || a === "turnFast") {
    if (!session.practicing && !turnBindsAllowed(session.runStyle)) session.hud.toast("Turn binds are disabled in Legit Scroll. They're available in practice and other styles.", 3500);
    return; // held turning is sampled with each simulation tick
  }
  if (a === "thirdPerson") {
    // Off during a ranked run (from its first tick until it finishes or restarts), so a stray T can't turn the run
    // into practice. Before the start, after a finish and on practice attempts it works as always.
    const t = session.timer;
    // (In a gauntlet every run should count: a third-person attempt never would.)
    if (session.modeLock && !thirdPerson.active) {
      session.hud.toast("No third person during a gauntlet.", 2500);
      return;
    }
    if (thirdPersonBlocked({ turningOn: !thirdPerson.active, runStarted: t.started, unranked: session.unranked })) {
      session.hud.toast("No third person during a timed run.", 2500);
      return;
    }
    const on = thirdPerson.toggle();
    // An attempt is practice while third person is on; turned off before the run starts, the attempt is clean again.
    if (on) session.practice = true;
    else if (!t.started) session.practice = false;
    if (on && !session.practicing) session.hud.toast("Third person. This run won't count.", 3000);
    else whisper(on ? "Third person" : "First person", { key: "toggle" });
    return;
  }
  if (a === "attack" || a === "attack2") {
    // With a gun out, Mouse2 is the sniper's zoom (the sim ignores attack2 for guns; the shots come from the sim).
    if (arms.gunActive) {
      if (a === "attack2") arms.secondary();
    } else vm.press(a === "attack2");
    return;
  }
  if (a === "inspect") {
    if (arms.knifeOut) vm.inspect();
    else gunView.inspect();
    return;
  }
  if (a === "viewmodel") {
    const on = !prefs.get().viewmodel.show;
    prefs.update((p) => (p.viewmodel.show = on));
    whisper(on ? "Viewmodel on" : "Viewmodel hidden", { key: "toggle" });
    return;
  }
  if (a === "keysOverlay") {
    const on = !prefs.get().hud.layout.keys.on;
    prefs.update((p) => (p.hud.layout.keys.on = on));
    whisper(on ? "Keys overlay on" : "Keys overlay hidden", { key: "toggle" });
    return;
  }
  if (a === "giveUsp") return void giveWeapon("usp");
  if (a === "giveGlock") return void giveWeapon("glock");
  if (a === "gunMenu") return void openGunPicker();
  if (a === "setStart") return session.setStartPoint();
  if (a === "clearStart") return session.clearStartPoint();
  if (restartGuard.press(a)) return;
  if (a === "restart" || a === "restartMain" || a === "restartBonus") restartAction(a);
  else if (a === "cycleStyle") session.cycleStyle();
};
input.onKey = (code) => {
  if (tutorial?.onKey(code)) return;
  // V: the run you just finished in the replay viewer.
  if (code === "KeyV" && session.lastRun && !session.editor?.active) {
    openReplayViewer({ bytes: session.lastRun.bytes, name: "Last run" });
    return;
  }
  // Z toggles the zone editor only where it's allowed (dev); other keys (editor digits) pass through.
  if (code !== "KeyZ" || zoneEditorAllowed) session.onKey(code);
};

const tickMs = DEFAULT_SETTINGS.tickInterval * 1000;
// Slow frames for a while: Potato mode suggested once, in a menu (potato-hint.ts).
const potatoHint = new PotatoHint();
let accumulator = 0;
let last = performance.now();

let lastCmd = { forward: 0, side: 0 };
/** Hide UI in game is in effect (prefs.hud.hidden while the game has the mouse). */
let gameHidden = false;
/** Say how to get the UI back the next time it hides: the first time on this page, and after the key turns it on. */
let hideHint = true;
let hidePref = prefs.get().hud.hidden;
prefs.watch((p) => {
  if (p.hud.hidden && !hidePref) hideHint = true; // turned on (the key, Settings, the pause menu)
  hidePref = p.hud.hidden;
});
/** Vertical speed of the hardest landing since the last frame (viewmodel landing dip). */
let landVz = 0;
/** The style's bind policy for the next command: turn binds and null binds. */
function bindPolicy(): { turnBinds: boolean; nullBinds: boolean } {
  // command() switches to the start zone's track style; use that policy even on its first tick (bonuses are Normal).
  const inputStyle = session.timer.inStart ? session.styleFor(session.timer.track) : session.runStyle;
  // (Practice attempts are never submitted: turn binds and null binds work in every style there.)
  const free = session.practicing;
  return { turnBinds: free || turnBindsAllowed(inputStyle), nullBinds: prefs.get().nullBinds && (free || nullBindsAllowed(inputStyle)) };
}
/** One tick; `at`: its boundary on the frame clock (timed input takes the input stamped up to it), none for a debug tick. */
function tick(at?: number) {
  if (inputExperiment) throw new Error("Manual/debug ticks are unsupported while experimental input is enabled");
  weaponsBeforeTick(); // a gun kept over a restart goes into this command, like a typed !usp
  const sample = input.sample({ ...bindPolicy(), tickInterval: session.settings.tickInterval, at });
  applyTick(sample);
}
function applyTick(sample: UserCmd, diagnostic?: SampledInput, generatedGive = 0) {
  if (practiceMode.noclipping) {
    // Practice noclip: the flight replaces command -> step -> afterStep; the map keeps running (practice-mode/).
    const r = practiceMode.noclipStep(sample);
    prev = curr;
    curr = r.state;
    playerAudio.tick(session.settings.tickInterval, curr, r.events);
    lastCmd = { forward: sample.forwardmove, side: sample.sidemove };
    return;
  }
  // Exact (f32/i16) values; recorded into the replay. Typing in chat (rooms or solo) holds movement and buttons.
  const epoch = input.samplerState?.lastReset;
  const pre = diagnostic && liveCapture.status.running ? core.state() : undefined;
  const filtered = mp ? mp.filterInput(sample) : soloChat ? soloChat.filterInput(sample) : sample;
  const cmd = session.command(filtered);
  // command() can restart into a different track style. Discard this pre-restart sample.
  if (diagnostic && input.samplerState?.lastReset !== epoch) return;
  if (diagnostic) experimentCapture.record("command", { sample: diagnostic, applied: cmd, generatedGive });
  const events = core.step(cmd.forwardmove, cmd.sidemove, cmd.yaw, cmd.pitch, cmd.buttons);
  prev = curr;
  curr = session.afterStep(cmd, events);
  if (diagnostic && pre) liveCapture.applied({ sample:diagnostic, applied:cmd, generatedGive,
    chatSuppressed:filtered !== sample, pre, post:curr, events,
    startTick:session.timer.status === "idle" ? 0 : session.timer.startTick,
    endTick:session.timer.status === "finished" ? session.timer.endTick : 0 });
  // Guns first (their state decides whether the knife presenter plays a gun shot itself), then the knife / slots.
  const weaponNow = weaponReport(core);
  weaponsAfterTick(weaponNow);
  const attackNow = events & EVENT_ATTACK ? attackReport(core) : null;
  gunView.tick(weaponNow, attackNow);
  if (attackNow && attackNow.weapon >= 2) mp?.onShot(); // other players see the shot (the knife's swings: vm.onAttack)
  arms.tick(curr, events); // weapon switches + EVENT_ATTACK: the swing / shot, its impact
  session.hud.setAmmo(gunView.ammo());
  tutorial?.tick(cmd, prev, curr, events);
  playerAudio.tick(session.settings.tickInterval, curr, events);
  mp?.afterTick(curr, cmd, events, weaponNow ? weaponNow.active : null, weaponNow?.silencer ?? false);
  lastCmd = { forward: cmd.forwardmove, side: cmd.sidemove };
  if (!prev.grounded && curr.grounded) landVz = Math.min(landVz, prev.velocity[2]);
  if (events & EVENT_JUMPED && !session.practicing) countJump(); // (practice doesn't count towards your stats)
  if (events & EVENT_TELEPORTED) {
    prev = curr; // don't interpolate across teleports
    applyTeleportAngles(curr, YAW_SET_TELEPORT);
    thirdPerson.snap();
  } else if (events & EVENT_ANGLES_CHANGED) {
    // Standing on a rotating platform turns the view with it (Source FIXANGLE_RELATIVE). The next command
    // carries the turned view, so replays need nothing extra.
    // Commit the platform turn relative to the simulated view, not pending camera preview motion.
    // With the sampler or timed input the camera runs ahead of the commands: turn the view the sim used.
    const committed = inputExperiment || input.timed;
    input.rebasePhysicsView((committed ? cmd.yaw : input.yaw) + curr.angleChange[1],
      Math.max(-89,Math.min(89,(committed ? cmd.pitch : input.pitch)+curr.angleChange[0])),YAW_SET_PUSHER);
  }
  if (diagnostic && session.timer.status === "finished") liveCapture.stop();
}

function frame(now: number) {
  if (desktopClient) {
    const replay = replayViewer.active ? replayViewer.replay : null;
    const presenceMap = replay?.header.map ?? mapName;
    if (mp && now - presenceRoomAt > 500) {
      presenceRoomAt = now;
      const r = roomActions()?.summary();
      presenceRoom = r ? { id: r.id, lobby: r.lobby, players: r.players, max: r.max } : null;
    }
    clientPresence({
      kind: replayViewer.active ? "replay" : session.timer.status === "finished" ? "results" : input.locked ? "playing" : "paused",
      mapId: presenceMap, mapName: presenceMap,
      mapImage: mapImages(presenceMap)?.thumbnail ?? null,
      style: replay?.header.style ?? session.runStyle,
      mode: replayViewer.active ? "replay" : session.unranked ? "practice" : mp ? "multiplayer" : "solo",
      room: mp && !replayViewer.active ? presenceRoom : null,
    });
  }
  input.frame(now);
  inputDebug.frame(now);
  restartGuard.frame(now, replayViewer.active);
  leaveHold.frame(now, replayViewer.active || !input.locked || isTextField(document.activeElement));
  // Hide UI in game: only while the game has the mouse, so the pause menu and Settings open as usual over the HUD.
  const hide = prefs.get().hud.hidden && input.locked && !replayViewer.active && !tutorial && !session.editor?.active;
  if (hide !== gameHidden) {
    gameHidden = hide;
    setUiHidden("game", hide, hideHint);
    if (hide) hideHint = false;
  }
  if (replayViewer.active) {
    // The viewer renders with its own sim; the live run stays paused underneath (and its heartbeats say so).
    session.frameHeld();
    playerAudio.frame(0, true, false);
    replayViewer.frame(now);
    drawn(now);
    setListenerFromCamera(camera);
    last = now;
    accumulator = 0;
    return;
  }
  const frameDt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  potatoHint.frame(frameDt * 1000, input.locked);
  if (inputExperiment) {
    accumulator = 0;
    const rejected = experimentRejection({ multiplayer: !!mp, tutorial: !!tutorial, practice: session.practicing || practiceMode.noclipping, editor: !!session.editor?.active, queue: !!readQueue(), gauntlet: !!gauntletStart || !!session.modeLock, nullBinds: prefs.get().nullBinds, thirdPerson: thirdPerson.active, debug: session.debug, autoRestart: prefs.get().autoRestart.when !== "off", tickInterval: session.settings.tickInterval });
    if (rejected && !experimentFailure) {
      liveCapture.fail(rejected);
      experimentFailure = true;
      if (experimentBadge) experimentBadge.textContent = "INPUT EXPERIMENT STOPPED · UNSUPPORTED STATE · SESSION UNRANKED";
      input.resetSampler(performance.now(), "unsupported-state");
      session.hud.toast(`${rejected}. Disable the experiment to continue (session stays unranked).`, 10000);
    }
    if (input.locked && document.visibilityState === "visible" && !experimentFailure) {
      try {
        pumpInputExperiment(input, (sample) => {
          const prepared = experimentWeapons.beforeCommand(sample.command, weaponsBeforeTick);
          applyTick(prepared.command, sample, prepared.generatedGive);
        }, bindPolicy());
      } catch (error) {
        experimentFailure = true;
        if (experimentBadge) experimentBadge.textContent = "INPUT EXPERIMENT FAULT · SIM STOPPED · SESSION UNRANKED";
        liveCapture.fail(String(error));
        experimentCapture.record("fault", { message: String(error) });
        input.resetSampler(performance.now(), "integration-fault");
        session.hud.toast(`Input experiment stopped: ${String(error)}. Disable to continue.`, 10000);
      }
    }
    last = now;
  } else {
    accumulator += Math.min(now - last, 250);
    last = now;
    if (input.locked) {
      while (accumulator >= tickMs) {
        // This tick's boundary: where it fell between the last frame and this one (timed input, timed-input.ts).
        tick(now - (accumulator - tickMs));
        accumulator -= tickMs;
      }
    } else {
      accumulator = 0;
    }
  }
  // Auto restart (Settings -> Keys): a timed run past its target restarts like R, or beeps once (auto-restart.ts).
  const auto = prefs.get().autoRestart;
  if (auto.when !== "off" && session.timer.status === "running") {
    const due = autoRestart.check(auto.when, auto.action, session.autoRestartRun(auto.when, !!tutorial));
    if (due === "restart") restartAction("restart");
    else if (due === "sound") runSounds.pastTarget();
  }
  const alpha = inputExperiment ? 1 : accumulator / tickMs;
  const lerp = (a: number, b: number) => a + (b - a) * alpha;
  const x = lerp(prev.position[0], curr.position[0]);
  const y = lerp(prev.position[1], curr.position[1]);
  const z = lerp(prev.position[2] + prev.viewOffsetZ, curr.position[2] + curr.viewOffsetZ);
  session.camera(camera);
  if (!thirdPerson.frame(camera, prev, curr, alpha, input.yaw, input.pitch, lastCmd, frameDt, (curr.tick + alpha) * session.settings.tickInterval)) {
    // Source (x, y, z) -> three (x, z, -y)
    camera.position.set(x, z, -y);
    camera.rotation.y = ((input.yaw - 90) * Math.PI) / 180;
    camera.rotation.x = (-input.pitch * Math.PI) / 180;
    camera.rotation.z = 0;
  }
  playerShadow.update([x, y, lerp(prev.position[2], curr.position[2])], curr.crouched, !thirdPerson.active && !mp?.isSpectating);
  mp?.frame(camera, frameDt); // other players; takes the camera while spectating

  const p = prefs.get();
  // Zone boxes go with the rest of the UI when it's hidden (ui/hide-ui.ts).
  session.view.root.visible = (p.showZones && !uiHidden()) || !!session.editor?.active;
  const origins = core.brushOrigins();
  w.update(origins, (curr.tick + alpha) * session.settings.tickInterval, core.effectStates());
  paintVisible(!(mp?.isSpectating ?? false));
  paintFrame(now, input.pointerLocked && !isTextField(document.activeElement) && input.actionHeld("paint"));
  measureFrame(now, !(mp?.isSpectating ?? false) && !uiHidden());
  triggerOverlayFrame(origins, core, uiHidden());
  arms.frame(frameDt, origins);
  // Sniper zoom (client FOV only), first person only.
  const fov = verticalFov(thirdPerson.active ? p.fov : arms.fov(p.fov));
  if (camera.fov !== fov) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
  // The arrival swoop (camera only; over as soon as play starts).
  if (arrival.active) {
    if (input.locked || thirdPerson.active || mp?.isSpectating) arrival.stop();
    else arrival.apply(camera, now, input.yaw, input.pitch);
  }
  session.frame(alpha, prev, curr, now);
  tutorial?.frame(camera, frameDt);
  // Viewmodel: animate always (swings stay in step), draw only in first person on your own player.
  // (Hidden with a gun out: no knife that shoots.)
  vm.setVisible(p.viewmodel.show && !thirdPerson.active && !mp?.isSpectating && arms.knifeOut);
  vm.update(
    frameDt,
    {
      velocity: [lerp(prev.velocity[0], curr.velocity[0]), lerp(prev.velocity[1], curr.velocity[1]), lerp(prev.velocity[2], curr.velocity[2])],
      grounded: curr.grounded,
      viewOffsetZ: lerp(prev.viewOffsetZ, curr.viewOffsetZ),
      sidemove: lastCmd.side,
      yaw: input.yaw,
      pitch: input.pitch,
      landed: landVz,
    },
    { primary: arms.knifeOut && input.actionHeld("attack"), secondary: arms.knifeOut && input.actionHeld("attack2"), inspect: arms.knifeOut && input.actionHeld("inspect") },
  );
  landVz = 0;
  // The gun viewmodel rides the knife viewmodel's bob / sway (which keeps animating while hidden); hidden while scoped.
  gunView.setVisible(p.viewmodel.show && !thirdPerson.active && !mp?.isSpectating && !arms.scoped);
  gunView.frame(frameDt, vm.feelMatrix, origins);
  if (vm.inspects.holding !== inspectHeld) {
    inspectHeld = vm.inspects.holding;
    session.recordInspect(inspectHeld ? INSPECT_HOLD : INSPECT_RELEASE);
  }
  mp?.setInspectHeld(inspectHeld);
  thirdPerson.setInspectHeld(inspectHeld);
  // A full menu screen over the paused game: drawn once into its blurred still, then skipped (ui/backdrop.ts).
  if (backdropLive()) {
    graphicsPipeline.render(scene, camera,(curr.tick+alpha)*session.settings.tickInterval);
    vm.render(renderer, camera);
    gunView.render(renderer, camera);
    backdropRendered(renderer.domElement);
    if (frameLoop.uncappedActive || browserUncapped) gpuFence.mark();
    drawn(now);
  }
  setListenerFromCamera(camera);
  // Wind from 3D speed (falls rush too).
  playerAudio.frame(Math.hypot(lerp(prev.velocity[0], curr.velocity[0]), lerp(prev.velocity[1], curr.velocity[1]), lerp(prev.velocity[2], curr.velocity[2])), curr.grounded, input.locked);
}
// Frames: requestAnimationFrame, or the uncapped loop while playing with Exceed monitor FPS; both keep the FPS limit
// (frame-loop.ts). The loop schedules the next frame before this one runs, so an exception further down (HUD,
// viewmodel, multiplayer) costs one frame, not the whole game.
const frameLoop = new FrameLoop({
  frame: benchmark
    ? (now) => {
        const t0 = performance.now();
        frame(now);
        benchmark.frame(now, performance.now() - t0, input.locked && !replayViewer.active);
      }
    : frame,
  uncapped: () => input.locked && prefs.get().graphics.uncapped && !replayViewer.active,
  limit: () => {
    const g = prefs.get().graphics;
    return !input.locked && g.menuFps > 0 ? g.menuFps : g.fpsLimit;
  },
  gpuIdle: () => gpuFence.idle(),
  gateRaf: () => browserUncapped,
});
frameLoop.start();
