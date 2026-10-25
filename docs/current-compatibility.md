# Current native compatibility

This source targets production v0.0.26, physics **16**, timer rules **2**, and
canonical verifier `bunnyhop-web/e0480bade42b`. Its pinned WASM SHA-256 is
`e0480bade42bed8cec193908d52de340ddc66070c1fa5640a76da1ac75cf1d8e`.
The build verifies the downloaded bytes and rejects changes to the rules until
the verifier pin is reviewed.

## Simulation and input

Physics 16 matches production's item gates on `bhop_synthetic_fix`,
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
