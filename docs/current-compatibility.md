# Current native compatibility

The vendored game sources come from web `main` at `59fd424c` (v0.0.29 and its hotfixes): physics **18**, timer rules **2**, and
millisecond scores (timing policy 1). The build makes the WASM verifier from that commit's core and checks its
SHA-256 (`3cd68ab1a59fb71b32f448a1be195f9ceaf3074ccb5ccb89b72ed2014f563242`). See
[the v0.0.29 integration notes](../native/docs/v0.0.29-native-integration.md) and
[upstream deltas](../native/docs/upstream-deltas.md).

## Ranked admission

The server accepts native runs only from builds on its allowlist: an exact build, WASM, physics and rules identity
with an expiry. Native 0.6.1 is admitted for Windows, macOS and Linux until November 12, 2026. Later builds and source builds keep
their replays locally until they are admitted. Every submitted replay is still re-simulated by the server.

## Input

SDL 3.4 is built from a pinned commit on every platform ([release notes](releases.md#sdl-version)). Mouse motion
and key presses carry SDL's event timestamps, and each tick takes the input that arrived before its cutoff, the same
rule as the website's timed input. The shared test vectors in `native/apps/native/src/timed_input_vectors.json`
come from the website's implementation. While you play, Windows reads the keyboard through raw input.

Turn binds use `cl_yawspeed` (60–720°/s, default 210) and a fast-turn multiplier (1–4, default 2). Both are written
into the replay. Legit Scroll drops turn binds outside practice.

## Replays

Playback supports BHR versions 1–10. Recording stops at 180,000 commands, about 30 minutes after a reset. Pending
uploads don't survive closing the app; the finished BHR stays in the local archive.

## Checks

Run from `native/`:

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

Map-based tests need their BSP files in the ignored `native/maps/` folder and skip without them. A pass on macOS
says nothing about Windows or Wayland input; those need a real mouse on that OS.
