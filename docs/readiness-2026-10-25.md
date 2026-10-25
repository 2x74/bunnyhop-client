# Native client audit — 25 October 2026

## Latest branded preview

The `.6` macOS ARM64 preview is named **bunnyhop.lol - Native**, with the
website's existing logo used as its application/window image. The Mac bundle
contains the official ICNS, Windows embeds the official ICO, and Linux packages
the PNG and desktop-entry identity. All three source icon formats are copied
into the hashed asset tree; package checks verify the OS integration copies.

Version `0.3.4-dev.20261025.6` has build identity
`bunnyhop-native/22ed1604d2cf2785e80be5c2`. Its ZIP is 50,081,746 bytes,
SHA-256 `386e4c6b8b540e06d873d835364e98c8e388b11ec300e0307ad42f06ff57e51d`.
It remains an ad-hoc signed preview requiring macOS 27.0, with physics 17/rules 2
and the same canonical verifier described below. It is not production-admitted.

A visible launch confirmed the app/window/menu name and the official logo in
macOS's About window. Closing About left the game running; Cmd+Q with the app
focused terminated the exact `.6` process. These checks made no score submission.
The `.6` build passes 13 CTests, 18 macOS packaging tests and 19 Linux packaging
tests; all 28 correctly re-signed identity/branding tamper variants are rejected.
The `.5` evidence below remains the detailed identity-fix qualification record.

## v0.0.27 / physics 17 candidate

The current candidate supersedes the physics-16 packages recorded below. It ports
the production physics-17 incline, edge, thin-trigger and telehop changes, retaining
the native WASM-compatible math. The canonical verifier is now
`bunnyhop-web/35dac92ea33c`, SHA-256
`35dac92ea33c874d4434f738f089b4b137d492ce8a1f9e4945ef6609c27d8778`,
1,415,101 bytes; timer rules remain 2.

The macOS ARM64 preview `0.3.4-dev.20261025.5` has build identity
`bunnyhop-native/7f722c62963fa3bdf1745ddf`. Its ZIP is 49,770,027 bytes,
SHA-256 `9f231ef2df34a5c292d807736475c5f94e081a0c8c26b091b5a1a95354a3c8a4`.
It is ad-hoc signed, without Developer ID signing or notarization. Release-check
passes its preview checks; strict release signing checks reject it as expected.
Its minimum macOS version is **27.0**, derived from the executable and bundled
SDL library. This local preview does not establish older-macOS compatibility.
The package and JSON report are retained under `native/target/native-packages/`.

Thirteen real recordings on nine maps were re-simulated as physics 17 against
the exact production WASM: 331,678 states, zero mismatches. Every case diverges
when run with physics 16, demonstrating that the comparisons exercise changed
behavior. Historical physics 13, 14 and 16 comparisons add 136,579 states with
zero mismatches. Two finishing v17 recordings (boxes_snowy and aztec) match the
shared encoder byte for byte, pass the offline ranked verifier and native
playback/seek, and reject a tampered checkpoint. These are offline proofs, not
production submissions or server qualification of a logged-in user.

The isolated macOS build passes 12 CTest checks, 38 physics tests, 21 bridge
tests, 64 UI tests and typechecking. The final identity-fix package passes 14 macOS packaging tests (three skips)
and 15 Linux packaging tests (two skips). The latter reuses the reviewed Linux
bridge library, rather than qualifying a new complete Linux package. The sandtrap2 map-dependent case skips because its fixture is absent.
Real-map backdrop checks pass on eazy and japan, including interrupted-tour
resumption. Source and unpacked-package home/pause smokes pass with HTTP 200,
zero WebGL/canvas use and zero simulation ticks. Parent inspection of the
packaged PNGs confirms the native map backdrop, six map tiles, complete pause
leaderboard and non-overlapping Inbox badge. The version reads v0.0.27 alpha.
Evidence and screenshots are retained under `native/target/readiness-v27-20261025/`.

Independent review of the final identity fixes found no material findings: 38
focused checks, 30 re-signed negative package checks and nine offline runtime
cases passed. The checker recomputes the full package identity and validates the
WASM pin, physics 17/rules 2 and actual macOS minimum. Invalid and development
manifests remain playable locally without claiming a qualified build.

