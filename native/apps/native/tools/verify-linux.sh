#!/usr/bin/env bash
# Optional external-fixture harness. It never assumes another source checkout.
# WITH_CLIENT=1 adds an isolated Xvfb/Mesa render check inside the container.
set -euo pipefail
usage() {
  cat <<'HELP'
Usage: MAPS_DIR=DIR CONTENT_CACHE_DIR=DIR PARITY_FIXTURES_DIR=DIR verify-linux.sh

Required inputs (mounted read-only):
  MAPS_DIR              BSP files named exactly like each fixture without .commands
  CONTENT_CACHE_DIR     The physics content cache used by the WASM fixture generator
  PARITY_FIXTURES_DIR   *.commands plus matching *.commands.expected.jsonl files

Generate fixtures first with apps/native/tools/parity.ts; see tools/README.md.
Optional: WITH_CLIENT=1, LINUX_OUT_DIR=DIR, LINUX_VERIFY_IMAGE=IMAGE.
WITH_CLIENT=1 requires generated target/native-assets and runs only inside Xvfb.
This script never uploads maps, replays, fixture commands or verification results.
HELP
}
if [[ $# -gt 0 ]]; then
  if [[ $# -eq 1 && $1 == --help ]]; then usage; exit 0; fi
  usage >&2; exit 2
fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
maps_dir=${MAPS_DIR:-}
cache_dir=${CONTENT_CACHE_DIR:-}
fixtures_dir=${PARITY_FIXTURES_DIR:-}
out_dir=${LINUX_OUT_DIR:-"$repo_root/target/native-linux"}
with_client=${WITH_CLIENT:-0}
image=${LINUX_VERIFY_IMAGE:-bunnyhop-native-linux-verify:local}
if [[ $with_client != 0 && $with_client != 1 ]]; then
  echo 'WITH_CLIENT must be 0 or 1' >&2; exit 2
fi
if [[ -z $maps_dir || -z $cache_dir || -z $fixtures_dir ]]; then
  echo 'Supply MAPS_DIR, CONTENT_CACHE_DIR and PARITY_FIXTURES_DIR explicitly; see --help.' >&2; exit 2
fi
for directory in "$maps_dir" "$cache_dir" "$fixtures_dir"; do
  if [[ ! -d $directory ]]; then echo "Input directory does not exist: $directory" >&2; exit 2; fi
done
maps_dir=$(CDPATH= cd -- "$maps_dir" && pwd)
cache_dir=$(CDPATH= cd -- "$cache_dir" && pwd)
fixtures_dir=$(CDPATH= cd -- "$fixtures_dir" && pwd)
fixtures=("$fixtures_dir"/*.commands)
if [[ ! -f ${fixtures[0]} ]]; then echo "No .commands fixtures in $fixtures_dir; generate or supply fixtures first." >&2; exit 2; fi
for fixture in "${fixtures[@]}"; do
  map=$(basename "$fixture" .commands)
  if [[ ! -s $fixture || ! -s $fixture.expected.jsonl ]]; then echo "Missing or empty fixture/expected states: $fixture" >&2; exit 2; fi
  if [[ ! -s $maps_dir/$map ]]; then echo "Missing fixture BSP: $maps_dir/$map" >&2; exit 2; fi
done
if [[ $with_client == 1 ]]; then
  for asset in hud.rgba viewmodels.json viewmodels.bin.z cosmetic-vertex-pars.glsl cosmetic-vertex-main.glsl cosmetic-fragment-pars.glsl cosmetic-fragment-albedo.glsl cosmetic-fragment-light.glsl tutorial.json; do
    if [[ ! -s $repo_root/target/native-assets/$asset ]]; then
      echo "WITH_CLIENT=1 needs generated target/native-assets/$asset; run the native resource exporters first." >&2; exit 2
    fi
  done
fi
command -v python3 >/dev/null || { echo 'Python 3 is required to compare saved WASM states.' >&2; exit 2; }
command -v docker >/dev/null || { echo 'Docker is required for the isolated Linux verification.' >&2; exit 2; }
mkdir -p "$out_dir"
out_dir=$(CDPATH= cd -- "$out_dir" && pwd)
docker build --build-arg "WITH_CLIENT=$with_client" \
  -t "$image" -f "$repo_root/apps/native/Dockerfile.verify" "$repo_root/apps/native"
docker run --rm \
  --mount "type=bind,source=$repo_root,target=/src,readonly" \
  --mount "type=bind,source=$maps_dir,target=/maps,readonly" \
  --mount "type=bind,source=$cache_dir,target=/content-cache,readonly" \
  --mount "type=bind,source=$fixtures_dir,target=/fixtures,readonly" \
  --mount "type=bind,source=$out_dir,target=/out" \
  -e CONTENT_CACHE_DIR=/content-cache -e CARGO_HOME=/out/cargo-home \
  -e "WITH_CLIENT=$with_client" "$image" bash -euo pipefail -c '
    { uname -a; rustc --version; cmake --version | head -1; c++ --version | head -1; } > /out/environment.txt
    client=OFF; if [[ "$WITH_CLIENT" = 1 ]]; then client=ON; fi
    cmake -S /src/apps/native -B /out/build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release -DRUST_TARGET_DIR=/out/cargo \
      -DBUNNYHOP_BUILD_CLIENT="$client"
    cmake --build /out/build
    ctest --test-dir /out/build --output-on-failure
    fixtures=(/fixtures/*.commands)
    for fixture in "${fixtures[@]}"; do
      map=$(basename "$fixture" .commands)
      sha256sum "$fixture" "$fixture.expected.jsonl" "/maps/$map" > "/out/$map.inputs.sha256"
      /out/build/bunnyhop-native-runner --map "/maps/$map" --commands "$fixture" \
        > "/out/$map.native.jsonl"
      echo "Linux states: /out/$map.native.jsonl ($(wc -l < "/out/$map.native.jsonl") rows)"
    done
    if [[ "$WITH_CLIENT" = 1 ]]; then
      pkg-config --modversion sdl3 > /out/sdl-version.txt
      LIBGL_ALWAYS_SOFTWARE=1 xvfb-run -a glxinfo -B > /out/gpu-environment.txt
      SDL_VIDEO_DRIVER=x11 LIBGL_ALWAYS_SOFTWARE=1 xvfb-run -a /out/build/bunnyhop-native \
        --map "/maps/$(basename "${fixtures[0]}" .commands)" \
        --no-menu --hidden --frames 30 --screenshot /out/gpu-smoke.ppm
    fi
    echo "Container verification complete"
  '
python3 "$script_dir/compare-states.py" "$fixtures_dir" "$out_dir"
echo "Linux verification artifacts: $out_dir"
