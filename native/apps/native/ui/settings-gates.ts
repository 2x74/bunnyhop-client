// Which website settings rows the native client shows. Every row of the website's settings screen is listed here by
// section / group / label ("*" for any group), with one of:
//
//   needs        the host keys or capabilities it writes (prefs-bridge.ts hostCan). The row shows once the host has
//                them all; "a|b" is either. An empty list is a row that only touches the menu (DPI, account buttons).
//   unavailable  the native renderer has its own version: the row shows, switched off, with this note.
//   excluded     never in the native client, and why.
//
// settings-coverage.browser.test.ts fails when the website gains a row this table doesn't place.

import { ACTIONS } from "../../web/src/ui/settings";
import { KINDS } from "../../web/src/triggers/volumes";

export type Gate = { needs: readonly string[]; unavailable?: string } | { excluded: string };

const needs = (...keys: string[]): Gate => ({ needs: keys });
const menuOnly: Gate = { needs: [] };
const excluded = (reason: string): Gate => ({ excluded: reason });
const ownVersion = (note: string, ...keys: string[]): Gate => ({ needs: keys, unavailable: note });

const RAW_INPUT = "The desktop client always reads raw mouse motion; there's no browser pointer lock to adjust.";
const SPIKES = "It drops browser pointer-lock jumps, which the desktop client never gets.";
const BROWSER_FRAMES =
  "A browser frame-loop option. The desktop client paces frames with FPS limit and Display → VSync.";
const NEARBY_LIGHTS =
  "The map's lamps as real lights. The desktop client's Enhanced and Cinematic looks don't draw them yet.";
const BOUNCE = "Bounced light. The desktop client's Enhanced and Cinematic looks don't draw it yet.";
const CLOUDS = "Volumetric clouds. The desktop client's Enhanced and Cinematic looks don't draw them yet.";

/**
 * The website's Keys screen lists Chat under Run once its settings have the chat bind (binds.ts chat); until the
 * vendored copy has it, the desktop client's own Chat row stands in. Both write the host's `chat` bind.
 */
export const WEBSITE_CHAT_BIND = ACTIONS.some((action) => (action.id as string) === "chat");
const WEBSITE_CHAT_ROWS: Record<string, Gate> = WEBSITE_CHAT_BIND ? { "keys/Run/Chat": needs("bind:chat") } : {};
const DESKTOP_CHAT_ROWS: Record<string, Gate> = WEBSITE_CHAT_BIND
  ? {}
  : { "keys/Desktop client/Chat": needs("bind:chat") };

