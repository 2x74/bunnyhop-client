# Native client audit — 25 October 2026

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

## Menu and presentation

The redesigned home and pause menus emphasize Play/Resume, with grouped game and
utility actions. A native OpenGL course and bunny scene supplies the backdrop;
the camera respects reduced motion. Embedded macOS/Windows views support live
composition, while GTK and screenshot checks use a bounded native PNG. The menu
still initializes no WebGL or WASM gameplay engine.

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

## Platform and package checks

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

The macOS preview is `0.3.4-dev.20261025.2`, build
`bunnyhop-native/ba1002b0217cd69de6d9b19e`. Its ZIP is 49,680,762 bytes, SHA-256
`392599b5c1858c3a7eb2499783096af0d0b3609abbcc5acb9e079e2dc2c66bd4`.
Release-check verified executable/menu/assets identity, required resources and
strict ad-hoc signature integrity. It is not Developer ID signed or notarized.
The packaged ordinary launch was visually inspected through native app controls:
the live 3D scene and menu composed correctly, Play opened the live map browser,
and Back returned to the home menu.
Both packaged home and online-map smoke checks also passed when launched from
`/tmp`, confirming bundled resource lookup independently of the source directory.

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
