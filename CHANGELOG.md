# Changelog

## Unreleased

- Added permanent, hash-verified map and shared-content caching with local reads across restarts.
- Fixed Discord artwork forwarding through the sandbox preload.

- Added Discord map artwork with a Bunnyhop logo badge and privacy-aware logo fallback.

- Adapted the dedicated Electron shell to Bunnyhop and retained browser-native game input.
- Added Bunnyhop settings, display/rendering profiles, local diagnostics, screenshot export, and a bounded run-summary vault.
- Added optional PB screenshots tied to the matching visible result card.
- Added opt-in Bunnyhop Discord Rich Presence with local IPC, reconnect, map visibility, and privacy controls.
- Allowed safe game downloads, including browser-generated `.bhr` replays, and validated map/server/replay deep links.
- Added local native packaging and guarded release-preparation scripts.
- Added repository branding; GitHub Actions is disabled and workflow files are removed.

Package version `0.1.0` identifies this development source. It does not represent a published release. There are no signed release artifacts or client latency measurements.
