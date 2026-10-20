# Native client — v0.0.1 preview

This fork's primary client is C++20/SDL3/OpenGL, linked to the shared Rust
simulation through a C ABI. Input, simulation ticks, rendering, timer rules,
command recording, replay encoding and heartbeat hashes run natively.

Web technology is used only for the map browser, account/sign-in controls,
leaderboards, settings and submission status. The menu bundle reuses those
website components and refuses imports of Three, the web game entry point or
the live simulation. macOS embeds WKWebView above the SDL view. Linux uses a
separate WebKitGTK menu window in the same application; the SDL game window
retains its native renderer and input. Windows uses WebView2 for menus and a
separate authentication view, with SDL still owning gameplay. There is no Electron dependency in this
client. The legacy Electron client remains at the repository root.

macOS ARM64 has been built and smoke-tested. Linux x64 and Windows x64 are
automated build targets, with execution and physical input validation reported
separately in the [release notes](https://github.com/2x74/bunnyhop-client/releases).
See the repository [release process](../../../docs/releases.md).

## Build and play

Requirements: Bun, CMake 3.24+, Ninja, C++20 compiler, Rust/Cargo, SDL3, OpenGL,
libcurl and zlib development libraries, and ffmpeg for the build-time audio
conversion. macOS uses system Cocoa/WebKit frameworks.
Linux menus additionally require pkg-config, GTK3 and WebKitGTK 4.1 >= 2.40
(`libwebkit2gtk-4.1-dev` on Debian); without them the CLI game remains available.

From this repository’s `native/` directory:

```sh
bun install --frozen-lockfile
bun apps/native/build.ts
apps/native/build/bunnyhop-native
```

The build produces `target/native-menu/menu.html` and a release manifest bound
to the executable, menu and canonical WASM. The first build downloads the public
canonical WASM and verifies its pinned SHA-256; `bun run wasm` prepares it
separately. The verified download is cached for offline builds and ignored by
Git. Rust is pinned through `rust-toolchain.toml` to the tested compiler.
A CMake-only rebuild or menu edit makes the previous manifest stale: the game
still works, but that binary cannot claim the previous release identity.

Pick a map from Play, or load one directly:

```sh
apps/native/build/bunnyhop-native --online-map bhop_eazy
apps/native/build/bunnyhop-native --map /path/to/bhop_eazy.bsp --no-menu
```

Online maps and hosted content come from bunnyhop.lol, are checked against their
SHA-256 hashes, and are cached in the native app's data directory. A local map
uses its adjacent `.zones.json`, when present. `--content-root DIR` supplies
loose Source files for local maps. Hosted maps use their downloaded content.

WASD moves, Space/wheel jumps, Ctrl ducks, E uses, R restarts, Escape opens the
menu, and F10 exits. SDL relative mouse motion drives the view; focus loss/menu
opening clears held input and pauses native simulation. All eight website styles
are available; bonuses use their canonical Normal settings. Sensitivity, separate
vertical sensitivity, FOV, VSync, FPS limit, volume, HUD/viewmodel visibility and
key/mouse bindings persist in the app's settings file.

## Replays and scores

The native timer follows the shared versioned start/end, prehop, prespeed,
split and statistics rules. Native `.bhr` files use the existing compressed
replay format and are saved before upload in the native app data directory's
`replays/` folder. The filename is also logged. Normal play records in memory;
optional ABI evidence captures can write detailed JSONL for debugging.

Native code owns the four-second signed-heartbeat cadence and command hashes.
The menu uses its own bunnyhop.lol account session to carry those heartbeats and
upload a finished replay. It checks the live release policy before uploading.
The server still re-simulates every submission with the canonical WASM and
applies the existing integrity checks. No native verdict is trusted.

Only an exact, unexpired `ALLOWED_NATIVE_CLIENT_BUILDS` entry matching the
current server WASM/physics/timer rules enables ranked upload. A local, stale,
unknown or expired release keeps the replay on disk. Sign in through the menu
to use an existing account; it does not import another browser's cookies.

Integer SDL mouse counts produce the existing counted-yaw replay telemetry.
Fractional trackpad deltas remain exact and use the uncounted format rather than
being rounded into mouse counts. Native recording and playback support the
existing BHR versions, including loadout and inspect events. The native client
does not yet run a client-side WASM self-check. Server verification and signed
heartbeats remain enabled. Recordings are currently capped at 180,000 commands
(about 30 minutes); longer recordings cannot upload. Press R for a new recording
after a completed attempt. A pending server result may take longer than the
menu's 30-second status-poll window; the replay remains on disk.

The replay library can watch, seek, pause, change playback speed, race a ghost,
import and export BHR files. Delete moves a replay into the local trash folder.
Leaderboard Watch/Race downloads the existing replay into this native pipeline.
Seeking and initial ghost preparation currently run synchronously; very long
replays can briefly stall the UI.

## Unsigned test releases

The v0.0.1 preview is distributed from
[2x74/bunnyhop-client Releases](https://github.com/2x74/bunnyhop-client/releases)
under an unsigned preview policy. macOS bundles are
ad-hoc sealed (`codesign --sign -`), without Developer ID or notarization.
Windows packages are unsigned unless signing is explicitly configured.
Signing credentials are not a prerequisite for the default package command:

```sh
bun run package --version 0.0.1
bun apps/native/packaging/release-check.ts \
  --package target/native-packages/bunnyhop-native-0.0.1-darwin-arm64
```

Use the actual stage path printed by the packager for `--package`. It produces a
platform archive, an unpacked application, dependency notices and a JSON report
containing the archive SHA-256 and native build identity. The app includes its
menu, native presentation assets and runtime libraries; Bun, Cargo, ffmpeg and
the source checkout are build dependencies, not player prerequisites.

macOS package identity normalizes only signature metadata before hashing, so
ad-hoc sealing does not invalidate the embedded release identity. An exact
packaged build still needs the normal server allowlist entry for ranked upload.
Unsigned releases retain the platform's usual first-launch prompts.

The optional release-manifest/download tools are groundwork for updates, not an
in-app automatic updater. Their trusted key list starts empty and downloads are
disabled until configured. Manual unsigned distribution does not require those
keys. See [packaging](packaging/) for platform scripts and release checks.

## Checks

```sh
ctest --test-dir apps/native/build --output-on-failure
cargo test -p bunnyhop-native-bridge
bun test apps/native/ui apps/native/packaging
bun apps/native/src/tutorial_oracle.ts /tmp/native-tutorial-oracle.json
apps/native/build/bunnyhop-native-tutorial-tests /tmp/native-tutorial-oracle.json
apps/native/build/bunnyhop-native --online-map bhop_eazy --hidden \
  --menu-smoke /tmp/bunnyhop-native-menu
```

The app-owned smoke reads the live account API, checks the menu origin and zero
WebGL attempts, loads the native map, and captures menu/native-game screenshots.
It never records or submits a run. A render-only test needs no web view:

```sh
apps/native/build/bunnyhop-native --map /path/to/bhop_eazy.bsp \
  --hidden --frames 30 --screenshot /tmp/native.ppm
```

Native recorder verification against the canonical WASM uses an offline fixture:

```sh
bun crates/native-bridge/tools/record-proof.ts \
  --map /path/to/map.bsp --replay /path/to/route.bhr \
  --output target/native-record-proof/new-run
```

This compares every native state and timer/stat row, native replay bytes against
the shared encoder, heartbeat hashes and checkpoints. It invokes the shared
ranked verifier and verifies rejection of a changed checkpoint. It never posts
fixture runs to the live server. Scripted fixtures are not human input and may
correctly trigger the separate integrity analyzer.

Linux checks can run in Docker with `apps/native/tools/verify-linux.sh`;
`WITH_CLIENT=1` includes SDL/OpenGL under Xvfb/Mesa. Headless/Xvfb tests do not
establish physical mouse latency or performance on a real Wayland desktop.

## Current scope and remaining parity

Native rendering now includes Source skies/3D skies, displacement blends, detail
and normal maps, water/glass/fog, static and moving props, original hands/weapons,
knife inspections, cosmetics and remote-player models. Geometry and animation
assets are exported from the original project during the build; there is no web
game renderer in the shipped menu. HUD, crosshair, movement/weapon audio, replay
playback and ghost rendering run natively.

Web menus reuse the account API, map browser, leaderboards, friends/DMs,
notifications, ranks/stats, cosmetics and room transport. Rooms relay poses to
native interpolation/rendering and support chat, voting and scheduled map
changes. Tutorial goals and coaching use a native port compared against the
original web implementation. This is not a claim of complete website parity:
full profile-card editing, supporter/gauntlet flows, complete third-person
animation blending, animated accessories, full audio mixing/music, and in-app
updates remain follow-up work. Ghost/trail cosmetic selectors currently update
account choices; those visual effects are not rendered natively.

Windows execution and a human native sign-in/finish/verified-score flow need
end-to-end confirmation. The other developer owns physical Linux input/performance
testing; headless Linux results cannot establish Wayland mouse behavior.
No FPS or latency improvement is established by correctness smoke tests.

The external movengine project was reviewed as a native input/BSP-rendering reference; this
prototype does not copy its GPL-3.0 code. Preserve repository and vendored
Source-related notices. The vendored JSON header is nlohmann/json 3.12.0 under
its included MIT license.

An integration test in the separately maintained server project also submitted
an untouched native-recorded BHR to an isolated API/WASM verifier. Admission,
native heartbeat hashes and altered-checkpoint rejection passed. That test used
local database/storage bindings and did not upload a fixture to production.
Server implementation and deployment configuration are deliberately absent
from this client repository.
