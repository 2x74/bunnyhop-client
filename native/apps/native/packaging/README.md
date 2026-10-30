# Native desktop packaging

Manual unsigned releases are the default, matching the existing Electron distribution approach. macOS packages are signed ad hoc for local launch; Developer ID, notarization, and Windows Authenticode are optional. Nothing here deploys a release, registers an active ranked build, uploads a score, or silently installs an update.

Run the following from the `native/` directory of this repository:

```sh
bun apps/native/package.ts --version 0.0.1
# When the native executable/menu/assets were already built:
bun apps/native/package.ts --skip-build --version 0.0.1
bun apps/native/packaging/release-check.ts --package target/native-packages/bunnyhop-native-0.0.1-darwin-arm64
bun test apps/native/packaging
```

Outputs are `target/native-packages/bunnyhop-native-VERSION-PLATFORM-ARCH.zip` (macOS/Windows) or `.tar.gz` (Linux), an adjacent JSON report, and the unpacked staging directory. Existing output directories/files are never replaced. Package on the target OS/architecture. Use `--out DIRECTORY` for another output location.

macOS `.app` contains the native executable, recursively copied non-system dylibs with rewritten loader paths, menus, native render/audio/font assets, manifest, and dependency notices. The final bundle is sealed and verified. `macho-code-v1` identity is shared by TypeScript packaging and C++ runtime: it hashes executable bytes with signature blobs/load-command padding and mutable linkedit lengths normalized. Tests compare unsigned, ad-hoc signed, re-signed and deliberately modified code, plus C++/TypeScript output. This build identity is separate from platform signature authenticity.

To optionally use already configured credentials (never pass passwords/private keys in chat):

```sh
bun apps/native/package.ts --version 0.0.1 --identity 'Developer ID Application: Existing Name (TEAM)' --notary-profile existing-keychain-profile
# Strict platform signing is opt-in, never required for the default unsigned release:
bun apps/native/package.ts --version 0.0.1 --require-platform-signing --identity EXISTING_IDENTITY --notary-profile EXISTING_PROFILE
```

Downloaded unsigned apps may require the normal macOS user approval in Privacy & Security. The packager does not remove quarantine or disable Gatekeeper.

Windows MSVC x64 build/package:

```powershell
bun install --frozen-lockfile
./apps/native/packaging/windows/build.ps1 -Version 0.0.1
# Or package an existing build, passing its dynamic-library and notice directories:
bun apps/native/package.ts --skip-build --version 0.0.1 --dependencies target/native-deps/vcpkg/installed/x64-windows/bin --licenses target/native-deps/vcpkg/installed/x64-windows/share
```

Unicode text uses the Windows SDK’s DirectWrite, Direct2D and WIC libraries. Their DLLs remain OS dependencies; no additional vcpkg package is needed.

When complete prebuilt resources exist, the Windows script calls `build.ts --prebuilt-resources`, avoiding exporter/ffmpeg dependencies in the Windows CI job. A source build requires ffmpeg on PATH.

The Windows script pins official vcpkg commit `8bd269459edab68222274040cb79608590b6c91e` (SDL3 3.4.18/cURL/zlib). CMake includes `WebView2.cmake` and calls `bunnyhop_windows_menu(bunnyhop-native)` in its WIN32 branch. The official Microsoft WebView2 NuGet SDK 1.0.4258.31 is pinned to SHA-256 `56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9`. Its static loader is linked; the separate system Evergreen Runtime is required for menus/account. The package copies the DLL dependency closure and app-local MSVC runtime when available. `Install.ps1` creates a per-user installation/Start-menu shortcut only after confirmation. Optional `Install-WebView2.ps1` requires confirmation, downloads Microsoft's official installer, validates its Microsoft Authenticode signature, then runs it. The game never downloads/executes that installer on startup.

Optional Windows Authenticode uses an already configured certificate-store thumbprint via `--windows-thumbprint` or `BUNNYHOP_WINDOWS_SIGNING_THUMBPRINT`. Unsigned ZIPs remain supported. Windows builds and real Windows UI/GPU behavior require validation on Windows; source and macOS tests do not establish that result.

