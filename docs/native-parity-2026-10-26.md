# Native web-parity implementation — 26 October 2026

This document describes the current `feat/native-web-parity-20261026` source changes. It is an implementation record, not a full-parity or release-qualification claim. The reference is the current web client in `bunnyhop-gfx-native/apps/web`; the native client remains C++/SDL/OpenGL with the shared Rust simulation. The embedded WebView supplies menus, authenticated API/WebSocket transport and shared command/social logic; it does not run the web gameplay renderer.

Follow-up sections record successive implementation passes and supersede earlier gap lists where explicitly addressed. The latest implementation and remaining limits are in [the audio/presentation follow-up](native-audio-parity-2026-10-26.md); the independent UI audit and older sections below are historical snapshots.

## Chat and multiplayer

- Gameplay chat now has a native SDL text editor and native HUD display. Chat and command-chat binds open it without pausing the simulation. It supports UTF-8 input, IME composition, clipboard operations, cursor editing, select-all, history and command completion. Closing chat clears gameplay input. Menu chat still works. Protocol text is capped at 128 UTF-16 units without splitting surrogate pairs. Suggestion requests carry an input/request fence so delayed replies can be rejected.
- The selected current web command registry, help and social commands are included in the native source snapshot. The native adapter handles restart/main/bonus, start points, style, practice, records, weapon commands, spectating, scores, nominations, race commands, reports, gift preview and social commands. Shared routing keeps local actions private and sends server commands or ordinary chat once; help/unknown/practice attempts use the protocol's private-log flag.
- Incoming room messages retain their structured metadata across the transport boundary. Local replies, friend DMs and social notification summaries reach the native chat sink while the WebView is hidden. Report/gift commands bring the menu forward; gifts retain the shared server-priced confirmation flow.
- Native room state retains roster metadata, remote timers, ping, nominations, votes and scheduled map changes. SDL integration provides a scoreboard, map-vote controls and transition countdown. The room menu provides profiles, reports, nomination submission, vote options, spectate controls and race challenge/accept/decline/forfeit. Typed race commands resolve the longest full player name (including spaces), unique prefixes or #slots; spectator cycling starts from the first/last eligible player.
- Remote interpolation now estimates each sender's time offset and batch cadence, absorbs bounded jitter, uses velocity-aware Hermite curves when movement permits, falls back to linear interpolation and permits at most 100 ms of extrapolation. Teleports snap. Weapon/silencer and jump/attack/inspect signals are retained for native presentation. Repeated consumers of one rendered frame share events; later frames do not retrigger them.
- Spectating uses remote pose, cosmetics, weapon and timer metadata. Native controls support target cycling and camera-mode changes. Existing authoritative race countdown/GO/result handling and verified race submission context remain in use.
- Room joins, stale callbacks, map handoff and leave fences remain generation-bound. Account identity changes close the old room and reset account-scoped social state; a rename or verification refresh of the same identity preserves the room. Late account lookups cannot restore an earlier identity. Kicks stop further room commands.

Main files: `native/apps/native/src/native_chat.hpp`, `room_state.hpp`, `room_modes.hpp`, `client.cpp`; `native/apps/native/ui/chat-service.ts`, `chat-routing.ts`, `room-service.ts`, `rooms-panel.ts`, `room-account.ts`, `adapt-social.ts`.

## Unicode display

`text_raster.hpp/.cpp` shapes complete UTF-8 lines with the platform font system: CoreText on macOS, DirectWrite/Direct2D/WIC on Windows, and Pango/Cairo on Linux. It returns bounded top-down RGBA glyph coverage for the HUD's texture cache. This preserves combining sequences and font fallback instead of replacing every non-ASCII byte with an atlas question mark. The output uses straight alpha for the existing blend mode. Font availability and emoji appearance remain platform-dependent.

## Integrated feature coverage