Interactive inspection of `.5` confirmed the live native map backdrop, all six
home tiles and a successful home-to-map pause transition without a lingering
loading message. Both the window close button and the macOS Quit Bunnyhop menu
command terminated their exact test processes. The synthetic Cmd+Q keystroke
was inconclusive and is not claimed as keyboard verification. No score was
submitted. The `.6` package above adds the official logo and native display name.

Required candidate CI now compares the platform's built native ABI runner with
the pinned WASM on four self-contained v17 fixtures: 31,440 states, zero
mismatches locally. All four contrast with v16; a native-v16 mutation fails with
3,479 mismatches. Independent gate review reproduced those results. The evidence
binds six package/parity artifacts to source, run and attempt. Hosted execution
is tracked separately; a local pass does not certify Windows runtime behavior.

This establishes the tested simulation and presentation scope, not full web
feature parity. Native still lacks the v0.0.27 practice/checkpoint controller,
sticky practice and noclip clock coasting, the Practice label, applied 50–175%
HUD scaling, and player-report entry points. The shared version/changelog and
Contributor/Owner badges are ported. HUD scale values survive settings import
but do not change the native renderer.

Independent review and current-revision Windows/Linux qualification are tracked
separately. Physical sign-in/input/gameplay, a controlled human leaderboard
finish, platform signing and exact-build admission remain release requirements.
The server's browser grace period does not admit old native physics-16 builds.
No package in this record was activated or published by these checks.

The starting point is ln's public `90a8c9f` source, after merging the previous
physics-15 compatibility PR. The overnight work adds polled/prorated mouse
input, configurable turn binds, SSJ/jump statistics, a strafe trainer, movable
HUD elements, custom audio/music, Discord presence/Join, settings search and
Linux GL-context fixes. Source is available for review, unlike the older v0.0.2
archive investigated on October 24.

## Findings addressed

Independent input, runtime and UI audits identified:

- Turn binds bypassed Legit Scroll restrictions, erased cumulative mouse counts
  and emitted raw resets without turn-button provenance.
- Live SSJ used unfiltered input while replay SSJ used the recorded style-filtered
  command. Explicit restart/load/seek transitions retained stale HUD history.
- Reset discarded the accumulator but retained elapsed time from before the
  transition. Fractional reports whose total was integral were rounded during
  proration. The trainer misclassified W-only movement as deadtime.
- Custom audio decoding allocated complete PCM before checking duration/budget;
  low-rate resampling could allocate far beyond the remaining pack budget.
- Malformed Discord payload field types could escape the RPC client and terminate
  gameplay. Persisted custom music could reopen audio after explicit disablement.
- Periodic host state could overwrite an in-progress yaw slider edit. The music
  selector advertised a bundled soundtrack absent from the distributed assets.

The fixes retain custom turn speeds as local-only attempts. Only the existing
server-supported 210°/s rate can claim ranked manual-turn provenance; the server
policy is unchanged. Replay archives remain available for custom-rate attempts.

Audio decoders now read bounded chunks and precheck metadata. Resampling validates
its output budget before allocation. Discord protocol errors disconnect the
integration without terminating the game. Disabled audio remains disabled.
The decoder notices now accompany packages and are required by release-check.

Independent follow-up reviews found no remaining actionable input or runtime
issues in their scopes. The runtime suites also passed ASan/UBSan; the oversized
FLAC reproduction peaked at approximately 9.6 MB RSS, and the low-rate WAV was
rejected before an oversized resample allocation.

## Initial menu candidate (superseded)

The redesigned home and pause menus emphasize Play/Resume, with grouped game and
utility actions. A native OpenGL course and bunny scene supplies the backdrop;
the camera respects reduced motion. Embedded macOS/Windows views support live
composition, while GTK and screenshot checks use a bounded native PNG. The menu
still initializes no WebGL or WASM gameplay engine.

That design was rejected: the requested target is the existing website, not a
new visual direction. The follow-up revision replaces its layout and invented
course scene with the website's shared home styles, six suggested map tiles on
the right, and the actual featured map backdrop. The initial package below is
retained here only as a record of the earlier checks.