Linux archives include the executable, resources, SDL/HTTP/compression libraries where dynamically linked, a local launcher, and `RUNTIME.txt`. Packaging requires `patchelf` and `readelf` (binutils). The executable uses only `$ORIGIN/../lib` and bundled ELF libraries use only `$ORIGIN`; absolute builder paths are removed before hashing. Non-system transitive dependencies are bundled. For a dlopen-only module, pass `--linux-dlopen-library /path/to/library.so` explicitly. Release checks reject unsafe loader paths and missing libraries even when a same-named host copy is available. The OS supplies glibc, display/GPU drivers, GTK, WebKitGTK 4.1 and Pango/Cairo/fontconfig. `linux-dependencies.txt` documents runtime installation; use the distribution/architecture used to build the archive. Use the Linux tester handoff below for physical input/GPU checks.

`.github/workflows/native-release.yml` (repository root) runs **Native release builds** when an exact numeric `vMAJOR.MINOR.PATCH` tag is pushed or through manual dispatch with a `version` input (default `0.0.1`). All jobs have read-only repository access. One resource build is reused by macOS arm64, Linux x64 and Windows x64 native builds; each platform runs tests, package resource/signature checks, and writes `SHA256SUMS`. Canonical WASM is downloaded only after its pinned hash is verified, used for identity/offline tests, and excluded from release archives. No Electron build runs. The reference workflow under `workflows/native-packages.yml` mirrors the installed workflow.

The workflow produces Actions artifacts named `bunnyhop-macos-arm64`, `bunnyhop-linux-x64` and `bunnyhop-windows-x64`; it **does not publish releases** or overwrite existing release assets. A maintainer reviews successful jobs, downloads the corresponding artifacts, verifies their checksums, and explicitly attaches archives/reports to the existing native prerelease. Keep each platform artifact in its own directory because each has its own `SHA256SUMS`. From the repository root:

```sh
gh workflow run native-release.yml --repo 2x74/bunnyhop-client --ref main -f version=0.0.1
gh run list --repo 2x74/bunnyhop-client --workflow native-release.yml
gh run download RUN_ID --repo 2x74/bunnyhop-client -n bunnyhop-windows-x64 -D artifacts/windows
(cd artifacts/windows && shasum -a 256 -c SHA256SUMS)
# Only after review; no --clobber, so existing verified assets remain intact:
gh release upload v0.0.1 artifacts/windows/*.zip artifacts/windows/*.json --repo 2x74/bunnyhop-client
```

Pushing the release tag already starts a run; manual dispatch is for an intentional rebuild, not a second required step. The existing verified local macOS asset is retained when attaching Linux/Windows results. Platform builds are targets until their hosted jobs pass; packaging CI does not establish physical input/GPU correctness.

# Updates

Settings → Updates checks the update channel, downloads the package for this platform and installs it in place.
`release-keys.json` pins the release key (`native-k8plus-2026-10`), the channel URL and the hosts a download may use:

- `manifestUrl`: `update-manifest.json` on the `native-update-channel` branch, read through raw.githubusercontent.com.
  GitHub's `/releases/latest/` skips prereleases, and every native release is a prerelease, so the channel is a file
  the signer rewrites instead.
- `downloadOrigins`: raw.githubusercontent.com, github.com and release-assets.githubusercontent.com (where GitHub
  redirects release downloads). Every redirect hop must stay on these.

The private key lives on the signing server only. CI never signs and needs no secret.

## Signing releases

`sign-release.ts --pending` runs from a timer on the signing server. For every published release from 0.6.2 on that
has the three platform archives and their package reports but no `update-manifest.json`, it downloads them, checks
each archive's size and SHA-256 against its report and the report's build identity, signs a manifest (version, notes
from the release body, and per platform the download URL, size, SHA-256, build and verifier) and attaches it to the
release. It then points the channel at the newest signed release and re-signs it when fewer than 10 days of its 30-day
validity remain. A release that is still missing files is skipped until the next run. Without `--upload` it only
prints what it would do.

```sh
bun apps/native/packaging/sign-release.ts --pending --upload --repo 2x74/bunnyhop-client \
  --key ~/services/bunnyhop-native-updates/keys/release-ed25519.pem --key-id native-k8plus-2026-10
```

It needs `gh` signed in with access to the repository, takes a lock so overlapping runs exit, and refuses a key file
others can read or a key that isn't the one pinned under `--key-id`. To sign files already on disk instead:

