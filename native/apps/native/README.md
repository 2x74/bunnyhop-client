# Native client

The game runs in C++20 with SDL3 and OpenGL, linked to the shared Rust simulation through a C ABI. Input,
simulation ticks, rendering, timer rules, replay recording and heartbeat hashes all run natively.

Menus are the website's own UI in an embedded web view: WKWebView on macOS, WebKitGTK on Linux (a separate menu
window) and WebView2 on Windows. The menu bundle refuses the web game entry point, Three and the live simulation
(`build-menu.ts`, `menu-boundary.ts`). There is no Electron dependency; the old Electron client lives at the
repository root.

The vendored game sources come from web `release-0.0.29` at `b29f5037`, physics 18, timer rules 2. See
[the v0.0.29 integration notes](../../docs/v0.0.29-native-integration.md).

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
frame time per phase, and flags stalls over 50 ms. It is off by default and does no per-event allocation.

## Replays and scores

Replays opens the local vault: finished and imported BHR files with search, filters and sorting. Playback has a
timeline over the live scene: drag to scrub, Space pauses, Left/Right steps a frame, Tab switches between cursor
and camera. The vault also races ghosts, imports and exports BHR files, and exports MP4 clips with gameplay audio
and optional music (FFmpeg with libx264).

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
verification. The v0.0.29 integration notes list the settings, practice, replay and video messages.

Settings are the website's settings screen. `ui/settings-gates.ts` places every website row: shown, waiting for a
host setting, switched off where the native renderer has its own version, or left out with the reason.

## Packages

Preview builds are published at [2x74/bunnyhop-client Releases](https://github.com/2x74/bunnyhop-client/releases).
macOS bundles are ad-hoc signed without notarization; Windows packages are unsigned.

```sh
bun run package --version <version>
bun apps/native/packaging/release-check.ts --package target/native-packages/<stage printed by the packager>
```

The packager writes a platform archive, the unpacked app, dependency notices and a JSON report with the archive
SHA-256 and the build identity. Settings → Updates only works for builds configured with a manifest URL and release
key; the default has none, so updating is manual. See the [release process](../../../docs/releases.md).

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
