# Native client

The game runs in C++20 with SDL3 and OpenGL, linked to the shared Rust simulation through a C ABI. Input,
simulation ticks, rendering, timer rules, replay recording and heartbeat hashes all run natively.

Menus are the website's own UI in an embedded web view: WKWebView on macOS, WebKitGTK on Linux (a separate menu
window) and WebView2 on Windows. The menu bundle refuses the web game entry point, Three and the live simulation
(`build-menu.ts`, `menu-boundary.ts`). There is no Electron dependency; the old Electron client lives at the
repository root.

The vendored game sources come from web `release-0.0.30` at `1593e71b`, physics 19, timer rules 2. Historical
physics 1–18 remain available for replays. See [the v0.0.30 integration notes](../../docs/v0.0.30-native-integration.md).

## Build and play

You need Bun, CMake 3.24+, Ninja, a C++20 compiler, Rust/Cargo, OpenGL, libcurl and zlib development libraries,
and ffmpeg (build-time audio conversion). Linux also needs pkg-config and Pango/Cairo (`libpango1.0-dev`), and
for menus GTK3 and WebKitGTK 4.1 >= 2.40 (`libwebkit2gtk-4.1-dev`). Windows needs the WebView2 runtime. Install
system fonts for Unicode text; the Noto packages cover most scripts.

From `native/`:

```sh
bun install --frozen-lockfile
bun apps/native/packaging/sdl.ts   # optional: the SDL3 commit releases use
bun apps/native/build.ts
apps/native/build/bunnyhop-native
```

Releases build SDL3 from the commit in `packaging/sdl.json` on every platform. `packaging/sdl.ts` builds it into
`target/native-deps/sdl`, and `build.ts` uses it when it's there; otherwise any installed SDL3 3.4 works for
development.

The build writes `target/native-menu/menu.html` and a release manifest bound to the executable, menu and WASM
verifier. `upstream-wasm.json` pins the verifier's source commit, toolchain and SHA-256. Rebuilding only the C++ or
the menu makes that manifest stale: the game still runs, but the binary no longer matches a released identity.

Pick a map from Play, or load one directly:

```sh
apps/native/build/bunnyhop-native --online-map bhop_eazy
apps/native/build/bunnyhop-native --map /path/to/bhop_eazy.bsp --no-menu
```

Hosted maps and content are checked against their SHA-256 and cached in the app's data folder, so cached maps play
offline. A local map uses its `.zones.json` when there is one; `--content-root DIR` adds loose Source files.

Default keys match the website: WASD, Space or wheel to jump, Ctrl to duck, E to use, R to restart, T for third
person, Escape for the menu. Alt+Enter toggles fullscreen. New installs start with VSync off and a 1000 FPS limit.

## Input

Each mouse report and key press counts in the tick it happened in, by its SDL event time, the same rule as the
website's timed input. Frame rate no longer decides which tick a strafe or A/D switch lands in, and the camera
still shows new motion at once. `--legacy-input` restores per-frame input for comparison. While you play, Windows
reads the keyboard through raw input.

Settings → Mouse → Show input stats overlays delivered reports per second, peak reports per frame, event age and
frame time per phase, and flags stalls over 50 ms. It also names the backend and reports motion timestamp jitter.
These measure delivered motion, including SDL timestamp estimates, rather than the USB polling rate.

Mouse → Advanced → Native input selects Auto, SDL or experimental Raw. Auto keeps SDL. Raw reads relative HID
counts with device timestamps on macOS (requires Input Monitoring) or evdev packets with monotonic kernel times on
Linux (requires access to the mouse device nodes). Buttons and keys keep SDL. Windows keeps SDL's raw-input thread;
its packet timestamps are estimates spread across each read batch. Missing permission, a disconnected device or a
raw queue overrun returns to SDL. After changing permission or reconnecting on Linux, select SDL then Raw to retry.
Check sensitivity with a physical mouse before using Raw; it has not completed target-OS hardware validation.

## Display

- Settings → Display → Fullscreen picks the monitor, resolution and refresh rate exclusive fullscreen switches to,
  so 4:3 (1280×960, 1024×768, 1440×1080) and 16:10 modes work. A new mode shows at once and goes back after ten
  seconds unless you press Enter. A resolution of another shape than the monitor asks Windows for Stretched or Black
  bars; drivers set to override games decide themselves. `--windowed` recovers from any mode.
- Graphics → Aspect ratio gives the same picture in borderless without a mode change. With black bars the HUD and
  crosshair stay inside the picture. Mouse turning is counts × sensitivity × 0.022° in every mode.