| Area | Added in this branch | Remaining differences |
| --- | --- | --- |
| Map rendering | Sky-depth isolation, correct water material/fog association, authored fog ranges, optional scene-color/depth refraction, linear/gamma fixes, native zone outlines and curtains, optional trigger/clip volumes, light-style updates, smoke volumes/stacks/trails, flashlight cone | Planar reflections, PBR/texture packs, AO/SSR/TAA, shadowed flashlight, exact particle textures and cell/PVS culling |
| Weapons/actors | Attack-driven muzzle flashes, tracers, casings and impacts; inspect, empty reload, shotgun and silencer clips; remote attack/inspect presentation; ghost colors/rims/trails; held-weapon/mode restoration on restart; full paged weapon picker; two-stage sniper zoom and timed rescope | Complete remote reload metadata/choreography, impacts attached to moving brushes |
| Chat/rooms | SDL chat entry and IME composition, Unicode display, shared commands and help, fenced completion, history and scrollback, name/badge/country/rank decorations, room scoreboard/votes/countdown, interpolation and event delivery, spectator eye/chase controls and spatial audio | Full rich clickable chat interaction and production multi-client qualification |
| Settings/HUD/input | Validated expanded preferences and import/export; crosshair, HUD layout/visibility/scale, key labels, speed graph/colors/gains/perfect indicators; viewmodel offsets/FOV/hand/bob/sway; graphics/audio controls; custom starts, hold restart and weapon cycling | Several larger web overlays remain smaller native panels |
| Replays/ghosts | Eye/chase/free/flyby/auto camera modes, four simultaneous ghost slots with independent bounded trails, PB/WR/local/import controls, gauntlet auto-advance and bounded replay/BSP prefetch | Video export and exact web drone/flyby behavior |
| Audio | Stereo spatial player/ghost audio, separate SFX/music/UI controls, menu cues and actor event audio, two-deck music crossfades and ducking | Physical listening and platform-device qualification; exact pause/restart fade timing |
| Profiles/stats | Current shared web profile, card editor, points, activity graphs, run lists, social controls and full Loadout; native local map/jump/attempt counters and account playtime reports | Authored 3D Loadout previews and live production account qualification |
| Support/account | Shared one-time support checkout, gifting with server-priced confirmation, refresh, rename/avatar/linked-account controls and held sign-out | Real checkout/account lifecycle qualification; the reference web UI has no subscription flow |

Third-person gameplay enters practice and invalidates the recording; it cannot be enabled during a ranked timed run or gauntlet. Returning to first person before starting resets a clean attempt. Restart while third person remains enabled stays practice. Replay/spectator cameras do not change a player's ranked attempt. Replay interface bindings remain available while live-only actions are gated.

Main modules: `settings.hpp`, `hud.hpp`, `start_point.hpp`, `weapon_commands.hpp`, `replay_camera.hpp`, `native_presentation.hpp`, `native_map_effects.hpp`, `spatial_audio.hpp`, `renderer.hpp`, `native_viewmodel.hpp`, and the native settings/replay/audio panels.

## First-pass integrated verification (macOS)

- `cmake --build apps/native/build -j 6` passed. `ctest --test-dir apps/native/build --output-on-failure`: **20/20 passed**. New C++ parity assertions remain enabled in Release builds.
- Native menu bundle: **159 modules**, with the no-Three/no-web-game-entry boundary enforced. Typecheck passed. Full UI suite: **126 tests passed / 906 assertions**.
- `cargo test --locked -p bunnyhop-core --lib`: **20 passed**; native bridge library tests: **22 passed**.
- Fresh offline `record-proof.ts` on `bh_aztec`: **3,842 states and timer rows matched** the bundled physics-17 WASM; **39 checkpoints** checked; native BHR bytes matched the shared encoder; heartbeat hashes, playback/seek, ghost state preservation and mutated-checkpoint rejection passed. WASM SHA-256: `35dac92ea33c874d4434f738f089b4b137d492ce8a1f9e4945ef6609c27d8778`. Evidence: `/tmp/native-parity-20261026-record-proof/proof.json`. This is one fresh route fixture against the bundled WASM, not a new production release admission.
- Offline native lifecycle smoke on that BSP/replay passed: practice/checkpoints, restart, third-person admission, gauntlet lock, replay seek, map transitions, HUD scales 50/100/175, timed leave guards, worker shutdown and stale-room callback rejection. **Zero network writes**. Evidence: `/tmp/native-parity-20261026-runtime/result.json`.
- Aero spawn and underwater render checks, plus xcsource spawn checks, completed with `GL_NO_ERROR`; screenshots were inspected. Aero underwater diagnostics report authored fog **150..2200**, replacing the inappropriate generic range; geometry remains visible. Evidence: `/tmp/native-parity-aero-underwater.png`, `/tmp/native-parity-aero-water.json`, `/tmp/native-parity-xcsource-final.png`. These check specific viewpoints, not every area or the original Windows machine.
- Linux build workflows explicitly install Pango development files and fallback fonts; packaging documents the OS font stack. Windows packaging excludes system `d2d1.dll` alongside DirectWrite/WIC. Platform runtime validation remains pending below.

