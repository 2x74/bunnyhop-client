# Bunnyhop Native

A native desktop fork of [bunnyhop.lol](https://bunnyhop.lol), maintained in
[2x74/bunnyhop-client](https://github.com/2x74/bunnyhop-client).

**v0.0.1 is an unsigned preview.** Get available packages and their checksums from
[Releases](https://github.com/2x74/bunnyhop-client/releases). macOS ARM64 has been
built and smoke-tested. Linux x64 and Windows x64 are automated build targets;
automation alone does not establish interactive gameplay or physical input
validation. Check each release's notes for the artifacts and checks that actually
completed.

Current source targets physics **15**, timer rules **2**, and canonical verifier
`bunnyhop-web/3cca0f22a3c3`. See [current compatibility and qualification](docs/current-compatibility.md).
Published archives have their own source/build identity and admission status.

## Native gameplay, shared game rules

C++20 and SDL3 own the window, relative mouse input, simulation scheduling and
OpenGL rendering. The shared Rust core supplies movement, collision, timer rules
and replay data through a C ABI. Gameplay does not run inside Chromium or a web
game canvas.

The embedded web view is for menus, account sign-in, map browsing, leaderboards
and network services. It reuses the website UI while refusing the web game entry
point, Three renderer and live JavaScript simulation. macOS uses WKWebView,
Linux uses WebKitGTK, and Windows uses WebView2. The native client has no
Electron dependency.

Native features include eight movement styles, persistent settings and binds,
local BHR recording/playback, ghosts, tutorial coaching, native HUD/audio,
cosmetics, and multiplayer room pose rendering. See the
[native guide](native/apps/native/README.md) for the detailed scope and remaining
parity work.

## Play

Download the archive for your platform from
[Releases](https://github.com/2x74/bunnyhop-client/releases), verify its SHA-256
against the accompanying package report, extract it, and launch Bunnyhop.
macOS packages are ad-hoc signed, without Developer ID or notarization. Windows
packages are unsigned. Expect the platform's usual first-launch warnings; these
packages do not provide a signed automatic update channel. See
[release and installation notes](docs/releases.md).

Choose a map from **Play**. WASD moves, Space or the mouse wheel jumps, Ctrl ducks,
E uses, R restarts, Escape opens the menu, and F10 exits. Sensitivity, separate
vertical sensitivity, FOV, frame/audio settings and key bindings are available in
the menu. Downloaded maps and shared content are checked against SHA-256 hashes
and cached locally.

Sign in through the native menu to use your Bunnyhop account. The app keeps its
own session; it does not import another browser's cookies. Replays are saved
locally before upload. Ranked upload requires an exact, unexpired server
allowlist entry for the executable/menu/assets and canonical verifier identity.
The server still verifies every submitted replay. A source build or an unknown,
stale or expired release keeps its replay locally; installing this preview does
not itself enable ranked scores.

## Build from source

Install Bun, CMake 3.24+, Ninja, a C++20 compiler, the pinned Rust toolchain,
SDL3, libcurl/zlib development libraries and ffmpeg. Linux menus also need GTK3
and WebKitGTK 4.1 >= 2.40; Windows needs the WebView2 runtime. Full platform
instructions are in the [native guide](native/apps/native/README.md).

```sh
cd native
bun install --frozen-lockfile
bun run build
bun run check
apps/native/build/bunnyhop-native
```

The first build downloads a pinned public WASM verifier and checks its SHA-256.
It is cached for later offline builds and is not committed or included in native
release archives. Build outputs, downloaded maps, content caches and local replays stay
out of Git.

```sh
# Load a specific hosted map, or a BSP you already have.
apps/native/build/bunnyhop-native --online-map bhop_eazy
apps/native/build/bunnyhop-native --map /path/to/map.bsp --no-menu

# Create an unsigned/ad-hoc package on the target OS.
bun run package --version 0.0.1
```

## Preview limits

A human native sign-in/finish/verified-score flow still needs end-to-end
confirmation. Physical Linux input and Wayland behavior require testing on a
real desktop; headless checks cannot establish them. Windows runtime and
interactive validation must be reported separately from compilation. Correctness
tests establish no FPS or latency advantage.

Website parity remains incomplete: full profile-card editing,
supporter/gauntlet flows, complete third-person animation blending, animated
accessories, full audio mixing/music and in-app updates remain follow-up work.
Ghost/trail cosmetic choices can sync to the account, but those effects are not
yet drawn natively. Long replay seeking can briefly stall the UI. See the native
guide for recording limits and verification details.

## Contribute

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report reproducible bugs at
[2x74/bunnyhop-client/issues](https://github.com/2x74/bunnyhop-client/issues), with
the package version, OS/architecture and steps. Review logs and replay files for
personal information before sharing them.

The older Electron shell remains in `electron/`, with its npm scripts at the
repository root. It loads the live website and is separate from native
`bun` commands. Its
[original documentation](https://github.com/2x74/bunnyhop-client/blob/321e746/README.md)
is retained in repository history; native v0.0.1 releases use the native path.

The project retains the original Aeperion attribution under the
[MIT license](LICENSE). Native packages include dependency and Source-related
notices. See [CHANGELOG.md](CHANGELOG.md) and [release setup](docs/releases.md).