- Windows: Display → Low latency mode presents through DXGI (flip model, tearing, VRR) and uses NVIDIA Reflex
  (with Boost and the latency analyzer's flash) or AMD Anti-Lag 2 when the card has them. It is offered only when the
  driver shares OpenGL frames with Direct3D, and any failure falls back to the OpenGL swap with a notice.
- While you play, Windows also gets a 1 ms timer, no power throttling and the "Games" scheduling class; menus and
  other apps get them back.
- A finished run records your view (shape, fit, FOV) with its diagnostics, so replays can show "4:3 stretched".



Replays opens the local vault: finished and imported BHR files with search, filters and sorting. Playback has a
timeline over the live scene with the speed graph, jumps, strafe switches and splits: drag to scrub, Space pauses,
`,` and `.` step a tick, J and N go to the next jump or split, L loops a part, 1-6 pick the camera (in-eye, chase,
free, flyby, auto, orbit), V and H switch the weapon in hand and the HUD, and Tab switches between cursor and camera.
Compare shows a second replay as a ghost with the time ahead or behind; Share copies the run's link at the shown tick.

Export video renders in a separate process (`--export-video`, below) while the game keeps running, one export after
another, into Downloads: any size up to 8K at 24-240 fps, motion blur and supersampling, H.264, HEVC, AV1, ProRes,
DNxHR, lossless FFV1 or PNG frames, with gameplay audio, optional music and the sound as a WAV. It uses FFmpeg from
PATH (or Homebrew on macOS), hardware encoders (VideoToolbox, NVENC, Quick Sync, AMF, VAAPI) where a test encode works
and software otherwise. The Replays list makes videos of replays without opening them.

Replays are saved to the app's `replays/` folder before upload. The menu uploads with your bunnyhop.lol account;
native code owns the four-second signed heartbeat and command hashes. The server re-simulates every submission
with the canonical verifier. Only a build on the server's allowlist (`ALLOWED_NATIVE_CLIENT_BUILDS`, matching
build, WASM, physics and rules, unexpired) can upload ranked runs; any other build keeps its replays locally.

Turn binds use `cl_yawspeed` and the fast-turn multiplier and are recorded in the replay. In Legit Scroll they
keep the attempt local outside practice. Recording stops at 180,000 commands (about 30 minutes). Closing the app
drops pending uploads; the BHR stays on disk.

## Menu and host messages

The native host reads ghost keys, progress delta and finish milliseconds from the simulation. Account data stays
in the menu, which forwards what the HUD shows:

- `runService`: `generation`, `status`, `rank` and the verdict fields. A verified result forwards `xp`, `level` and
  `achievements`, or `rewards: [{title, detail}]` for named unlocks (at most 12; titles up to 95 bytes, details up
  to 127).
- `hudLeaderboard`: `{type: "hudLeaderboard", generation, map, style, track, place, topPercent}` once the board
  entry is fetched. `place` is the board rank, `topPercent` is optional in (0, 100], and `place: 0` clears it.
  Replies for another run, map, style or track are ignored.

The menu sends these from `ui/run-rewards.ts` and `ui/hud-leaderboard.ts`. Neither affects recording or
verification.

The HUD layout editor runs in the host, over the game (`src/hud_editor.cpp`): F2 or Settings → HUD → Edit layout
(`hudEditor`) opens it. Places are the website's anchored `hudLayoutWeb` entries, so a `bhl1.` layout code imports on
either side; the run status, notices and replay banner, which the website doesn't have, are anchored `hudLayout`
entries. Settings → HUD → Layout preset sends `hudPreset` with `classic`, `minimal` or `streamer`.

Account → Edit avatar is the website's avatar editor (`ui/avatar-editor.ts`). The menu has no WebGL, so it sends
`avatarRender` with the spec, its packed loadout and backdrop, and the host poses and draws the bunny offscreen
(`src/avatar_service.hpp`), answering `bunnyhopNativeAvatar({id, png | webp | saved | error})`. The saved picture is a
256 px lossless WebP that the menu posts with the game's own session; Download PNG writes to the Downloads folder.
Pose data comes from the vendored `avatar/stage.ts` (`src/export-avatar.ts`); `ui/avatar-stage-sync.test.ts` flags
the numbers native mirrors when a re-sync changes them. The v0.0.29 integration notes list the settings, practice, replay and video messages.

Settings are the website's settings screen. `ui/settings-gates.ts` places every website row: shown, waiting for a
host setting, switched off where the native renderer has its own version, or left out with the reason.

Graphics → Look has the website's four looks. Enhanced and Cinematic draw through `src/enhanced_look.hpp` (soft bloom,
grade, haze, contact shading, sun shafts, edge smoothing) with sun shadows (`src/sun_shadows.hpp`) and the lighting
profiles. Sky packs show in those two looks: the seven built-in skies are fetched once into the data folder's
`sky-cache/` when picked, and `.hdr`, PNG, JPEG and `.bhsky.json` files in its `skies/` folder (where Add from a link
and Import file save theirs) show in the Sky picker. Downloads and decoding run on workers (`src/sky_library.cpp`).

