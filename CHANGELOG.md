# Changelog

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