## Verification completed by the chat/multiplayer stream

- Twenty-three targeted Bun tests passed with 185 assertions across chat input, routing, room transport, account identity and social adaptation. Input cases include surrogate-safe protocol limits, stale suggestion rejection, race name/style/track resolution and spectator cycle boundaries. The chat corpus exercises every built-in command and alias, local/private-log/broadcast distinctions, disconnected commands, solo behavior and suggestions. Room tests cover stale callbacks, map handoff, bounded snapshots, clock offset, structured chat/metadata and kick behavior.
- Social-adapter coverage includes live notification mirroring/account reset anchors and explicit failure when upstream anchors drift.
- `bun native/apps/native/typecheck.ts` passed after these changes.
- The menu build succeeded with 155 source modules and enforced its no-Three/no-game-entry boundary. Later parallel edits may change the final module count.
- `room_state_tests.cpp` compiled and passed standalone on macOS: interpolation midpoint, event-once behavior, teleports, remote timer metadata, extrapolation cap, scheduled-change clock conversion and closed-room fences.
- `text_raster_tests.cpp` compiled and passed standalone on macOS: Latin, CJK, Korean, Arabic, Hebrew, combining marks and emoji produced glyph coverage; transparency, scaling, invalid UTF-8 and input bounds were checked.

These are completed checks, not substitutes for the integrated checks below. No Windows/Linux raster-runtime result is claimed here.

## Remaining qualification and known limits

- Integrated results are recorded above. A signed/packaged Windows release and fresh platform-specific release admission have not been produced by this branch; it has not been published.
- Physical Windows typing/IME, DirectWrite fallback, WebView focus, clipboard, audio and packaged-launch checks remain required. Linux Pango/GTK focus and text rendering also need platform runtime qualification. A source implementation or cross-compile alone does not establish either.
- Multi-client live testing must cover reconnect, map download failure, map votes, account changes while connected, spectator switching, jitter/loss and race verification/rejection. Offline fixtures cannot establish production network behavior.
- Native chat preserves room role/badge/color metadata and supports scrollback, but the current SDL line presentation is simpler than the web's fully styled and clickable chat. Rich link interaction and every web overlay/menu detail are not claimed as complete.
- The weapon picker exposes all eligible core weapons through paged native menus. Race menus/report/gift forms use the native menu document rather than reproducing every web in-game overlay.
- Unicode glyph availability, emoji color and bidirectional caret/selection behavior need user-facing review. Whole-line system shaping is implemented; the editor uses UTF-8 codepoint boundaries rather than full grapheme-cluster cursor semantics.
- Authored 3D Loadout previews, native player glow, animated accessories and complete remote animation choreography remain incomplete. Enhanced rendering is outside the requested follow-up scope.
- Replay video export and exact cinematic camera behavior remain incomplete. In-app updates require configured release public keys and origin; the existing standalone update tooling fails closed without them.
- Exact visual/audio equivalence, hardware listening quality, all accessibility interactions and performance under large live rosters require separate review. This source update should not be labeled full web feature parity until an explicit feature matrix and those runtime checks are complete.

## Profile and account UI follow-up

The simplified native profile has been replaced by the current web `profileScreen`, card and card editor. The same source now supplies the card's rank/level/tier clears/records/playtime/jumps/replay views, featured and recent runs, points contributions, activity graph and totals, social counts/relationship menus, virtualized personal-best/all-replay lists, card backgrounds/frames/titles/badges/name/link editing, country selection and mouse-profile controls. Native navigation preserves profile tab/category/card-part links; Watch/Race/Play still use native gameplay routes. The standalone Loadout shortcut now opens the same full shared Loadout tab, including offline free choices, owned/locked catalogs and unlock explanations.

The menu retains a no-Three/no-web-game boundary. Authored knife availability uses an exact metadata catalog, tested against the shipped registry. Loadout previews now use 126 authored static item images. Live rotation, inspect and combined knife/finish/glove previews remain absent; small outfit images also need higher-resolution exports. Card and achievement emblems use the shared SVG/CSS representations. Changing shared loadout selections updates the native cosmetics bridge and invalidates older singleton refreshes.

