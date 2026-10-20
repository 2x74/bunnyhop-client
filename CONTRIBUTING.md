# Contributing

This fork's primary client is the native project in `native/`. Track changes and
report issues in [2x74/bunnyhop-client](https://github.com/2x74/bunnyhop-client).
The root Electron shell is retained as a separate legacy implementation.

## Native development

Install the platform dependencies in the [native guide](native/apps/native/README.md),
then run:

```sh
cd native
bun install --frozen-lockfile
bun run build
bun run check
ctest --test-dir apps/native/build --output-on-failure
cargo test -p bunnyhop-native-bridge --locked
bun test ./apps/native/packaging
```

`bun run check` builds the menu, typechecks the adapters/exporters/tools and runs
mocked-network menu tests. The first full build downloads the pinned canonical
WASM verifier; `bun run wasm` can prepare that cache separately. Native tests and
scripted replay fixtures must never submit fabricated scores to production.
Interactive game/menu smoke checks open application windows: run them only when
you intend to use a graphical desktop. Document their results separately from
headless build and unit-test results.

Keep changes focused. Explain the user-visible behavior, checks run, and exact
OS/architecture tested. Mouse/input changes need physical desktop validation;
headless/Xvfb success does not establish latency or Wayland behavior. Performance
claims need a reproducible measurement and hardware/software conditions.

SDL remains the gameplay input source and the native renderer owns gameplay.
Menu changes must preserve the boundary against importing the web game entry
point, Three or a live JavaScript simulation. Validate and bound host messages,
network payloads, replays and downloaded content. Preserve shared physics,
timer/replay semantics and server verification rather than introducing a
client-trusted score path.

## Packaging and review

Use the [native release process](docs/releases.md). The preview supports unsigned
Windows/Linux archives and ad-hoc macOS bundles; no signing credential is needed
for default local packaging. Builds and packages must be made on their target OS
and architecture. Report untested platforms honestly.

Do not commit credentials, certificates, account data, local replays, downloaded
maps, content caches or generated packages. Preserve dependency/license notices.
Release keys belong outside Git; the optional update trust list is empty by
default. A package being downloadable does not authorize it for ranked scores.

The legacy Electron project still uses Node.js 22+ and `npm ci` /
`npm run verify` from the repository root. Its policy, IPC sandbox and optional
Discord presence are separate from the native gameplay path. See its
[original documentation](https://github.com/2x74/bunnyhop-client/blob/321e746/README.md)
when changing that implementation.

Contributions use the existing [MIT license](LICENSE) and
[code of conduct](CODE_OF_CONDUCT.md).