const ROWS: Record<string, Gate> = {
  ...WEBSITE_CHAT_ROWS,
  "mouse/Mouse/Sensitivity": needs("sensitivity"),
  "mouse/Mouse/Mouse DPI": menuOnly,
  "mouse/Mouse/Show DPI on profile": menuOnly,
  "mouse/Mouse/Separate vertical sensitivity": needs("separateVertical"),
  "mouse/Mouse/Vertical sensitivity": needs("verticalSensitivity"),
  "mouse/Mouse/Invert mouse Y": needs("invertY"),
  "mouse/Mouse/Raw input": excluded(RAW_INPUT),
  "mouse/View/Field of view": needs("fov"),
  "mouse/Mouse input/Spike filter": excluded(SPIKES),
  "mouse/Mouse input/Timestamped input": needs("timedInput"),
  "mouse/Mouse input/Show input stats": needs("mouseDiagnostics"),

  "crosshair/Style/Style": needs("crosshairStyle", "crosshair"),
  "crosshair/Look/Color": needs("crosshairColor"),
  "crosshair/Look/Size": needs("crosshairSize"),
  "crosshair/Look/Thickness": needs("crosshairThickness"),
  "crosshair/Look/Gap": needs("crosshairGap"),
  "crosshair/Look/Opacity": needs("crosshairAlpha"),
  "crosshair/Look/Outline": needs("crosshairOutline"),

  "hud/Show on screen/Show on screen": excluded(
    "A picture of the website's layout. The desktop client's HUD has its own places: the switches below turn " +
      "elements on and off, and Edit layout moves them over the game.",
  ),
  "hud/Show on screen/Leaderboard place": needs("hudPlace"),
  "hud/Show on screen/Spectator list": needs("hud:spectators"),
  "hud/Show on screen/Practice": needs("hud:practice"),
  "hud/Hide UI/Hide UI": needs("hud"),
  "hud/Hide UI/Hidden UI keeps": needs("hudHiddenKeeps"),
  "hud/Colours/Colour blind": needs("colorBlind"),
  "hud/Layout/Edit layout": needs("hudLayoutWeb", "bind:hudEditor"),
  "hud/Layout/Preset": excluded("The website's presets fit its HUD; the desktop client's are under Layout preset."),
  "hud/Layout/HUD scale": needs("hudScale"),
  "hud/Keys overlay/Style": needs("keysStyle"),
  "hud/Keys overlay/Size": needs("hudLayout|hudLayoutWeb"),
  "hud/Keys overlay/Opacity": needs("hudKeysOpacity"),
  "hud/Keys overlay/Pressed": needs("hudKeysPressed"),
  "hud/Keys overlay/Idle": needs("hudKeysIdle"),
  "hud/Keys overlay/Rows": needs("hudKeysRowsWasd", "hudKeysRowsActions", "hudKeysRowsMouse"),
  "hud/Strafe trainer/Show strafe trainer": needs("strafeTrainer", "hudLayoutWeb"),
  "hud/Strafe trainer/Preset": needs(
    "strafeTrainer",
    "hudStrafeTrainerStyle",
    "hudStrafeTrainerFollow",
    "strafeTrainerSmoothing",
    "hudStrafeTrainerZone",
    "strafeTrainerHints",
    "hudStrafeTrainerShowPace",
  ),
  "hud/Strafe trainer/Style": needs("hudStrafeTrainerStyle"),
  "hud/Strafe trainer/Follow the turn": needs("hudStrafeTrainerFollow"),
  "hud/Strafe trainer/Smoothing": needs("strafeTrainerSmoothing"),
  "hud/Strafe trainer/On-pace zone": needs("hudStrafeTrainerZone"),
  "hud/Strafe trainer/Height": needs("hudStrafeTrainerHeight"),
  "hud/Strafe trainer/Dim below": needs("hudStrafeTrainerDimBelow"),
  "hud/Strafe trainer/Trainer color": needs("hudStrafeTrainerColor"),
  "hud/Strafe trainer/Percentage": needs("hudStrafeTrainerShowPace"),
  "hud/Strafe trainer/Turn hints": needs("strafeTrainerHints"),
  "hud/Strafe trainer/Jump sound": needs("hudStrafeTrainerSound"),
  "hud/Jump stats/Chat": needs("hudSsjChat"),
  "hud/Jump stats/HUD": needs("jumpStats"),
  "hud/Jump stats/Jumps": needs("jumpStatsMode", "jumpStatsInterval"),
  "hud/Jump stats/Speed": needs("hudSsjFieldsSpeed"),
  "hud/Jump stats/Difference": needs("hudSsjFieldsDiff"),
  "hud/Jump stats/Gain": needs("hudSsjFieldsGain"),
  "hud/Jump stats/Sync": needs("hudSsjFieldsSync"),
  "hud/Jump stats/Strafes": needs("hudSsjFieldsStrafes"),
  "hud/Jump stats/Efficiency": needs("hudSsjFieldsEff"),
  "hud/Jump stats/Height": needs("hudSsjFieldsHeight"),
  "hud/Jump stats/Time": needs("hudSsjFieldsTime"),
  "hud/Jump stats/Start Pre": needs("hud:startPre"),
  "hud/Strafe timing/Strafe offsets": needs("hud:strafeOffsets"),
  "hud/Strafe timing/First jump tick HUD": needs("hud:firstJump"),
  "hud/Strafe timing/First jump tick chat": needs("hudMovementFjtChat"),
  "hud/Longjump stats/Enable longjump stats": needs("hudMovementLj", "hud:longJump"),
  "hud/Longjump stats/Longjump HUD": needs("hud:longJump"),
  "hud/Longjump stats/Longjump chat": needs("hudMovementLjChat"),
  "hud/Longjump stats/Jump result": needs("hudMovementLj", "bind:lastLj"),
  "hud/More elements/Bonus / track": needs("hud:track"),
  "hud/More elements/Stage / CP": needs("hud:stage"),
  "hud/More elements/Ghost keys": needs("hud:ghostKeys"),
  "hud/More elements/Speed graph": needs("speedGraph", "hud:graph"),
  "hud/More elements/Map / style line": needs("hudLayout|hudLayoutWeb", "hud:map"),
  "hud/More elements/Personal best": needs("hud:pb"),
  "hud/More elements/Ammo": needs("hudLayout|hudLayoutWeb", "hud:ammo"),
  "hud/More elements/Start Pre": needs("hud:startPre"),
  "hud/More elements/Speed colours": needs("speedColors"),
  "hud/More elements/Gain ticks": needs("gainTicks"),
  "hud/More elements/Edge glow": needs("hudEdgeGlow"),
  "hud/More elements/Zones": needs("zonesVisible"),
  "hud/Triggers and clips/Triggers": needs("triggersVisible"),
  "hud/Triggers and clips/Clips": needs("clipsVisible"),
  "hud/Triggers and clips/Style": needs("triggersStyle"),
  "hud/Triggers and clips/Line thickness": needs("triggersThickness"),
  "hud/Triggers and clips/Fill opacity": needs("triggersOpacity", "triggersStyle"),
  ...Object.fromEntries(
    KINDS.map((kind) => {
      const key = `triggersColors${kind.id[0].toUpperCase()}${kind.id.slice(1)}`;
      return [`hud/Triggers and clips/${kind.label}`, needs(key)];
    }),
  ),
  "hud/Share layout/Layout code": needs("hudLayoutWeb"),

  // Bind rows: one per action, in whichever group the website puts it.
  ...Object.fromEntries(ACTIONS.map((action) => [`keys/*/${action.label}`, needs(`bind:${action.id}`)])),
  "keys/Movement/Null binds": needs("nullBinds"),
  "keys/Movement/Release W on jump": excluded("Not in the desktop client yet."),
  "hud/JHUD/JHUD": excluded("Not in the desktop client yet."),
  "hud/JHUD/Sync": excluded("Not in the desktop client yet."),
  "hud/JHUD/JSS": excluded("Not in the desktop client yet."),
  "hud/JHUD/Strafe analyzer": excluded("Not in the desktop client yet."),
  "hud/JHUD/Speed colours until jump": excluded("Not in the desktop client yet."),
  "hud/JHUD/Stop after jump": excluded("Not in the desktop client yet."),
  "hud/JHUD/Under 60%": excluded("Not in the desktop client yet."),
  "hud/JHUD/60-70%": excluded("Not in the desktop client yet."),
  "hud/JHUD/70-80%": excluded("Not in the desktop client yet."),
  "hud/JHUD/80-90%": excluded("Not in the desktop client yet."),
  "hud/JHUD/90% and up": excluded("Not in the desktop client yet."),
  "ghost/Compare/Compare with": excluded("Not in the desktop client yet."),
  "ghost/Compare/Speed difference": excluded("Not in the desktop client yet."),
  "audio/Volume/Map sounds": needs("mapVolume"),
  "audio/Mute channels/Map sounds": needs("muteMap"),
  "keys/Movement/Turn speed": needs("yawSpeed"),
  "keys/Movement/Fast turn": needs("angleSpeedKey"),
  "keys/Practice/Teleport keeps speed": needs("practiceKeepVelocity"),
  "keys/Run/Hold to restart": needs("holdRestart"),
  "keys/Run/Auto restart": needs("autoRestartWhen"),
  "keys/Run/When it passes": needs("autoRestartWhen", "autoRestartAction"),
  "keys/Tools/Pause / menu": menuOnly,

  "paint/Surface paint/Colour": needs("paint"),
  "paint/Surface paint/Size": needs("paint"),
  "paint/Surface paint/Marks": menuOnly,
  "measure/Distance measurement/Measurement": needs("bind:measurePoint"),

  "ghost/Race/Show ghosts": needs("showGhost"),
  "ghost/Race/Your PB": needs("ghostPb"),
  "ghost/Race/World record": needs("ghostWr"),
  "ghost/Race/Custom ghost": needs("ghostCustom"),
  "ghost/Players and name tags/Ghost tags": needs("ghostTag"),
  "ghost/Players and name tags/Player glow": needs("showPlayerGlow"),
  "ghost/Players and name tags/First-person glow": needs("firstPersonGlow"),
  "ghost/Players and name tags/Player tags": needs("tagsPlayers"),
  "ghost/Players and name tags/Names through walls": needs("tagsThroughWalls"),
  "ghost/Look/Opacity": needs("ghostOpacity"),
  "ghost/Look/Trail": needs("ghostTrail"),
  "ghost/Route guide/Ghost route": needs("ghostRoute"),
  "ghost/Route guide/Route ghost": needs("ghostRoute", "ghostRouteSource"),
  "ghost/Route guide/Route path": needs("ghostRoute", "ghostRouteMode"),
  "ghost/More/Fade when close": needs("ghostNearFade"),
  "ghost/More/Replay file": excluded("Race a replay file from Replays or the pause menu's Load replay file."),

  "graphics/Quality/Preset": needs(
    "graphicsPotato",
    "graphicsAntialias",
    "graphicsAnisotropy",
    "graphicsResolutionScale",
    "graphicsWaterReflections",
  ),
  "graphics/Quality/Look": needs("sourceLook"),
  "graphics/Quality/Potato mode": needs("graphicsPotato"),
  "graphics/Quality/Antialiasing": needs("graphicsAntialias"),
  "graphics/Quality/Water reflections": needs("graphicsWaterReflections"),
  "graphics/Quality/Anisotropic filtering": needs("graphicsAnisotropy"),
  "graphics/Colour & visibility/Brightness": needs("graphicsBrightness"),
  "graphics/Colour & visibility/Gamma": needs("graphicsGamma"),
  "graphics/Colour & visibility/Vibrance": needs("graphicsVibrance"),
  "graphics/Colour & visibility/Fullbright": needs("graphicsFullbright"),
  "graphics/Colour & visibility/Flashlight": needs("graphicsFlashlight"),
  "graphics/Display/Fullscreen when playing": excluded("Display → Window mode: windowed, borderless or fullscreen."),
  "graphics/Display/Resolution": needs("graphicsResolutionScale"),
  "graphics/Display/Aspect ratio": needs("graphicsAspect"),
  "graphics/Display/Fit": needs("graphicsAspect", "graphicsAspectFit"),
  "graphics/Display/Sharp pixels": needs("graphicsPixelated"),
  "graphics/Display/Menu background": needs("graphicsMenuBackground"),
  "graphics/Frame rate/FPS limit": needs("fpsLimit"),
  "graphics/Frame rate/Exceed monitor FPS": excluded(BROWSER_FRAMES),
  "graphics/Frame rate/Low-latency canvas": excluded("A browser canvas mode. The desktop client draws to its window."),
  "graphics/Frame rate/FPS limit in menus": needs("graphicsMenuFps"),
  "graphics/Effects/Bloom": needs("graphicsBloom"),
  "graphics/Effects/Map visual profiles": needs("graphicsMapProfiles"),
  "graphics/Effects/Material detail": needs("graphicsMaterialResponse"),
  "graphics/Effects/Edge smoothing": needs("graphicsSpatialAA"),
  "graphics/Effects/Contact shading": needs("graphicsContactShading"),
  "graphics/Effects/Atmospheric haze": needs("graphicsAtmosphere"),
  "graphics/Effects/Sun shafts": needs("graphicsSunShafts"),
  "graphics/Effects/Volumetric light": excluded(
    "Light scattering through the sun's shadows. The desktop client's Enhanced and Cinematic looks don't draw it yet.",
  ),
  "graphics/Lighting/Lighting profile": needs("graphicsLightingProfile", "graphicsAmbienceShowcase", "graphicsPreset"),
  "graphics/Lighting/Sun strength": needs("graphicsDirectContribution"),
  "graphics/Lighting/Ambient strength": needs("graphicsAmbientContribution"),
  "graphics/Lighting/Sun shadows": needs("graphicsDynamicShadows", "graphicsShadowQuality"),
  "graphics/Lighting/Shadow strength": needs("graphicsShadowStrength"),
  "graphics/Lighting/Shadow range": needs("graphicsShadowDistance"),
  "graphics/Lighting/Nearby light shadows": excluded(NEARBY_LIGHTS),
  "graphics/Lighting/Nearby lights": excluded(NEARBY_LIGHTS),
  "graphics/Lighting/Nearby light strength": excluded(NEARBY_LIGHTS),
  "graphics/Lighting/*": excluded(BOUNCE),
  "graphics/Clouds/*": excluded(CLOUDS),
  "graphics/Sky/Sky": needs("graphicsSkyMode", "graphicsSkyPackId"),
  "graphics/Sky/Sky rotation": needs("graphicsSkyRotation"),
  "graphics/Sky/Sky brightness": needs("graphicsSkyExposure"),
  "graphics/Sky/Sky lighting": needs("graphicsLightingSource"),
  "graphics/Sky packs/*": needs("graphicsSkyPackId"),

  "viewmodel/Viewmodel/Show viewmodel": needs("viewmodel"),
  "viewmodel/Viewmodel/Viewmodel FOV": needs("viewmodelFov"),
  "viewmodel/Viewmodel/Hand": needs("viewmodelLeftHand"),
  "viewmodel/Viewmodel/Position preset": needs("viewmodelFov", "viewmodelX", "viewmodelY", "viewmodelZ"),
  "viewmodel/Loadout/Equipped": menuOnly,
  "viewmodel/Loadout/Swing": menuOnly,
  "viewmodel/Position/Offset X": needs("viewmodelX"),
  "viewmodel/Position/Offset Y": needs("viewmodelY"),
  "viewmodel/Position/Offset Z": needs("viewmodelZ"),
  "viewmodel/Position/Reset to default": needs("viewmodelFov", "viewmodelX", "viewmodelY", "viewmodelZ"),
  "viewmodel/Movement feel/Bob": needs("viewmodelBob"),
  "viewmodel/Movement feel/Sway": needs("viewmodelSway"),

  "audio/Volume/Master volume": needs("volume"),
  "audio/Volume/Mute all": needs("muted"),
  "audio/Volume/Music": needs("musicVolume"),
  "audio/Volume/Effects": needs("sfxVolume"),
  "audio/Volume/Wind & water": needs("ambienceVolume"),
  "audio/Volume/Interface": needs("uiVolume"),
  "audio/Music/Play music": needs("audioMusicMode"),
  "audio/Music/Shuffle": needs("audioShuffle"),
  "audio/Music/Next track": menuOnly,
  "audio/Sounds/Footsteps": needs("footsteps"),
  "audio/Sounds/Wind": needs("wind"),
  "audio/Sounds/Other players": needs("othersAudio"),
  "audio/Sounds/Classic CS:S sounds": needs("classicSounds"),
  "audio/Scroll feedback/Perf% HUD": needs("audioPerfHud"),
  "audio/Scroll feedback/Perfect hop indicator": needs("perfectIndicator"),
  "audio/Scroll feedback/Quiet perfect hop tick": needs("perfectTick"),
  "audio/Announcer/*": needs("announcer"),
  "audio/Mute channels/Music": needs("muteMusic"),
  "audio/Mute channels/Effects": needs("muteSfx"),
  "audio/Mute channels/Wind & water": needs("muteAmbience"),
  "audio/Mute channels/Interface": needs("muteUi"),
  "audio/More/Ghost sounds": needs("ghostAudio"),
  "audio/More/Mute in background": needs("muteInBackground"),
  "audio/More/Test": menuOnly,

  "css/Custom CSS/Use your CSS": menuOnly,
  "css/Custom CSS/Your CSS": menuOnly,

  "account/Account/Name and sign-in": menuOnly,
  "account/Account/Profile flag": menuOnly,
  "account/Account/Privacy & data": menuOnly,
  "account/Account/First-visit intro": menuOnly,
  "account/Account/Desktop app link": excluded("A link to download the desktop app."),
  "account/Account/Show the tutorial": menuOnly,
};