Native sensitivity is synchronized before constructing the shared profile. Mouse edits publish only for the captured account generation; account switches cancel pending work. Profile/card/account mutation APIs accept a fetch-dispatch ownership fence. The fence checks before fetch, after headers and after a streamed JSON body, so an old editor or response cannot mutate a newly signed-in account or replace its cached identity. Tests use mocked requests, never real account mutations or purchases.

Initial profile-specific checks: the mocked browser test passed with 13 assertions covering the card/points/activity totals, replay filtering, card editor controls and a mocked cosmetic autosave, full Loadout and zero WebGL attempts. The initial activity fixture rendered an empty graph; the independent audit corrected its UTC date and added explicit nonzero-bar and finish-count assertions. Screenshots were saved for Overview, Runs, Edit card and Loadout. Four profile write-fence tests passed, including an account switch during a streaming response; five mouse-publication tests passed, including asynchronous request preparation. The native knife catalog, structured chat decorations and shared-cosmetic refresh fence also passed targeted regressions.

## Support and gameplay follow-up

The native Support screen reuses the current web support and gifting UI. One-time Stripe checkout runs only after an explicit click, opens a validated checkout URL in the system browser, and supports retry and status refresh. Gift credits retain the server-priced review/confirmation and request identity. Account controls now include rename, avatar, linked identity management and held sign-out/sign-out-everywhere. Account changes and disposal invalidate outstanding actions. No real payments or account mutations were made during verification.

Native activity tracking now supplies the local map history, jump counts and attempt counts used by shared menus. Authenticated active playtime uses the existing `/me/playtime` API. Focus, capture, recent input and replay/spectator state gate accrual; counters exclude smoke fixtures. Reports are batched, bounded, retried within the same account generation and fenced at fetch dispatch. Unsent time is persisted for its owning account only, capped at 120 seconds. A report reserved for dispatch is removed from persistence to avoid replaying it after a process exit; an abrupt exit during a request can therefore lose that batch. This does not replace server-verified run/record statistics.

The native host now wires the full paged weapon picker, two-stage sniper zoom with shot/rescope behavior, scrolling chat and IME editing guards, independently bounded trails for all four ghost slots, and music crossfades/ducking. Gauntlet playback prefetches the next compatible BSP and content into the existing validated cache, with cancellation and revision fences; background limits are 64 MiB BSP and 256 MiB content. Prefetch never activates a map, and larger downloads remain available through the foreground loader.

## Second-pass integrated verification (macOS)

- `bun run check` passed: isolated menu build **198 modules**, native TypeScript checks, and **159 tests / 1,020 assertions / zero failures** across 28 files. The build still rejects Three/web-game imports.
- `cmake --build apps/native/build -j 6` passed; CTest **25/25 passed**. New tests cover sniper state, weapon-menu restrictions, all-ghost trails, music envelopes and activity counters. Release assertions are enabled for those checks and the external-URL/music lifecycle tests.
- The music integration test exercised the shipped tracks through SDL dummy audio, including transition, pause, skip, fade, ducking and balanced audio subsystem teardown. This is not a physical listening test.
- Mocked browser tests exercised full profiles/card saves, stats, Loadout, Support, gifting and account controls. Screenshots were inspected. No real checkout, public chat, score submission or account mutation occurred.
- Fresh offline lifecycle smoke passed against the first-pass BSP/replay proof: practice/checkpoints, restart, third-person admission, gauntlet lock, replay, map transitions, HUD scales, leave guards, worker shutdown and stale-room rejection. **Zero network writes and zero WebGL contexts.** Evidence: `/tmp/native-parity-20261026-second-runtime/result.json`.
- The shared Rust simulation was unchanged in this second pass; the earlier 42 Rust tests and 3,842-state native/WASM comparison remain the relevant evidence. Windows/Linux physical runtime and live multi-client qualification remain outstanding. No release was published.

## Native 0.4.0 presentation, desktop and vault pass

This pass remains local and unmerged. It uses the same Rust simulation and a C++/OpenGL gameplay renderer. The embedded menu bundle still rejects Three and the web game entry.

