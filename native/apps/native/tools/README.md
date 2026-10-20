# Optional Linux parity harness

`verify-linux.sh` consumes explicitly supplied maps, physics content and saved
WASM fixtures. It does not depend on a sibling repository or ship maps/replays.
Run these commands from this repository's `native/` directory. Bun dependencies,
the pinned canonical WASM and the native runner must be available first; follow
the [native build instructions](../README.md).

Generate deterministic fixtures for a map you already have permission to use:

```sh
CONTENT_CACHE_DIR=./local-content-cache \
  bun apps/native/tools/parity.ts --map ./local-maps/example.bsp --ticks 2000
```

The generator saves `target/native-parity/example.bsp.commands` and
`example.bsp.commands.expected.jsonl`, then compares the current host runner
against the same WASM states. `--map` may be repeated for multiple maps. An
optional `--replay FILE.bhr` uses one local replay as input; generated fixtures
and reports are local test artifacts, never score submissions. Use the same
physics content cache when generating fixtures and checking Linux. An empty
cache directory is sufficient only for self-contained fixtures whose BSP needs
no external physics assets.

Supply those inputs to the isolated Linux build:

```sh
MAPS_DIR=./local-maps \
CONTENT_CACHE_DIR=./local-content-cache \
PARITY_FIXTURES_DIR=./target/native-parity \
  bash apps/native/tools/verify-linux.sh
```

Docker and Python 3 are required. All three input directories are mounted
read-only, including a fixture directory outside the checkout if supplied.
Every `.commands` file must have a matching `.commands.expected.jsonl`, and the
map filename is the fixture filename with `.commands` removed. For example,
`example.bsp.commands` requires `MAPS_DIR/example.bsp`. The script validates
these files before starting Docker. Outputs go to `target/native-linux`, or to
`LINUX_OUT_DIR` when set, and include exact-bit comparison reports and input
hashes. No maps or fixtures are downloaded or uploaded by this harness.

`WITH_CLIENT=1` additionally requires generated `target/native-assets` and runs
the native OpenGL smoke inside the container's Xvfb/Mesa display with menus
disabled. It does not open a host desktop window. Generate those resources with
`bun apps/native/src/export-viewmodels.ts` and
`bun apps/native/src/export-presentation.ts` before selecting that option.
This checks a virtual display only; it establishes neither physical mouse
behavior nor real Wayland/X11 driver performance. Use the
[Linux tester handoff](../packaging/README.md#linux-tester-handoff) for those
separate checks.