```sh
bun apps/native/packaging/sign-release.ts --local DIR --tag vX.Y.Z --repo 2x74/bunnyhop-client \
  --key PEM --key-id native-k8plus-2026-10 --out update-manifest.json
```

## Installing in place

The client unpacks the verified archive into `.bunnyhop-update` next to the install (beside the `.app` on macOS,
inside the game folder on Windows and Linux), recomputes the unpacked build's identity and, on macOS, checks its code
signature. "Restart to update" waits until no run is in progress and no upload is pending, then quits and starts
its own program as `--finish-update PLAN`. That helper waits for the game to close, renames each replaced entry to
`NAME.update-old`, moves the new one in and starts the new version. If a rename fails, or the new version exits with
an error within 20 seconds, every rename is undone and the old version starts again. The game data folder is never
part of the swap; an install whose data folder sits inside a replaced entry falls back to a manual install.

Copies that can't replace themselves (development builds, a translocated macOS app, an AppImage, a read-only
folder) save the verified package in the updates folder for a manual install, as before. `update.ts` remains a
command-line check and download.

`apps/native/tools/update-e2e.ts` runs the whole path on macOS against a loopback server and a throwaway key. Build the
old package from a binary configured with `-DBUNNYHOP_UPDATE_TEST_HOOKS=ON` and package it with
`--update-test-hooks`; such packages are never release-eligible.

# Linux tester handoff

Build on the target machine with Rust 1.99.1, Bun 1.4.3, CMake/Ninja, a C++20 compiler, SDL3 3.4.18, OpenGL/Mesa development files, cURL/zlib, GTK3, WebKitGTK 4.1 and Pango/Cairo development files (`libpango1.0-dev`), pkg-config and ffmpeg. Pango/Cairo is required for native HUD/chat text even with menus disabled. Install fonts for the languages under test; Noto core/CJK/emoji packages provide broad fallback. On Ubuntu 24.04 SDL3 may need a separate source install; the workflow template shows the pinned official SDL commit/build. Install locked JS dependencies with `bun install --frozen-lockfile`, run `bun apps/native/build.ts`, then `ctest --test-dir apps/native/build --output-on-failure`, `cargo test -p bunnyhop-native-bridge --locked`, and `bun test apps/native/packaging`. Set `CMAKE_PREFIX_PATH`/`LD_LIBRARY_PATH` if SDL was installed outside system locations. Package locally with `bun apps/native/package.ts --skip-build --version VERSION`.

The optional Docker parity harness requires explicit `MAPS_DIR`, `CONTENT_CACHE_DIR` and `PARITY_FIXTURES_DIR` inputs; it assumes no private sibling checkout. See [fixture generation and isolated verification](../tools/README.md). Its Xvfb mode is a separate virtual-display check, not a substitute for the physical tests below.

Compare the native and web clients on the same map, current physics 15, style, track, restart point, sensitivity/vertical-sensitivity mode, FOV and display settings. Test a real mouse and a trackpad (including small fractional motion), then test Wayland and X11 separately and report which SDL video driver/session was used. Check focus loss/Alt-Tab, opening/closing menus and Escape while movement/jump/attack keys are held: no stuck input or unexpected live simulation while paused. Check FPS limits, VSync on/off, resolution/window resize and high-DPI scaling.

Exercise local replay recording/import/playback, pause/speed/seeking, returning to live play, and race ghost alignment on a real map. In a test room check chat/vote/map rotation, remote player rendering/interpolation, spectator flow and race start/finish. Check account login/logout/cookie persistence, then perform a real human run and inspect the ordinary finish/submission result only when that native build is admitted by the service. **Never upload fixtures, synthetic commands, oracle recordings or verification-test replays to production.** Offline parity proofs stay offline.

Return the package JSON report and `resources/native-manifest.json` (or `share/bunnyhop-native/native-manifest.json`), git commit, `rustc --version`, Bun version, OS/distribution/kernel, GPU/driver/OpenGL renderer, SDL version/video driver, Wayland/X11 session and scaling, input device/settings, map/style/track, and exact reproduction steps. Include stdout/stderr, CTest/core/package-test logs, linked-library `RUNTIME.txt`/`ldd` output, smoke JSON/screenshots when available, and any affected local `.bhr` file plus its SHA-256. Redact tokens/cookies; no account secrets are needed. Physical testing remains required; macOS packaging tests do not establish Linux or Windows input/GPU correctness.