Review found and fixed a home-smoke assertion that confused the home heading with
a map name, and a PNG capture that leaked its depth function into gameplay.
Capture restores that state and each map draw establishes its required depth
function. The standalone scene check verifies state restoration as well as
animation, reduced motion, PNG capture and zero-size handling.

A separate macOS graphics review compared `bhop_eazy` and `bhop_lol_aero` with
viewmodels enabled and disabled. Scene-to-map transitions, incorrect incoming
depth state and fallback capture at three sizes produced zero differing
framebuffer bytes against baseline, with no GL errors.

UI validation passed 57 tests with 396 assertions and TypeScript checking. The
browser integration smoke exercised live map discovery, map selection, settings,
account controls and Resume with zero external scripts, WASM calls or WebGL
attempts. The native input/SSJ checks include 313 oracle reports; the Rust bridge
passed 21 tests. Eight turn-admission oracle cases passed against an unmodified
private server helper, without changing admission or submitting a score.

## Initial candidate platform and package checks

macOS ARM64: the integrated CMake build and 11 CTest checks passed. Home and
`bhop_eazy` menu smoke checks exited successfully with HTTP 200, visible controls,
zero WebGL attempts/contexts and zero canvases. Scripted error paths exit without
opening a modal alert. The earlier timeout's modal-alert hang was diagnosed and
fixed; its original timeout trigger was not reproduced.

Linux ARM64: a separate Release build and all 13 CTest checks passed under
X11/Xvfb/software Mesa, including GTK lifecycle and Bun oracles. Scene, home and
online-map menu checks all exited successfully. The menu checks confirmed the
static native backdrop, HTTP 200 and zero WebGL/canvas usage. Source remained
read-only and unchanged during validation. This does not establish physical GPU,
audio-device, input or Wayland behavior.

The superseded macOS preview is `0.3.4-dev.20261025.2`, build
`bunnyhop-native/ba1002b0217cd69de6d9b19e`. Its ZIP is 49,680,762 bytes, SHA-256
`392599b5c1858c3a7eb2499783096af0d0b3609abbcc5acb9e079e2dc2c66bd4`.
Release-check verified executable/menu/assets identity, required resources and
strict ad-hoc signature integrity. It is not Developer ID signed or notarized.
The packaged ordinary launch was visually inspected through native app controls:
the live 3D scene and menu composed correctly, Play opened the live map browser,
and Back returned to the home menu.
Both packaged home and online-map smoke checks also passed when launched from
`/tmp`, confirming bundled resource lookup independently of the source directory.

## Web menu parity revision

The replacement uses the website's home and pause markup and unchanged shared
`style.css`: wordmark, menu rail, account footer, and six suggested maps on the
right. An independent browser comparison at 1280×720 found no differences in
position, dimensions or typography for the main home layout elements. The first
map tile and background use the same shared featured-map selection.

The invented scene is removed. A separate native BSP context renders cinematic
map tours, using checkpoint/start anchors and camera collision traces. It never
steps gameplay, records a run or submits scores. macOS/Windows compose the scene
behind the transparent menu; GTK receives a bounded PNG. The same map's website
art supplies the loading/failure fallback. Reduced motion holds a stable shot.

Downloads share a cache lock, respect cancellation and cap background BSPs at
32 MiB and total content at 256 MiB. Core/renderer construction stays on the main
thread. Gameplay loading cancels the background request. Host state is dispatched
before backdrop callbacks, and opening Pause re-arms the callback on all platforms,
including after tutorial/replay loads that hid the menu.

Native-specific behavior remains explicit: Gauntlets and Support open their web
pages, Quit replaces the web-only desktop/about links, and the pause rail's final
Quit action closes the client. Small home windows can scroll to reach every tile.

The rebuilt macOS client passed all 12 CTest checks. Standalone real-map backdrop
checks passed on `bhop_eazy` and `bhop_japan`: stable reduced-motion frame, camera
movement, bounded PNG, cancellation/de-duplication, pack-state restoration and
zero GL errors.

