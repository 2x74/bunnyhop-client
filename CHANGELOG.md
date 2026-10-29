# Changelog

## v0.6.1 — Native

**Fixes**
- Frame rate is back up while you play. The timer, speed, FPS counter and run stats no longer redraw their text from
  scratch every frame; in 0.6.0 that cost most of the frame on Windows.

## v0.6.0 — Native

**Input**
- Mouse movement and key presses now count in the tick they happened in, using each event's timestamp, the same
  way the website does. Quick A/D taps and strafes no longer get dropped or land late at low or uneven frame rates.
- Windows reads the keyboard through raw input while you play, and keys no longer stick after the menu takes focus.
- New installs start with VSync off and a 1000 FPS limit.
- Settings → Mouse → Show input stats shows reports per second, event age and frame timing, and flags stalls.

**Menus and settings**
- Settings is now the website's settings screen, with the same search, sections and presets. Rows the native
  renderer can't use are hidden or say why.
- New installs use the website's default binds: fast turn ↑, noclip Z, third person T, show clips unbound.
- Custom CSS, the replay viewer, credits and account screens match the website.
- The finish card looks like the website's: your time, PB or record, delta, rank, and XP and unlocks once the run
  is verified. The HUD shows your board place ("#4 · top 3%").
- The scoreboard, chat, name tags and notifications follow the website's styles. The Runner player model is
  retired, as on the website.

**v0.0.29**
- Turn speed (`cl_yawspeed`, 60–720°/s) and the fast-turn multiplier (1–4) are saved with your replay.
- Times are scored in milliseconds, matching the server.
- Practice from any point of a replay, and replays open trimmed to the run.
- Ghost colours, trails and glow, replay Compare and the timeline match the website.

**Fixes**
- Borderless and fullscreen switching no longer hides the menu.
- Settings no longer reset after a crash or a bad keybind, and settings files save safely.
- Paths with non-English characters work.

## v0.5.1 — Native

**Fixes**
- Custom spawns (`!ss` / `!setspawn`) now actually apply when you restart. Before,
  the game said the spawn was saved but restarts ignored it.
- Windows: **Borderless windowed** is now a real borderless window, so it no longer
  turns into exclusive fullscreen (which could hide the menu and stop you moving).
- Settings import accepts the website's settings code (`bhs1.…`) as well as JSON,
  and the import box is bigger.

## v0.5.0 — Native

**Gameplay**
- Setspawn (`!ss` / `!setspawn`) now works in practice and anywhere you're standing
  still. A spawn outside the start zone restarts as a practice run, and the timer
  still starts from the start zone.
- Noclip (`!nc`) works in normal and practice runs, including mid-run, and stops a
  running timer.
- `!showtriggers` and `!showclips` now toggle triggers and player clips separately.
  Both are also in Settings and can be bound.

**HUD and audio**
- JHUD colours by gain, on by default: red under 60%, orange 60–69%, green 70–79%,
  cyan 80–89%, white 90% and up. Turn it off in Settings → Jump stats colours.
- The PERFECT indicator and perf % now only show in EZ Scroll and Legit Scroll.
- New **Weapon sounds** toggle covering gunfire, knife swings and stabs, reloads and
  impacts.

**Settings**
- **Settings → Game data:** move your game data to another folder or drive, either
  now or on the next launch.
- New default binds: noclip is now `` ` `` (was Z), show triggers is Mouse 3, show
  clips is T.

**Fixes**
- Fullscreen no longer leaves the menu invisible: the game runs borderless while the
  menu is open. The new `--windowed` launch flag resets a display mode you can't get
  out of.
- The practice-mode hint now shows your actual binds.
- Turnbinds at any speed are no longer held back by the client outside Legit Scroll:
  runs are submitted and the server decides whether they rank (it ranks 210°/s).
  In Legit Scroll, turnbinds still only work in practice.

**Security**
- Classic CS:S sounds only ever decode as WAV, and an Ogg Vorbis decoder overflow
  (CVE-2023-45678) is patched.

## Unreleased — current-server compatibility

- Update the shared simulation to physics 15 and pin the matching canonical WASM.
- Decode BHR v10 fractional look data and manual-turn rebases for replay playback.
- Queue SDL mouse reports by simulation tick deadlines and preserve GL contexts
  around GTK menu work.
- Bind ranked attempts to confirmed accounts through actual HTTP dispatch and
  preserve completed uploads across gameplay restarts.
- Harden Linux package library paths and dependency closure; retain standalone
  release resource builds and platform-specific packaging fixes.
- Refresh shared menu/protocol modules. No release publication or score admission
  is included; see [qualification notes](docs/current-compatibility.md).

## v0.0.1 — Native preview

- Introduces the C++20/SDL3/OpenGL native client, linked to the shared Rust game
  core for movement, collision, timer rules, command recording and BHR replays.
- Keeps gameplay rendering and input native, with embedded web menus for accounts,
  maps, leaderboards, settings and network services.
- Adds eight styles, persistent native settings/binds, local replay playback and
  ghosts, tutorial coaching, native HUD/audio, cosmetics and multiplayer rooms.
- Adds native packaging, package identity/checksum checks and automated platform
  build targets. macOS ARM64 has been built and smoke-tested; other platform
  results belong in the release notes as they complete.
- Establishes an unsigned preview policy: ad-hoc macOS bundles, unsigned Windows
  and Linux packages, manual updates, and no active update signing keys.
- Retains server verification and the exact release allowlist requirement for
  ranked uploads. Replays stay local when a build is not admitted.
- Makes this repository's documentation native-first while retaining the legacy
  Electron implementation and original attribution.

This is an early preview, not complete website parity. No FPS or input latency
improvement is established. See [README.md](README.md) for limitations and
[Releases](https://github.com/2x74/bunnyhop-client/releases) for available artifacts
and validation results.

## Earlier Electron development

The legacy shell added Bunnyhop branding, display/settings profiles, diagnostics,
screenshots, a bounded run-summary vault, optional Discord Rich Presence,
validated deep links/downloads and a permanent hash-verified content cache.
Its source package version `0.1.0` predates the native release version and is not
the native v0.0.1 package identity. The earlier
[documentation](https://github.com/2x74/bunnyhop-client/blob/321e746/README.md)
remains available in repository history.