- **Models and animation:** original weapon/hand/cosmetic assets, 126 authored Loadout preview images, first/third-person glow and animated accessories. The native hosted Bunny evaluator ports the web BoneSetup/CsAnimState algorithms over 83 original SHA-verified animation clips: locomotion blends, feet yaw, aim, jumping and firing. A 360-frame web oracle with full-pose checkpoints reports a maximum matrix error of `1.67e-5`. Asset exports and release packaging require the hosted animation pair. Render inspection found and removed an embedded default carrot that duplicated equipped weapons; muzzle flashes now follow the authored gun muzzle and animated part.
- **Firing and chat:** canonical weapon checks cover all 24 gun IDs, cooldowns, ammunition, reload/drop, Glock burst and USP silencer. Actual full-client USP/AK-47/M3/AWP shots reduce ammunition and reload back to capacity with valid shot rays and no GL error. Chat supports Unicode grapheme editing, platform shaping, selection, IME and validated clickable links. An actual screenshot exposed a macOS glyph orientation bug; the raster fix has an asymmetric-glyph regression.
- **Desktop controls:** F10 opens Display settings; Alt+Enter toggles borderless/windowed. Modes, always-on-top, remembered logical bounds, centering, maximize/restore and optional fullscreen focus-loss minimization are implemented. Bounds are clamped to connected usable displays and persisted with a debounce. The application's own menus suspend topmost behavior.
- **Updates:** the Settings Updates panel checks signed manifests, explicitly downloads with cancellation/progress, validates expiry/platform/origin/size/hash and reveals verified packages. Ed25519 verification is implemented in Rust. The default build has no trusted keys or manifest URL, so update network operations remain disabled. Installation is manual; no self-replacement, package execution or production signed-download claim is made.
- **Maps and multiplayer:** metadata refresh reuses verified cached content; complete cached maps work offline on network/server failures. Invalid metadata, authorization/404 responses or corrupt content do not silently downgrade to offline success. Loading has staged byte/file progress, renderer preparation, cancel/retry and error dismissal. Failed/cancelled swaps reset the previous recording cleanly. The Room panel reuses the shared web scoreboard, including PB ordering, status, marks, flags, host and latency, plus the shared map leaderboard dialog.
- **Replay vault:** actual local/imported BHR archive gains search/style/sort/date/size controls and local completed-run summaries. Optional device-PB result captures are saved from the native framebuffer. Device bests are explicitly unverified and distinct from account records. Summary retention is 5,000; captures are capped at 500, 16 MiB each and 1 GiB total. Replay files are never automatically pruned. Metadata/capture errors cannot block replay saving or submission; explicit trash actions retain associated data locally.
- **Replay viewer:** a native overlay supplies a live timeline, pause, endpoint/±5-second seeks, speed and camera controls. Space pauses, Left/Right steps frames, Tab switches cursor/camera control, and right-drag controls chase/free look. Native queued seeks coalesce once per frame; menu dragging is rate-limited and flushes the final tick. Pause state and free-camera placement survive seeking, and stale pending seeks are discarded on stop/replacement. Web cinematic camera planning is ported with an incremental, bounded prepass. FFmpeg/libx264 export supports clip bounds, resolution/orientation, frame rate, quality, camera and HUD; it currently exports video without audio.

## Final integrated evidence for this pass (macOS)

- Full menu build/typecheck/UI suite: **173 tests passed, 1,475 assertions, zero failures**, 35 files; **207 menu source modules**, no Three/game entry. The first integrated run found a cleared loading error leaving a blocking overlay; this was fixed before the clean rerun.
- Native build passes. CTest: **37/37 passed**, including hosted-animation oracle, Unicode, window controls, map cache, replay controls, vault, export, update signature fixtures and existing parity tests.
- Packaging tests: **20 passed, 3 platform-specific Linux skips, 161 assertions**. No package was published.
- Native bridge Rust tests from this pass: **26/26 passed**, including release crypto and all-gun behavior. Physics was not changed by this presentation/desktop/vault pass; the earlier 3,842-state native/WASM proof remains applicable.
- Fresh full-client offline lifecycle smoke confirms practice/gauntlet admission, map transitions, worker teardown, replay endpoint/pause/rapid seek/free-camera preservation: `native/artifacts/native-040-review/runtime-proof.json`. **Zero network writes, zero WebGL contexts.**
- Fresh video export smoke encodes 120 frames and verifies restoration after cancellation, encoder failure and completion. The fixture is explicitly paused at tick 37 so asynchronous restoration can be inspected; encoding also gates simulation advancement. Evidence and video are in `native/artifacts/native-040-review/`.
- Actual C++ client captures show Aero spawn/underwater geometry, xcsource without debug triggers, canonical firing/reload, shaped chat and the live replay timeline. The hosted model montage is assembled from cropped native renders. Vault/loading UI screenshots use clearly identified fixture data. Read-only online Aero loading also completed through the persistent cache.

