# Current native compatibility

This source targets the production v0.0.26 simulation: physics **15**, timer rules
**2**, and canonical verifier `bunnyhop-web/3cca0f22a3c3`. The pinned WASM SHA-256 is
`3cca0f22a3c30492d30c2f5e745f8940cc29498eafdbab4d9ff5cd9e07bbd20a`.
The build verifies the downloaded bytes and rejects a physics/timer constant
change until the verifier pin is reviewed.

## Changes

- Physics 14 adds per-map maximum velocity and spawn-time train initialization;
  physics 15 preserves signed door travel on `bhop_montana_fix`. Historical
  simulation versions remain available for older replays.
- BHR v10 playback understands fractional counted look and manual-turn rebases.
  Native recording retains its existing counted/uncounted formats.
- Mouse reports are queued by SDL timestamps and consumed at simulation tick
  deadlines. Rendering previews pending reports without consuming recorded input.
  Keyboard/button timing and the 250 ms catch-up cap remain unchanged.
- GTK operations temporarily release and restore the SDL GL context, including
  nested callbacks and context replacement. Physical Wayland validation remains
  required.
- Ranked attempts bind to confirmed account IDs. Changes suspend writes and
  invalidate the previous account's attempt. Ownership is checked immediately
  before the actual fetch, after asynchronous device-header preparation. Initial
  heartbeats share one session, and completed uploads survive gameplay restarts.
- Linux packaging rewrites all bundled ELF search paths relative to the package,
  resolves non-system transitive dependencies and rejects unsafe/missing paths.
  The release checker repeats those checks independently.
- Shared menu/protocol modules are current while native aliases continue to keep
  Three, the web game entry point and live JavaScript simulation out of the menu.

## Standalone validation

On macOS ARM64, using Bun 1.4.3 and Rust 1.99.1:

- Locked dependency installation, full native build and standalone typecheck passed.
- UI/packaging tests: **63 passed**, three Linux-only tests skipped.
- Native Rust bridge: **20 passed**, including cross-language v10 playback tests
  and the style oracle across 15 physics versions and all eight styles.
- Physics 14/15 regressions: **eight passed**, with the local BSP fixtures supplied.
- Native CTest: **seven passed**, including input, boundaries and tutorial checks.
- Native menu smoke on the rebuilt standalone client: account API HTTP 200,
  loaded `bhop_eazy` controls visible, zero WebGL attempts, menu/game screenshots
  captured. This exercised the menu and renderer, not a real sign-in or score.

Run the checks from `native/`:

```sh
bun install --frozen-lockfile
bun run build
bun run check
bun test ./apps/native/packaging
ctest --test-dir apps/native/build --output-on-failure
cargo test --locked -p bunnyhop-native-bridge
cargo test --locked -p bunnyhop-core --release --features native-wasm-math \
  --test physics_v14 --test physics_v15
```

Map-based physics tests require the named BSP files in ignored `native/maps/`;
without them individual map cases skip. Build output, maps, canonical WASM and
player recordings are not committed. Linux and Windows are separate platform
qualification targets; a macOS build does not establish their runtime behavior.

## Live score qualification

This update does not publish a release or enable scores. Each final packaged
artifact needs its own exact, unexpired native admission entry matching the
current canonical WASM, physics and timer rules. A source build's identity is
different from a packaged identity. Every submitted replay still goes through
canonical server verification and integrity analysis.

Before broad admission, complete hands-on sign-in/input/gameplay checks on each
supported platform and a controlled human finish-to-public-leaderboard test.
Do not upload scripted fixtures to production. The server-side private verifier
must also preserve its current native policy and forward the configured
`BEATS_OPTIONAL_S`; that service change lives outside this client repository.

Known limits remain: recordings stop at 180,000 commands (about 30 minutes since
reset), pending upload jobs/tokens do not survive app closure, and long replay
seeking/ghost preparation is synchronous. Completed BHR files remain archived.

The input and GTK corrections here were implemented from the public source.
They do not incorporate or authenticate additional unpublished changes in a
separately uploaded release. Source and package identities must be checked for
each release independently.
