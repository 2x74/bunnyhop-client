# Native desktop packaging

Manual unsigned releases are the default, matching the existing Electron distribution approach. macOS packages are signed ad hoc for local launch; Developer ID, notarization, and Windows Authenticode are optional. Nothing here deploys a release, registers an active ranked build, uploads a score, or silently installs an update.

Run the following from the `native/` directory of this repository:

```sh
bun apps/native/package.ts --version 0.1.0
# When the native executable/menu/assets were already built:
bun apps/native/package.ts --skip-build --version 0.1.0
bun apps/native/packaging/release-check.ts --package target/native-packages/bunnyhop-native-0.1.0-darwin-arm64
bun test apps/native/packaging
```

Outputs are `target/native-packages/bunnyhop-native-VERSION-PLATFORM-ARCH.zip` (macOS/Windows) or `.tar.gz` (Linux), an adjacent JSON report, and the unpacked staging directory. Existing output directories/files are never replaced. Package on the target OS/architecture. Use `--out DIRECTORY` for another output location.

macOS `.app` contains the native executable, recursively copied non-system dylibs with rewritten loader paths, menus, native render/audio/font assets, manifest, and dependency notices. The final bundle is sealed and verified. `macho-code-v1` identity is shared by TypeScript packaging and C++ runtime: it hashes executable bytes with signature blobs/load-command padding and mutable linkedit lengths normalized. Tests compare unsigned, ad-hoc signed, re-signed and deliberately modified code, plus C++/TypeScript output. This build identity is separate from platform signature authenticity.

To optionally use already configured credentials (never pass passwords/private keys in chat):

```sh
bun apps/native/package.ts --version 0.1.0 --identity 'Developer ID Application: Existing Name (TEAM)' --notary-profile existing-keychain-profile
# Strict platform signing is opt-in, never required for the default unsigned release:
bun apps/native/package.ts --version 0.1.0 --require-platform-signing --identity EXISTING_IDENTITY --notary-profile EXISTING_PROFILE
```

Downloaded unsigned apps may require the normal macOS user approval in Privacy & Security. The packager does not remove quarantine or disable Gatekeeper.

Windows MSVC x64 build/package:

```powershell
bun install --frozen-lockfile
./apps/native/packaging/windows/build.ps1 -Version 0.1.0
# Or package an existing build, passing its dynamic-library and notice directories:
bun apps/native/package.ts --skip-build --version 0.1.0 --dependencies target/native-deps/vcpkg/installed/x64-windows/bin --licenses target/native-deps/vcpkg/installed/x64-windows/share
```

When complete prebuilt resources exist, the Windows script calls `build.ts --prebuilt-resources`, avoiding exporter/ffmpeg dependencies in the Windows CI job. A source build requires ffmpeg on PATH.

The Windows script pins official vcpkg commit `8bd269459edab68222274040cb79608590b6c91e` (SDL3 3.4.18/cURL/zlib). CMake includes `WebView2.cmake` and calls `bunnyhop_windows_menu(bunnyhop-native)` in its WIN32 branch. The official Microsoft WebView2 NuGet SDK 1.0.4258.31 is pinned to SHA-256 `56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9`. Its static loader is linked; the separate system Evergreen Runtime is required for menus/account. The package copies the DLL dependency closure and app-local MSVC runtime when available. `Install.ps1` creates a per-user installation/Start-menu shortcut only after confirmation. Optional `Install-WebView2.ps1` requires confirmation, downloads Microsoft's official installer, validates its Microsoft Authenticode signature, then runs it. The game never downloads/executes that installer on startup.

Optional Windows Authenticode uses an already configured certificate-store thumbprint via `--windows-thumbprint` or `BUNNYHOP_WINDOWS_SIGNING_THUMBPRINT`. Unsigned ZIPs remain supported. Windows builds and real Windows UI/GPU behavior require validation on Windows; source and macOS tests do not establish that result.

Linux archives include the executable, resources, SDL/HTTP/compression libraries where dynamically linked, a local launcher, and `RUNTIME.txt`. The OS supplies glibc, display/GPU drivers, GTK and WebKitGTK 4.1. `linux-dependencies.txt` documents runtime installation; use the distribution/architecture used to build the archive. Use the Linux tester handoff below for physical input/GPU checks.

`workflows/native-packages.yml` is an **uninstalled** manually dispatched GitHub CI template. This repository disables automation; keeping the template under this directory preserves that policy. If automation is explicitly approved later, review it before copying to `.github/workflows/native-packages.yml`. It uses pinned official GitHub actions, runs build commands from `native/`, and prefixes artifact paths with `native/`. It builds workflow artifacts only and never publishes releases or uploads to production.