## Packages

Preview builds are published at [2x74/bunnyhop-client Releases](https://github.com/2x74/bunnyhop-client/releases).
macOS bundles are ad-hoc signed without notarization; Windows packages are unsigned.

```sh
bun run package --version <version>
bun apps/native/packaging/release-check.ts --package target/native-packages/<stage printed by the packager>
```

The packager writes a platform archive, the unpacked app, dependency notices and a JSON report with the archive
SHA-256 and the build identity. From 0.6.2, Settings → Updates checks for new releases (once a day by default),
downloads and verifies the package, and installs it on "Restart to update"; your data folder isn't touched. See the
[release process](../../../docs/releases.md) and [packaging notes](packaging/README.md#updates).

## Checks

```sh
bun run check                                   # menu build, typecheck, format, tests
ctest --test-dir apps/native/build --output-on-failure
cargo test -p bunnyhop-native-bridge
bun test apps/native/packaging
```

Smoke runs that need no account:

```sh
apps/native/build/bunnyhop-native --map /path/to/map.bsp --hidden --frames 30 --screenshot /tmp/native.ppm
apps/native/build/bunnyhop-native --map /path/to/map.bsp --no-menu --hidden --presentation-smoke /tmp/hud
```

Export replays to video without the game, one process for any number of jobs. It prints JSON progress lines and
reads `cancel` on stdin:

```sh
apps/native/build/bunnyhop-native --export-video /path/to/spec.json
```

```json
{
  "cache": "/path/to/data",
  "jobs": [
    {
      "replay": "/path/to/run.bhr",
      "map": "bhop_eazy",
      "output": "/path/to/folder",
      "options": { "width": 1920, "height": 1080, "fps": 60, "quality": "high", "camera": "chase", "hud": true,
                   "codec": "hevc", "samples": 4, "shutter": 90 }
    }
  ]
}
```

The map comes from `cache` (or is downloaded) unless the job names a `bsp`. `settings` sets the player's settings
(defaults otherwise).

Profile a full offline gameplay workload without capturing the mouse or opening a menu:

```sh
# Run from native/. Build with CMake or the regular build above.
apps/native/build/bunnyhop-native-gameplay-benchmark /path/to/spec.json
```

The spec is JSON, for example:

```json
{
  "path": "/path/to/bhop_neonlaser.bsp",
  "out": "target/gameplay-profile.json",
  "width": 1920,
  "height": 1080,
  "eye": [-8480, 32, 96],
  "yaw": 0,
  "frames": 3000,
  "warmup": 300,
  "mouseHz": 2000,
  "ghosts": 3,
  "fpsLimit": 0,
  "vsync": false,
  "limitQueuedFrames": true
}
```

Use a camera inside the supplied map; omit `eye` and `yaw` to use its spawn. Optional `contentRoot` supplies loose
Source assets. The report includes p50/p99/max/mean milliseconds and reciprocal mean FPS for each phase, frame
samples, renderer counters, rasterizations, GPU/driver and SDL version. Warmup frames are excluded. Pump time
includes synthetic input and per-report diagnostics; simulation includes recording; feedback includes SSJ and the
trainer. The HUD, chat, 12-player scoreboard, three cached ghost fixtures, frame diagnostics, swap and GPU fence
are active. Rendering uses Source look, simple water and no MSAA. `ordinarySleep: true` compares the old sleep
method when capped. No menu, audio or network is created, and no replay is saved or submitted. Hidden-window swap
measures throughput and pacing; a real display and mouse are needed for input latency and focus checks.

Check the recorder against the shared verifier with an offline fixture. It never posts to the live server:

```sh
bun apps/native/tools/record-proof.ts --map /path/to/map.bsp --replay /path/to/route.bhr \
  --output target/native-record-proof/new-run
```

Linux checks run in Docker with `apps/native/tools/verify-linux.sh` (`WITH_CLIENT=1` adds SDL/OpenGL under Xvfb).
Headless runs don't test a real mouse; input changes need a check on the target OS.

`--menu-smoke OUTPUT_PREFIX --online-map NAME --hidden` sends the map selection through the menu's host bridge.
It uses a private data folder at `OUTPUT_PREFIX/data` and never submits scores.

## Notices

The movengine project was read as a reference for input and BSP rendering; none of its GPL-3.0 code is used. Keep
the repository's and the vendored Source-related notices. The JSON header is nlohmann/json 3.12.0 (MIT).

![Combined native Loadout preview](../../../docs/images/native-loadout-combined.png)