Remaining release qualification: physical Windows fullscreen/DPI/input/GPU behavior, physical Linux behavior, production multi-client play and account/verified-score flows. Signed update configuration and a production native download still require operator setup and qualification. Remaining fidelity limits include onboarding acting, optional CS skins/runner models, sampled authored third-person inspect deltas on moving poses, strong-caret rather than dual-affinity bidi editing, and export audio. Correctness captures are not FPS/performance claims. No push, merge or release has occurred.

## Zone visibility follow-up

A fresh native end-zone capture confirmed main start/end bounds and green/red outline mapping. Comparison with web `ZoneView` found that native curtains were incorrectly double-sided. Native now keeps floor outlines visible from either side but draws each curtain only from its outward-facing side, matching web's `FrontSide` rule and preventing the curtain from tinting the view inside a zone. The client rebuilt successfully and actual native captures verified the correction (`native/artifacts/native-040-review/start-zone.png`, `end-zone.png`). Zone data still comes from hosted metadata or local `.zones.json` sidecars; missing zone data is not invented.

Additional parity items for the UI audit: native zone/run HUD colors do not yet expose web's semantic color-blind palettes; zone start/reset/finish effects use simplified timing rather than every web tween and provisional-WR gold flare. These are fidelity/accessibility differences, separate from zone collision/timing correctness.

## High polling-rate input follow-up

