# Current native compatibility

This source targets production v0.0.27 with the Source-look graphics update, physics **17**, timer rules **2**,
and canonical verifier `bunnyhop-web/240b3b26afe5`. Its pinned WASM SHA-256 is
`240b3b26afe569b98eb59a73ee4b8f809d360511bda0479ae2be9edb67b8757f`. That verifier simulates identically to the
previous `bunnyhop-web/35dac92ea33c` (production re-simulated 2,331 replays with no difference); it changes only
lightmap encoding and presentation-only entity states.
The build verifies the downloaded bytes and rejects changes to the rules until
the verifier pin is reviewed.

## Simulation and input

Physics 17 includes production's incline, edge, thin-trigger landing and telehop
fixes. Physics 16 matches production's item gates on `bhop_synthetic_fix`,
`bhop_wonderland` and `bhop_lego3`, and the ingredient objectives on
`bhop_cooksassistant`. Physics 14/15 fixes and historical replay versions remain
available. The native Rust core retains its WASM-compatible math configuration.

Mouse motion is accumulated at SDL polling time and prorated across native ticks.
The camera previews pending motion without advancing the recording. Fractional
reports retain their precision even when their combined total is an integer.
Focus/menu/restart transitions discard pending input and reset elapsed time.
Device event timestamps are not used. Keyboard/button state follows polling.

Playback supports BHR versions 1–10. Manual turns preserve mouse counts and turn
button provenance; Legit Scroll prohibits turn binds outside practice. Only the
server-supported 210°/s rate is ranked-compatible. Using another configured turn
rate makes that attempt local-only while retaining its BHR archive. Recording
uses the shared counted/uncounted formats and fractional turn format as needed.
The client does not run a client-side WASM self-check.

## v0.0.27 presentation and feature scope

The shared menu shows the new version, changelog, Contributor and Owner badges.
The native practice controller uses the shared checkpoint/noclip primitives and
v0.0.27 policy: saving is harmless, using teleport/noclip marks the attempt as
practice until restart, noclip coasts the clock, and practice cannot submit.
The checkpoint menu and Practice label render natively. HUD scale applies from
50–175%, including spacing. Menus reuse the web's Gauntlet and player-report
components, with native lifecycle adapters. Main menu releases the loaded map.
Home backgrounds can play a PB in an independent native context, falling back
to map tours. The eleven production OST tracks are bundled and hash-checked;
playback controls use SDL, with no browser audio playback.
Simulation compatibility is not a claim of complete website feature parity.

Gauntlet playback has Previous/Next split navigation and rejects obsolete map
builds. It does not have the web's continuous attempt timeline, automatic split
advance or next-map prefetch. Pause includes Replays, On screen and Help tabs;
On screen uses native setting switches and Help lists native keys. Solo native
play has no chat console. Sharing a last run and MP4 export remain web features.
Soundtrack controls stay inside the app and do not claim OS media keys.

## Accounts and packages

Ranked attempts bind to a confirmed account ID. Changing accounts invalidates the
old attempt's network writes; a same-account profile refresh preserves it.
Ownership is rechecked at actual fetch dispatch, after asynchronous device
headers are ready. Initial heartbeats share one session. Completed uploads survive
starting another attempt, with at most four in flight.

Linux packaging rewrites bundled ELF search paths relative to the package,
resolves non-system dependencies and rejects unsafe or missing paths. The release
checker independently repeats those checks. Package notices include the custom
audio decoders. A source build and its packaged release have different identities.

ln's overnight source is now public in commits through `90a8c9f`, including the
previously unpublished custom audio, JHUD/SSJ and platform fixes. The source audit
and fixes in this branch do not authenticate older separately uploaded archives.
Each release must be qualified using its own source and packaged identity.
The package checker and runtime validate the pinned WASM, physics/rules and
recomputed component identity. Invalid manifests remain local-only. macOS
packages declare the maximum deployment target across the executable and bundled
libraries; local previews on this development Mac require macOS 27.0. Hosted
package requirements must be read from that package's report, not inferred from
the local preview.
The app display name is **bunnyhop.lol - Native**; packaged icons use the existing
official bunnyhop logo.

## Validation

See [the October 25 audit and qualification record](readiness-2026-10-25.md) for
current results and the scope of native, browser, offline-verifier and platform
checks. Run the standalone checks from `native/`:

```sh
bun install --frozen-lockfile
bun run build
bun run check
bun test ./apps/native/packaging
ctest --test-dir apps/native/build --output-on-failure
cargo test --locked -p bunnyhop-native-bridge
cargo test --locked -p bunnyhop-core --release --features native-wasm-math \
  --test physics_v14 --test physics_v15 --test physics_v16 \
  --test physics_v16_cooks --test physics_versions
```

Map-based tests require their BSP fixtures in ignored `native/maps/`; cases can
skip if those assets are absent. Generated assets, canonical WASM, player
recordings and build output are not committed. A macOS pass does not establish
physical Windows or Wayland behavior.

## Live score qualification

A source update, passing simulation proof or published archive does not enable
ranked scores. Each final package requires an exact, unexpired admission entry
matching the canonical WASM, physics and timer rules. Every submitted replay still
passes canonical server verification and integrity analysis.

Before broad admission, complete physical sign-in/input/gameplay checks on each
supported platform and a controlled human finish-to-public-leaderboard test.
Do not submit scripted fixtures to production. The private verifier must retain
native admission policy and forward `BEATS_OPTIONAL_S`; that service change is
tracked separately from this client repository.

Recordings stop at 180,000 commands (about 30 minutes since reset). Pending upload
jobs/tokens do not survive app closure, though completed BHR files remain archived.
Long replay seeking and ghost preparation remain synchronous. These checks make
no FPS or latency improvement claim.
