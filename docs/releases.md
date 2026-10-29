# Native releases

Native releases are published in
[2x74/bunnyhop-client](https://github.com/2x74/bunnyhop-client/releases).
Download the latest preview for Windows x64, Linux x64 or macOS ARM64 there. Which builds can submit ranked
runs is listed in [current compatibility](current-compatibility.md). The legacy Electron project and its root npm
version are separate from the native package version.

## Preview policy and platform status

Each release lists the platform checks that passed. CI checks do not establish physical mouse input,
Wayland behavior, interactive account/login flows or gameplay performance. Each
release must identify the checks actually completed and the remaining limits.

The default macOS package is ad-hoc signed, without Developer ID or notarization.
Windows and Linux archives are unsigned. SHA-256 checksums detect changes to the
published files; they do not replace a publisher signature. From 0.6.2 the game checks a signed update manifest,
downloads the package for its platform, verifies it and installs it in place when the player chooses
"Restart to update". The release key stays on the signing server; see [Signed updates](#signed-updates).

A release archive's existence does not admit ranked scores. Ranked submission
still requires an exact, unexpired server allowlist entry for the packaged native
build and canonical WASM identity. The server re-simulates submitted replays and
applies its normal integrity checks. Unknown/local/stale releases keep recordings
on disk.

## Download and launch

1. Choose the archive matching your OS and architecture from
   [Releases](https://github.com/2x74/bunnyhop-client/releases).
2. Compare its SHA-256 with `SHA256SUMS` and the accompanying package JSON report.
   On macOS use `shasum -a 256 ARCHIVE`; on Linux use `sha256sum ARCHIVE`; on
   Windows use `Get-FileHash ARCHIVE -Algorithm SHA256` in PowerShell.
3. Extract the archive before launching. On macOS move `bunnyhop.lol - Native.app` to a chosen
   application folder. Use the normal Finder **Open** flow if macOS asks you to
   confirm an unnotarized app. Windows includes optional installation scripts and
   needs the WebView2 runtime for menus. Linux's launcher uses the bundled native
   libraries; GTK3/WebKitGTK and the other listed system dependencies remain
   required. Read `DEPENDENCIES.txt` in the Linux package.

The preview is not notarized or Authenticode signed. Do not disable system
security globally to run it. Check the release source and checksums before
accepting a first-launch prompt.

## Build and package locally

Install the dependencies in the [native guide](../native/apps/native/README.md),
then run on the target OS and architecture:

```sh
cd native
bun install --frozen-lockfile
bun run build
bun run check
ctest --test-dir apps/native/build --output-on-failure
cargo test -p bunnyhop-native-bridge --locked
bun test ./apps/native/packaging
bun run package --version 0.4.0
```

The first build downloads the pinned public canonical WASM verifier and checks
its SHA-256. `bun run wasm` prepares this ignored cache separately. Once cached,
the verifier can be reused offline; a missing or changed asset fails the build
with recovery instructions. Rust uses the repository's pinned toolchain.

Outputs live in `native/target/native-packages/`: an unpacked stage, `.zip`
(macOS/Windows) or `.tar.gz` (Linux), and a JSON report with the archive hash,
platform, signing state and native build identity. Generated assets, downloaded
maps, local replays and packages must remain outside Git.

Run the package checker against the stage path printed by the packager:

```sh
bun apps/native/packaging/release-check.ts \
  --package target/native-packages/bunnyhop-native-0.4.0-darwin-arm64
```

Substitute the actual platform path. Package checks validate integrity and
closure; an interactive smoke test remains a separate action that opens windows.
Do not describe a compile-only or headless run as physical desktop testing.

## SDL version

All three platforms build SDL3 from the commit in
[`native/apps/native/packaging/sdl.json`](../native/apps/native/packaging/sdl.json), and
`release-check.ts` rejects a package whose bundled SDL was built from anything else.
The pin follows SDL's `release-3.4.x` maintenance branch until the next 3.4 tag, then moves to that tag.

To update it: change the commit in `sdl.json`, read the SDL changes since the old commit for anything
touching mouse, keyboard, focus or windows, and test input on a real Windows machine before tagging.

## Release workflow

[Native release builds](https://github.com/2x74/bunnyhop-client/actions/workflows/native-release.yml)
is installed at `.github/workflows/native-release.yml`. It runs for `v*` tag
pushes and manual dispatch with a `version` input (default `0.4.0`) and a
`platform` selector (`all`, `windows`, `linux`, or `macos`). Versions are
validated as exact numeric `MAJOR.MINOR.PATCH`; use the matching `v0.4.0` tag for
this release.

The workflow builds native resources, then macOS ARM64, Linux x64 and Windows
x64 packages. Platform artifact names are `bunnyhop-macos-arm64-RUN-ATTEMPT`,
`bunnyhop-linux-x64-RUN-ATTEMPT` and `bunnyhop-windows-x64-RUN-ATTEMPT`,
where `RUN` and `ATTEMPT` are the immutable workflow run coordinates. They
contain the platform archive, package JSON report and `SHA256SUMS`.
`native-resources-RUN-ATTEMPT` is an intermediate build artifact. `native-candidate-evidence-RUN-ATTEMPT` binds source SHA, successful
deterministic gates, package identities and artifact IDs/digests. Single-platform
candidates are for inspection; promotion review requires all platform gates.
Inspect each job's result before treating that platform as available.

[Release candidates](native-release-flow.md) describes each job, the artifacts and
how ranked admission entries are derived from the package reports.

The workflow uploads Actions artifacts only. It does not publish GitHub
Releases, register ranked builds, submit scores, configure update keys or deploy
server changes. A maintainer publishes the reviewed preview explicitly:

1. Review and merge the release source, version and dependency/license notices.
2. Push the matching reviewed tag, or dispatch the workflow for the reviewed ref.
3. Review successful platform checks and download their artifacts. Compare
   archive hashes with the package reports and verify the release source/ref.
   Reject packages containing credentials, account data or build-machine paths.
4. Create the GitHub prerelease for the tag and attach only verified packages,
   reports and checksums. A locally verified macOS preview may be published first;
   attach Linux/Windows only after those platform checks pass.
5. Record the actual validation and unresolved limits in the release notes.
   Adding a later platform must not replace an existing archive silently.

## Signed updates

The signing server runs `sign-release.ts --pending --upload` every few minutes. Once a published release from 0.6.2
on has all three platform archives and their package reports, it checks them, attaches a signed
`update-manifest.json` to the release and points the update channel at it; players get it at their next check.
Nothing else is needed at release time. A release published as a draft, or missing a platform, is left alone until
it is complete. Details are in the [packaging notes](../native/apps/native/packaging/README.md#updates).

Before attaching packages, check the new build is admitted for ranked runs, or say in the notes that it isn't yet:
the update notice tells players whether the server lists the build, and runs from an unlisted build stay local.

Optional Developer ID/notarization or Windows signing configuration must remain
outside Git. Signing is not required for this explicitly unsigned preview, and
no private update key is needed to distribute it manually.

## Legacy Electron builds

The retained Electron shell uses `npm ci`, `npm run verify`,
`npm run electron:pack` and `npm run electron:dist -- --publish never` at the
repository root. Its older updater/release helpers are separate from the native
workflow. See the
[original Electron documentation](https://github.com/2x74/bunnyhop-client/blob/321e746/README.md)
for its development and integration behavior. Native releases do not publish
Electron installers or enable the Electron update channel.