The native input path has no application 1 kHz cap: every delivered SDL relative-motion report accumulates in doubles, time-prorates into canonical simulation ticks, and is visible to the render camera on a non-consuming copy. The Windows SDL 3.4 backend drains `GetRawInputBuffer` until empty; its reconstructed event timestamps are not USB hardware timestamps ([upstream source](https://github.com/libsdl-org/SDL/blob/release-3.4.0/src/video/windows/SDL_windowsevents.c#L721-L785)). Relative OS acceleration remains disabled by the application's SDL hints ([SDL documentation](https://wiki.libsdl.org/SDL3/SDL_HINT_MOUSE_RELATIVE_SYSTEM_SCALE)). No physics/tick-rate or ranked-admission change was made.

Added an optional Mouse settings diagnostics overlay and last-sample panel: delivered motion events/sec, peak burst/frame, mean/max SDL event age and maximum event-pump duration. These are explicitly not configured hardware polling frequency or click-to-photon latency. Collection has constant storage and no per-report I/O/allocation; it is disabled by default. Activity-clock sampling is now once per event batch rather than once per packet. Capture/restart/input-reset transitions explicitly flush queued stale mouse motion while preserving keyboard/button events.

`native_mouse_rate` exercises actual SDL push/poll events plus native accumulation/proration: 80 schedules across 125/1,000/2,000/4,000/8,000 Hz and 60/144/240/360 FPS, fractional/integer motion, stalls, render-copy isolation and clear behavior. All **484,000 reports** are pushed/polled/sampled exactly; a separate 2,048-event burst passes. Diagnostic arithmetic and selective motion flushing also pass. These are synthetic software-path tests, not hardware certification.

Verification after this change: native build succeeds; **38/38 CTests pass**; menu/typecheck/UI checks pass (**175 tests, 1,498 assertions** in this integrated run); the dedicated diagnostics browser test also passes with fixture data. Fresh native lifecycle smoke passes with zero network writes and zero WebGL contexts. `native/artifacts/native-040-review/mouse-diagnostics-ui-fixture.png` is explicitly a UI fixture screenshot, not an observed 8 kHz device result.

Windows 8 kHz hardware qualification remains required: compare 1/2/4/8 kHz while moving continuously on the same map at fixed and uncapped FPS; inspect frame-time/input processing spikes, total motion consistency, focus/Alt+Tab/restart and buttons/wheel. Delivered motion rate may differ from nominal USB polling when stationary, coalesced by the OS/driver or combined across devices. Renderer/VSync scheduling still bounds visible response; no measured native-vs-web latency claim is established yet.

## Independent menu audit follow-up

Claude Opus 5.5 at high effort completed the [UI audit](native-ui-audit-2026-10-26.md), with nine fixes covering Back/Esc history, the pause screen after map selection, Loadout category routing, narrow profile layouts, static preview controls/layout and activity-graph test coverage. Its full check passed **176 tests / 1,505 assertions / 0 failures**, including menu build and typecheck. Parent review independently reran the Chromium navigation/profile tests (**3 passed / 37 assertions**) and WebKit navigation tests (**2 passed / 22 assertions**) and inspected the updated overview, narrow profile and Loadout screenshots.

Profiles, Support and Loadout have mocked Chromium and Playwright WebKit evidence. This does not establish system WKWebView, WebView2 or WebKitGTK behavior: actual-host profile/Support/Loadout smoke, physical Windows/Linux behavior and live production data remain unverified. Current feature gaps are custom CSS, richer/higher-resolution Loadout previews, named settings presets and smarter search, drag-to-place HUD editing, first-visit onboarding and gamepad menu navigation. The separate zone accessibility/fidelity and Windows high-rate hardware checks above also remain open. No changes were committed, pushed, merged or published during this audit.

## Menu feature completion follow-up

The user excluded custom CSS from native scope. Named settings presets, token/alias
search with spelling suggestions, a drag/keyboard HUD editor, first-visit onboarding
and SDL-backed gamepad menu navigation are now implemented. The HUD-editor bind
opens placement directly. Presets are device-local, preserve validated native
settings and guard modified settings and detached asynchronous dialogs. HUD and
settings screens clean up listeners when removed. Optimistic edits let a preset
capture the latest control value before the next host acknowledgement.

Loadout now requests bounded PNG frames from an independent native OpenGL preview
renderer; the WebView still imports no Three/game renderer. Combined knife,
finish and gloves, character/ghost views, mesh rotation, close-up and original
inspect animations are supported. Thumbnail exports keep doubled character,
headwear and ghost resolution within the existing atlas budget. The native smoke
produced seven distinct views, verified framebuffer/viewport restoration and
rejected invalid modes. Static previews remain the host-unavailable fallback.

The previous independent audit remains a historical snapshot. Its menu-feature
items above are addressed; real system-WebView, physical Windows/Linux, live
account/multiplayer and high-rate mouse qualification are still separate. The
[performance report](performance/README.md) records controlled render measurements,
not a general gameplay or latency advantage. No release, push or merge is implied.

Final menu pass verification: Release native build passes; **39/39 CTests** pass,
including SDL virtual-controller mapping/focus/hotplug. Menu build, typecheck and
**184 UI tests / 1,565 assertions** pass. Fresh settings/onboarding screenshot tests
pass (**3 tests / 31 assertions**), using mocked UI state. The performance series
contains **24 corrected runs / 120,000 measured frames** plus warmups; raw data and charts
are checked into `docs/performance/`. These results do not replace physical
Windows/Linux or live-account qualification.


Aztec follow-up: fixed repeated identity bone-texture uploads for floor weapons.
The actual-GL floor-pose regression passes and before/after framebuffer bytes
match. The original performance chart omitted floor guns on web; it is archived
as superseded. The current four-map 1080p chart includes them on both clients.
See the [correction and diagnostic evidence](performance/README.md#aztec-investigation-and-correction).

## Audio, accessibility and presentation completion follow-up

The [audio/presentation report](native-audio-parity-2026-10-26.md) supersedes the
earlier video-only, missing runner/onboarding acting, sampled inspect and
strong-caret limitations. Native now includes configurable gameplay/ambient/UI
sounds, optional cached CS:S cues, announcer controls, synchronized replay MP4
audio, original Runner selection, live inspect composition, onboarding acting,
dual-affinity text editing and color-blind zone/HUD/menu palettes. The native
model-setting apply path updates player and ghost selection immediately.

Final integrated macOS Release build, **46/46 CTests**, menu build/typecheck and
**191 UI tests / 1,610 assertions** pass. A full-client 120-frame MP4 has exactly
two seconds of both video and non-silent audio, with replay state restored after
completion/cancel/error. Screenshots and precise boundaries are in the report.
A subsequent release-preparation pass adds exact clean-LJ observation/tracking and
opt-in replay music. Optional CS player skins are excluded by user choice; replay
files do not reconstruct historical server PB/WR announcements. Release announcer recordings now use explicitly CC BY 4.0 replacements with
retained source attribution and licenses. Physical
platform/live-service qualification and signed-release configuration remain open.
Custom CSS and enhanced graphics remain outside requested scope. No commit, push,
merge or release was performed.