# Optional signed-download groundwork

`update.ts` is a standalone CLI, not an integrated in-app updater. `release-keys.json` deliberately has no pinned keys, so update checking/downloading fails closed. No signing secret is needed for manual unsigned releases. Future activation requires a reviewed release public key and download origin configuration in the installed client/tool. Do not generate a transient release key and silently trust it.

With an already configured Ed25519 private-key file, an operator can create a signed envelope for package reports; the tool does not publish it:

```sh
bun apps/native/packaging/release.ts --report PACKAGE.json --url-base https://downloads.bunnyhop.lol/native/VERSION/ --key EXISTING_PRIVATE_KEY_FILE --key-id reviewed-release-key --out NEW-release.json
bun apps/native/packaging/update.ts --manifest https://downloads.bunnyhop.lol/native/release.json --keys REVIEWED_PUBLIC_KEYS.json --current CURRENT_BUILD
# Only after explicit user confirmation:
bun apps/native/packaging/update.ts --manifest HTTPS_MANIFEST --keys REVIEWED_PUBLIC_KEYS.json --download USER_DOWNLOAD_DIRECTORY --confirm
```

The CLI verifies Ed25519 signatures before using manifest metadata, expiry/platform/URL/size limits, redirects against pinned HTTPS origins, and streamed artifact SHA-256/byte count. It refuses destination replacement. It never extracts, executes, or installs downloaded files; the user closes the game and explicitly opens/installs a verified package. Tests reject key/signature/content tampering, expired manifests, unsafe paths/origins, redirect escapes and corrupt downloads.

# Linux tester handoff

Build on the target machine with Rust 1.99.1, Bun 1.4.3, CMake/Ninja, a C++20 compiler, SDL3 3.4.18, OpenGL/Mesa development files, cURL/zlib, GTK3 and WebKitGTK 4.1 development files, pkg-config and ffmpeg. On Ubuntu 24.04 SDL3 may need a separate source install; the workflow template shows the pinned official SDL commit/build. Install locked JS dependencies with `bun install --frozen-lockfile`, run `bun apps/native/build.ts`, then `ctest --test-dir apps/native/build --output-on-failure`, `cargo test -p bunnyhop-native-bridge --locked`, and `bun test apps/native/packaging`. Set `CMAKE_PREFIX_PATH`/`LD_LIBRARY_PATH` if SDL was installed outside system locations. Package locally with `bun apps/native/package.ts --skip-build --version VERSION`.

The optional Docker parity harness requires explicit `MAPS_DIR`, `CONTENT_CACHE_DIR` and `PARITY_FIXTURES_DIR` inputs; it assumes no private sibling checkout. See [fixture generation and isolated verification](../tools/README.md). Its Xvfb mode is a separate virtual-display check, not a substitute for the physical tests below.

Compare the native and web clients on the same map, physics 13, style, track, restart point, sensitivity/vertical-sensitivity mode, FOV and display settings. Test a real mouse and a trackpad (including small fractional motion), then test Wayland and X11 separately and report which SDL video driver/session was used. Check focus loss/Alt-Tab, opening/closing menus and Escape while movement/jump/attack keys are held: no stuck input or unexpected live simulation while paused. Check FPS limits, VSync on/off, resolution/window resize and high-DPI scaling.

Exercise local replay recording/import/playback, pause/speed/seeking, returning to live play, and race ghost alignment on a real map. In a test room check chat/vote/map rotation, remote player rendering/interpolation, spectator flow and race start/finish. Check account login/logout/cookie persistence, then perform a real human run and inspect the ordinary finish/submission result only when that native build is admitted by the service. **Never upload fixtures, synthetic commands, oracle recordings or verification-test replays to production.** Offline parity proofs stay offline.

Return the package JSON report and `resources/native-manifest.json` (or `share/bunnyhop-native/native-manifest.json`), git commit, `rustc --version`, Bun version, OS/distribution/kernel, GPU/driver/OpenGL renderer, SDL version/video driver, Wayland/X11 session and scaling, input device/settings, map/style/track, and exact reproduction steps. Include stdout/stderr, CTest/core/package-test logs, linked-library `RUNTIME.txt`/`ldd` output, smoke JSON/screenshots when available, and any affected local `.bhr` file plus its SHA-256. Redact tokens/cookies; no account secrets are needed. These physical checks are assigned to the other developer; macOS packaging tests do not establish Linux or Windows input/GPU correctness.