/** Rows only the native client has (its own sections and the groups it adds under the website's Advanced lines). */
export const NATIVE_GATES: Readonly<Record<string, Gate>> = {
  "display/Window/Window mode": needs("windowMode"),
  "display/Window/Always on top": needs("alwaysOnTop"),
  "display/Window/Remember window size and position": needs("rememberWindowBounds"),
  "display/Window/Minimize fullscreen when switching apps": needs("minimizeOnFocusLoss"),
  "display/Window/Window controls": menuOnly,
  "display/Window/Shortcuts": menuOnly,
  "display/Fullscreen/Monitor": needs("fullscreenMode"),
  "display/Fullscreen/Resolution": needs("fullscreenMode"),
  "display/Fullscreen/Refresh rate": needs("fullscreenMode"),
  "display/Fullscreen/Scaling": needs("fullscreenScaling"),
  "display/Frame pacing/VSync": needs("vsync"),
  "display/Frame pacing/GPU frame limit": needs("limitQueuedFrames"),
  "display/Frame pacing/Low latency mode": needs("lowLatencyMode"),
  "display/Frame pacing/Reflex flash indicator": needs("reflexFlash"),
  "display/Local replays/Capture device personal bests": needs("capturePbScreenshots"),
  "discord/Rich Presence/Show on Discord": needs("discordRichPresence"),
  "discord/Rich Presence/Show the map": needs("discordShowMap"),
  "discord/Rich Presence/Privacy mode": needs("privacyMode"),
  "discord/Join/Let friends join": needs("discordJoin"),
  "discord/Join/Include private lobbies": needs("discordJoinLobbies"),
  "data/Game data folder/Folder": menuOnly,
  "data/Game data folder/Default folder": menuOnly,
  "data/Game data folder/Move game data": menuOnly,
  "data/Game data folder/Waiting to move": menuOnly,
  "data/Game data folder/Folder not found": menuOnly,
  "updates/Native client/Version": menuOnly,
  "updates/Native client/Updates": menuOnly,
  "updates/Native client/Ranked": menuOnly,
  "updates/Native client/What's new": menuOnly,
  "updates/Native client/Check automatically": menuOnly,
  "mouse/Native input/Mouse backend": needs("inputBackend"),
  "mouse/Mouse diagnostics/Last sample": needs("mouseDiagnostics"),
  "graphics/Native renderer/Water": needs("waterQuality"),
  "graphics/Native renderer/World effects": needs("effectsVisible"),
  "hud/More jump stats/Gain colours": needs("jumpStatsColors"),
  "hud/More jump stats/Every N jumps": needs("jumpStatsInterval"),
  "audio/Sound packs/Effects pack": needs("sfxPack"),
  "audio/Sound packs/Music pack": needs("musicPack"),
  "audio/Sound packs/Weapon sounds": needs("weaponSounds"),
  ...DESKTOP_CHAT_ROWS,
  "keys/Desktop client/Command chat": needs("bind:commandChat"),
  "keys/Desktop client/Scoreboard": needs("bind:scoreboard"),
  "keys/Desktop client/Next player (spectating)": needs("bind:spectatorNext"),
  "keys/Desktop client/Previous player (spectating)": needs("bind:spectatorPrevious"),
  "keys/Desktop client/Spectator camera": needs("bind:spectatorMode"),
  "keys/Desktop client/Show triggers": needs("bind:showTriggers"),
  "keys/Desktop client/Show player clips": needs("bind:showClips"),
  "css/Custom CSS/CSS file": menuOnly,
  "hud/Show on screen/Speed": needs("hudLayoutWeb"),
  "hud/Show on screen/Timer": needs("hudLayoutWeb"),
  "hud/Show on screen/Run stats": needs("hudLayoutWeb"),
  "hud/Show on screen/Split vs PB": needs("hudLayoutWeb"),
  "hud/Show on screen/Sync bar": needs("hudLayoutWeb"),
  "hud/Show on screen/Keys overlay": needs("keysOverlay"),
  "hud/Show on screen/Strafe trainer": needs("strafeTrainer"),
  "hud/Show on screen/FPS counter": needs("hudLayoutWeb"),
  "hud/Show on screen/Chat": needs("hudLayoutWeb"),
  "hud/Layout/Layout preset": needs("hudLayoutWeb"),
  "paint/Keys/Paint (hold)": needs("bind:paint"),
  "paint/Keys/Place paint mark": needs("bind:paintOnce"),
  "paint/Keys/Clear paint": needs("bind:clearPaint"),
  "paint/Keys/Change keys": menuOnly,
};

/** The gate of a row, or null when the table doesn't place it. */
export function gateFor(section: string, group: string, label: string): Gate | null {
  return ROWS[`${section}/${group}/${label}`] ?? ROWS[`${section}/*/${label}`] ?? ROWS[`${section}/${group}/*`] ?? null;
}

/** Every listed website row and its gate (for the coverage test). */
export const WEB_ROWS: Readonly<Record<string, Gate>> = ROWS;
