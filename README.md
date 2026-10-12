<p align="center">
  <img src="assets/readme-banner.svg" alt="Bunnyhop Desktop — Find your flow" width="100%">
</p>

<p align="center">
  <a href="https://bunnyhop.lol"><strong>Play Bunnyhop ↗</strong></a> &nbsp; · &nbsp;
  <a href="#run-from-source">Get started</a> &nbsp; · &nbsp;
  <a href="docs/releases.md">Build locally</a> &nbsp; · &nbsp;
  <a href="https://github.com/8tp/bunnyhop-client/issues">Report a bug</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-44-ffb432?style=flat-square&amp;labelColor=181b21" alt="Electron 44">
  <img src="https://img.shields.io/badge/macOS_·_Windows_·_Linux-desktop-ffb432?style=flat-square&amp;labelColor=181b21" alt="Targets macOS, Windows and Linux">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-ffb432?style=flat-square&amp;labelColor=181b21" alt="MIT license"></a>
</p>

# Bunnyhop Client

A dedicated desktop home for [bunnyhop.lol](https://bunnyhop.lol). Keep your game in its own window, share your activity on Discord, and keep a local record of your runs.

**This repository contains only the Electron client.** The game loads from the live website. Game source, maps, physics, server code, and the website integration worktree are maintained separately and are not included here. The client preserves the game's browser input and replay behavior; there is no native input sidecar.

| Make it yours | Keep your best | Stay connected |
| --- | --- | --- |
| Display profiles, fullscreen, and native settings | Local run history, screenshots, and optional PB captures | Opt-in Discord Rich Presence and Bunnyhop deep links |

> **Development preview** · No published releases yet. macOS ARM64 has been built and smoke-tested; Windows and Linux still need native validation. Game-aware features require the matching website hooks. GitHub Actions is disabled; builds and checks run locally.

## Run from source

Use Node.js 22 or newer and npm on macOS, Windows, or Linux:

```sh
npm ci
npm run verify
npm start
```

Electron needs a graphical desktop. Linux additionally needs the normal Electron runtime libraries. The client loads the live website; native integration requires the corresponding web hooks to be deployed. Without those hooks, the game still runs, but presence and completed-run archives will not receive game state.

On macOS, repeated unsigned developer builds may trigger a “Bunnyhop Safe Storage” login-keychain prompt because their signatures change. Signed releases require a consistent Developer ID identity. Automated smoke launchers use disposable profiles and a mock keychain; they never need your login password. Normal app launches retain secure credential storage.

## Features

- F10 opens client settings; `npm start -- --settings` opens them at launch.
- F9 saves a screenshot through a file dialog. F11 toggles fullscreen outside kiosk mode.
- Competitive, balanced, compatibility, and custom settings control fullscreen/kiosk/windowed mode, display selection, frame limiting, GPU options, device scaling, and Windows process priority. Balanced is the default; frame uncapping and GPU tweaks are optional.
- Settings include local diagnostics and JSON support-report export. Diagnostics describe the detected environment, not measured input latency.
- The local run vault stores bounded completed-run summaries. Optional PB screenshots wait for a matching result-card signal from the game and are cancelled when the result is left.
- Opt-in Discord Rich Presence connects to Discord desktop over local IPC, retries when Discord starts late or restarts, and uses Bunnyhop application ID `1556467060916224040`. Map display has its own switch. Privacy mode disables presence; no room identifier, join secret, or renderer-supplied URL is sent. The button points to `https://bunnyhop.lol`.
- Game-generated `.bhr` replay, image, JSON, text, CSV, and video downloads use a save dialog. Replay import/export stays in the game's browser UI; `.bhr` has no OS file association.
- Packaged builds register `bunnyhop://` links for maps, servers, and replays.

Client settings live in `Bunnyhop/client-settings.json` under Application Support on macOS or AppData/Roaming on Windows, and in `~/.config/bunnyhop/client-settings.json` on Linux (respecting `XDG_CONFIG_HOME`). The sibling `vault` directory holds summaries, captures, support reports, and `status.json`, a small local activity file. F10 can open that directory. Vault data stays on this machine; game accounts and run submissions retain the website's normal network behavior.

Rendering and display changes show a relaunch prompt. CLI options such as `--windowed`, `--fullscreen`, `--kiosk`, `--uncap`, `--no-uncap`, `--gpu-tweaks`, and `--no-gpu-tweaks` apply to that launch without being saved.

## Deep links

Packaged installations support these forms:

```text
bunnyhop://map/bhop_example
bunnyhop://server/public-room-id
bunnyhop://replay/run-id
bunnyhop://open?url=https%3A%2F%2Fbunnyhop.lol%2F
```

Identifiers are validated. The `open` form accepts only a Bunnyhop HTTPS origin. Opening a link navigates the main game window and can interrupt a run. Protocol registration depends on the OS and installation format; source runs do not register it.

## Build and verify

```sh
npm run check                 # JavaScript syntax and source checks
npm test                      # Node tests, including fake Discord IPC
npm run electron:smoke        # Sandboxed window/preload fixture smoke
npm run electron:pack         # Unpacked native application
npm run electron:packaged-smoke
npm run electron:dist         # Native installer/archive formats
```

Build output is in `dist/electron`. Development builds are unsigned and do not check for updates. On macOS, an unsigned developer build can be made with:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:dist -- --mac --arm64 -c.mac.identity=null -c.mac.notarize=false --publish never
```

Only a signed release build carrying the release stamp and an explicit publisher configuration checks for updates. Windows and macOS verify update signatures; Linux updates are manual. Release signing, notarization, metadata, and publication requirements are in [release setup](docs/releases.md). There are no active GitHub workflows or automatic publications.

## Contribute or report an issue

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Include the OS, client version, reproduction steps, and a reviewed F10 support report for bugs. Remove personal data before sharing reports or screenshots.

The client is [MIT licensed](LICENSE), retaining the original Aeperion attribution. See [CHANGELOG.md](CHANGELOG.md) for this adaptation's scope.
