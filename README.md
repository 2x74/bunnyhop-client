> [!WARNING]
> This is still in beta! If you run into any issues, use the `Feedback` button in the client to report a problem!

# bunnyhop.lol - Native

A native desktop client for [bunnyhop.lol](https://bunnyhop.lol). The game runs in C++ with SDL3 and OpenGL on
the same Rust movement, collision and timer code as the website. Menus, accounts, maps and leaderboards are the
website's own UI in an embedded web view (WKWebView, WebKitGTK or WebView2). There is no Electron.

## Play

1. Download the archive for your platform from [Releases](https://github.com/2x74/bunnyhop-client/releases).
2. Check its SHA-256 against the release's package report, extract it and open **bunnyhop.lol - Native**.
3. Sign in from the menu to use your bunnyhop.lol account. The app keeps its own session.

Packages are unsigned previews, so expect your OS's first-launch warning. macOS builds are ad-hoc signed, without
notarization. Updates are manual. See [release and installation notes](docs/releases.md).

Default keys match the website: WASD, Space or wheel to jump, Ctrl to duck, E to use, R to restart, T for third
person, Escape for the menu. Alt+Enter toggles fullscreen. Settings, binds, HUD layout and cosmetics use the
website's screens, so they carry over.

## Ranked runs

Every finished run is saved locally first. A run uploads for ranking only from a build the server has admitted;
the server then re-simulates the replay like any other. Other builds, including ones you compile yourself, keep
their replays on your machine. See [current compatibility](docs/current-compatibility.md) for what this source
targets and which builds are admitted.

## Build from source

You need Bun, CMake 3.24+, Ninja, a C++20 compiler, the pinned Rust toolchain, libcurl/zlib and ffmpeg. Linux
menus also need GTK3 and WebKitGTK 4.1; Windows needs the WebView2 runtime.

```sh
cd native
bun install --frozen-lockfile
bun run build
bun run check
apps/native/build/bunnyhop-native
```

The [native guide](native/apps/native/README.md) has the full requirements, how the verifier and SDL are pinned,
command-line options and the test suite.

## Contribute

Read [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md) for code style, [SECURITY.md](SECURITY.md) and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report bugs at
[issues](https://github.com/2x74/bunnyhop-client/issues) with the version, OS and steps. Check logs and replays for
personal information before sharing them.

The older Electron shell is in `electron/` with its npm scripts at the repository root; it loads the live website.

Original Aeperion attribution is kept under the [MIT license](LICENSE). Packages include dependency and
Source-related notices. See [CHANGELOG.md](CHANGELOG.md).

<sub> luna says hi... </sub>