UI validation on the frozen revision passes 64 tests, typechecking and the live
browser integration smoke. A second independent review rebuilt the menu into an
isolated directory and matched its SHA-256:
`d25df285e50096904d8ac910946d3af5bb9459028af11977c4e29e7e75ad9d7f`.
It found no package-blocking issues. A narrow fast-failure race can retain the
map-art fallback instead of restarting the tour if the UI misses an entire
loading-state interval; the menu remains usable.

WebKit hidden-window checks reproduced a stopped animation clock, leaving
entrances and async images unpainted. The native menu detects that state and
finishes suspended entrances; visible windows retain the web animations. Smoke
assertions now inspect ancestor opacity, in-viewport tiles and decoded backdrop
images. A screenshot-only settle hook finishes remaining row animations after
those assertions pass. Both final packaged home and `bhop_eazy` pause checks
passed from `/tmp`, with HTTP 200, zero WebGL/canvas use, visible backgrounds,
and zero gameplay ticks. Their actual PNGs were visually inspected.

The final Linux ARM64 Release build passed all 14 CTest checks, the real-BSP
backdrop smoke, and both integrated menu checks under X11/Xvfb/software Mesa.
Home showed six fully painted map tiles over `bh_aztec`; Pause showed the complete
rail and settled leaderboard over `bhop_eazy`. Both returned HTTP 200, zero
WebGL/canvas usage and zero simulation ticks. Hash audits found no changes to
614 source/bundle inputs during validation. At the tested Linux window size,
the unread Inbox badge slightly overlaps its label in the shared pause rail;
this remains a minor layout limitation. Physical GPU/Wayland and Windows runtime
behavior were not tested by this run.

The replacement macOS ARM64 preview is `0.3.4-dev.20261025.3`, build
`bunnyhop-native/301414c9971fbb7ed6363514`. ZIP size is 49,752,291 bytes, SHA-256
`c4641b4976211d4cafc6133d2dd055b97649f3bb647a02e88d9497de8da11eb3`.
Release-check passed resource/executable/menu identities and strict ad-hoc
signature verification. It is not Developer ID signed or notarized. Ordinary
launch ran the native renderer, but interactive inspection of this final package
was blocked by the computer-use service returning `cgWindowNotFound` and timing
out. Packaged WebView screenshot checks establish the static composition;
interactive live composition remains a separate check for this revision.

## Current production compatibility

Production advanced to physics 16 after the prior PR. This branch ports the exact
shared map-I/O/objective changes from production main `5dadd300`, retains native
WASM-compatible math, and pins the live verifier:

- Build: `bunnyhop-web/e0480bade42b`
- SHA-256: `e0480bade42bed8cec193908d52de340ddc66070c1fa5640a76da1ac75cf1d8e`
- Size: 1,407,626 bytes
- Physics 16, timer rules 2

Targeted v16 tests exercised real BSP fixtures for synthetic, wonderland, lego3
and cooksassistant. Older-map cases can skip when their separate fixtures are
absent. The 1,822-tick horseshit_4 capture matched native/WASM state and timer rows,
19 checkpoints and command hashes; native replay encoding, playback/seek and
modified-checkpoint rejection passed. This is an offline scripted proof, not a
human or production leaderboard result.

A separate 2,001-state differential check passed on each of the four v16 maps.
The cooks check reported four missing optional model resources; both paths used
the same inputs. The map-specific gate regression suite supplies the stronger
behavioral coverage for the v16 changes.

## Qualification boundary

The live API was read for compatibility and menu smoke checks. No production
score, native admission change, deployment or release publication was performed.
The live native admission list was empty when checked.

A final package still needs physical sign-in/input/gameplay qualification on its
intended platform, followed by an explicitly controlled human score-to-public-
leaderboard test under that exact package identity. A source build, passing
simulation proof or CI job cannot substitute for those checks. Windows and
physical Wayland testing must be reported separately from macOS or headless Linux.

The separate private verifier change forwarding `BEATS_OPTIONAL_S` remains outside
this public client PR. Closing the app still loses pending network upload jobs,
though completed BHR files are archived; long seeks remain synchronous.
